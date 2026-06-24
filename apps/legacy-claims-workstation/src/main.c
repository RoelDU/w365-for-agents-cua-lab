/*
 * main.c - entry point. Parses CLI flags, runs --test if requested, otherwise
 * sets up the legacy auth flow and the main window before pumping messages.
 */
#include "app.h"
#include "data.h"
#include "handoff.h"
#include "log.h"
#include "setup.h"
#include "test.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

static int has_arg(int argc, char **argv, const char *needle, const char **out_value)
{
    size_t nlen = strlen(needle);
    for (int i = 1; i < argc; ++i) {
        if (strncmp(argv[i], needle, nlen) == 0) {
            if (argv[i][nlen] == '=') {
                if (out_value) *out_value = argv[i] + nlen + 1;
                return 1;
            }
            if (argv[i][nlen] == '\0') {
                if (out_value) *out_value = NULL;
                return 1;
            }
        }
    }
    return 0;
}

static void parse_cli(WgmApp *app, int argc, char **argv)
{
    const char *v = NULL;
    if (has_arg(argc, argv, "--no-splash", NULL))       app->no_splash = 1;
    if (has_arg(argc, argv, "--skip-compliance", NULL)) app->skip_compliance = 1;
    if (has_arg(argc, argv, "--skip-motd", NULL))       app->skip_motd = 1;
    if (has_arg(argc, argv, "--skip-ready-gate", NULL)) app->skip_ready_gate = 1;
    if (has_arg(argc, argv, "--fast-auth", NULL)) {
        app->fast_auth = 1;
        app->skip_compliance = 1;
        app->skip_motd = 1;
        app->skip_ready_gate = 1;
    }
    if (has_arg(argc, argv, "--stable-host", NULL)) app->stable_host = 1;
    if (has_arg(argc, argv, "--idle-timeout", &v) && v) app->idle_timeout = atoi(v);
    else app->idle_timeout = 900;
    if (has_arg(argc, argv, "--demo-pin", &v) && v) app->demo_pin = atoi(v);

    wgm_handoff_configure(app, argc, argv);
}

/* __argc / __argv come from the CRT (declared in stdlib.h on MinGW). */

int APIENTRY WinMain(HINSTANCE hi, HINSTANCE hp, LPSTR cmd, int show)
{
    (void)hp; (void)cmd; (void)show;
    g_app.hinst = hi;
    wgm_log_init();
    wgm_log("--- claims.exe start ---");

    int argc = __argc;
    char **argv = __argv;

    /* Quick exits: native installer (no PowerShell) — must run before any UI. */
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--install") == 0)   return wgm_setup_install();
        if (strcmp(argv[i], "--uninstall") == 0) return wgm_setup_uninstall();
    }

    /* Quick exits: --test and --prepare-demo-data (no UI) */
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--test") == 0) {
            int rc = wgm_run_tests();
            return rc;
        }
        if (strcmp(argv[i], "--reset-data") == 0) {
            wgm_model_reset(&g_app.model);
            wgm_model_free(&g_app.model);
            /* Allow --reset-data alone to terminate without UI when paired with --prepare. */
        }
    }
    int prepare_only = 0;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--prepare-demo-data") == 0) {
            prepare_only = 1;
            wgm_model_reset(&g_app.model);
            char data_dir[MAX_PATH];
            wgm_data_dir(data_dir, sizeof data_dir);
            wgm_log("--prepare-demo-data: wrote CSVs to %s", data_dir);
        }
    }
    if (prepare_only) {
        wgm_model_free(&g_app.model);
        return 0;
    }

    parse_cli(&g_app, argc, argv);

    /* Load model up front */
    wgm_model_load(&g_app.model);

    /* Run the legacy auth flow */
    if (wgm_login_run(&g_app) != 0) {
        wgm_log("login cancelled");
        wgm_model_free(&g_app.model);
        return 0;
    }

    /* Build the main window */
    if (wgm_main_create(&g_app) != 0) {
        MessageBoxA(NULL, "Failed to create main window.", "Claims Workstation",
                    MB_OK | MB_ICONERROR);
        wgm_model_free(&g_app.model);
        return 1;
    }

    /* Consume the orchestrator handoff (prefill -> prime UI -> ready.json). */
    if (g_app.handoff_active) {
        int rc = wgm_handoff_load_prefill(&g_app);
        if (rc == 0) {
            wgm_handoff_prime_and_ready(&g_app);
        } else if (rc == -2) {
            wgm_handoff_write_error(&g_app, "PREFILL_INVALID",
                "Prefill JSON is missing required fields (request_id and a selector).");
        } else {
            wgm_handoff_write_error(&g_app, "PREFILL_INVALID",
                "Prefill JSON could not be read.");
        }
    }

    int code = wgm_main_run(&g_app);
    wgm_log("--- claims.exe end ---");
    wgm_model_free(&g_app.model);
    return code;
}
