/*
 * portal.h - XDG Desktop Portal ScreenCast session handshake via libportal.
 */
#ifndef CAPTURE_APP_PORTAL_H
#define CAPTURE_APP_PORTAL_H

#include "config.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum {
    PORTAL_OK = 0,
    PORTAL_ERR_USER_DENIED = 2,
    PORTAL_ERR_BACKEND     = -1
} portal_status_t;

typedef struct portal_ctx portal_ctx_t;

portal_ctx_t   *portal_create(const app_config_t *cfg);
portal_status_t portal_start_session(portal_ctx_t *ctx,
                                     int *out_pw_fd,
                                     uint32_t *out_pw_node_id);
bool            portal_is_closed(portal_ctx_t *ctx);
void            portal_close_session(portal_ctx_t *ctx);
void            portal_destroy(portal_ctx_t *ctx);

#endif /* CAPTURE_APP_PORTAL_H */
