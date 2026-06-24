/*
 * ui_login.c - splash, compliance, login, staged auth, MOTD, ready gate.
 *
 * Each modal is gated by the corresponding --skip-* / --fast-auth CLI flag.
 * Splash and staged-auth windows are created dynamically and dismissed with a
 * WM_TIMER; the rest are dialog templates from claims.rc.
 */
#include "app.h"
#include "log.h"
#include "util.h"
#include "resource.h"

#include <commctrl.h>
#include <stdio.h>
#include <string.h>

WgmApp g_app;

/* PIN -> user table (matches PROMPT.md). */
typedef struct { const char *pin; const char *agent_id; const char *display; WgmRole role; } LoginRow;
static const LoginRow LOGIN_TABLE[] = {
    { "1234", "C1001", "A. Carter",  ROLE_CSR },
    { "2345", "C1002", "M. Johnson", ROLE_CSR },
    { "3456", "C1003", "R. Davis",   ROLE_SR  },
    { "9999", "M2001", "A. Morgan",  ROLE_MGR },
};
#define LOGIN_TABLE_N (int)(sizeof LOGIN_TABLE / sizeof LOGIN_TABLE[0])

static const char *role_name(WgmRole r)
{
    switch (r) {
    case ROLE_CSR: return "CSR";
    case ROLE_SR:  return "Senior CSR";
    case ROLE_MGR: return "Claims Manager";
    }
    return "?";
}

static int apply_pin(WgmApp *app, const char *pin)
{
    for (int i = 0; i < LOGIN_TABLE_N; ++i) {
        if (strcmp(LOGIN_TABLE[i].pin, pin) == 0) {
            wgm_strlcpy(app->user.pin,       LOGIN_TABLE[i].pin,       sizeof app->user.pin);
            wgm_strlcpy(app->user.agent_id,  LOGIN_TABLE[i].agent_id,  sizeof app->user.agent_id);
            wgm_strlcpy(app->user.display,   LOGIN_TABLE[i].display,   sizeof app->user.display);
            app->user.role = LOGIN_TABLE[i].role;
            return 0;
        }
    }
    return -1;
}

/* ---------------- Splash ---------------- */
static void show_splash_ms(WgmApp *app, int ms)
{
    if (app->no_splash || ms <= 0) return;
    HWND splash = CreateDialogParamA(app->hinst, MAKEINTRESOURCEA(IDD_SPLASH), NULL, NULL, 0);
    if (!splash) return;
    HWND prog = GetDlgItem(splash, IDC_SPLASH_PROGRESS);
    SendMessage(prog, PBM_SETRANGE32, 0, 100);
    SendMessage(prog, PBM_SETSTEP,    1, 0);
    ShowWindow(splash, SW_SHOW);
    UpdateWindow(splash);
    int steps = 20;
    int per   = ms / steps;
    if (per < 25) per = 25;
    for (int i = 0; i <= steps; ++i) {
        SendMessage(prog, PBM_SETPOS, (WPARAM)(i * 100 / steps), 0);
        MSG msg;
        while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
        Sleep((DWORD)per);
    }
    DestroyWindow(splash);
}

/* ---------------- Compliance ---------------- */
static INT_PTR CALLBACK compliance_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    (void)lp;
    if (m == WM_INITDIALOG)
        return TRUE;
    if (m == WM_COMMAND && LOWORD(wp) == IDC_COMPLIANCE_AGREE) {
        EndDialog(h, IDOK);
        return TRUE;
    }
    return FALSE;
}

static void show_compliance(WgmApp *app)
{
    if (app->skip_compliance) return;
    DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_COMPLIANCE), NULL, compliance_proc, 0);
    wgm_log_audit("compliance_ack", app->user.agent_id[0] ? app->user.agent_id : "-", "");
}

/* ---------------- Login dialog ---------------- */
typedef struct LoginCtx { WgmApp *app; int attempts; int editable; } LoginCtx;

/* Pin -> Agent ID quick lookup so a known PIN can fill the Agent ID display. */
static const char *pin_to_agent_id(const char *pin)
{
    if (!pin || !*pin) return NULL;
    for (int i = 0; i < LOGIN_TABLE_N; ++i)
        if (strcmp(LOGIN_TABLE[i].pin, pin) == 0)
            return LOGIN_TABLE[i].agent_id;
    return NULL;
}

static INT_PTR CALLBACK login_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    LoginCtx *ctx = (LoginCtx *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (m == WM_INITDIALOG) {
        ctx = (LoginCtx *)lp;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)ctx);
        /* Pre-populate Agent ID from persisted last_agent.txt; default C1001. */
        char last[16] = {0};
        if (wgm_read_last_agent(last, sizeof last) != 0 || !last[0])
            wgm_strlcpy(last, "C1001", sizeof last);
        SetDlgItemTextA(h, IDC_LOGIN_AGENT_ID, last);
        /* Agent ID starts read-only; Switch agent... unlocks it. */
        SendDlgItemMessageA(h, IDC_LOGIN_AGENT_ID, EM_SETREADONLY, TRUE, 0);
        ctx->editable = 0;
        SetDlgItemTextA(h, IDC_LOGIN_WORKSTATION, "T-1001");
        HWND cb = GetDlgItem(h, IDC_LOGIN_BRANCH);
        const char *branches[] = {"WST-014","EST-002","MID-007","SOU-021","NWE-009"};
        for (int i = 0; i < (int)(sizeof branches / sizeof *branches); ++i)
            SendMessageA(cb, CB_ADDSTRING, 0, (LPARAM)branches[i]);
        SendMessageA(cb, CB_SETCURSEL, 0, 0);
        SetFocus(GetDlgItem(h, IDC_LOGIN_PIN));
        return FALSE; /* we set focus ourselves */
    }
    if (m == WM_COMMAND && LOWORD(wp) == IDC_LOGIN_SWITCH) {
        /* Toggle Agent ID edit to writable for this login attempt. */
        SendDlgItemMessageA(h, IDC_LOGIN_AGENT_ID, EM_SETREADONLY, FALSE, 0);
        ctx->editable = 1;
        SetDlgItemTextA(h, IDC_LOGIN_STATUS,
            "Agent ID is now editable for this sign-on. Enter new ID and PIN.");
        SetFocus(GetDlgItem(h, IDC_LOGIN_AGENT_ID));
        SendDlgItemMessageA(h, IDC_LOGIN_AGENT_ID, EM_SETSEL, 0, -1);
        return TRUE;
    }
    if (m == WM_COMMAND && LOWORD(wp) == IDC_LOGIN_CONNECT) {
        char agent[16] = {0}, pin[8] = {0};
        GetDlgItemTextA(h, IDC_LOGIN_AGENT_ID, agent, sizeof agent);
        GetDlgItemTextA(h, IDC_LOGIN_PIN,      pin,   sizeof pin);
        if (apply_pin(ctx->app, pin) == 0) {
            /* Cross-check: if agent typed an Agent ID, it should match the PIN's
             * agent. If not, treat as a mismatch (still demo-only). */
            const char *expected = pin_to_agent_id(pin);
            if (agent[0] && expected && strcmp(agent, expected) != 0) {
                ctx->attempts++;
                char msg[160];
                _snprintf(msg, sizeof msg,
                          "Agent ID does not match PIN. %d of 3 failed attempts.",
                          ctx->attempts);
                SetDlgItemTextA(h, IDC_LOGIN_STATUS, msg);
                wgm_log_audit("login_mismatch", agent, msg);
                ctx->app->user.agent_id[0] = '\0';
                ctx->app->user.display[0]  = '\0';
                return TRUE;
            }
            wgm_write_last_agent(ctx->app->user.agent_id);
            wgm_log_audit("login_success", ctx->app->user.agent_id, "");
            EndDialog(h, IDOK);
            return TRUE;
        }
        ctx->attempts++;
        char msg[160];
        if (ctx->attempts >= 3) {
            _snprintf(msg, sizeof msg,
                      "Account locked. Contact your branch supervisor (ext. 7400).");
            EnableWindow(GetDlgItem(h, IDC_LOGIN_CONNECT), FALSE);
            SetDlgItemTextA(h, IDC_LOGIN_STATUS, msg);
            wgm_log_audit("login_locked", agent, "");
            /* Demo-friendly: 5-second cooldown (not 30) to keep tests moving. */
            SetTimer(h, 1, 5000, NULL);
        } else {
            int remaining = 3 - ctx->attempts;
            (void)remaining;
            _snprintf(msg, sizeof msg,
                      "Authentication failed. %d of 3 failed attempts.%s",
                      ctx->attempts,
                      ctx->attempts == 2 ? " Account will be locked after the next failed attempt." : "");
            SetDlgItemTextA(h, IDC_LOGIN_STATUS, msg);
            wgm_log_audit("login_fail", agent, msg);
        }
        return TRUE;
    }
    if (m == WM_TIMER && wp == 1) {
        KillTimer(h, 1);
        ctx->attempts = 0;
        EnableWindow(GetDlgItem(h, IDC_LOGIN_CONNECT), TRUE);
        SetDlgItemTextA(h, IDC_LOGIN_STATUS, "Account unlocked. Please try again.");
        return TRUE;
    }
    if (m == WM_CLOSE) {
        EndDialog(h, IDCANCEL);
        return TRUE;
    }
    return FALSE;
}

static int do_interactive_login(WgmApp *app)
{
    LoginCtx ctx = { app, 0, 0 };
    INT_PTR r = DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_LOGIN), NULL,
                                login_proc, (LPARAM)&ctx);
    return r == IDOK ? 0 : -1;
}

/* ---------------- Staged auth ---------------- */
static const char *AUTH_LINES[] = {
    "Establishing host link to WMHOST01 ...",
    "Validating credentials ...",
    "Loading user profile ...",
    "Checking terminal authorization (T-1001) ...",
    "Loading menu permissions ...",
    "Synchronizing local cache ...",
    "Welcome - HOST: LINKED."
};
#define AUTH_N (int)(sizeof AUTH_LINES / sizeof AUTH_LINES[0])

static void show_staged_auth(WgmApp *app)
{
    if (app->fast_auth) {
        /* 200 ms single-line flash */
        HWND dlg = CreateDialogParamA(app->hinst, MAKEINTRESOURCEA(IDD_STAGED_AUTH), NULL, NULL, 0);
        if (dlg) {
            HWND lb = GetDlgItem(dlg, IDC_AUTH_LIST);
            SendMessageA(lb, LB_ADDSTRING, 0, (LPARAM)"Establishing session (fast-auth) ...");
            ShowWindow(dlg, SW_SHOW);
            UpdateWindow(dlg);
            Sleep(200);
            DestroyWindow(dlg);
        }
        return;
    }
    HWND dlg = CreateDialogParamA(app->hinst, MAKEINTRESOURCEA(IDD_STAGED_AUTH), NULL, NULL, 0);
    if (!dlg) return;
    HWND lb = GetDlgItem(dlg, IDC_AUTH_LIST);
    ShowWindow(dlg, SW_SHOW);
    UpdateWindow(dlg);
    for (int i = 0; i < AUTH_N; ++i) {
        char line[160];
        if (i == 2 && app->user.display[0])
            _snprintf(line, sizeof line, "Loading user profile for %s ...", app->user.display);
        else if (i == AUTH_N - 1 && app->user.display[0])
            _snprintf(line, sizeof line, "Welcome, %s (%s). HOST: LINKED.",
                      app->user.display, role_name(app->user.role));
        else
            _snprintf(line, sizeof line, "%s", AUTH_LINES[i]);
        SendMessageA(lb, LB_ADDSTRING, 0, (LPARAM)line);
        MSG msg;
        while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
        Sleep(500);
    }
    Sleep(500);
    DestroyWindow(dlg);
}

/* ---------------- MOTD ---------------- */
static const char *MOTD_TEXT =
    "NOTICE FROM CLAIMS OPERATIONS - 04/15/2024 06:00 EST\r\n\r\n"
    "Catastrophe event declared: Hurricane Donovan, FL region. All Florida "
    "property claims must be escalated to the Catastrophe Unit (FO-FL-CAT) "
    "for review prior to reserve setting. Standard SLAs are suspended for "
    "affected ZIP codes through 04/30/2024.\r\n\r\n"
    "- Claims Ops Desk, ext. 7421";

static INT_PTR CALLBACK motd_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    (void)lp;
    if (m == WM_INITDIALOG) {
        SetDlgItemTextA(h, IDC_MOTD_TEXT, MOTD_TEXT);
        return TRUE;
    }
    if (m == WM_COMMAND && LOWORD(wp) == IDC_MOTD_ACK) {
        EndDialog(h, IDOK);
        return TRUE;
    }
    return FALSE;
}

static void show_motd(WgmApp *app)
{
    if (app->skip_motd) return;
    DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_MOTD), NULL, motd_proc, 0);
    wgm_log_audit("motd_ack", app->user.agent_id, "");
}

/* ---------------- Ready gate ---------------- */
typedef struct ReadyCtx { WgmApp *app; } ReadyCtx;

static INT_PTR CALLBACK ready_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    ReadyCtx *ctx = (ReadyCtx *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (m == WM_INITDIALOG) {
        ctx = (ReadyCtx *)lp;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)ctx);
        HWND cb = GetDlgItem(h, IDC_READY_AUX);
        static const char *AUX[] = { "BREAK", "MEAL", "TRAINING", "OUTBOUND", "TECH-ISSUE" };
        for (int i = 0; i < (int)(sizeof AUX / sizeof *AUX); ++i)
            SendMessageA(cb, CB_ADDSTRING, 0, (LPARAM)AUX[i]);
        SendMessageA(cb, CB_SETCURSEL, 0, 0);
        return TRUE;
    }
    if (m == WM_COMMAND) {
        if (LOWORD(wp) == IDC_READY_YES) {
            ctx->app->ready = 1;
            ctx->app->aux_code[0] = '\0';
            EndDialog(h, IDOK);
            return TRUE;
        }
        if (LOWORD(wp) == IDC_READY_NO) {
            HWND cb = GetDlgItem(h, IDC_READY_AUX);
            int sel = (int)SendMessageA(cb, CB_GETCURSEL, 0, 0);
            char buf[16] = {0};
            if (sel >= 0)
                SendMessageA(cb, CB_GETLBTEXT, (WPARAM)sel, (LPARAM)buf);
            ctx->app->ready = 0;
            wgm_strlcpy(ctx->app->aux_code, buf, sizeof ctx->app->aux_code);
            EndDialog(h, IDOK);
            return TRUE;
        }
    }
    if (m == WM_CLOSE) {
        ctx->app->ready = 1;
        EndDialog(h, IDOK);
        return TRUE;
    }
    return FALSE;
}

static void show_ready_gate(WgmApp *app)
{
    if (app->skip_ready_gate) {
        app->ready = 1;
        app->aux_code[0] = '\0';
        return;
    }
    ReadyCtx ctx = { app };
    DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_READY_GATE), NULL, ready_proc, (LPARAM)&ctx);
    wgm_log_audit("ready_state", app->user.agent_id, app->ready ? "READY" : app->aux_code);
}

/* ---------------- About ---------------- */
static INT_PTR CALLBACK about_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    (void)lp;
    if (m == WM_INITDIALOG)
        return TRUE;
    if (m == WM_COMMAND && LOWORD(wp) == IDOK) {
        EndDialog(h, IDOK);
        return TRUE;
    }
    return FALSE;
}

void wgm_show_about(HWND parent)
{
    DialogBoxParamA(g_app.hinst, MAKEINTRESOURCEA(IDD_ABOUT), parent, about_proc, 0);
}

/* ---------------- Public entry: full legacy auth sequence ---------------- */
int wgm_login_run(WgmApp *app)
{
    int splash_ms = app->fast_auth ? 200 : 1800;
    show_splash_ms(app, splash_ms);

    show_compliance(app);

    if (app->demo_pin) {
        char pin[8];
        _snprintf(pin, sizeof pin, "%d", app->demo_pin);
        if (apply_pin(app, pin) != 0) {
            /* Default to CSR A. Carter on bad demo PIN */
            apply_pin(app, "1234");
        }
        wgm_write_last_agent(app->user.agent_id);
        wgm_log_audit("login_demo_pin", app->user.agent_id, pin);
    } else {
        if (do_interactive_login(app) != 0)
            return -1;
    }

    show_staged_auth(app);
    show_motd(app);
    show_ready_gate(app);
    return 0;
}
