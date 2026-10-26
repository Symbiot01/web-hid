/*
 * vaapi_encoder.c - VA-API H.264 Annex B encoder using libva + libva-drm.
 *
 * Features:
 *   - Opens DRM render node (/dev/dri/renderD128, with automatic fallback scan
 *     across /dev/dri/renderD128..renderD135 on hybrid iGPU+dGPU laptops).
 *   - Zero-copy DMA-BUF import via vaCreateSurfaces(VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2)
 *     + VA-API Video Processing (VPP) hardware scaling/CSC into NV12 encode surfaces,
 *     plus clean CPU/vaDeriveImage fallback when MemPtr/SHM buffers are used.
 *   - Encodes H.264 Main Profile (VAProfileH264Main) at configured bitrate and
 *     keyframe interval (GOP = keyframe_interval_sec * fps).
 *   - Outputs complete H.264 Annex B access units (00 00 00 01 start codes) with
 *     SPS + PPS + IDR at keyframes and P-slices in between.
 */
#define _POSIX_C_SOURCE 200809L

#include "vaapi_encoder.h"
#include "log.h"

#include <drm/drm_fourcc.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <va/va.h>
#include <va/va_drm.h>
#include <va/va_drmcommon.h>
#include <va/va_enc_h264.h>
#include <va/va_vpp.h>

#define NUM_RECON_SURFACES 2

struct vaapi_encoder {
    const app_config_t *cfg;
    int                 drm_fd;
    char                opened_node[256];
    VADisplay           va_dpy;
    VAEntrypoint        enc_entrypoint;
    VAConfigID          enc_config;
    VAContextID         enc_context;
    VASurfaceID         input_surface;
    VASurfaceID         recon_surfaces[NUM_RECON_SURFACES];
    VABufferID          coded_buf;

    bool                vpp_available;
    VAConfigID          vpp_config;
    VAContextID         vpp_context;

    uint32_t            width;
    uint32_t            height;
    uint32_t            mb_width;
    uint32_t            mb_height;
    uint32_t            aligned_width;
    uint32_t            aligned_height;
    uint32_t            gop_size;
    uint64_t            frame_count;
    uint16_t            idr_pic_id;
    atomic_bool         force_keyframe;

    uint8_t            *au_buf;
    size_t              au_cap;
};

/* Bitstream writer for H.264 RBSP SPS/PPS generation */
typedef struct {
    uint8_t data[256];
    size_t  bit_pos;
} bs_writer_t;

static void bs_init(bs_writer_t *bs)
{
    memset(bs, 0, sizeof(*bs));
}

static void bs_put_bit(bs_writer_t *bs, uint32_t bit)
{
    size_t byte_idx = bs->bit_pos >> 3;
    size_t bit_idx  = 7 - (bs->bit_pos & 7);
    if (byte_idx < sizeof(bs->data)) {
        if (bit & 1u) {
            bs->data[byte_idx] |= (uint8_t)(1u << bit_idx);
        }
        bs->bit_pos++;
    }
}

static void bs_put_bits(bs_writer_t *bs, uint32_t val, int nbits)
{
    for (int i = nbits - 1; i >= 0; --i) {
        bs_put_bit(bs, (val >> i) & 1u);
    }
}

static void bs_put_ue(bs_writer_t *bs, uint32_t val)
{
    uint32_t code = val + 1u;
    int leading_zeros = 0;
    uint32_t tmp = code;
    while (tmp > 1u) {
        tmp >>= 1;
        leading_zeros++;
    }
    for (int i = 0; i < leading_zeros; ++i) {
        bs_put_bit(bs, 0);
    }
    bs_put_bits(bs, code, leading_zeros + 1);
}

static void bs_put_se(bs_writer_t *bs, int32_t val)
{
    uint32_t code_num;
    if (val <= 0) {
        code_num = (uint32_t)(-2 * val);
    } else {
        code_num = (uint32_t)(2 * val - 1);
    }
    bs_put_ue(bs, code_num);
}

static void bs_rbsp_trailing(bs_writer_t *bs)
{
    bs_put_bit(bs, 1);
    while ((bs->bit_pos & 7) != 0) {
        bs_put_bit(bs, 0);
    }
}

static size_t write_annexb_nal(uint8_t *dst, size_t dst_cap,
                               uint8_t nal_header, const bs_writer_t *rbsp)
{
    size_t rbsp_bytes = rbsp->bit_pos >> 3;
    if (dst_cap < 5 + rbsp_bytes * 2) {
        return 0;
    }
    size_t out = 0;
    dst[out++] = 0x00;
    dst[out++] = 0x00;
    dst[out++] = 0x00;
    dst[out++] = 0x01;
    dst[out++] = nal_header;

    int zero_run = 0;
    for (size_t i = 0; i < rbsp_bytes; ++i) {
        uint8_t b = rbsp->data[i];
        if (zero_run == 2 && b <= 0x03) {
            dst[out++] = 0x03;
            zero_run = 0;
        }
        dst[out++] = b;
        if (b == 0x00) {
            zero_run++;
        } else {
            zero_run = 0;
        }
    }
    return out;
}

static size_t build_h264_sps_pps_annexb(const vaapi_encoder_t *enc,
                                        uint8_t *dst, size_t dst_cap)
{
    bs_writer_t sps;
    bs_init(&sps);

    /* profile_idc = 77 (Main), constraint_set1_flag = 1, level_idc = 41 */
    bs_put_bits(&sps, 77, 8);
    bs_put_bit(&sps, 0); /* constraint_set0_flag */
    bs_put_bit(&sps, 1); /* constraint_set1_flag */
    bs_put_bit(&sps, 0); /* constraint_set2_flag */
    bs_put_bit(&sps, 0); /* constraint_set3_flag */
    bs_put_bit(&sps, 0); /* constraint_set4_flag */
    bs_put_bit(&sps, 0); /* constraint_set5_flag */
    bs_put_bits(&sps, 0, 2);
    bs_put_bits(&sps, 41, 8);
    bs_put_ue(&sps, 0);  /* seq_parameter_set_id = 0 */

    bs_put_ue(&sps, 4);  /* log2_max_frame_num_minus4 = 4 */
    bs_put_ue(&sps, 0);  /* pic_order_cnt_type = 0 */
    bs_put_ue(&sps, 4);  /* log2_max_pic_order_cnt_lsb_minus4 = 4 */
    bs_put_ue(&sps, 1);  /* max_num_ref_frames = 1 */
    bs_put_bit(&sps, 0); /* gaps_in_frame_num_value_allowed_flag = 0 */

    bs_put_ue(&sps, enc->mb_width - 1);
    bs_put_ue(&sps, enc->mb_height - 1);
    bs_put_bit(&sps, 1); /* frame_mbs_only_flag = 1 */
    bs_put_bit(&sps, 1); /* direct_8x8_inference_flag = 1 */

    bool crop = (enc->aligned_width != enc->width) || (enc->aligned_height != enc->height);
    bs_put_bit(&sps, crop ? 1 : 0);
    if (crop) {
        bs_put_ue(&sps, 0);
        bs_put_ue(&sps, (enc->aligned_width - enc->width) / 2);
        bs_put_ue(&sps, 0);
        bs_put_ue(&sps, (enc->aligned_height - enc->height) / 2);
    }

    bs_put_bit(&sps, 1); /* vui_parameters_present_flag = 1 */
    bs_put_bit(&sps, 0); /* aspect_ratio_info_present_flag */
    bs_put_bit(&sps, 0); /* overscan_info_present_flag */
    bs_put_bit(&sps, 0); /* video_signal_type_present_flag */
    bs_put_bit(&sps, 0); /* chroma_loc_info_present_flag */
    bs_put_bit(&sps, 1); /* timing_info_present_flag */
    bs_put_bits(&sps, 1, 32);                 /* num_units_in_tick = 1 */
    bs_put_bits(&sps, enc->cfg->fps * 2, 32); /* time_scale = 2 * fps */
    bs_put_bit(&sps, 1);                      /* fixed_frame_rate_flag = 1 */
    bs_put_bit(&sps, 0); /* nal_hrd_parameters_present_flag */
    bs_put_bit(&sps, 0); /* vcl_hrd_parameters_present_flag */
    bs_put_bit(&sps, 0); /* pic_struct_present_flag */
    bs_put_bit(&sps, 0); /* bitstream_restriction_flag */
    bs_rbsp_trailing(&sps);

    bs_writer_t pps;
    bs_init(&pps);
    bs_put_ue(&pps, 0);  /* pic_parameter_set_id = 0 */
    bs_put_ue(&pps, 0);  /* seq_parameter_set_id = 0 */
    bs_put_bit(&pps, 1); /* entropy_coding_mode_flag = 1 (CABAC) */
    bs_put_bit(&pps, 0); /* bottom_field_pic_order_in_frame_present_flag = 0 */
    bs_put_ue(&pps, 0);  /* num_slice_groups_minus1 = 0 */
    bs_put_ue(&pps, 0);  /* num_ref_idx_l0_default_active_minus1 = 0 */
    bs_put_ue(&pps, 0);  /* num_ref_idx_l1_default_active_minus1 = 0 */
    bs_put_bit(&pps, 0); /* weighted_pred_flag = 0 */
    bs_put_bits(&pps, 0, 2); /* weighted_bipred_idc = 0 */
    bs_put_se(&pps, 0);  /* pic_init_qp_minus26 = 0 (QP 26) */
    bs_put_se(&pps, 0);  /* pic_init_qs_minus26 = 0 */
    bs_put_se(&pps, 0);  /* chroma_qp_index_offset = 0 */
    bs_put_bit(&pps, 1); /* deblocking_filter_control_present_flag = 1 */
    bs_put_bit(&pps, 0); /* constrained_intra_pred_flag = 0 */
    bs_put_bit(&pps, 0); /* redundant_pic_cnt_present_flag = 0 */
    bs_rbsp_trailing(&pps);

    size_t off = 0;
    off += write_annexb_nal(dst + off, dst_cap - off, 0x67, &sps); /* NAL ref=3, type=7 (SPS) */
    off += write_annexb_nal(dst + off, dst_cap - off, 0x68, &pps); /* NAL ref=3, type=8 (PPS) */
    return off;
}

static uint64_t monotonic_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int try_open_va_device(vaapi_encoder_t *enc, const char *node_path)
{
    int fd = open(node_path, O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        return -1;
    }
    VADisplay dpy = vaGetDisplayDRM(fd);
    if (!dpy) {
        close(fd);
        return -1;
    }
    int maj = 0, min = 0;
    VAStatus st = vaInitialize(dpy, &maj, &min);
    if (st != VA_STATUS_SUCCESS) {
        close(fd);
        return -1;
    }

    VAEntrypoint eps[16];
    int num_eps = 0;
    st = vaQueryConfigEntrypoints(dpy, VAProfileH264Main, eps, &num_eps);
    if (st != VA_STATUS_SUCCESS || num_eps <= 0) {
        vaTerminate(dpy);
        close(fd);
        return -1;
    }

    VAEntrypoint chosen = (VAEntrypoint)0;
    for (int i = 0; i < num_eps; ++i) {
        if (eps[i] == VAEntrypointEncSlice) {
            chosen = VAEntrypointEncSlice;
            break;
        }
    }
    if (chosen == 0) {
        for (int i = 0; i < num_eps; ++i) {
            if (eps[i] == VAEntrypointEncSliceLP) {
                chosen = VAEntrypointEncSliceLP;
                break;
            }
        }
    }
    if (chosen == 0) {
        vaTerminate(dpy);
        close(fd);
        return -1;
    }

    enc->drm_fd         = fd;
    enc->va_dpy         = dpy;
    enc->enc_entrypoint = chosen;
    snprintf(enc->opened_node, sizeof(enc->opened_node), "%s", node_path);

    /* Probe optional VPP support for zero-copy DMA-BUF BGRx -> NV12 conversion */
    num_eps = 0;
    if (vaQueryConfigEntrypoints(dpy, VAProfileNone, eps, &num_eps) == VA_STATUS_SUCCESS) {
        for (int i = 0; i < num_eps; ++i) {
            if (eps[i] == VAEntrypointVideoProc) {
                if (vaCreateConfig(dpy, VAProfileNone, VAEntrypointVideoProc,
                                   NULL, 0, &enc->vpp_config) == VA_STATUS_SUCCESS) {
                    enc->vpp_available = true;
                }
                break;
            }
        }
    }

    LOG_INFO("vaapi", "VAAPI encoder initialized on %s (VA %d.%d, vendor='%s', entrypoint=%d, vpp=%s)",
             node_path, maj, min, vaQueryVendorString(dpy),
             (int)chosen, enc->vpp_available ? "yes" : "no");
    return 0;
}

vaapi_encoder_t *vaapi_encoder_create(const app_config_t *cfg)
{
    if (!cfg) {
        return NULL;
    }
    vaapi_encoder_t *enc = calloc(1, sizeof(*enc));
    if (!enc) {
        return NULL;
    }
    enc->cfg           = cfg;
    enc->drm_fd        = -1;
    enc->enc_config    = VA_INVALID_ID;
    enc->enc_context   = VA_INVALID_ID;
    enc->input_surface = VA_INVALID_SURFACE;
    for (int i = 0; i < NUM_RECON_SURFACES; ++i) {
        enc->recon_surfaces[i] = VA_INVALID_SURFACE;
    }
    enc->coded_buf     = VA_INVALID_ID;
    enc->vpp_config    = VA_INVALID_ID;
    enc->vpp_context   = VA_INVALID_ID;
    enc->gop_size      = cfg->keyframe_interval_sec * cfg->fps;
    if (enc->gop_size < 1) {
        enc->gop_size = 10;
    }
    atomic_init(&enc->force_keyframe, true);

    /* Try configured render node first (/dev/dri/renderD128), then scan renderD128..135 */
    if (try_open_va_device(enc, cfg->render_node) != 0) {
        bool opened = false;
        for (int idx = 128; idx <= 135; ++idx) {
            char candidate[64];
            snprintf(candidate, sizeof(candidate), "/dev/dri/renderD%d", idx);
            if (strcmp(candidate, cfg->render_node) == 0) {
                continue;
            }
            if (try_open_va_device(enc, candidate) == 0) {
                opened = true;
                break;
            }
        }
        if (!opened) {
            LOG_ERROR("vaapi", "failed to initialize VA-API H.264 encoder on %s or fallback render nodes",
                      cfg->render_node);
            free(enc);
            return NULL;
        }
    }

    VAConfigAttrib attribs[2];
    memset(attribs, 0, sizeof(attribs));
    attribs[0].type  = VAConfigAttribRTFormat;
    attribs[0].value = VA_RT_FORMAT_YUV420;
    attribs[1].type  = VAConfigAttribRateControl;
    attribs[1].value = VA_RC_CBR;

    VAStatus st = vaCreateConfig(enc->va_dpy, VAProfileH264Main, enc->enc_entrypoint,
                                 attribs, 2, &enc->enc_config);
    if (st != VA_STATUS_SUCCESS) {
        /* Fallback to CQP if driver does not advertise CBR on this entrypoint */
        attribs[1].value = VA_RC_CQP;
        st = vaCreateConfig(enc->va_dpy, VAProfileH264Main, enc->enc_entrypoint,
                            attribs, 2, &enc->enc_config);
    }
    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaCreateConfig failed: %s", vaErrorStr(st));
        vaapi_encoder_destroy(enc);
        return NULL;
    }

    enc->au_cap = 2 * 1024 * 1024;
    enc->au_buf = malloc(enc->au_cap);
    if (!enc->au_buf) {
        vaapi_encoder_destroy(enc);
        return NULL;
    }

    return enc;
}

static void destroy_resolution_resources(vaapi_encoder_t *enc)
{
    if (!enc || !enc->va_dpy) {
        return;
    }
    if (enc->coded_buf != VA_INVALID_ID) {
        vaDestroyBuffer(enc->va_dpy, enc->coded_buf);
        enc->coded_buf = VA_INVALID_ID;
    }
    if (enc->enc_context != VA_INVALID_ID) {
        vaDestroyContext(enc->va_dpy, enc->enc_context);
        enc->enc_context = VA_INVALID_ID;
    }
    if (enc->vpp_context != VA_INVALID_ID) {
        vaDestroyContext(enc->va_dpy, enc->vpp_context);
        enc->vpp_context = VA_INVALID_ID;
    }
    if (enc->input_surface != VA_INVALID_SURFACE) {
        vaDestroySurfaces(enc->va_dpy, &enc->input_surface, 1);
        enc->input_surface = VA_INVALID_SURFACE;
    }
    for (int i = 0; i < NUM_RECON_SURFACES; ++i) {
        if (enc->recon_surfaces[i] != VA_INVALID_SURFACE) {
            vaDestroySurfaces(enc->va_dpy, &enc->recon_surfaces[i], 1);
            enc->recon_surfaces[i] = VA_INVALID_SURFACE;
        }
    }
}

static int ensure_resolution_context(vaapi_encoder_t *enc, uint32_t width, uint32_t height)
{
    if (width == 0 || height == 0) {
        return -1;
    }
    /* H.264 YUV420 requires even dimensions */
    width  &= ~1u;
    height &= ~1u;

    if (enc->enc_context != VA_INVALID_ID &&
        enc->width == width && enc->height == height) {
        return 0;
    }

    destroy_resolution_resources(enc);

    enc->width          = width;
    enc->height         = height;
    enc->mb_width       = (width + 15u) / 16u;
    enc->mb_height      = (height + 15u) / 16u;
    enc->aligned_width  = enc->mb_width * 16u;
    enc->aligned_height = enc->mb_height * 16u;
    enc->frame_count    = 0;

    VASurfaceAttrib sattr;
    memset(&sattr, 0, sizeof(sattr));
    sattr.type          = VASurfaceAttribPixelFormat;
    sattr.flags         = VA_SURFACE_ATTRIB_SETTABLE;
    sattr.value.type    = VAGenericValueTypeInteger;
    sattr.value.value.i = VA_FOURCC_NV12;

    VAStatus st = vaCreateSurfaces(enc->va_dpy, VA_RT_FORMAT_YUV420,
                                   enc->aligned_width, enc->aligned_height,
                                   &enc->input_surface, 1, &sattr, 1);
    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaCreateSurfaces(input) failed: %s", vaErrorStr(st));
        return -1;
    }

    st = vaCreateSurfaces(enc->va_dpy, VA_RT_FORMAT_YUV420,
                          enc->aligned_width, enc->aligned_height,
                          enc->recon_surfaces, NUM_RECON_SURFACES, &sattr, 1);
    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaCreateSurfaces(recon) failed: %s", vaErrorStr(st));
        destroy_resolution_resources(enc);
        return -1;
    }

    VASurfaceID all_targets[1 + NUM_RECON_SURFACES];
    all_targets[0] = enc->input_surface;
    for (int i = 0; i < NUM_RECON_SURFACES; ++i) {
        all_targets[1 + i] = enc->recon_surfaces[i];
    }

    st = vaCreateContext(enc->va_dpy, enc->enc_config,
                         (int)enc->aligned_width, (int)enc->aligned_height,
                         VA_PROGRESSIVE, all_targets, 1 + NUM_RECON_SURFACES,
                         &enc->enc_context);
    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaCreateContext(encode) failed: %s", vaErrorStr(st));
        destroy_resolution_resources(enc);
        return -1;
    }

    uint32_t coded_sz = enc->aligned_width * enc->aligned_height;
    if (coded_sz < 262144u) {
        coded_sz = 262144u;
    }
    st = vaCreateBuffer(enc->va_dpy, enc->enc_context, VAEncCodedBufferType,
                        coded_sz, 1, NULL, &enc->coded_buf);
    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaCreateBuffer(coded_buf) failed: %s", vaErrorStr(st));
        destroy_resolution_resources(enc);
        return -1;
    }

    if (enc->vpp_available && enc->vpp_config != VA_INVALID_ID) {
        if (vaCreateContext(enc->va_dpy, enc->vpp_config,
                            (int)enc->aligned_width, (int)enc->aligned_height,
                            VA_PROGRESSIVE, &enc->input_surface, 1,
                            &enc->vpp_context) != VA_STATUS_SUCCESS) {
            enc->vpp_context = VA_INVALID_ID;
        }
    }

    LOG_INFO("vaapi", "configured H.264 context: %ux%u (aligned %ux%u), bitrate=%u kbps, gop=%u",
             enc->width, enc->height, enc->aligned_width, enc->aligned_height,
             enc->cfg->bitrate_kbps, enc->gop_size);
    return 0;
}

static uint32_t drm_fourcc_to_va_fourcc(uint32_t drm_fmt)
{
    switch (drm_fmt) {
    case DRM_FORMAT_XRGB8888: return VA_FOURCC_BGRX;
    case DRM_FORMAT_ARGB8888: return VA_FOURCC_BGRA;
    case DRM_FORMAT_XBGR8888: return VA_FOURCC_RGBX;
    case DRM_FORMAT_ABGR8888: return VA_FOURCC_RGBA;
    case DRM_FORMAT_NV12:     return VA_FOURCC_NV12;
    default:                  return VA_FOURCC_BGRX;
    }
}

/*
 * Zero-copy DMA-BUF import via VASurfaceAttribExternalBuffers / DRM_PRIME_2
 * followed by hardware VPP blit into the NV12 encode surface.
 */
static int import_dmabuf_via_vpp(vaapi_encoder_t *enc, const capture_frame_t *frame)
{
    if (frame->dma_fd < 0 || enc->vpp_context == VA_INVALID_ID) {
        return -1;
    }

    VADRMPRIMESurfaceDescriptor prime_desc;
    memset(&prime_desc, 0, sizeof(prime_desc));
    prime_desc.fourcc      = drm_fourcc_to_va_fourcc(frame->drm_format);
    prime_desc.width       = frame->width;
    prime_desc.height      = frame->height;
    prime_desc.num_objects = 1;
    prime_desc.objects[0].fd                  = frame->dma_fd;
    prime_desc.objects[0].size                = (uint32_t)(frame->dma_size > 0
                                                    ? frame->dma_size
                                                    : (size_t)frame->stride * frame->height);
    prime_desc.objects[0].drm_format_modifier = frame->drm_modifier_full;

    prime_desc.num_layers = 1;
    prime_desc.layers[0].drm_format      = frame->drm_format;
    prime_desc.layers[0].num_planes      = 1;
    prime_desc.layers[0].object_index[0] = 0;
    prime_desc.layers[0].offset[0]       = 0;
    prime_desc.layers[0].pitch[0]        = frame->stride;

    VASurfaceAttrib attribs[2];
    memset(attribs, 0, sizeof(attribs));
    attribs[0].type          = VASurfaceAttribMemoryType;
    attribs[0].flags         = VA_SURFACE_ATTRIB_SETTABLE;
    attribs[0].value.type    = VAGenericValueTypeInteger;
    attribs[0].value.value.i = VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2;

    attribs[1].type          = VASurfaceAttribExternalBufferDescriptor;
    attribs[1].flags         = VA_SURFACE_ATTRIB_SETTABLE;
    attribs[1].value.type    = VAGenericValueTypePointer;
    attribs[1].value.value.p = &prime_desc;

    unsigned int rt_fmt = (frame->drm_format == DRM_FORMAT_NV12)
                              ? VA_RT_FORMAT_YUV420
                              : VA_RT_FORMAT_RGB32;

    VASurfaceID imported = VA_INVALID_SURFACE;
    VAStatus st = vaCreateSurfaces(enc->va_dpy, rt_fmt,
                                   frame->width, frame->height,
                                   &imported, 1, attribs, 2);
    if (st != VA_STATUS_SUCCESS) {
        return -1;
    }

    VAProcPipelineParameterBuffer vpp_param;
    memset(&vpp_param, 0, sizeof(vpp_param));
    vpp_param.surface = imported;
    vpp_param.surface_color_standard = VAProcColorStandardSRGB;
    vpp_param.output_color_standard  = VAProcColorStandardBT709;

    VABufferID vpp_buf = VA_INVALID_ID;
    st = vaCreateBuffer(enc->va_dpy, enc->vpp_context,
                        VAProcPipelineParameterBufferType,
                        sizeof(vpp_param), 1, &vpp_param, &vpp_buf);
    if (st != VA_STATUS_SUCCESS) {
        vaDestroySurfaces(enc->va_dpy, &imported, 1);
        return -1;
    }

    int rc = -1;
    if (vaBeginPicture(enc->va_dpy, enc->vpp_context, enc->input_surface) == VA_STATUS_SUCCESS) {
        if (vaRenderPicture(enc->va_dpy, enc->vpp_context, &vpp_buf, 1) == VA_STATUS_SUCCESS) {
            if (vaEndPicture(enc->va_dpy, enc->vpp_context) == VA_STATUS_SUCCESS) {
                rc = 0;
            }
        } else {
            (void)vaEndPicture(enc->va_dpy, enc->vpp_context);
        }
    }

    vaDestroyBuffer(enc->va_dpy, vpp_buf);
    vaDestroySurfaces(enc->va_dpy, &imported, 1);
    return rc;
}

/*
 * Fallback path: converts BGRx/RGBx or copies NV12 from MemPtr into the
 * VA-API input_surface via vaDeriveImage + vaMapBuffer.
 */
static int upload_frame_via_derive_image(vaapi_encoder_t *enc, const capture_frame_t *frame)
{
    VAImage img;
    memset(&img, 0, sizeof(img));
    VAStatus st = vaDeriveImage(enc->va_dpy, enc->input_surface, &img);
    if (st != VA_STATUS_SUCCESS) {
        return -1;
    }

    uint8_t *dst_base = NULL;
    st = vaMapBuffer(enc->va_dpy, img.buf, (void **)&dst_base);
    if (st != VA_STATUS_SUCCESS || !dst_base) {
        vaDestroyImage(enc->va_dpy, img.image_id);
        return -1;
    }

    uint8_t *y_plane  = dst_base + img.offsets[0];
    uint8_t *uv_plane = dst_base + img.offsets[1];
    uint32_t y_pitch  = img.pitches[0];
    uint32_t uv_pitch = img.pitches[1];

    if (frame->mem_ptr && frame->mem_size > 0) {
        const uint8_t *src = (const uint8_t *)frame->mem_ptr;
        uint32_t w = (frame->width < enc->width) ? frame->width : enc->width;
        uint32_t h = (frame->height < enc->height) ? frame->height : enc->height;

        if (frame->drm_format == DRM_FORMAT_NV12) {
            for (uint32_t r = 0; r < h; ++r) {
                memcpy(y_plane + (size_t)r * y_pitch, src + (size_t)r * frame->stride, w);
            }
            const uint8_t *src_uv = src + (size_t)frame->stride * frame->height;
            for (uint32_t r = 0; r < h / 2; ++r) {
                memcpy(uv_plane + (size_t)r * uv_pitch, src_uv + (size_t)r * frame->stride, w);
            }
        } else {
            /* Fast BT.601 integer BGRx -> NV12 conversion */
            for (uint32_t r = 0; r < h; r += 2) {
                const uint8_t *row0 = src + (size_t)r * frame->stride;
                const uint8_t *row1 = src + (size_t)(r + 1) * frame->stride;
                uint8_t *dy0 = y_plane + (size_t)r * y_pitch;
                uint8_t *dy1 = y_plane + (size_t)(r + 1) * y_pitch;
                uint8_t *duv = uv_plane + (size_t)(r / 2) * uv_pitch;

                for (uint32_t c = 0; c < w; c += 2) {
                    uint32_t b00 = row0[c * 4 + 0], g00 = row0[c * 4 + 1], r00 = row0[c * 4 + 2];
                    uint32_t b01 = row0[(c + 1) * 4 + 0], g01 = row0[(c + 1) * 4 + 1], r01 = row0[(c + 1) * 4 + 2];
                    uint32_t b10 = row1[c * 4 + 0], g10 = row1[c * 4 + 1], r10 = row1[(c + 1) * 4 - 2];
                    uint32_t b11 = row1[(c + 1) * 4 + 0], g11 = row1[(c + 1) * 4 + 1], r11 = row1[(c + 1) * 4 + 2];

                    dy0[c]     = (uint8_t)(((66 * r00 + 129 * g00 + 25 * b00 + 128) >> 8) + 16);
                    dy0[c + 1] = (uint8_t)(((66 * r01 + 129 * g01 + 25 * b01 + 128) >> 8) + 16);
                    dy1[c]     = (uint8_t)(((66 * r10 + 129 * g10 + 25 * b10 + 128) >> 8) + 16);
                    dy1[c + 1] = (uint8_t)(((66 * r11 + 129 * g11 + 25 * b11 + 128) >> 8) + 16);

                    int32_t r_avg = (int32_t)((r00 + r01 + r10 + r11) >> 2);
                    int32_t g_avg = (int32_t)((g00 + g01 + g10 + g11) >> 2);
                    int32_t b_avg = (int32_t)((b00 + b01 + b10 + b11) >> 2);

                    duv[c]     = (uint8_t)(((-38 * r_avg - 74 * g_avg + 112 * b_avg + 128) >> 8) + 128);
                    duv[c + 1] = (uint8_t)(((112 * r_avg - 94 * g_avg - 18 * b_avg + 128) >> 8) + 128);
                }
            }
        }
    } else {
        /* Pattern fill if neither DMA-BUF nor MemPtr succeeded */
        uint8_t luma = (uint8_t)(16 + (enc->frame_count * 3) % 200);
        for (uint32_t r = 0; r < enc->height; ++r) {
            memset(y_plane + (size_t)r * y_pitch, luma, enc->width);
        }
        for (uint32_t r = 0; r < enc->height / 2; ++r) {
            memset(uv_plane + (size_t)r * uv_pitch, 128, enc->width);
        }
    }

    vaUnmapBuffer(enc->va_dpy, img.buf);
    vaDestroyImage(enc->va_dpy, img.image_id);
    return 0;
}

void vaapi_encoder_request_keyframe(vaapi_encoder_t *enc)
{
    if (enc) {
        atomic_store_explicit(&enc->force_keyframe, true, memory_order_relaxed);
    }
}

int vaapi_encoder_encode(vaapi_encoder_t *enc,
                         const capture_frame_t *frame,
                         encoded_au_t *out_au)
{
    if (!enc || !frame || !out_au) {
        return -1;
    }

    uint64_t t0_ns = monotonic_ns();

    if (ensure_resolution_context(enc, frame->width, frame->height) != 0) {
        return -1;
    }

    if (import_dmabuf_via_vpp(enc, frame) != 0) {
        if (upload_frame_via_derive_image(enc, frame) != 0) {
            LOG_ERROR("vaapi", "failed to import or upload frame %" PRIu64, frame->sequence);
            return -1;
        }
    }

    bool is_idr = (enc->frame_count % enc->gop_size == 0) ||
                  atomic_exchange_explicit(&enc->force_keyframe, false, memory_order_relaxed);

    if (is_idr) {
        enc->frame_count = 0;
        enc->idr_pic_id++;
    }

    uint32_t frame_num = (uint32_t)(enc->frame_count % 256u);
    uint16_t poc_lsb   = (uint16_t)((enc->frame_count * 2u) % 256u);

    VASurfaceID curr_recon = enc->recon_surfaces[enc->frame_count % NUM_RECON_SURFACES];
    VASurfaceID prev_recon = enc->recon_surfaces[(enc->frame_count + 1) % NUM_RECON_SURFACES];

    VABufferID param_bufs[6];
    int num_bufs = 0;

    if (is_idr) {
        VAEncSequenceParameterBufferH264 seq;
        memset(&seq, 0, sizeof(seq));
        seq.seq_parameter_set_id = 0;
        seq.level_idc            = 41;
        seq.intra_period         = enc->gop_size;
        seq.intra_idr_period     = enc->gop_size;
        seq.ip_period            = 1;
        seq.bits_per_second      = enc->cfg->bitrate_kbps * 1000u;
        seq.max_num_ref_frames   = 1;
        seq.picture_width_in_mbs  = (uint16_t)enc->mb_width;
        seq.picture_height_in_mbs = (uint16_t)enc->mb_height;
        seq.seq_fields.bits.chroma_format_idc                 = 1;
        seq.seq_fields.bits.frame_mbs_only_flag               = 1;
        seq.seq_fields.bits.direct_8x8_inference_flag         = 1;
        seq.seq_fields.bits.log2_max_frame_num_minus4         = 4;
        seq.seq_fields.bits.pic_order_cnt_type                = 0;
        seq.seq_fields.bits.log2_max_pic_order_cnt_lsb_minus4 = 4;
        if (enc->aligned_width != enc->width || enc->aligned_height != enc->height) {
            seq.frame_cropping_flag      = 1;
            seq.frame_crop_right_offset  = (enc->aligned_width - enc->width) / 2;
            seq.frame_crop_bottom_offset = (enc->aligned_height - enc->height) / 2;
        }
        seq.vui_parameters_present_flag               = 1;
        seq.vui_fields.bits.timing_info_present_flag  = 1;
        seq.vui_fields.bits.fixed_frame_rate_flag     = 1;
        seq.num_units_in_tick                         = 1;
        seq.time_scale                                = enc->cfg->fps * 2u;

        if (vaCreateBuffer(enc->va_dpy, enc->enc_context,
                           VAEncSequenceParameterBufferType,
                           sizeof(seq), 1, &seq, &param_bufs[num_bufs]) == VA_STATUS_SUCCESS) {
            num_bufs++;
        }
    }

    VAEncPictureParameterBufferH264 pic;
    memset(&pic, 0, sizeof(pic));
    pic.CurrPic.picture_id          = curr_recon;
    pic.CurrPic.frame_idx           = frame_num;
    pic.CurrPic.flags               = 0;
    pic.CurrPic.TopFieldOrderCnt    = poc_lsb;
    pic.CurrPic.BottomFieldOrderCnt = poc_lsb;

    for (int i = 0; i < 16; ++i) {
        pic.ReferenceFrames[i].picture_id = VA_INVALID_SURFACE;
        pic.ReferenceFrames[i].flags      = VA_PICTURE_H264_INVALID;
    }
    if (!is_idr) {
        pic.ReferenceFrames[0].picture_id          = prev_recon;
        pic.ReferenceFrames[0].frame_idx           = (frame_num > 0) ? (frame_num - 1) : 0;
        pic.ReferenceFrames[0].flags               = VA_PICTURE_H264_SHORT_TERM_REFERENCE;
        pic.ReferenceFrames[0].TopFieldOrderCnt    = (int32_t)(poc_lsb - 2);
        pic.ReferenceFrames[0].BottomFieldOrderCnt = (int32_t)(poc_lsb - 2);
    }

    pic.coded_buf                                           = enc->coded_buf;
    pic.pic_parameter_set_id                                = 0;
    pic.seq_parameter_set_id                                = 0;
    pic.frame_num                                           = (uint16_t)frame_num;
    pic.pic_init_qp                                         = 26;
    pic.num_ref_idx_l0_active_minus1                        = 0;
    pic.num_ref_idx_l1_active_minus1                        = 0;
    pic.pic_fields.bits.idr_pic_flag                        = is_idr ? 1 : 0;
    pic.pic_fields.bits.reference_pic_flag                  = 1;
    pic.pic_fields.bits.entropy_coding_mode_flag            = 1;
    pic.pic_fields.bits.deblocking_filter_control_present_flag = 1;

    if (vaCreateBuffer(enc->va_dpy, enc->enc_context,
                       VAEncPictureParameterBufferType,
                       sizeof(pic), 1, &pic, &param_bufs[num_bufs]) == VA_STATUS_SUCCESS) {
        num_bufs++;
    }

    VAEncSliceParameterBufferH264 slice;
    memset(&slice, 0, sizeof(slice));
    slice.macroblock_address   = 0;
    slice.num_macroblocks      = enc->mb_width * enc->mb_height;
    slice.macroblock_info      = VA_INVALID_ID;
    slice.slice_type           = is_idr ? 2 : 0; /* 2 = I-slice, 0 = P-slice */
    slice.pic_parameter_set_id = 0;
    slice.idr_pic_id           = enc->idr_pic_id;
    slice.pic_order_cnt_lsb    = poc_lsb;

    for (int i = 0; i < 32; ++i) {
        slice.RefPicList0[i].picture_id = VA_INVALID_SURFACE;
        slice.RefPicList0[i].flags      = VA_PICTURE_H264_INVALID;
        slice.RefPicList1[i].picture_id = VA_INVALID_SURFACE;
        slice.RefPicList1[i].flags      = VA_PICTURE_H264_INVALID;
    }
    if (!is_idr) {
        slice.RefPicList0[0] = pic.ReferenceFrames[0];
    }

    if (vaCreateBuffer(enc->va_dpy, enc->enc_context,
                       VAEncSliceParameterBufferType,
                       sizeof(slice), 1, &slice, &param_bufs[num_bufs]) == VA_STATUS_SUCCESS) {
        num_bufs++;
    }

    /* Submit picture with EAGAIN retry handling */
    VAStatus st = VA_STATUS_ERROR_UNKNOWN;
    for (int attempt = 0; attempt < 5; ++attempt) {
        st = vaBeginPicture(enc->va_dpy, enc->enc_context, enc->input_surface);
        if (st == VA_STATUS_SUCCESS) {
            break;
        }
        struct timespec req = { .tv_sec = 0, .tv_nsec = 2000000L };
        nanosleep(&req, NULL);
    }
    if (st != VA_STATUS_SUCCESS) {
        for (int i = 0; i < num_bufs; ++i) {
            vaDestroyBuffer(enc->va_dpy, param_bufs[i]);
        }
        LOG_ERROR("vaapi", "vaBeginPicture failed: %s", vaErrorStr(st));
        return -1;
    }

    st = vaRenderPicture(enc->va_dpy, enc->enc_context, param_bufs, num_bufs);
    if (st == VA_STATUS_SUCCESS) {
        st = vaEndPicture(enc->va_dpy, enc->enc_context);
    } else {
        (void)vaEndPicture(enc->va_dpy, enc->enc_context);
    }

    for (int i = 0; i < num_bufs; ++i) {
        vaDestroyBuffer(enc->va_dpy, param_bufs[i]);
    }

    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaRenderPicture/vaEndPicture failed: %s", vaErrorStr(st));
        return -1;
    }

    st = vaSyncSurface(enc->va_dpy, enc->input_surface);
    if (st != VA_STATUS_SUCCESS) {
        LOG_ERROR("vaapi", "vaSyncSurface failed: %s", vaErrorStr(st));
        return -1;
    }

    VACodedBufferSegment *seg = NULL;
    st = vaMapBuffer(enc->va_dpy, enc->coded_buf, (void **)&seg);
    if (st != VA_STATUS_SUCCESS || !seg) {
        LOG_ERROR("vaapi", "vaMapBuffer(coded_buf) failed: %s", vaErrorStr(st));
        return -1;
    }

    size_t out_off = 0;
    if (is_idr) {
        out_off += build_h264_sps_pps_annexb(enc, enc->au_buf, enc->au_cap);
    }

    for (const VACodedBufferSegment *cur = seg; cur != NULL; cur = (const VACodedBufferSegment *)cur->next) {
        if (cur->buf && cur->size > 0 && out_off + cur->size + 1 <= enc->au_cap) {
            const uint8_t *b = (const uint8_t *)cur->buf;
            /* Ensure 4-byte 00 00 00 01 start code prefix for downstream RTP packetizer */
            if (cur->size >= 3 && b[0] == 0x00 && b[1] == 0x00 && b[2] == 0x01) {
                enc->au_buf[out_off++] = 0x00;
            }
            memcpy(enc->au_buf + out_off, cur->buf, cur->size);
            out_off += cur->size;
        }
    }

    vaUnmapBuffer(enc->va_dpy, enc->coded_buf);

    enc->frame_count++;
    uint64_t t1_ns = monotonic_ns();
    double elapsed_ms = (double)(t1_ns - t0_ns) / 1000000.0;

    out_au->data           = enc->au_buf;
    out_au->size           = out_off;
    out_au->is_keyframe    = is_idr;
    out_au->timestamp_ns   = frame->timestamp_ns;
    out_au->encode_time_ms = elapsed_ms;

    LOG_DEBUG("vaapi", "encoded frame %" PRIu64 " (%s, %zu bytes) in %.2f ms",
              enc->frame_count, is_idr ? "IDR" : "P", out_off, elapsed_ms);
    return 0;
}

void vaapi_encoder_destroy(vaapi_encoder_t *enc)
{
    if (!enc) {
        return;
    }
    destroy_resolution_resources(enc);
    if (enc->va_dpy) {
        if (enc->enc_config != VA_INVALID_ID) {
            vaDestroyConfig(enc->va_dpy, enc->enc_config);
        }
        if (enc->vpp_config != VA_INVALID_ID) {
            vaDestroyConfig(enc->va_dpy, enc->vpp_config);
        }
        vaTerminate(enc->va_dpy);
        enc->va_dpy = NULL;
    }
    if (enc->drm_fd >= 0) {
        close(enc->drm_fd);
        enc->drm_fd = -1;
    }
    free(enc->au_buf);
    free(enc);
}
