/*
 * config.c - INI configuration parser, CLI override parser, and validation.
 */
#define _POSIX_C_SOURCE 200809L

#include "config.h"

#include <ctype.h>
#include <errno.h>
#include <getopt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

void config_init_defaults(app_config_t *cfg)
{
    if (!cfg) {
        return;
    }
    memset(cfg, 0, sizeof(*cfg));
    snprintf(cfg->config_path, sizeof(cfg->config_path), "/etc/capture-app/config.ini");
    cfg->fps                        = 10;
    cfg->bitrate_kbps               = 3000;
    cfg->keyframe_interval_sec      = 2;
    snprintf(cfg->monitor, sizeof(cfg->monitor), "primary");
    snprintf(cfg->whip_url, sizeof(cfg->whip_url),
             "https://mediarelay.sahilpatel.online/cam/whip");
    cfg->log_level                  = LOG_LEVEL_INFO;
    snprintf(cfg->log_file, sizeof(cfg->log_file), "stderr");
    cfg->duration_sec               = 0;
    cfg->reconnect_initial_delay_ms = 500;
    cfg->reconnect_max_delay_ms     = 30000;
    cfg->reconnect_max_attempts     = 0;
    cfg->pipeline_depth             = 4;
    cfg->drop_policy                = DROP_POLICY_OLDEST;
    snprintf(cfg->render_node, sizeof(cfg->render_node), "/dev/dri/renderD128");
    cfg->action                     = ACTION_RUN_FOREGROUND;

    const char *home = getenv("HOME");
    if (home && home[0] != '\0') {
        snprintf(cfg->restore_token_file, sizeof(cfg->restore_token_file),
                 "%.440s/.local/state/capture-app/restore_token", home);
        snprintf(cfg->pid_file, sizeof(cfg->pid_file),
                 "%.440s/.local/state/capture-app/capture-app.pid", home);
    } else {
        snprintf(cfg->restore_token_file, sizeof(cfg->restore_token_file),
                 "/tmp/capture-app-restore_token");
        snprintf(cfg->pid_file, sizeof(cfg->pid_file),
                 "/tmp/capture-app.pid");
    }
}

const char *drop_policy_to_string(drop_policy_t policy)
{
    switch (policy) {
    case DROP_POLICY_OLDEST: return "oldest";
    case DROP_POLICY_NEWEST: return "newest";
    case DROP_POLICY_BLOCK:  return "block";
    default:                 return "oldest";
    }
}

int drop_policy_from_string(const char *str, drop_policy_t *out)
{
    if (!str || !out) {
        return -1;
    }
    if (strcasecmp(str, "oldest") == 0) {
        *out = DROP_POLICY_OLDEST;
        return 0;
    }
    if (strcasecmp(str, "newest") == 0) {
        *out = DROP_POLICY_NEWEST;
        return 0;
    }
    if (strcasecmp(str, "block") == 0) {
        *out = DROP_POLICY_BLOCK;
        return 0;
    }
    return -1;
}

static char *trim_whitespace(char *s)
{
    while (*s && isspace((unsigned char)*s)) {
        s++;
    }
    if (*s == '\0') {
        return s;
    }
    char *end = s + strlen(s) - 1;
    while (end > s && isspace((unsigned char)*end)) {
        *end-- = '\0';
    }
    return s;
}

static void strip_inline_comment(char *val)
{
    bool in_quotes = false;
    for (char *p = val; *p; ++p) {
        if (*p == '"') {
            in_quotes = !in_quotes;
        } else if (!in_quotes && (*p == '#' || *p == ';')) {
            *p = '\0';
            break;
        }
    }
}

static int parse_u32_strict(const char *val, uint32_t *out)
{
    if (!val || *val == '\0' || *val == '-') {
        return -1;
    }
    errno = 0;
    char *end = NULL;
    unsigned long v = strtoul(val, &end, 10);
    if (errno != 0 || end == val || *end != '\0' || v > UINT32_MAX) {
        return -1;
    }
    *out = (uint32_t)v;
    return 0;
}

static int apply_kv(app_config_t *cfg, const char *key, const char *val,
                    char *err_buf, size_t err_len)
{
    if (strcasecmp(key, "fps") == 0) {
        if (parse_u32_strict(val, &cfg->fps) != 0) {
            snprintf(err_buf, err_len, "invalid integer for fps: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "bitrate_kbps") == 0 || strcasecmp(key, "bitrate-kbps") == 0) {
        if (parse_u32_strict(val, &cfg->bitrate_kbps) != 0) {
            snprintf(err_buf, err_len, "invalid integer for bitrate_kbps: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "keyframe_interval") == 0 || strcasecmp(key, "keyframe-interval") == 0) {
        if (parse_u32_strict(val, &cfg->keyframe_interval_sec) != 0) {
            snprintf(err_buf, err_len, "invalid integer for keyframe_interval: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "monitor") == 0) {
        snprintf(cfg->monitor, sizeof(cfg->monitor), "%s", val);
    } else if (strcasecmp(key, "whip_url") == 0 || strcasecmp(key, "whip-url") == 0) {
        snprintf(cfg->whip_url, sizeof(cfg->whip_url), "%s", val);
    } else if (strcasecmp(key, "whip_bearer_token") == 0) {
        snprintf(cfg->whip_bearer_token, sizeof(cfg->whip_bearer_token), "%s", val);
    } else if (strcasecmp(key, "whip_ice_servers") == 0) {
        snprintf(cfg->whip_ice_servers, sizeof(cfg->whip_ice_servers), "%s", val);
    } else if (strcasecmp(key, "console_url") == 0 || strcasecmp(key, "console-url") == 0) {
        snprintf(cfg->console_url, sizeof(cfg->console_url), "%s", val);
        size_t clen = strlen(cfg->console_url);
        while (clen > 0 && cfg->console_url[clen - 1] == '/') {
            cfg->console_url[--clen] = '\0';
        }
    } else if (strcasecmp(key, "capture_token") == 0 || strcasecmp(key, "capture-token") == 0) {
        snprintf(cfg->capture_token, sizeof(cfg->capture_token), "%s", val);
    } else if (strcasecmp(key, "cert") == 0 || strcasecmp(key, "cert_path") == 0) {
        snprintf(cfg->cert_path, sizeof(cfg->cert_path), "%s", val);
    } else if (strcasecmp(key, "key") == 0 || strcasecmp(key, "key_path") == 0) {
        snprintf(cfg->key_path, sizeof(cfg->key_path), "%s", val);
    } else if (strcasecmp(key, "ca") == 0 || strcasecmp(key, "ca_path") == 0) {
        snprintf(cfg->ca_path, sizeof(cfg->ca_path), "%s", val);
    } else if (strcasecmp(key, "spki_pin_sha256") == 0) {
        snprintf(cfg->spki_pin_sha256, sizeof(cfg->spki_pin_sha256), "%s", val);
    } else if (strcasecmp(key, "log_level") == 0 || strcasecmp(key, "log-level") == 0) {
        if (log_parse_level(val, &cfg->log_level) != 0) {
            snprintf(err_buf, err_len, "invalid log_level: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "log_file") == 0 || strcasecmp(key, "log-file") == 0) {
        snprintf(cfg->log_file, sizeof(cfg->log_file), "%s", val);
    } else if (strcasecmp(key, "duration") == 0) {
        if (parse_u32_strict(val, &cfg->duration_sec) != 0) {
            snprintf(err_buf, err_len, "invalid duration: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "reconnect_initial_delay_ms") == 0) {
        if (parse_u32_strict(val, &cfg->reconnect_initial_delay_ms) != 0) {
            snprintf(err_buf, err_len, "invalid reconnect_initial_delay_ms: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "reconnect_max_delay_ms") == 0) {
        if (parse_u32_strict(val, &cfg->reconnect_max_delay_ms) != 0) {
            snprintf(err_buf, err_len, "invalid reconnect_max_delay_ms: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "reconnect_max_attempts") == 0) {
        if (parse_u32_strict(val, &cfg->reconnect_max_attempts) != 0) {
            snprintf(err_buf, err_len, "invalid reconnect_max_attempts: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "pipeline_depth") == 0) {
        if (parse_u32_strict(val, &cfg->pipeline_depth) != 0) {
            snprintf(err_buf, err_len, "invalid pipeline_depth: '%s'", val);
            return -1;
        }
    } else if (strcasecmp(key, "drop_policy") == 0) {
        if (drop_policy_from_string(val, &cfg->drop_policy) != 0) {
            snprintf(err_buf, err_len, "invalid drop_policy: '%s' (expected oldest|newest|block)", val);
            return -1;
        }
    } else if (strcasecmp(key, "pid_file") == 0) {
        snprintf(cfg->pid_file, sizeof(cfg->pid_file), "%s", val);
    } else if (strcasecmp(key, "render_node") == 0) {
        snprintf(cfg->render_node, sizeof(cfg->render_node), "%s", val);
    } else if (strcasecmp(key, "restore_token_file") == 0) {
        snprintf(cfg->restore_token_file, sizeof(cfg->restore_token_file), "%s", val);
    } else if (strcasecmp(key, "synthetic_capture") == 0) {
        cfg->synthetic_capture = (strcasecmp(val, "true") == 0 || strcmp(val, "1") == 0);
    } else {
        snprintf(err_buf, err_len, "unknown configuration key: '%s'", key);
        return -1;
    }
    return 0;
}

int config_load_ini(app_config_t *cfg, const char *path, char *err_buf, size_t err_len)
{
    if (!cfg || !path) {
        return -1;
    }
    FILE *fp = fopen(path, "r");
    if (!fp) {
        snprintf(err_buf, err_len, "cannot open config file '%s': %s", path, strerror(errno));
        return -1;
    }

    char line[1024];
    int line_no = 0;
    while (fgets(line, sizeof(line), fp) != NULL) {
        line_no++;
        char *s = trim_whitespace(line);
        if (*s == '\0' || *s == '#' || *s == ';') {
            continue;
        }
        if (*s == '[') {
            char *close_bracket = strchr(s, ']');
            if (!close_bracket) {
                snprintf(err_buf, err_len, "%s:%d: malformed section header", path, line_no);
                fclose(fp);
                return -1;
            }
            continue;
        }
        char *eq = strchr(s, '=');
        if (!eq) {
            snprintf(err_buf, err_len, "%s:%d: missing '=' in assignment", path, line_no);
            fclose(fp);
            return -1;
        }
        *eq = '\0';
        char *key = trim_whitespace(s);
        char *val = trim_whitespace(eq + 1);
        strip_inline_comment(val);
        val = trim_whitespace(val);

        size_t vlen = strlen(val);
        if (vlen >= 2 && ((val[0] == '"' && val[vlen - 1] == '"') ||
                          (val[0] == '\'' && val[vlen - 1] == '\''))) {
            val[vlen - 1] = '\0';
            val++;
        }

        if (apply_kv(cfg, key, val, err_buf, err_len) != 0) {
            fclose(fp);
            return -1;
        }
    }

    fclose(fp);
    return 0;
}

enum {
    OPT_CONFIG = 1000,
    OPT_FPS,
    OPT_BITRATE,
    OPT_KEYFRAME,
    OPT_MONITOR,
    OPT_WHIP_URL,
    OPT_CONSOLE_URL,
    OPT_CAPTURE_TOKEN,
    OPT_CERT,
    OPT_KEY,
    OPT_CA,
    OPT_PIN,
    OPT_LOG_LEVEL,
    OPT_LOG_FILE,
    OPT_DURATION,
    OPT_PID_FILE,
    OPT_RENDER_NODE,
    OPT_RECONNECT_MAX_ATTEMPTS,
    OPT_RECONNECT_INIT_MS,
    OPT_RECONNECT_MAX_MS,
    OPT_DAEMON,
    OPT_SYNTHETIC,
    OPT_VERSION,
    OPT_HELP
};

int config_parse_cli(app_config_t *cfg, int argc, char **argv, char *err_buf, size_t err_len)
{
    static const struct option long_opts[] = {
        {"config",                 required_argument, NULL, OPT_CONFIG},
        {"fps",                    required_argument, NULL, OPT_FPS},
        {"bitrate-kbps",           required_argument, NULL, OPT_BITRATE},
        {"keyframe-interval",      required_argument, NULL, OPT_KEYFRAME},
        {"monitor",                required_argument, NULL, OPT_MONITOR},
        {"whip-url",               required_argument, NULL, OPT_WHIP_URL},
        {"console-url",            required_argument, NULL, OPT_CONSOLE_URL},
        {"capture-token",          required_argument, NULL, OPT_CAPTURE_TOKEN},
        {"cert",                   required_argument, NULL, OPT_CERT},
        {"key",                    required_argument, NULL, OPT_KEY},
        {"ca",                     required_argument, NULL, OPT_CA},
        {"spki-pin",               required_argument, NULL, OPT_PIN},
        {"log-level",              required_argument, NULL, OPT_LOG_LEVEL},
        {"log-file",               required_argument, NULL, OPT_LOG_FILE},
        {"duration",               required_argument, NULL, OPT_DURATION},
        {"pid-file",               required_argument, NULL, OPT_PID_FILE},
        {"render-node",            required_argument, NULL, OPT_RENDER_NODE},
        {"reconnect-max-attempts", required_argument, NULL, OPT_RECONNECT_MAX_ATTEMPTS},
        {"reconnect-initial-ms",   required_argument, NULL, OPT_RECONNECT_INIT_MS},
        {"reconnect-max-ms",       required_argument, NULL, OPT_RECONNECT_MAX_MS},
        {"daemon",                 no_argument,       NULL, OPT_DAEMON},
        {"synthetic-capture",      no_argument,       NULL, OPT_SYNTHETIC},
        {"version",                no_argument,       NULL, OPT_VERSION},
        {"help",                   no_argument,       NULL, OPT_HELP},
        {NULL, 0, NULL, 0}
    };

    /* Check if first argument is a lifecycle subcommand: start, stop, status, restart */
    int arg_offset = 0;
    if (argc >= 2 && argv[1] && argv[1][0] != '-') {
        if (strcmp(argv[1], "start") == 0) {
            cfg->action = ACTION_START_DAEMON;
            arg_offset = 1;
        } else if (strcmp(argv[1], "stop") == 0) {
            cfg->action = ACTION_STOP;
            arg_offset = 1;
        } else if (strcmp(argv[1], "status") == 0) {
            cfg->action = ACTION_STATUS;
            arg_offset = 1;
        } else if (strcmp(argv[1], "restart") == 0) {
            cfg->action = ACTION_RESTART;
            arg_offset = 1;
        }
    }

    int eff_argc = argc - arg_offset;
    char **eff_argv = argv + arg_offset;

    /* First pass: locate --config / --version / --help */
    bool explicit_config = false;
    optind = 1;
    opterr = 0;
    int c;
    while ((c = getopt_long(eff_argc, eff_argv, "dhv", long_opts, NULL)) != -1) {
        if (c == OPT_VERSION || c == 'v') {
            cfg->show_version = true;
            return 0;
        }
        if (c == OPT_HELP || c == 'h') {
            cfg->show_help = true;
            return 0;
        }
        if (c == OPT_CONFIG) {
            snprintf(cfg->config_path, sizeof(cfg->config_path), "%s", optarg);
            explicit_config = true;
        }
    }

    if (explicit_config) {
        if (config_load_ini(cfg, cfg->config_path, err_buf, err_len) != 0) {
            return -1;
        }
    } else {
        if (access(cfg->config_path, R_OK) == 0) {
            if (config_load_ini(cfg, cfg->config_path, err_buf, err_len) != 0) {
                return -1;
            }
        }
        const char *home = getenv("HOME");
        if (home && home[0] != '\0') {
            char user_cfg[512];
            snprintf(user_cfg, sizeof(user_cfg), "%.440s/.config/capture-app/config.ini", home);
            if (access(user_cfg, R_OK) == 0) {
                snprintf(cfg->config_path, sizeof(cfg->config_path), "%s", user_cfg);
                if (config_load_ini(cfg, user_cfg, err_buf, err_len) != 0) {
                    return -1;
                }
            }
        }
    }

    /* Second pass: apply CLI overrides */
    bool cli_console_url = false;
    optind = 1;
    opterr = 0;
    while ((c = getopt_long(eff_argc, eff_argv, "dhv", long_opts, NULL)) != -1) {
        switch (c) {
        case OPT_CONFIG:
            break;
        case OPT_FPS:
            if (apply_kv(cfg, "fps", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_BITRATE:
            if (apply_kv(cfg, "bitrate_kbps", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_KEYFRAME:
            if (apply_kv(cfg, "keyframe_interval", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_MONITOR:
            snprintf(cfg->monitor, sizeof(cfg->monitor), "%s", optarg);
            break;
        case OPT_WHIP_URL:
            snprintf(cfg->whip_url, sizeof(cfg->whip_url), "%s", optarg);
            break;
        case OPT_CONSOLE_URL:
            cli_console_url = true;
            if (apply_kv(cfg, "console_url", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_CAPTURE_TOKEN:
            if (apply_kv(cfg, "capture_token", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_CERT:
            snprintf(cfg->cert_path, sizeof(cfg->cert_path), "%s", optarg);
            break;
        case OPT_KEY:
            snprintf(cfg->key_path, sizeof(cfg->key_path), "%s", optarg);
            break;
        case OPT_CA:
            snprintf(cfg->ca_path, sizeof(cfg->ca_path), "%s", optarg);
            break;
        case OPT_PIN:
            snprintf(cfg->spki_pin_sha256, sizeof(cfg->spki_pin_sha256), "%s", optarg);
            break;
        case OPT_LOG_LEVEL:
            if (apply_kv(cfg, "log_level", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_LOG_FILE:
            snprintf(cfg->log_file, sizeof(cfg->log_file), "%s", optarg);
            break;
        case OPT_DURATION:
            if (apply_kv(cfg, "duration", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_PID_FILE:
            snprintf(cfg->pid_file, sizeof(cfg->pid_file), "%s", optarg);
            break;
        case OPT_RENDER_NODE:
            snprintf(cfg->render_node, sizeof(cfg->render_node), "%s", optarg);
            break;
        case OPT_RECONNECT_MAX_ATTEMPTS:
            if (apply_kv(cfg, "reconnect_max_attempts", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_RECONNECT_INIT_MS:
            if (apply_kv(cfg, "reconnect_initial_delay_ms", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_RECONNECT_MAX_MS:
            if (apply_kv(cfg, "reconnect_max_delay_ms", optarg, err_buf, err_len) != 0) return -1;
            break;
        case OPT_DAEMON:
        case 'd':
            if (cfg->action == ACTION_RUN_FOREGROUND) {
                cfg->action = ACTION_START_DAEMON;
            }
            break;
        case OPT_SYNTHETIC:
            cfg->synthetic_capture = true;
            break;
        default:
            snprintf(err_buf, err_len, "unrecognized or incomplete CLI option (try --help)");
            return -1;
        }
    }

    if (optind < eff_argc) {
        snprintf(err_buf, err_len, "unexpected positional argument: '%s'", eff_argv[optind]);
        return -1;
    }

    if (cfg->synthetic_capture && !cli_console_url) {
        cfg->console_url[0] = '\0';
    }

    /* When running in background daemon mode, default log_file to state dir if still stderr */
    if ((cfg->action == ACTION_START_DAEMON || cfg->action == ACTION_RESTART ||
         cfg->action == ACTION_STATUS) &&
        strcasecmp(cfg->log_file, "stderr") == 0) {
        const char *home = getenv("HOME");
        if (home && home[0] != '\0') {
            snprintf(cfg->log_file, sizeof(cfg->log_file),
                     "%.440s/.local/state/capture-app/capture-app.log", home);
        } else {
            snprintf(cfg->log_file, sizeof(cfg->log_file),
                     "/tmp/capture-app.log");
        }
    }

    return 0;
}

int config_validate(const app_config_t *cfg, char *err_buf, size_t err_len)
{
    if (!cfg) {
        return -1;
    }
    if (cfg->fps < 1 || cfg->fps > 120) {
        snprintf(err_buf, err_len, "fps (%u) must be between 1 and 120", cfg->fps);
        return -1;
    }
    if (cfg->bitrate_kbps < 100 || cfg->bitrate_kbps > 50000) {
        snprintf(err_buf, err_len, "bitrate_kbps (%u) must be between 100 and 50000",
                 cfg->bitrate_kbps);
        return -1;
    }
    if (cfg->keyframe_interval_sec < 1 || cfg->keyframe_interval_sec > 60) {
        snprintf(err_buf, err_len, "keyframe_interval (%u) must be between 1 and 60 seconds",
                 cfg->keyframe_interval_sec);
        return -1;
    }
    if (strncmp(cfg->whip_url, "https://", 8) != 0 &&
        strncmp(cfg->whip_url, "http://", 7) != 0) {
        snprintf(err_buf, err_len, "whip_url must start with https:// or http:// (got '%s')",
                 cfg->whip_url);
        return -1;
    }
    if (cfg->pipeline_depth < 1 || cfg->pipeline_depth > 64) {
        snprintf(err_buf, err_len, "pipeline_depth (%u) must be between 1 and 64",
                 cfg->pipeline_depth);
        return -1;
    }
    if (cfg->reconnect_initial_delay_ms < 50 ||
        cfg->reconnect_max_delay_ms < cfg->reconnect_initial_delay_ms) {
        snprintf(err_buf, err_len,
                 "reconnect delays invalid (initial=%u ms, max=%u ms)",
                 cfg->reconnect_initial_delay_ms, cfg->reconnect_max_delay_ms);
        return -1;
    }

    /* Validate mTLS certificate pairing & readability if provided */
    bool has_cert = (cfg->cert_path[0] != '\0');
    bool has_key  = (cfg->key_path[0] != '\0');
    if (has_cert != has_key) {
        snprintf(err_buf, err_len,
                 "both --cert and --key must be provided together for mTLS");
        return -1;
    }
    if (has_cert && access(cfg->cert_path, R_OK) != 0) {
        snprintf(err_buf, err_len, "client certificate not readable: '%s' (%s)",
                 cfg->cert_path, strerror(errno));
        return -1;
    }
    if (has_key && access(cfg->key_path, R_OK) != 0) {
        snprintf(err_buf, err_len, "client private key not readable: '%s' (%s)",
                 cfg->key_path, strerror(errno));
        return -1;
    }
    if (cfg->ca_path[0] != '\0' && access(cfg->ca_path, R_OK) != 0) {
        snprintf(err_buf, err_len, "CA certificate not readable: '%s' (%s)",
                 cfg->ca_path, strerror(errno));
        return -1;
    }

    return 0;
}

void config_print_help(const char *prog_name)
{
    const char *p = prog_name ? prog_name : "capture-app";
    printf("Usage:\n"
           "  %s [OPTIONS]            Run in foreground\n"
           "  %s start [OPTIONS]      Start in background (detached from terminal)\n"
           "  %s stop                 Stop running background/foreground instance cleanly\n"
           "  %s status               Show running status and live pipeline statistics\n"
           "  %s restart [OPTIONS]    Restart background instance\n\n"
           "Wayland/X11 Portal + PipeWire + VA-API H.264 + WHIP Screen Publisher\n\n"
           "Options:\n"
           "  -d, --daemon                   Run detached in the background (same as 'start')\n"
           "  --config PATH                  Configuration INI path (default: /etc/capture-app/config.ini)\n"
           "  --fps N                        Target capture & encode frame rate (default: 10)\n"
           "  --bitrate-kbps N               Target H.264 bitrate in kbps (default: 3000)\n"
           "  --keyframe-interval N          Keyframe (IDR) interval in seconds (default: 2)\n"
           "  --monitor NAME                 Target monitor selector (default: primary)\n"
           "  --whip-url URL                 WHIP endpoint URL (default: https://mediarelay.sahilpatel.online/desk/whip)\n"
           "  --console-url URL              Operator Console URL for on-demand standby control\n"
           "  --capture-token TOKEN          Bearer token for /api/capture/poll standby control\n"
           "  --cert PATH                    mTLS client certificate PEM path (default: none)\n"
           "  --key PATH                     mTLS client private key PEM path (default: none)\n"
           "  --ca PATH                      Custom CA bundle PEM path (default: system store)\n"
           "  --spki-pin PIN                 Optional SHA-256 SPKI pin for server TLS verification\n"
           "  --log-level LEVEL              Log verbosity: DEBUG|INFO|WARN|ERROR (default: INFO)\n"
           "  --log-file PATH                Log output file path or stderr (default: stderr)\n"
           "  --duration N                   Run duration in seconds, 0 = forever (default: 0)\n"
           "  --pid-file PATH                PID file path (default: ~/.local/state/capture-app/capture-app.pid)\n"
           "  --render-node PATH             DRM render node path (default: /dev/dri/renderD128)\n"
           "  --reconnect-max-attempts N     Max WHIP reconnect attempts, 0 = forever (default: 0)\n"
           "  --reconnect-initial-ms N       Initial reconnect delay in ms (default: 500)\n"
           "  --reconnect-max-ms N           Max reconnect backoff delay in ms (default: 30000)\n"
           "  --synthetic-capture            Use synthetic test frames (for headless integration testing)\n"
           "  -v, --version                  Print version and build hash\n"
           "  -h, --help                     Show this help message and exit\n",
           p, p, p, p, p);
}
