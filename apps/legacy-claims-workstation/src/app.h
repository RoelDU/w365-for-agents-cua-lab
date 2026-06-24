/*
 * app.h - shared state and entry points used across UI modules.
 */
#ifndef WGM_APP_H
#define WGM_APP_H

#include <windows.h>
#include "data.h"

#define WGM_MAIN_TITLE "Zava Mutual - Claims Workstation v1.0"
/* "Zava Mutual - Claims Workstation v1.0" with U+2014 EM DASH */

#define WGM_FNOL_STEPS 5

typedef struct WgmAuxList { const char *code; const char *desc; } WgmAuxList;

typedef enum {
    ROLE_CSR = 0,
    ROLE_SR  = 1,
    ROLE_MGR = 2
} WgmRole;

typedef struct WgmUser {
    char pin[8];
    char agent_id[16];   /* C1001 / M2001 */
    char display[32];    /* "A. Carter"  */
    WgmRole role;
} WgmUser;

typedef struct WgmFnolVehicle {
    char year[8];
    char make[32];
    char model[32];
    char vin[24];
    char damage[128];
} WgmFnolVehicle;

typedef struct WgmFnolParty {
    char role[24];  /* CLAIMANT / WITNESS / OTHER DRIVER */
    char name[64];
    char phone[24];
    char addr[128];
} WgmFnolParty;

typedef struct WgmFnolState {
    int step;                    /* 0..4 */
    char loss_date[16];
    char loss_time[8];
    char loss_location[128];
    char loss_type[24];
    char narrative[600];
    WgmFnolVehicle vehicles[8];
    int  n_vehicles;
    WgmFnolParty parties[8];
    int  n_parties;
    int  cov_applied[16];        /* checkbox flags per coverage row */
    int  n_covs;                 /* number of coverages displayed */
    double total_deductible;
    int submitted;
    char claim_id[24];
} WgmFnolState;

typedef struct WgmApp {
    HINSTANCE  hinst;
    HWND       hwnd_main;
    HWND       hwnd_tabs;
    HWND       hwnd_status;
    HWND       hwnd_search_results;
    HWND       hwnd_search_input;

    /* Tab content windows (visible based on current tab) */
    HWND       hwnd_tab_policy;
    HWND       hwnd_tab_coverage;
    HWND       hwnd_tab_claims;
    HWND       hwnd_tab_fnol;
    HWND       hwnd_tab_notes;

    /* Selection */
    int        selected_customer_idx;
    int        selected_policy_idx;

    /* Logged-in user */
    WgmUser    user;
    int        ready;        /* 1 = READY, 0 = aux */
    char       aux_code[16];

    /* CLI / runtime */
    int        no_splash;
    int        skip_compliance;
    int        skip_motd;
    int        skip_ready_gate;
    int        fast_auth;
    int        idle_timeout;
    int        stable_host;
    int        demo_pin;       /* 0 = none */

    /* FNOL */
    WgmFnolState fnol;

    /* Data */
    WgmModel   model;

    /* Faux host link */
    int        host_linked;

    /* Agent365 / orchestrator handoff (see handoff.h / INTEGRATION.md) */
    int        handoff_active;
    char       handoff_prefill_path[MAX_PATH];
    char       handoff_ready_path[MAX_PATH];
    char       handoff_result_path[MAX_PATH];
    char       handoff_error_path[MAX_PATH];
    char       hf_request_id[64];
    char       hf_policy_number[40];
    char       hf_caller_phone[40];
    char       hf_intent[40];
    char       hf_summary[256];
    char       hf_matched_customer[80];
    char       hf_matched_policy[40];
} WgmApp;

extern WgmApp g_app;

/* ----- Login / auth flow ----- */
int  wgm_login_run(WgmApp *app);            /* Splash -> compliance -> login -> staged auth -> MOTD -> ready gate */
void wgm_show_about(HWND parent);

/* ----- Main window ----- */
int  wgm_main_create(WgmApp *app);          /* Creates the main window; returns 0 OK */
int  wgm_main_run(WgmApp *app);             /* Pumps messages; returns exit code */
void wgm_main_refresh_status(WgmApp *app);  /* Repaint status bar */
void wgm_main_load_customer(WgmApp *app, int customer_idx, int prefer_policy_idx);

/* ----- FNOL wizard (panel inside the main window) ----- */
void wgm_fnol_init(WgmApp *app);
void wgm_fnol_show_step(WgmApp *app, int step);
void wgm_fnol_set_loss_type(WgmApp *app, const char *loss_type);
void wgm_fnol_set_narrative(WgmApp *app, const char *narrative);
int  wgm_fnol_submit(WgmApp *app);          /* Submit; returns 0 OK, sets g_app.fnol.claim_id */

/* Map intent string ("auto_collision") to legacy loss type ("COLLISION"). */
const char *wgm_intent_to_loss_type(const char *intent);

#endif /* WGM_APP_H */
