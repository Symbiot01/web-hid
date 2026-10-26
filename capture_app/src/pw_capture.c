/*
 * pw_capture.c - libpipewire-0.3 consumer for XDG ScreenCast streams.
 *
 * Negotiates SPA_DATA_DmaBuf first with SPA_DATA_MemFd / SPA_DATA_MemPtr fallback,
 * supports BGRx, BGRA, RGBx, RGBA, XRGB2101010, NV12, and I420 formats, downpaces
 * incoming 60 Hz compositor frames to the target FPS via monotonic wall-clock
 * filtering before pushing into the bounded pipeline, and immediately returns
 * pw_buffer to PipeWire via pw_stream_queue_buffer().
 */
#define _POSIX_C_SOURCE 200809L

#include "pw_capture.h"
#include "log.h"

#include <drm/drm_fourcc.h>
#include <inttypes.h>
#include <pipewire/pipewire.h>
#include <spa/buffer/buffer.h>
#include <spa/param/buffers.h>
#include <spa/param/video/format-utils.h>
#include <spa/pod/builder.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#ifndef DRM_FORMAT_MOD_LINEAR
#define DRM_FORMAT_MOD_LINEAR 0ULL
#endif

#ifndef DRM_FORMAT_MOD_INVALID
#define DRM_FORMAT_MOD_INVALID ((1ULL << 56) - 1)
#endif

#ifndef I915_FORMAT_MOD_X_TILED
#define I915_FORMAT_MOD_X_TILED 0x0100000000000001ULL
#endif

#ifndef I915_FORMAT_MOD_Y_TILED
#define I915_FORMAT_MOD_Y_TILED 0x0100000000000002ULL
#endif

struct pw_capture_ctx {
    const app_config_t      *cfg;
    pipeline_queue_t        *queue;
    struct pw_thread_loop   *thread_loop;
    struct pw_context       *context;
    struct pw_core          *core;
    struct spa_hook          core_listener;
    struct pw_stream        *stream;
    struct spa_hook          stream_listener;
    struct spa_video_info_raw video_info;
    bool                     format_valid;
    uint64_t                 frame_interval_ns;
    uint64_t                 next_frame_pts_ns;
    uint64_t                 seq;
    atomic_bool              stream_error;
    bool                     running;
};

static uint64_t monotonic_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static uint32_t spa_format_to_drm_fourcc(enum spa_video_format fmt)
{
    switch (fmt) {
    case SPA_VIDEO_FORMAT_BGRx: return DRM_FORMAT_XRGB8888;
    case SPA_VIDEO_FORMAT_BGRA: return DRM_FORMAT_ARGB8888;
    case SPA_VIDEO_FORMAT_RGBx: return DRM_FORMAT_XBGR8888;
    case SPA_VIDEO_FORMAT_RGBA: return DRM_FORMAT_ABGR8888;
    case SPA_VIDEO_FORMAT_NV12: return DRM_FORMAT_NV12;
    case SPA_VIDEO_FORMAT_I420: return DRM_FORMAT_YUV420;
    default:                    return DRM_FORMAT_XRGB8888;
    }
}

static void on_core_error(void *data, uint32_t id, int seq, int res, const char *message)
{
    pw_capture_ctx_t *ctx = (pw_capture_ctx_t *)data;
    LOG_ERROR("pipewire", "core error id=%u seq=%d res=%d: %s",
              id, seq, res, message ? message : "unknown");
    if (id == PW_ID_CORE && ctx) {
        atomic_store_explicit(&ctx->stream_error, true, memory_order_relaxed);
    }
}

static void on_stream_state_changed(void *data,
                                    enum pw_stream_state old_state,
                                    enum pw_stream_state state,
                                    const char *error)
{
    pw_capture_ctx_t *ctx = (pw_capture_ctx_t *)data;
    LOG_INFO("pipewire", "stream state: %s -> %s%s%s",
             pw_stream_state_as_string(old_state),
             pw_stream_state_as_string(state),
             error ? " (" : "",
             error ? error : "");
    if (state == PW_STREAM_STATE_ERROR && ctx) {
        atomic_store_explicit(&ctx->stream_error, true, memory_order_relaxed);
    }
}

static void on_stream_param_changed(void *data, uint32_t id, const struct spa_pod *param)
{
    pw_capture_ctx_t *ctx = (pw_capture_ctx_t *)data;
    if (!param || id != SPA_PARAM_Format) {
        return;
    }

    if (spa_format_video_raw_parse(param, &ctx->video_info) < 0) {
        LOG_ERROR("pipewire", "failed to parse negotiated SPA_PARAM_Format");
        return;
    }

    ctx->format_valid = true;
    LOG_INFO("pipewire",
             "negotiated format: %ux%u format_id=%u modifier=0x%" PRIx64 " max_fps=%u/%u",
             ctx->video_info.size.width,
             ctx->video_info.size.height,
             (unsigned)ctx->video_info.format,
             (uint64_t)ctx->video_info.modifier,
             ctx->video_info.max_framerate.num,
             ctx->video_info.max_framerate.denom);

    uint8_t params_buf[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(params_buf, sizeof(params_buf));
    const struct spa_pod *params[2];

    uint32_t data_types = (1u << SPA_DATA_DmaBuf) |
                          (1u << SPA_DATA_MemFd)  |
                          (1u << SPA_DATA_MemPtr);

    params[0] = (const struct spa_pod *)spa_pod_builder_add_object(
        &b,
        SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
        SPA_PARAM_BUFFERS_buffers,  SPA_POD_CHOICE_RANGE_Int(8, 4, 16),
        SPA_PARAM_BUFFERS_blocks,   SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int(data_types));

    params[1] = (const struct spa_pod *)spa_pod_builder_add_object(
        &b,
        SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
        SPA_PARAM_META_type, SPA_POD_Id(SPA_META_Header),
        SPA_PARAM_META_size, SPA_POD_Int(sizeof(struct spa_meta_header)));

    pw_stream_update_params(ctx->stream, params, 2);
}

static void on_stream_process(void *data)
{
    pw_capture_ctx_t *ctx = (pw_capture_ctx_t *)data;
    struct pw_buffer *pw_buf = NULL;
    struct pw_buffer *latest = NULL;

    /* Drain available buffers to keep only the freshest frame if compositor burst */
    while ((pw_buf = pw_stream_dequeue_buffer(ctx->stream)) != NULL) {
        if (latest) {
            pw_stream_queue_buffer(ctx->stream, latest);
        }
        latest = pw_buf;
    }

    if (!latest) {
        return;
    }

    uint64_t now_ns = monotonic_ns();
    if (ctx->next_frame_pts_ns != 0 && now_ns < ctx->next_frame_pts_ns) {
        /* Downpace at capture: immediately return skipped frame to PipeWire */
        pw_stream_queue_buffer(ctx->stream, latest);
        return;
    }

    if (ctx->next_frame_pts_ns == 0 ||
        now_ns - ctx->next_frame_pts_ns > ctx->frame_interval_ns * 2) {
        ctx->next_frame_pts_ns = now_ns + ctx->frame_interval_ns;
    } else {
        ctx->next_frame_pts_ns += ctx->frame_interval_ns;
    }

    struct spa_buffer *sbuf = latest->buffer;
    if (!ctx->format_valid || sbuf->n_datas == 0) {
        pw_stream_queue_buffer(ctx->stream, latest);
        return;
    }

    struct spa_data *d = &sbuf->datas[0];
    if (d->chunk && (d->chunk->flags & SPA_CHUNK_FLAG_CORRUPTED)) {
        pw_stream_queue_buffer(ctx->stream, latest);
        return;
    }

    uint32_t width  = ctx->video_info.size.width;
    uint32_t height = ctx->video_info.size.height;
    uint32_t stride = (d->chunk && d->chunk->stride > 0)
                          ? (uint32_t)d->chunk->stride
                          : width * 4u;
    size_t   size   = (d->chunk && d->chunk->size > 0)
                          ? (size_t)d->chunk->size
                          : (size_t)stride * height;

    capture_frame_t frame;
    memset(&frame, 0, sizeof(frame));
    frame.sequence          = ++ctx->seq;
    frame.timestamp_ns      = now_ns;
    frame.width             = width;
    frame.height            = height;
    frame.stride            = stride;
    frame.drm_format        = spa_format_to_drm_fourcc(ctx->video_info.format);
    frame.drm_modifier      = (uint32_t)(ctx->video_info.modifier & 0xffffffffULL);
    frame.drm_modifier_full = (uint64_t)ctx->video_info.modifier;
    frame.dma_fd            = -1;

    if (d->type == SPA_DATA_DmaBuf && d->fd >= 0) {
        frame.dma_fd   = (int)d->fd;
        frame.dma_size = (d->maxsize > 0) ? (size_t)d->maxsize : size;
        (void)pipeline_push(ctx->queue, &frame);
    } else if (d->type == SPA_DATA_MemPtr && d->data != NULL) {
        frame.mem_ptr  = (uint8_t *)d->data + (d->chunk ? d->chunk->offset : 0);
        frame.mem_size = size;
        (void)pipeline_push(ctx->queue, &frame);
    } else if (d->type == SPA_DATA_MemFd && d->fd >= 0) {
        size_t map_len = (d->maxsize > 0) ? (size_t)d->maxsize : size;
        void *mapped = mmap(NULL, map_len, PROT_READ, MAP_SHARED, (int)d->fd, d->mapoffset);
        if (mapped != MAP_FAILED) {
            frame.mem_ptr  = (uint8_t *)mapped + (d->chunk ? d->chunk->offset : 0);
            frame.mem_size = size;
            (void)pipeline_push(ctx->queue, &frame);
            munmap(mapped, map_len);
        }
    }

    /* Always return the buffer promptly to PipeWire; pipeline_push duplicated dma_fd */
    pw_stream_queue_buffer(ctx->stream, latest);
}

static const struct pw_core_events g_core_events = {
    PW_VERSION_CORE_EVENTS,
    .error = on_core_error,
};

static const struct pw_stream_events g_stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = on_stream_state_changed,
    .param_changed = on_stream_param_changed,
    .process       = on_stream_process,
};

pw_capture_ctx_t *pw_capture_create(const app_config_t *cfg, pipeline_queue_t *queue)
{
    if (!cfg || !queue) {
        return NULL;
    }
    pw_init(NULL, NULL);

    pw_capture_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) {
        return NULL;
    }
    ctx->cfg = cfg;
    ctx->queue = queue;
    ctx->frame_interval_ns = 1000000000ULL / (cfg->fps > 0 ? cfg->fps : 10);
    atomic_init(&ctx->stream_error, false);
    return ctx;
}

int pw_capture_start(pw_capture_ctx_t *ctx, int pw_fd, uint32_t node_id)
{
    if (!ctx || pw_fd < 0) {
        return -1;
    }

    pw_capture_stop(ctx);
    atomic_store_explicit(&ctx->stream_error, false, memory_order_relaxed);

    ctx->thread_loop = pw_thread_loop_new("capture-pw-loop", NULL);
    if (!ctx->thread_loop) {
        LOG_ERROR("pipewire", "pw_thread_loop_new failed");
        return -1;
    }

    ctx->context = pw_context_new(pw_thread_loop_get_loop(ctx->thread_loop), NULL, 0);
    if (!ctx->context) {
        LOG_ERROR("pipewire", "pw_context_new failed");
        pw_thread_loop_destroy(ctx->thread_loop);
        ctx->thread_loop = NULL;
        return -1;
    }

    if (pw_thread_loop_start(ctx->thread_loop) < 0) {
        LOG_ERROR("pipewire", "pw_thread_loop_start failed");
        pw_context_destroy(ctx->context);
        ctx->context = NULL;
        pw_thread_loop_destroy(ctx->thread_loop);
        ctx->thread_loop = NULL;
        return -1;
    }

    pw_thread_loop_lock(ctx->thread_loop);

    ctx->core = pw_context_connect_fd(ctx->context, pw_fd, NULL, 0);
    if (!ctx->core) {
        LOG_ERROR("pipewire", "pw_context_connect_fd failed");
        pw_thread_loop_unlock(ctx->thread_loop);
        pw_capture_stop(ctx);
        return -1;
    }

    pw_core_add_listener(ctx->core, &ctx->core_listener, &g_core_events, ctx);

    struct pw_properties *props = pw_properties_new(
        PW_KEY_MEDIA_TYPE,     "Video",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_MEDIA_ROLE,     "Screen",
        NULL);

    ctx->stream = pw_stream_new(ctx->core, "capture-app-screencast", props);
    if (!ctx->stream) {
        LOG_ERROR("pipewire", "pw_stream_new failed");
        pw_thread_loop_unlock(ctx->thread_loop);
        pw_capture_stop(ctx);
        return -1;
    }

    pw_stream_add_listener(ctx->stream, &ctx->stream_listener, &g_stream_events, ctx);

    uint8_t buf[2048];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof(buf));
    const struct spa_pod *params[2];

    struct spa_rectangle def_size = SPA_RECTANGLE(1920, 1080);
    struct spa_rectangle min_size = SPA_RECTANGLE(64, 64);
    struct spa_rectangle max_size = SPA_RECTANGLE(7680, 4320);
    struct spa_fraction  def_fps  = SPA_FRACTION(ctx->cfg->fps, 1);
    struct spa_fraction  min_fps  = SPA_FRACTION(0, 1);
    struct spa_fraction  max_fps  = SPA_FRACTION(120, 1);

    /* Pod 0: DMA-BUF format offer with explicit linear + Intel tiled modifiers */
    struct spa_pod_frame f_obj;
    struct spa_pod_frame f_mod;
    spa_pod_builder_push_object(&b, &f_obj, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat);
    spa_pod_builder_add(&b,
        SPA_FORMAT_mediaType,    SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(7,
            SPA_VIDEO_FORMAT_BGRx,
            SPA_VIDEO_FORMAT_BGRx,
            SPA_VIDEO_FORMAT_BGRA,
            SPA_VIDEO_FORMAT_NV12,
            SPA_VIDEO_FORMAT_I420,
            SPA_VIDEO_FORMAT_RGBx,
            SPA_VIDEO_FORMAT_RGBA),
        0);
    spa_pod_builder_prop(&b, SPA_FORMAT_VIDEO_modifier,
        SPA_POD_PROP_FLAG_MANDATORY | SPA_POD_PROP_FLAG_DONT_FIXATE);
    spa_pod_builder_push_choice(&b, &f_mod, SPA_CHOICE_Enum, 0);
    spa_pod_builder_long(&b, (int64_t)DRM_FORMAT_MOD_LINEAR);
    spa_pod_builder_long(&b, (int64_t)DRM_FORMAT_MOD_LINEAR);
    spa_pod_builder_long(&b, (int64_t)I915_FORMAT_MOD_X_TILED);
    spa_pod_builder_long(&b, (int64_t)I915_FORMAT_MOD_Y_TILED);
    spa_pod_builder_pop(&b, &f_mod);
    spa_pod_builder_add(&b,
        SPA_FORMAT_VIDEO_size,         SPA_POD_CHOICE_RANGE_Rectangle(&def_size, &min_size, &max_size),
        SPA_FORMAT_VIDEO_framerate,    SPA_POD_Fraction(&min_fps),
        SPA_FORMAT_VIDEO_maxFramerate, SPA_POD_CHOICE_RANGE_Fraction(&def_fps, &min_fps, &max_fps),
        0);
    params[0] = (const struct spa_pod *)spa_pod_builder_pop(&b, &f_obj);

    /* Pod 1: Fallback without modifier (allows MemPtr/SHM when DMA-BUF is unavailable) */
    params[1] = (const struct spa_pod *)spa_pod_builder_add_object(
        &b,
        SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
        SPA_FORMAT_mediaType,          SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype,       SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format,       SPA_POD_CHOICE_ENUM_Id(7,
            SPA_VIDEO_FORMAT_BGRx,
            SPA_VIDEO_FORMAT_BGRx,
            SPA_VIDEO_FORMAT_BGRA,
            SPA_VIDEO_FORMAT_NV12,
            SPA_VIDEO_FORMAT_I420,
            SPA_VIDEO_FORMAT_RGBx,
            SPA_VIDEO_FORMAT_RGBA),
        SPA_FORMAT_VIDEO_size,         SPA_POD_CHOICE_RANGE_Rectangle(&def_size, &min_size, &max_size),
        SPA_FORMAT_VIDEO_framerate,    SPA_POD_Fraction(&min_fps),
        SPA_FORMAT_VIDEO_maxFramerate, SPA_POD_CHOICE_RANGE_Fraction(&def_fps, &min_fps, &max_fps));

    int res = pw_stream_connect(
        ctx->stream,
        PW_DIRECTION_INPUT,
        node_id,
        (enum pw_stream_flags)(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS),
        params,
        2);

    pw_thread_loop_unlock(ctx->thread_loop);

    if (res < 0) {
        LOG_ERROR("pipewire", "pw_stream_connect failed: %d", res);
        pw_capture_stop(ctx);
        return -1;
    }

    ctx->running = true;
    LOG_INFO("pipewire", "PipeWire client connected to node %u (target %u fps)",
             node_id, ctx->cfg->fps);
    return 0;
}

bool pw_capture_has_error(pw_capture_ctx_t *ctx)
{
    if (!ctx) {
        return true;
    }
    return atomic_load_explicit(&ctx->stream_error, memory_order_relaxed);
}

void pw_capture_stop(pw_capture_ctx_t *ctx)
{
    if (!ctx) {
        return;
    }
    if (ctx->thread_loop) {
        pw_thread_loop_stop(ctx->thread_loop);
    }
    if (ctx->stream) {
        pw_stream_disconnect(ctx->stream);
        pw_stream_destroy(ctx->stream);
        ctx->stream = NULL;
    }
    if (ctx->core) {
        pw_core_disconnect(ctx->core);
        ctx->core = NULL;
    }
    if (ctx->context) {
        pw_context_destroy(ctx->context);
        ctx->context = NULL;
    }
    if (ctx->thread_loop) {
        pw_thread_loop_destroy(ctx->thread_loop);
        ctx->thread_loop = NULL;
    }
    ctx->running = false;
}

void pw_capture_destroy(pw_capture_ctx_t *ctx)
{
    if (!ctx) {
        return;
    }
    pw_capture_stop(ctx);
    free(ctx);
}
