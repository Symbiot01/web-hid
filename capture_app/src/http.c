/*
 * http.c - libcurl + OpenSSL 3 WHIP signaling client (POST SDP offer, DELETE resource).
 */
#define _POSIX_C_SOURCE 200809L

#include "http.h"
#include "log.h"

#include <ctype.h>
#include <curl/curl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

typedef struct {
    char  *buf;
    size_t cap;
    size_t len;
} body_accum_t;

static size_t write_body_cb(char *ptr, size_t size, size_t nmemb, void *userdata)
{
    size_t total = size * nmemb;
    body_accum_t *acc = (body_accum_t *)userdata;
    if (!acc || !acc->buf || acc->cap == 0) {
        return 0;
    }
    size_t avail = (acc->len + 1 < acc->cap) ? (acc->cap - 1 - acc->len) : 0;
    size_t to_copy = (total < avail) ? total : avail;
    if (to_copy > 0) {
        memcpy(acc->buf + acc->len, ptr, to_copy);
        acc->len += to_copy;
        acc->buf[acc->len] = '\0';
    }
    return total;
}

static size_t header_cb(char *buffer, size_t size, size_t nitems, void *userdata)
{
    size_t total = size * nitems;
    whip_http_response_t *resp = (whip_http_response_t *)userdata;
    if (!resp) {
        return total;
    }
    const char *prefix = "Location:";
    size_t plen = strlen(prefix);
    if (total > plen && strncasecmp(buffer, prefix, plen) == 0) {
        const char *p = buffer + plen;
        while ((size_t)(p - buffer) < total && (*p == ' ' || *p == '\t')) {
            p++;
        }
        size_t rem = total - (size_t)(p - buffer);
        while (rem > 0 && (p[rem - 1] == '\r' || p[rem - 1] == '\n' || isspace((unsigned char)p[rem - 1]))) {
            rem--;
        }
        if (rem >= sizeof(resp->location_url)) {
            rem = sizeof(resp->location_url) - 1;
        }
        memcpy(resp->location_url, p, rem);
        resp->location_url[rem] = '\0';
    }
    return total;
}

static void resolve_relative_location(const char *whip_url, char *location_url, size_t cap)
{
    if (location_url[0] == '\0') {
        return;
    }
    if (strncmp(location_url, "http://", 7) == 0 ||
        strncmp(location_url, "https://", 8) == 0) {
        return;
    }
    /* Extract scheme://authority from whip_url */
    const char *scheme_end = strstr(whip_url, "://");
    if (!scheme_end) {
        return;
    }
    const char *host_start = scheme_end + 3;
    const char *path_start = strchr(host_start, '/');
    size_t origin_len = path_start ? (size_t)(path_start - whip_url) : strlen(whip_url);

    char resolved[1200];
    if (location_url[0] == '/') {
        if (origin_len > 500) {
            origin_len = 500;
        }
        snprintf(resolved, sizeof(resolved), "%.*s%s", (int)origin_len, whip_url, location_url);
    } else {
        snprintf(resolved, sizeof(resolved), "%.500s/%.500s", whip_url, location_url);
    }
    snprintf(location_url, cap, "%.*s", (int)(cap - 1), resolved);
}

static void configure_tls(CURL *curl, const app_config_t *cfg)
{
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);

    if (cfg->ca_path[0] != '\0') {
        curl_easy_setopt(curl, CURLOPT_CAINFO, cfg->ca_path);
    }
    if (cfg->cert_path[0] != '\0' && cfg->key_path[0] != '\0') {
        curl_easy_setopt(curl, CURLOPT_SSLCERT, cfg->cert_path);
        curl_easy_setopt(curl, CURLOPT_SSLKEY, cfg->key_path);
        curl_easy_setopt(curl, CURLOPT_SSLCERTTYPE, "PEM");
        curl_easy_setopt(curl, CURLOPT_SSLKEYTYPE, "PEM");
    }
    if (cfg->spki_pin_sha256[0] != '\0') {
        curl_easy_setopt(curl, CURLOPT_PINNEDPUBLICKEY, cfg->spki_pin_sha256);
    }
}

int http_whip_post_offer(const app_config_t *cfg,
                         const char *offer_sdp,
                         whip_http_response_t *out_resp)
{
    if (!cfg || !offer_sdp || !out_resp) {
        return -1;
    }
    memset(out_resp, 0, sizeof(*out_resp));

    CURL *curl = curl_easy_init();
    if (!curl) {
        snprintf(out_resp->error_msg, sizeof(out_resp->error_msg), "curl_easy_init failed");
        return -1;
    }

    char curl_err[CURL_ERROR_SIZE];
    curl_err[0] = '\0';

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/sdp");
    headers = curl_slist_append(headers, "Accept: application/sdp");
    if (cfg->whip_bearer_token[0] != '\0') {
        char auth_hdr[384];
        snprintf(auth_hdr, sizeof(auth_hdr), "Authorization: Bearer %s", cfg->whip_bearer_token);
        headers = curl_slist_append(headers, auth_hdr);
    }

    body_accum_t acc = {
        .buf = out_resp->answer_sdp,
        .cap = sizeof(out_resp->answer_sdp),
        .len = 0
    };

    curl_easy_setopt(curl, CURLOPT_URL, cfg->whip_url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, offer_sdp);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(offer_sdp));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &acc);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_cb);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, out_resp);
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, curl_err);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 10000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

    configure_tls(curl, cfg);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        snprintf(out_resp->error_msg, sizeof(out_resp->error_msg), "%s",
                 curl_err[0] ? curl_err : curl_easy_strerror(res));
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        return (res == CURLE_SSL_CERTPROBLEM ||
                res == CURLE_SSL_CIPHER ||
                res == CURLE_PEER_FAILED_VERIFICATION ||
                res == CURLE_SSL_PINNEDPUBKEYNOTMATCH) ? -2 : -1;
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &out_resp->status_code);
    resolve_relative_location(cfg->whip_url, out_resp->location_url, sizeof(out_resp->location_url));

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (out_resp->status_code != 201 && out_resp->status_code != 200) {
        snprintf(out_resp->error_msg, sizeof(out_resp->error_msg),
                 "unexpected HTTP status %ld", out_resp->status_code);
        return -1;
    }
    return 0;
}

int http_whip_delete_resource(const app_config_t *cfg,
                              const char *resource_url)
{
    if (!cfg || !resource_url || resource_url[0] == '\0') {
        return 0;
    }

    CURL *curl = curl_easy_init();
    if (!curl) {
        return -1;
    }

    struct curl_slist *headers = NULL;
    if (cfg->whip_bearer_token[0] != '\0') {
        char auth_hdr[384];
        snprintf(auth_hdr, sizeof(auth_hdr), "Authorization: Bearer %s", cfg->whip_bearer_token);
        headers = curl_slist_append(headers, auth_hdr);
    }

    curl_easy_setopt(curl, CURLOPT_URL, resource_url);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
    if (headers) {
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    }
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 2000L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 4000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    configure_tls(curl, cfg);

    CURLcode res = curl_easy_perform(curl);
    long code = 0;
    if (res == CURLE_OK) {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
        LOG_INFO("whip", "DELETE %s -> HTTP %ld", resource_url, code);
    } else {
        LOG_WARN("whip", "DELETE %s failed: %s", resource_url, curl_easy_strerror(res));
    }

    if (headers) {
        curl_slist_free_all(headers);
    }
    curl_easy_cleanup(curl);
    return (res == CURLE_OK) ? 0 : -1;
}

int http_console_poll(const app_config_t *cfg,
                      int wait_sec,
                      bool *out_video_wanted,
                      bool *out_snap_wanted)
{
    if (!cfg || cfg->console_url[0] == '\0' || cfg->capture_token[0] == '\0') {
        return -1;
    }

    CURL *curl = curl_easy_init();
    if (!curl) {
        return -1;
    }

    char url[640];
    snprintf(url, sizeof(url), "%s/api/capture/poll?wait=%d",
             cfg->console_url, (wait_sec > 0 && wait_sec <= 15) ? wait_sec : 8);

    char auth_hdr[384];
    snprintf(auth_hdr, sizeof(auth_hdr), "Authorization: Bearer %s", cfg->capture_token);

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Accept: application/json");
    headers = curl_slist_append(headers, auth_hdr);

    char resp_buf[1024];
    resp_buf[0] = '\0';
    body_accum_t acc = {
        .buf = resp_buf,
        .cap = sizeof(resp_buf),
        .len = 0
    };

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &acc);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, (long)((wait_sec + 7) * 1000));
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    configure_tls(curl, cfg);

    CURLcode res = curl_easy_perform(curl);
    long code = 0;
    if (res == CURLE_OK) {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK || code != 200) {
        return -1;
    }

    if (out_video_wanted) {
        if (strstr(resp_buf, "\"video\":true") != NULL ||
            strstr(resp_buf, "\"video\": true") != NULL) {
            *out_video_wanted = true;
        } else if (strstr(resp_buf, "\"video\":false") != NULL ||
                   strstr(resp_buf, "\"video\": false") != NULL) {
            *out_video_wanted = false;
        }
    }
    if (out_snap_wanted) {
        *out_snap_wanted = (strstr(resp_buf, "\"snap\":true") != NULL ||
                            strstr(resp_buf, "\"snap\": true") != NULL);
    }
    return 0;
}

int http_console_post_status(const app_config_t *cfg,
                             bool streaming,
                             uint32_t fps,
                             uint32_t bitrate_kbps)
{
    if (!cfg || cfg->console_url[0] == '\0' || cfg->capture_token[0] == '\0') {
        return 0;
    }

    CURL *curl = curl_easy_init();
    if (!curl) {
        return -1;
    }

    char url[640];
    snprintf(url, sizeof(url), "%s/api/capture/status", cfg->console_url);

    char auth_hdr[384];
    snprintf(auth_hdr, sizeof(auth_hdr), "Authorization: Bearer %s", cfg->capture_token);

    char body[256];
    snprintf(body, sizeof(body),
             "{\"streaming\":%s,\"fps\":%u,\"bitrateKbps\":%u}",
             streaming ? "true" : "false", fps, bitrate_kbps);

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: application/json");
    headers = curl_slist_append(headers, auth_hdr);

    char resp_buf[256];
    resp_buf[0] = '\0';
    body_accum_t acc = {
        .buf = resp_buf,
        .cap = sizeof(resp_buf),
        .len = 0
    };

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &acc);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 3000L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 5000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    configure_tls(curl, cfg);

    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return (res == CURLE_OK) ? 0 : -1;
}
