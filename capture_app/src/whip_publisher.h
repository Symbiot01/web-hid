/*
 * whip_publisher.h - libdatachannel WHIP (WebRTC HTTP Ingestion Protocol) publisher.
 */
#ifndef CAPTURE_APP_WHIP_PUBLISHER_H
#define CAPTURE_APP_WHIP_PUBLISHER_H

#include "config.h"
#include "pipeline.h"
#include "vaapi_encoder.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum {
    WHIP_OK = 0,
    WHIP_ERR_UNREACHABLE = 3,
    WHIP_ERR_TLS_AUTH    = 1,
    WHIP_ERR_ABORTED     = -1
} whip_status_t;

typedef struct whip_publisher whip_publisher_t;

whip_publisher_t *whip_publisher_create(const app_config_t *cfg,
                                        pipeline_queue_t *queue,
                                        vaapi_encoder_t *encoder);

/*
 * Connects to the WHIP endpoint with exponential backoff up to
 * reconnect_max_attempts (0 = forever). Returns WHIP_OK on success,
 * WHIP_ERR_UNREACHABLE (3) if retries are exhausted, or WHIP_ERR_TLS_AUTH (1)
 * on invalid client/CA certificate.
 */
whip_status_t whip_publisher_connect_with_retry(whip_publisher_t *pub,
                                                volatile int *stop_flag);

bool whip_publisher_needs_reconnect(whip_publisher_t *pub);
int  whip_publisher_send_frame(whip_publisher_t *pub, const encoded_au_t *au);
void whip_publisher_disconnect(whip_publisher_t *pub);
void whip_publisher_destroy(whip_publisher_t *pub);

#endif /* CAPTURE_APP_WHIP_PUBLISHER_H */
