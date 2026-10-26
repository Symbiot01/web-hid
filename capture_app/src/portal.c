/*
 * portal.c - XDG Desktop Portal ScreenCast handshake using libportal.
 *
 * Implements the full D-Bus ScreenCast portal workflow:
 *   1. CreateSession + SelectSources (XDP_OUTPUT_MONITOR, XDP_CURSOR_MODE_EMBEDDED,
 *      XDP_PERSIST_MODE_PERSISTENT with optional restore_token)
 *   2. Start (triggers desktop user consent dialog if no valid restore_token)
 *   3. Extracts PipeWire node_id from xdp_session_get_streams() and opens the
 *      authenticated PipeWire remote fd via xdp_session_open_pipewire_remote().
 *   4. Cleanly closes the portal session on shutdown via xdp_session_close().
 */
#define _POSIX_C_SOURCE 200809L

#include "portal.h"
#include "log.h"

#include <errno.h>
#include <gio/gio.h>
#include <glib.h>
#include <libportal/portal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct portal_ctx {
    const app_config_t *cfg;
    GMainContext       *glib_ctx;
    GMainLoop          *loop;
    XdpPortal          *portal;
    XdpSession         *session;
    portal_status_t     last_status;
    uint32_t            pw_node_id;
    int                 pw_fd;
    atomic_bool         session_closed_by_host;
};

static char *load_restore_token(const char *path)
{
    if (!path || path[0] == '\0') {
        return NULL;
    }
    FILE *fp = fopen(path, "r");
    if (!fp) {
        return NULL;
    }
    char buf[256];
    if (!fgets(buf, sizeof(buf), fp)) {
        fclose(fp);
        return NULL;
    }
    fclose(fp);
    size_t len = strlen(buf);
    while (len > 0 && (buf[len - 1] == '\n' || buf[len - 1] == '\r' || buf[len - 1] == ' ')) {
        buf[--len] = '\0';
    }
    return (len > 0) ? strdup(buf) : NULL;
}

static void save_restore_token(const char *path, const char *token)
{
    if (!path || path[0] == '\0' || !token || token[0] == '\0') {
        return;
    }
    char dir_buf[512];
    snprintf(dir_buf, sizeof(dir_buf), "%s", path);
    char *slash = strrchr(dir_buf, '/');
    if (slash && slash != dir_buf) {
        *slash = '\0';
        g_mkdir_with_parents(dir_buf, 0700);
    }
    FILE *fp = fopen(path, "w");
    if (!fp) {
        LOG_WARN("portal", "could not save restore token to '%s': %s", path, strerror(errno));
        return;
    }
    fchmod(fileno(fp), 0600);
    fprintf(fp, "%s\n", token);
    fclose(fp);
    LOG_INFO("portal", "saved screencast restore_token to '%s'", path);
}

static void on_session_closed_signal(XdpSession *session, gpointer user_data)
{
    (void)session;
    portal_ctx_t *ctx = (portal_ctx_t *)user_data;
    if (ctx) {
        atomic_store_explicit(&ctx->session_closed_by_host, true, memory_order_relaxed);
        LOG_WARN("portal", "screencast session closed by desktop portal / compositor");
    }
}

static void on_session_started(GObject *source, GAsyncResult *result, gpointer user_data)
{
    portal_ctx_t *ctx = (portal_ctx_t *)user_data;
    GError *error = NULL;

    gboolean ok = xdp_session_start_finish(XDP_SESSION(source), result, &error);
    if (!ok) {
        if (error) {
            LOG_ERROR("portal", "xdp_session_start_finish failed (domain=%s code=%d): %s",
                      g_quark_to_string(error->domain), error->code, error->message);
            if (error->code == G_IO_ERROR_CANCELLED ||
                strstr(error->message, "denied") != NULL ||
                strstr(error->message, "Denied") != NULL ||
                strstr(error->message, "cancelled") != NULL ||
                strstr(error->message, "Cancelled") != NULL ||
                strstr(error->message, "canceled") != NULL) {
                ctx->last_status = PORTAL_ERR_USER_DENIED;
            } else {
                ctx->last_status = PORTAL_ERR_BACKEND;
            }
            g_error_free(error);
        } else {
            LOG_ERROR("portal", "user denied portal screencast consent prompt");
            ctx->last_status = PORTAL_ERR_USER_DENIED;
        }
        g_main_loop_quit(ctx->loop);
        return;
    }

    char *new_token = xdp_session_get_restore_token(ctx->session);
    if (new_token) {
        save_restore_token(ctx->cfg->restore_token_file, new_token);
        g_free(new_token);
    }

    GVariant *streams = xdp_session_get_streams(ctx->session);
    if (!streams) {
        LOG_ERROR("portal", "xdp_session_get_streams returned NULL");
        ctx->last_status = PORTAL_ERR_BACKEND;
        g_main_loop_quit(ctx->loop);
        return;
    }

    GVariantIter iter;
    g_variant_iter_init(&iter, streams);
    guint32 node_id = 0;
    GVariant *props = NULL;
    bool found = false;

    while (g_variant_iter_loop(&iter, "(u@a{sv})", &node_id, &props)) {
        ctx->pw_node_id = (uint32_t)node_id;
        found = true;
        g_variant_unref(props);
        break;
    }

    if (!found) {
        LOG_ERROR("portal", "portal returned empty stream list");
        ctx->last_status = PORTAL_ERR_BACKEND;
        g_main_loop_quit(ctx->loop);
        return;
    }

    int fd = xdp_session_open_pipewire_remote(ctx->session);
    if (fd < 0) {
        LOG_ERROR("portal", "xdp_session_open_pipewire_remote failed (fd=%d)", fd);
        ctx->last_status = PORTAL_ERR_BACKEND;
        g_main_loop_quit(ctx->loop);
        return;
    }

    ctx->pw_fd = fd;
    ctx->last_status = PORTAL_OK;
    LOG_INFO("portal", "portal session established (pipewire_fd=%d, node_id=%u)",
             ctx->pw_fd, ctx->pw_node_id);
    g_main_loop_quit(ctx->loop);
}

static void on_session_created(GObject *source, GAsyncResult *result, gpointer user_data)
{
    portal_ctx_t *ctx = (portal_ctx_t *)user_data;
    GError *error = NULL;

    ctx->session = xdp_portal_create_screencast_session_finish(
        XDP_PORTAL(source), result, &error);
    if (!ctx->session) {
        LOG_ERROR("portal",
                  "xdp_portal_create_screencast_session_finish failed (domain=%s code=%d): %s",
                  error ? g_quark_to_string(error->domain) : "unknown",
                  error ? error->code : -1,
                  error ? error->message : "unknown error");
        if (error) {
            g_error_free(error);
        }
        ctx->last_status = PORTAL_ERR_BACKEND;
        g_main_loop_quit(ctx->loop);
        return;
    }

    g_signal_connect(ctx->session, "closed", G_CALLBACK(on_session_closed_signal), ctx);

    LOG_INFO("portal", "requesting ScreenCast Start (waiting for user consent or restore_token)...");
    xdp_session_start(ctx->session, NULL, NULL, on_session_started, ctx);
}

portal_ctx_t *portal_create(const app_config_t *cfg)
{
    portal_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) {
        return NULL;
    }
    ctx->cfg = cfg;
    ctx->pw_fd = -1;
    ctx->pw_node_id = 0;
    atomic_init(&ctx->session_closed_by_host, false);
    ctx->glib_ctx = g_main_context_default();
    ctx->loop = g_main_loop_new(ctx->glib_ctx, FALSE);
    return ctx;
}

portal_status_t portal_start_session(portal_ctx_t *ctx,
                                     int *out_pw_fd,
                                     uint32_t *out_pw_node_id)
{
    if (!ctx || !out_pw_fd || !out_pw_node_id) {
        return PORTAL_ERR_BACKEND;
    }

    portal_close_session(ctx);
    atomic_store_explicit(&ctx->session_closed_by_host, false, memory_order_relaxed);

    if (!ctx->portal) {
        ctx->portal = xdp_portal_new();
        if (!ctx->portal) {
            LOG_ERROR("portal", "xdp_portal_new() failed (is xdg-desktop-portal running?)");
            return PORTAL_ERR_BACKEND;
        }
    }

    char *restore_token = load_restore_token(ctx->cfg->restore_token_file);
    XdpPersistMode persist = (ctx->cfg->restore_token_file[0] != '\0')
                                 ? XDP_PERSIST_MODE_PERSISTENT
                                 : XDP_PERSIST_MODE_TRANSIENT;

    LOG_INFO("portal", "creating ScreenCast session (output=MONITOR, cursor=EMBEDDED, persist=%d)",
             (int)persist);

    xdp_portal_create_screencast_session(
        ctx->portal,
        XDP_OUTPUT_MONITOR,
        XDP_SCREENCAST_FLAG_NONE,
        XDP_CURSOR_MODE_EMBEDDED,
        persist,
        restore_token,
        NULL,
        on_session_created,
        ctx);

    free(restore_token);

    g_main_loop_run(ctx->loop);

    if (ctx->last_status == PORTAL_OK) {
        *out_pw_fd      = ctx->pw_fd;
        *out_pw_node_id = ctx->pw_node_id;
    }
    return ctx->last_status;
}

bool portal_is_closed(portal_ctx_t *ctx)
{
    if (!ctx) {
        return true;
    }
    while (g_main_context_pending(ctx->glib_ctx)) {
        g_main_context_iteration(ctx->glib_ctx, FALSE);
    }
    return atomic_load_explicit(&ctx->session_closed_by_host, memory_order_relaxed);
}

void portal_close_session(portal_ctx_t *ctx)
{
    if (!ctx) {
        return;
    }
    if (ctx->session) {
        XdpSessionState st = xdp_session_get_session_state(ctx->session);
        if (st == XDP_SESSION_ACTIVE) {
            LOG_INFO("portal", "closing active XdpSession via xdp_session_close()");
            xdp_session_close(ctx->session);
        }
        while (g_main_context_pending(ctx->glib_ctx)) {
            g_main_context_iteration(ctx->glib_ctx, FALSE);
        }
        g_object_unref(ctx->session);
        ctx->session = NULL;
    }
    ctx->pw_fd = -1;
    ctx->pw_node_id = 0;
}

void portal_destroy(portal_ctx_t *ctx)
{
    if (!ctx) {
        return;
    }
    portal_close_session(ctx);
    if (ctx->portal) {
        g_object_unref(ctx->portal);
        ctx->portal = NULL;
    }
    if (ctx->loop) {
        g_main_loop_unref(ctx->loop);
        ctx->loop = NULL;
    }
    free(ctx);
}
