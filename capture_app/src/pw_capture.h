/*
 * pw_capture.h - libpipewire-0.3 ScreenCast consumer with DMA-BUF negotiation
 *                and MemPtr fallback.
 */
#ifndef CAPTURE_APP_PW_CAPTURE_H
#define CAPTURE_APP_PW_CAPTURE_H

#include "config.h"
#include "pipeline.h"
#include <stdbool.h>
#include <stdint.h>

typedef struct pw_capture_ctx pw_capture_ctx_t;

pw_capture_ctx_t *pw_capture_create(const app_config_t *cfg, pipeline_queue_t *queue);
int               pw_capture_start(pw_capture_ctx_t *ctx, int pw_fd, uint32_t node_id);
bool              pw_capture_has_error(pw_capture_ctx_t *ctx);
void              pw_capture_stop(pw_capture_ctx_t *ctx);
void              pw_capture_destroy(pw_capture_ctx_t *ctx);

#endif /* CAPTURE_APP_PW_CAPTURE_H */
