/*
 * http.h - HTTPS helper for WHIP SDP offer POST and resource DELETE.
 */
#ifndef CAPTURE_APP_HTTP_H
#define CAPTURE_APP_HTTP_H

#include "config.h"
#include <stddef.h>

typedef struct {
    long status_code;
    char answer_sdp[16384];
    char location_url[512];
    char error_msg[256];
} whip_http_response_t;

int http_whip_post_offer(const app_config_t *cfg,
                         const char *offer_sdp,
                         whip_http_response_t *out_resp);

int http_whip_delete_resource(const app_config_t *cfg,
                              const char *resource_url);

int http_console_poll(const app_config_t *cfg,
                      int wait_sec,
                      bool *out_video_wanted,
                      bool *out_snap_wanted);

int http_console_post_status(const app_config_t *cfg,
                             bool streaming,
                             uint32_t fps,
                             uint32_t bitrate_kbps);

#endif /* CAPTURE_APP_HTTP_H */
