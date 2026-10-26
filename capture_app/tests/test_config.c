/*
 * test_config.c - Unit tests for INI config parser, CLI overrides, and validation.
 */
#define _POSIX_C_SOURCE 200809L

#include "../src/config.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void test_defaults(void)
{
    app_config_t cfg;
    config_init_defaults(&cfg);
    assert(cfg.fps == 10);
    assert(cfg.bitrate_kbps == 3000);
    assert(cfg.keyframe_interval_sec == 2);
    assert(strcmp(cfg.monitor, "primary") == 0);
    assert(strcmp(cfg.whip_url, "https://mediarelay.sahilpatel.online/cam/whip") == 0);
    assert(cfg.reconnect_initial_delay_ms == 500);
    assert(cfg.reconnect_max_delay_ms == 30000);
    assert(cfg.reconnect_max_attempts == 0);
    assert(cfg.pipeline_depth == 4);
    assert(cfg.drop_policy == DROP_POLICY_OLDEST);
    printf("[PASS] test_defaults\n");
}

static void test_ini_parse_and_cli_override(void)
{
    char tmp_path[] = "/tmp/test_capture_cfg_XXXXXX";
    int fd = mkstemp(tmp_path);
    assert(fd >= 0);

    const char *ini_body =
        "# Sample capture-app INI\n"
        "[capture]\n"
        "fps = 15\n"
        "bitrate_kbps = 4500\n"
        "keyframe_interval = 3\n"
        "monitor = HDMI-A-1\n"
        "pipeline_depth = 8\n"
        "drop_policy = newest # inline comment\n"
        "\n"
        "[whip]\n"
        "whip_url = https://mediarelay.sahilpatel.online/desk/whip\n"
        "reconnect_initial_delay_ms = 250\n"
        "reconnect_max_delay_ms = 10000\n"
        "reconnect_max_attempts = 5\n";

    ssize_t w = write(fd, ini_body, strlen(ini_body));
    assert(w == (ssize_t)strlen(ini_body));
    close(fd);

    app_config_t cfg;
    config_init_defaults(&cfg);

    char err[256] = {0};
    char argv_buf[7][64];
    snprintf(argv_buf[0], sizeof(argv_buf[0]), "capture-app");
    snprintf(argv_buf[1], sizeof(argv_buf[1]), "--config");
    snprintf(argv_buf[2], sizeof(argv_buf[2]), "%s", tmp_path);
    snprintf(argv_buf[3], sizeof(argv_buf[3]), "--fps");
    snprintf(argv_buf[4], sizeof(argv_buf[4]), "20");
    snprintf(argv_buf[5], sizeof(argv_buf[5]), "--bitrate-kbps");
    snprintf(argv_buf[6], sizeof(argv_buf[6]), "2500");

    char *argv[] = {
        argv_buf[0], argv_buf[1], argv_buf[2],
        argv_buf[3], argv_buf[4], argv_buf[5], argv_buf[6],
        NULL
    };
    int rc = config_parse_cli(&cfg, 7, argv, err, sizeof(err));
    assert(rc == 0);
    assert(cfg.fps == 20); /* CLI override wins over INI 15 */
    assert(cfg.bitrate_kbps == 2500); /* CLI override wins over INI 4500 */
    assert(cfg.keyframe_interval_sec == 3);
    assert(strcmp(cfg.monitor, "HDMI-A-1") == 0);
    assert(strcmp(cfg.whip_url, "https://mediarelay.sahilpatel.online/desk/whip") == 0);
    assert(cfg.pipeline_depth == 8);
    assert(cfg.drop_policy == DROP_POLICY_NEWEST);
    assert(cfg.reconnect_initial_delay_ms == 250);
    assert(cfg.reconnect_max_delay_ms == 10000);
    assert(cfg.reconnect_max_attempts == 5);

    assert(config_validate(&cfg, err, sizeof(err)) == 0);
    unlink(tmp_path);
    printf("[PASS] test_ini_parse_and_cli_override\n");
}

static void test_validation_rejects_invalid(void)
{
    app_config_t cfg;
    char err[256] = {0};

    config_init_defaults(&cfg);
    cfg.fps = 0;
    assert(config_validate(&cfg, err, sizeof(err)) != 0);

    config_init_defaults(&cfg);
    snprintf(cfg.whip_url, sizeof(cfg.whip_url), "ftp://invalid.example.com/whip");
    assert(config_validate(&cfg, err, sizeof(err)) != 0);

    /* Unpaired mTLS cert without key must fail validation */
    config_init_defaults(&cfg);
    snprintf(cfg.cert_path, sizeof(cfg.cert_path), "/nonexistent/client.crt");
    assert(config_validate(&cfg, err, sizeof(err)) != 0);

    /* Non-existent mTLS cert + key must fail validation */
    config_init_defaults(&cfg);
    snprintf(cfg.cert_path, sizeof(cfg.cert_path), "/nonexistent/client.crt");
    snprintf(cfg.key_path, sizeof(cfg.key_path), "/nonexistent/client.key");
    assert(config_validate(&cfg, err, sizeof(err)) != 0);

    printf("[PASS] test_validation_rejects_invalid\n");
}

int main(void)
{
    test_defaults();
    test_ini_parse_and_cli_override();
    test_validation_rejects_invalid();
    printf("All config unit tests passed.\n");
    return 0;
}
