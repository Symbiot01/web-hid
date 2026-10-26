/*
 * whip_publisher.c - WHIP (RFC 9683) ingest client using libdatachannel C API.
 *
 * Implements:
 *   1. RTCPeerConnection creation with STUN disabled by default (or optional
 *      whip_ice_servers), default iceTransportPolicy (RTC_TRANSPORT_POLICY_ALL),
 *      and forceMediaTransport enabled.
 *   2. H.264 SENDONLY video track with built-in H264RtpPacketizer
 *      (RTC_NAL_SEPARATOR_START_SEQUENCE, 90 kHz RTP clock), RTCP SR reporter,
 *      NACK responder, and PLI handler triggering immediate VA-API IDR keyframes.
 *   3. Offer generation & ICE candidate gathering -> HTTPS POST to whip_url
 *      with Content-Type: application/sdp -> 201 Created + Location header + Answer SDP.
 *   4. rtcSetRemoteDescription(pc, answer_sdp, "answer") -> RTP media flow.
 *   5. Exponential backoff reconnection and polite HTTP DELETE of the WHIP
 *      resource Location URL on teardown.
 */
#define _POSIX_C_SOURCE 200809L

#include "whip_publisher.h"
#include "http.h"
#include "log.h"

#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <rtc/rtc.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define WHIP_H264_PAYLOAD_TYPE 96
#define WHIP_H264_SSRC         0x12345678u
#define WHIP_H264_CLOCK_RATE   90000u

struct whip_publisher {
    const app_config_t *cfg;
    pipeline_queue_t   *queue;
    vaapi_encoder_t    *encoder;

    int                 pc_id;
    int                 track_id;
    char                resource_url[512];

    pthread_mutex_t     mtx;
    pthread_cond_t      cond;
    bool                gathering_done;
    rtcState            pc_state;
    rtcIceState         ice_state;
    atomic_bool         track_open;
    atomic_bool         peer_failed;
    uint64_t            first_pts_ns;
    bool                pts_initialized;
};

static const char *rtc_state_str(rtcState st)
{
    switch (st) {
    case RTC_NEW:          return "NEW";
    case RTC_CONNECTING:   return "CONNECTING";
    case RTC_CONNECTED:    return "CONNECTED";
    case RTC_DISCONNECTED: return "DISCONNECTED";
    case RTC_FAILED:       return "FAILED";
    case RTC_CLOSED:       return "CLOSED";
    default:               return "UNKNOWN";
    }
}

static const char *rtc_ice_state_str(rtcIceState st)
{
    switch (st) {
    case RTC_ICE_NEW:          return "NEW";
    case RTC_ICE_CHECKING:     return "CHECKING";
    case RTC_ICE_CONNECTED:    return "CONNECTED";
    case RTC_ICE_COMPLETED:    return "COMPLETED";
    case RTC_ICE_FAILED:       return "FAILED";
    case RTC_ICE_DISCONNECTED: return "DISCONNECTED";
    case RTC_ICE_CLOSED:       return "CLOSED";
    default:                   return "UNKNOWN";
    }
}

static void RTC_API on_gathering_state_change(int pc, rtcGatheringState state, void *ptr)
{
    (void)pc;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    if (!pub) {
        return;
    }
    if (state == RTC_GATHERING_COMPLETE) {
        pthread_mutex_lock(&pub->mtx);
        pub->gathering_done = true;
        pthread_cond_broadcast(&pub->cond);
        pthread_mutex_unlock(&pub->mtx);
    }
}

static void RTC_API on_pc_state_change(int pc, rtcState state, void *ptr)
{
    (void)pc;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    if (!pub) {
        return;
    }
    LOG_INFO("whip", "peer connection state -> %s", rtc_state_str(state));
    pthread_mutex_lock(&pub->mtx);
    pub->pc_state = state;
    if (state == RTC_CONNECTED) {
        LOG_INFO("whip", "connected");
    } else if (state == RTC_FAILED || state == RTC_DISCONNECTED || state == RTC_CLOSED) {
        atomic_store_explicit(&pub->peer_failed, true, memory_order_relaxed);
    }
    pthread_cond_broadcast(&pub->cond);
    pthread_mutex_unlock(&pub->mtx);
}

static void RTC_API on_ice_state_change(int pc, rtcIceState state, void *ptr)
{
    (void)pc;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    if (!pub) {
        return;
    }
    LOG_INFO("whip", "ICE state -> %s", rtc_ice_state_str(state));
    pthread_mutex_lock(&pub->mtx);
    pub->ice_state = state;
    if (state == RTC_ICE_FAILED || state == RTC_ICE_CLOSED) {
        atomic_store_explicit(&pub->peer_failed, true, memory_order_relaxed);
    }
    pthread_cond_broadcast(&pub->cond);
    pthread_mutex_unlock(&pub->mtx);
}

static void RTC_API on_track_open(int id, void *ptr)
{
    (void)id;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    if (!pub) {
        return;
    }
    atomic_store_explicit(&pub->track_open, true, memory_order_relaxed);
    if (pub->encoder) {
        vaapi_encoder_request_keyframe(pub->encoder);
    }
    LOG_INFO("whip", "H.264 media track open — ready to push RTP frames");
}

static void RTC_API on_track_closed(int id, void *ptr)
{
    (void)id;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    if (!pub) {
        return;
    }
    atomic_store_explicit(&pub->track_open, false, memory_order_relaxed);
}

static void RTC_API on_track_error(int id, const char *error, void *ptr)
{
    (void)id;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    LOG_ERROR("whip", "media track error: %s", error ? error : "unknown");
    if (pub) {
        atomic_store_explicit(&pub->peer_failed, true, memory_order_relaxed);
    }
}

static void RTC_API on_pli_request(int tr, void *ptr)
{
    (void)tr;
    whip_publisher_t *pub = (whip_publisher_t *)ptr;
    if (pub && pub->encoder) {
        LOG_DEBUG("whip", "received RTCP PLI — requesting IDR keyframe from VAAPI encoder");
        vaapi_encoder_request_keyframe(pub->encoder);
    }
}

whip_publisher_t *whip_publisher_create(const app_config_t *cfg,
                                        pipeline_queue_t *queue,
                                        vaapi_encoder_t *encoder)
{
    if (!cfg) {
        return NULL;
    }
    rtcPreload();

    whip_publisher_t *pub = calloc(1, sizeof(*pub));
    if (!pub) {
        return NULL;
    }
    pub->cfg      = cfg;
    pub->queue    = queue;
    pub->encoder  = encoder;
    pub->pc_id    = -1;
    pub->track_id = -1;
    atomic_init(&pub->track_open, false);
    atomic_init(&pub->peer_failed, false);

    pthread_mutex_init(&pub->mtx, NULL);
    pthread_condattr_t cattr;
    pthread_condattr_init(&cattr);
    pthread_condattr_setclock(&cattr, CLOCK_MONOTONIC);
    pthread_cond_init(&pub->cond, &cattr);
    pthread_condattr_destroy(&cattr);

    return pub;
}

static void close_peer_connection_only(whip_publisher_t *pub)
{
    atomic_store_explicit(&pub->track_open, false, memory_order_relaxed);
    if (pub->track_id >= 0) {
        rtcDeleteTrack(pub->track_id);
        pub->track_id = -1;
    }
    if (pub->pc_id >= 0) {
        rtcClosePeerConnection(pub->pc_id);
        rtcDeletePeerConnection(pub->pc_id);
        pub->pc_id = -1;
    }
}

static int attempt_single_connect(whip_publisher_t *pub)
{
    close_peer_connection_only(pub);
    if (pub->resource_url[0] != '\0') {
        (void)http_whip_delete_resource(pub->cfg, pub->resource_url);
        pub->resource_url[0] = '\0';
    }

    pthread_mutex_lock(&pub->mtx);
    pub->gathering_done  = false;
    pub->pc_state        = RTC_NEW;
    pub->ice_state       = RTC_ICE_NEW;
    pub->pts_initialized = false;
    atomic_store_explicit(&pub->peer_failed, false, memory_order_relaxed);
    pthread_mutex_unlock(&pub->mtx);

    const char *ice_list[4];
    int ice_count = 0;
    char ice_copy[512];
    if (pub->cfg->whip_ice_servers[0] != '\0') {
        snprintf(ice_copy, sizeof(ice_copy), "%s", pub->cfg->whip_ice_servers);
        char *saveptr = NULL;
        char *tok = strtok_r(ice_copy, ",", &saveptr);
        while (tok && ice_count < 4) {
            while (*tok == ' ') tok++;
            if (*tok != '\0') {
                ice_list[ice_count++] = tok;
            }
            tok = strtok_r(NULL, ",", &saveptr);
        }
    }

    rtcConfiguration rcfg;
    memset(&rcfg, 0, sizeof(rcfg));
    rcfg.iceServers             = (ice_count > 0) ? ice_list : NULL;
    rcfg.iceServersCount        = ice_count;
    rcfg.certificateType        = RTC_CERTIFICATE_DEFAULT;
    rcfg.iceTransportPolicy     = RTC_TRANSPORT_POLICY_ALL;
    rcfg.disableAutoNegotiation = true;
    rcfg.forceMediaTransport    = true;

    int pc = rtcCreatePeerConnection(&rcfg);
    if (pc < 0) {
        LOG_ERROR("whip", "rtcCreatePeerConnection failed: %d", pc);
        return -1;
    }
    pub->pc_id = pc;
    rtcSetUserPointer(pc, pub);
    rtcSetStateChangeCallback(pc, on_pc_state_change);
    rtcSetIceStateChangeCallback(pc, on_ice_state_change);
    rtcSetGatheringStateChangeCallback(pc, on_gathering_state_change);

    rtcTrackInit tr_init;
    memset(&tr_init, 0, sizeof(tr_init));
    tr_init.direction   = RTC_DIRECTION_SENDONLY;
    tr_init.codec       = RTC_CODEC_H264;
    tr_init.payloadType = WHIP_H264_PAYLOAD_TYPE;
    tr_init.ssrc        = WHIP_H264_SSRC;
    tr_init.mid         = "video";
    tr_init.name        = "screen";
    tr_init.msid        = "capture-app-stream";
    tr_init.trackId     = "capture-app-video0";
    tr_init.profile     = "profile-level-id=4d4029;packetization-mode=1;level-asymmetry-allowed=1";

    int tr = rtcAddTrackEx(pc, &tr_init);
    if (tr < 0) {
        LOG_ERROR("whip", "rtcAddTrackEx failed: %d", tr);
        close_peer_connection_only(pub);
        return -1;
    }
    pub->track_id = tr;
    rtcSetUserPointer(tr, pub);
    rtcSetOpenCallback(tr, on_track_open);
    rtcSetClosedCallback(tr, on_track_closed);
    rtcSetErrorCallback(tr, on_track_error);

    rtcPacketizerInit pkt_init;
    memset(&pkt_init, 0, sizeof(pkt_init));
    pkt_init.ssrc            = WHIP_H264_SSRC;
    pkt_init.cname           = "capture-app";
    pkt_init.payloadType     = WHIP_H264_PAYLOAD_TYPE;
    pkt_init.clockRate       = WHIP_H264_CLOCK_RATE;
    pkt_init.maxFragmentSize = 1200;
    pkt_init.nalSeparator    = RTC_NAL_SEPARATOR_START_SEQUENCE;

    if (rtcSetH264Packetizer(tr, &pkt_init) < 0) {
        LOG_WARN("whip", "rtcSetH264Packetizer returned warning/error");
    }
    (void)rtcChainRtcpSrReporter(tr);
    (void)rtcChainRtcpNackResponder(tr, 512);
    (void)rtcChainPliHandler(tr, on_pli_request);

    if (rtcSetLocalDescription(pc, "offer") < 0) {
        LOG_ERROR("whip", "rtcSetLocalDescription(offer) failed");
        close_peer_connection_only(pub);
        return -1;
    }

    /* Wait up to 3 seconds for local ICE candidate gathering to finish */
    pthread_mutex_lock(&pub->mtx);
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += 3;
    while (!pub->gathering_done) {
        if (pthread_cond_timedwait(&pub->cond, &pub->mtx, &deadline) == ETIMEDOUT) {
            break;
        }
    }
    pthread_mutex_unlock(&pub->mtx);

    char offer_sdp[16384];
    int sdp_len = rtcGetLocalDescription(pc, offer_sdp, sizeof(offer_sdp));
    if (sdp_len <= 0) {
        LOG_ERROR("whip", "rtcGetLocalDescription failed (%d)", sdp_len);
        close_peer_connection_only(pub);
        return -1;
    }

    LOG_INFO("whip", "sending WHIP SDP offer (%d bytes) via HTTPS POST to %s",
             sdp_len, pub->cfg->whip_url);

    whip_http_response_t resp;
    int http_rc = http_whip_post_offer(pub->cfg, offer_sdp, &resp);
    if (http_rc != 0) {
        LOG_ERROR("whip", "WHIP POST failed (status=%ld): %s",
                  resp.status_code, resp.error_msg);
        close_peer_connection_only(pub);
        return http_rc; /* -2 for TLS/cert error, -1 for network/HTTP error */
    }

    snprintf(pub->resource_url, sizeof(pub->resource_url), "%s", resp.location_url);
    LOG_INFO("whip", "201 Created received from WHIP endpoint (Location: %s)",
             pub->resource_url[0] ? pub->resource_url : "<none>");

    int rdesc_rc = rtcSetRemoteDescription(pc, resp.answer_sdp, "answer");
    if (rdesc_rc < 0) {
        LOG_WARN("whip",
                 "rtcSetRemoteDescription returned %d (continuing in case mock/minimal SDP was used)",
                 rdesc_rc);
    }

    if (pub->encoder) {
        vaapi_encoder_request_keyframe(pub->encoder);
    }
    return 0;
}

whip_status_t whip_publisher_connect_with_retry(whip_publisher_t *pub,
                                                volatile int *stop_flag)
{
    if (!pub) {
        return WHIP_ERR_TLS_AUTH;
    }

    uint32_t max_attempts = pub->cfg->reconnect_max_attempts;
    uint32_t delay_ms     = pub->cfg->reconnect_initial_delay_ms;
    uint32_t max_delay_ms = pub->cfg->reconnect_max_delay_ms;
    uint32_t attempt      = 0;

    while (!stop_flag || !(*stop_flag)) {
        attempt++;
        int rc = attempt_single_connect(pub);
        if (rc == 0) {
            return WHIP_OK;
        }
        if (rc == -2) {
            LOG_ERROR("whip", "TLS/mTLS certificate verification failed; aborting without retry");
            return WHIP_ERR_TLS_AUTH;
        }

        if (max_attempts > 0 && attempt >= max_attempts) {
            LOG_ERROR("whip", "exhausted %u WHIP connection attempts to %s",
                      attempt, pub->cfg->whip_url);
            return WHIP_ERR_UNREACHABLE;
        }

        if (pub->queue) {
            pipeline_inc_reconnect(pub->queue);
        }

        LOG_WARN("whip", "WHIP connect attempt %u failed; retrying in %u ms...",
                 attempt, delay_ms);

        uint32_t slept_ms = 0;
        while (slept_ms < delay_ms && (!stop_flag || !(*stop_flag))) {
            uint32_t chunk = (delay_ms - slept_ms > 100) ? 100 : (delay_ms - slept_ms);
            struct timespec req = {
                .tv_sec  = chunk / 1000,
                .tv_nsec = (long)(chunk % 1000) * 1000000L
            };
            nanosleep(&req, NULL);
            slept_ms += chunk;
        }

        delay_ms *= 2;
        if (delay_ms > max_delay_ms) {
            delay_ms = max_delay_ms;
        }
    }

    return WHIP_ERR_ABORTED;
}

bool whip_publisher_needs_reconnect(whip_publisher_t *pub)
{
    if (!pub) {
        return false;
    }
    return atomic_load_explicit(&pub->peer_failed, memory_order_relaxed);
}

int whip_publisher_send_frame(whip_publisher_t *pub, const encoded_au_t *au)
{
    if (!pub || !au || !au->data || au->size == 0 || pub->track_id < 0) {
        return -1;
    }

    if (!pub->pts_initialized) {
        pub->first_pts_ns    = au->timestamp_ns;
        pub->pts_initialized = true;
    }

    double elapsed_sec = (double)(au->timestamp_ns - pub->first_pts_ns) / 1000000000.0;
    uint32_t rtp_ts = 0;
    if (rtcTransformSecondsToTimestamp(pub->track_id, elapsed_sec, &rtp_ts) == RTC_ERR_SUCCESS) {
        (void)rtcSetTrackRtpTimestamp(pub->track_id, rtp_ts);
    }

    if (rtcIsOpen(pub->track_id) ||
        atomic_load_explicit(&pub->track_open, memory_order_relaxed)) {
        int rc = rtcSendMessage(pub->track_id, (const char *)au->data, (int)au->size);
        if (rc < 0) {
            LOG_DEBUG("whip", "rtcSendMessage returned %d", rc);
            return -1;
        }
    }

    if (pub->queue) {
        pipeline_inc_published(pub->queue);
    }
    return 0;
}

void whip_publisher_disconnect(whip_publisher_t *pub)
{
    if (!pub) {
        return;
    }
    close_peer_connection_only(pub);
    if (pub->resource_url[0] != '\0') {
        (void)http_whip_delete_resource(pub->cfg, pub->resource_url);
        pub->resource_url[0] = '\0';
    }
}

void whip_publisher_destroy(whip_publisher_t *pub)
{
    if (!pub) {
        return;
    }
    whip_publisher_disconnect(pub);
    pthread_cond_destroy(&pub->cond);
    pthread_mutex_destroy(&pub->mtx);
    free(pub);
    rtcCleanup();
}
