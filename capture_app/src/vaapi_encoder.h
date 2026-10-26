/*
 * vaapi_encoder.h - Hardware VA-API H.264 Annex B encoder (libva + libva-drm).
 */
#ifndef CAPTURE_APP_VAAPI_ENCODER_H
#define CAPTURE_APP_VAAPI_ENCODER_H

#include "config.h"
#include "pipeline.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct vaapi_encoder vaapi_encoder_t;

typedef struct {
    uint8_t *data;
    size_t   size;
    bool     is_keyframe;
    uint64_t timestamp_ns;
    double   encode_time_ms;
} encoded_au_t;

vaapi_encoder_t *vaapi_encoder_create(const app_config_t *cfg);
void             vaapi_encoder_request_keyframe(vaapi_encoder_t *enc);
int              vaapi_encoder_encode(vaapi_encoder_t *enc,
                                      const capture_frame_t *frame,
                                      encoded_au_t *out_au);
void             vaapi_encoder_destroy(vaapi_encoder_t *enc);

#endif /* CAPTURE_APP_VAAPI_ENCODER_H */
