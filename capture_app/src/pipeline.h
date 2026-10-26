/*
 * pipeline.h - Bounded SPSC/thread-safe frame queue, drop policies, and atomic stats.
 */
#ifndef CAPTURE_APP_PIPELINE_H
#define CAPTURE_APP_PIPELINE_H

#include "config.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint64_t sequence;
    uint64_t timestamp_ns;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t drm_format;       /* DRM fourcc */
    uint32_t drm_modifier;     /* low 32 bits of DRM modifier */
    uint64_t drm_modifier_full;/* full 64-bit DRM modifier */
    int      dma_fd;           /* borrowed, dup'd on push, closed by consumer after encode */
    size_t   dma_size;
    void    *mem_ptr;          /* fallback path (heap copy owned by frame until release) */
    size_t   mem_size;
} capture_frame_t;

typedef struct {
    uint64_t captured;
    uint64_t encoded;
    uint64_t published;
    uint64_t dropped;
    uint64_t reconnect_count;
} pipeline_stats_t;

typedef struct pipeline_queue pipeline_queue_t;

pipeline_queue_t *pipeline_create(uint32_t capacity, drop_policy_t policy);
void              pipeline_destroy(pipeline_queue_t *q);
void              pipeline_stop(pipeline_queue_t *q);

/*
 * Pushes a frame into the bounded queue according to drop_policy.
 * If frame->dma_fd >= 0, pipeline_push() dup()s the descriptor so the
 * PipeWire producer can immediately return the pw_buffer via pw_stream_queue_buffer().
 * If frame->mem_ptr != NULL, pipeline_push() copies mem_size bytes into a frame buffer
 * freed by capture_frame_release().
 */
int  pipeline_push(pipeline_queue_t *q, const capture_frame_t *in_frame);

/*
 * Pops the next frame for encoding. Blocks up to timeout_ms (or returns -1 on stop/timeout).
 * Caller must call capture_frame_release(&frame) once VA-API encoding has finished.
 */
int  pipeline_pop(pipeline_queue_t *q, capture_frame_t *out_frame, int timeout_ms);

void capture_frame_release(capture_frame_t *frame);

void pipeline_inc_encoded(pipeline_queue_t *q);
void pipeline_inc_published(pipeline_queue_t *q);
void pipeline_inc_reconnect(pipeline_queue_t *q);
void pipeline_get_stats(pipeline_queue_t *q, pipeline_stats_t *out_stats);
void pipeline_log_stats(pipeline_queue_t *q);

#endif /* CAPTURE_APP_PIPELINE_H */
