/*
 * config.h - INI configuration parser, CLI override parser, and validation.
 */
#ifndef CAPTURE_APP_CONFIG_H
#define CAPTURE_APP_CONFIG_H

#include "log.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum {
    DROP_POLICY_OLDEST = 0,
    DROP_POLICY_NEWEST = 1,
    DROP_POLICY_BLOCK  = 2
} drop_policy_t;

typedef enum {
    ACTION_RUN_FOREGROUND = 0,
    ACTION_START_DAEMON   = 1,
    ACTION_STOP           = 2,
    ACTION_STATUS         = 3,
    ACTION_RESTART        = 4
} app_action_t;

typedef struct {
    char          config_path[512];
    uint32_t      fps;
    uint32_t      bitrate_kbps;
    uint32_t      keyframe_interval_sec;
    char          monitor[128];
    char          whip_url[512];
    char          whip_bearer_token[256];
    char          whip_ice_servers[512];
    char          console_url[512];
    char          capture_token[256];
    char          cert_path[512];
    char          key_path[512];
    char          ca_path[512];
    char          spki_pin_sha256[128];
    log_level_t   log_level;
    char          log_file[512];
    uint32_t      duration_sec;
    uint32_t      reconnect_initial_delay_ms;
    uint32_t      reconnect_max_delay_ms;
    uint32_t      reconnect_max_attempts;
    uint32_t      pipeline_depth;
    drop_policy_t drop_policy;
    char          pid_file[512];
    char          render_node[256];
    char          restore_token_file[512];
    app_action_t  action;
    bool          synthetic_capture;
    bool          show_version;
    bool          show_help;
} app_config_t;

void config_init_defaults(app_config_t *cfg);
int  config_load_ini(app_config_t *cfg, const char *path, char *err_buf, size_t err_len);
int  config_parse_cli(app_config_t *cfg, int argc, char **argv, char *err_buf, size_t err_len);
int  config_validate(const app_config_t *cfg, char *err_buf, size_t err_len);
const char *drop_policy_to_string(drop_policy_t policy);
int  drop_policy_from_string(const char *str, drop_policy_t *out);
void config_print_help(const char *prog_name);

#endif /* CAPTURE_APP_CONFIG_H */
