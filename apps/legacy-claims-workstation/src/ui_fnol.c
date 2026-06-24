/*
 * ui_fnol.c - single-window FNOL wizard (5 steps), hosted inside the main
 * window's "New FNOL" tab page. Steps are sibling child windows that are
 * shown/hidden by Back/Next; no PropertySheet, no modeless popups.
 */
#include "app.h"
#include "data.h"
#include "handoff.h"
#include "log.h"
#include "resource.h"
#include "util.h"

#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern WgmApp g_app;

static const char *STEP_LABELS[WGM_FNOL_STEPS] = {
    "Step 1 of 5  -  Incident",
    "Step 2 of 5  -  Vehicles / Property",
    "Step 3 of 5  -  Parties",
    "Step 4 of 5  -  Coverage Application",
    "Step 5 of 5  -  Review & Submit"
};

static HWND g_step_panels[WGM_FNOL_STEPS];

/* Custom window class for FNOL step containers. STATIC controls do not
 * forward WM_COMMAND or WM_NOTIFY to their parents, which means any buttons
 * (e.g. Add Vehicle, Add Party) embedded in a STATIC-hosted step page would
 * never reach the FNOL pane's wndproc. This class forwards both message
 * families up to the step panel's parent (the FNOL pane). */
static const char *STEP_PANEL_CLASS = "WgmFnolStepPanel";
static int g_step_panel_registered = 0;

static LRESULT CALLBACK fnol_step_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    switch (m) {
    case WM_COMMAND:
    case WM_NOTIFY: {
        HWND parent = GetParent(h);
        if (parent) return SendMessageA(parent, m, wp, lp);
        break;
    }
    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORBTN:
    case WM_CTLCOLORDLG:
    case WM_CTLCOLORLISTBOX: {
        HDC dc = (HDC)wp;
        SetBkMode(dc, OPAQUE);
        SetBkColor(dc, GetSysColor(COLOR_3DFACE));
        return (LRESULT)GetSysColorBrush(COLOR_3DFACE);
    }
    case WM_ERASEBKGND: {
        HDC dc = (HDC)wp;
        RECT r; GetClientRect(h, &r);
        FillRect(dc, &r, GetSysColorBrush(COLOR_3DFACE));
        return 1;
    }
    }
    return DefWindowProcA(h, m, wp, lp);
}

static void register_step_panel_class(void)
{
    if (g_step_panel_registered) return;
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = fnol_step_proc;
    wc.hInstance = g_app.hinst;
    wc.hCursor = LoadCursorA(NULL, MAKEINTRESOURCEA(32512)); /* IDC_ARROW */
    wc.hbrBackground = (HBRUSH)(COLOR_3DFACE + 1);
    wc.lpszClassName = STEP_PANEL_CLASS;
    if (RegisterClassA(&wc)) g_step_panel_registered = 1;
}

/* Lazily-created child IDs that live across panels (Back/Next/Cancel/Submit). */
static HWND g_step_label;
static HWND g_btn_back, g_btn_next, g_btn_cancel, g_btn_submit;
static HWND g_result_label, g_result_edit;

/* Step 1 */
static HWND e_loss_date, e_loss_time, e_loss_loc, e_loss_type, e_narrative;
/* Step 2 */
static HWND lv_vehicles, b_veh_add, b_veh_rm;
/* Step 3 */
static HWND lv_parties, b_party_add, b_party_rm;
/* Step 4 */
static HWND lv_cov, e_ded;
/* Step 5 */
static HWND e_review;

static const char *LOSS_TYPES_LIST[] = {
    "COLLISION","THEFT","FIRE","WATER","WIND","LIABILITY","GLASS","VANDALISM"
};

static void apply_font_recursive(HWND h)
{
    HFONT f = (HFONT)SendMessageA(GetParent(h), WM_GETFONT, 0, 0);
    if (!f) return;
    SendMessageA(h, WM_SETFONT, (WPARAM)f, TRUE);
    HWND c = GetWindow(h, GW_CHILD);
    while (c) {
        SendMessageA(c, WM_SETFONT, (WPARAM)f, TRUE);
        c = GetWindow(c, GW_HWNDNEXT);
    }
}

/* Build a step container window child of the FNOL pane. */
static HWND build_step_container(HWND parent, int x, int y, int w, int h)
{
    register_step_panel_class();
    HWND s = CreateWindowExA(0, STEP_PANEL_CLASS, "",
        WS_CHILD | WS_CLIPCHILDREN,
        x, y, w, h, parent, NULL, g_app.hinst, NULL);
    return s;
}

static void build_step1(HWND parent)
{
    int x = 8, y = 8;
    CreateWindowExA(0, "STATIC", "Loss Date (MM/DD/YYYY):",
        WS_CHILD | WS_VISIBLE, x, y, 160, 16, parent, NULL, g_app.hinst, NULL);
    e_loss_date = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
        x + 170, y - 2, 110, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_LOSS_DATE,
        g_app.hinst, NULL);
    CreateWindowExA(0, "STATIC", "Time (HH:MM):",
        WS_CHILD | WS_VISIBLE, x + 300, y, 90, 16, parent, NULL, g_app.hinst, NULL);
    e_loss_time = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
        x + 396, y - 2, 80, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_LOSS_TIME,
        g_app.hinst, NULL);
    y += 28;

    CreateWindowExA(0, "STATIC", "Loss Location:",
        WS_CHILD | WS_VISIBLE, x, y, 160, 16, parent, NULL, g_app.hinst, NULL);
    e_loss_loc = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
        x + 170, y - 2, 460, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_LOSS_LOCATION,
        g_app.hinst, NULL);
    y += 28;

    CreateWindowExA(0, "STATIC", "Loss Type:",
        WS_CHILD | WS_VISIBLE, x, y, 160, 16, parent, NULL, g_app.hinst, NULL);
    e_loss_type = CreateWindowExA(0, "COMBOBOX", "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
        x + 170, y - 2, 180, 200, parent, (HMENU)(LONG_PTR)IDC_FNOL_LOSS_TYPE,
        g_app.hinst, NULL);
    for (int i = 0; i < (int)(sizeof LOSS_TYPES_LIST / sizeof *LOSS_TYPES_LIST); ++i)
        SendMessageA(e_loss_type, CB_ADDSTRING, 0, (LPARAM)LOSS_TYPES_LIST[i]);
    SendMessageA(e_loss_type, CB_SETCURSEL, 0, 0);
    y += 28;

    CreateWindowExA(0, "STATIC", "Narrative (adjuster shorthand):",
        WS_CHILD | WS_VISIBLE, x, y, 280, 16, parent, NULL, g_app.hinst, NULL);
    y += 18;
    e_narrative = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL |
        ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN,
        x, y, 700, 240,
        parent, (HMENU)(LONG_PTR)IDC_FNOL_NARRATIVE, g_app.hinst, NULL);
}

static void build_step2(HWND parent)
{
    int x = 8, y = 8;
    CreateWindowExA(0, "STATIC", "Vehicles / Property involved",
        WS_CHILD | WS_VISIBLE, x, y, 280, 16, parent, NULL, g_app.hinst, NULL);
    y += 18;
    lv_vehicles = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS,
        x, y, 700, 220,
        parent, (HMENU)(LONG_PTR)IDC_FNOL_VEH_LIST, g_app.hinst, NULL);
    LVCOLUMNA c = {0}; c.mask = LVCF_TEXT | LVCF_WIDTH;
    c.cx = 60;  c.pszText = (char *)"Year";   SendMessageA(lv_vehicles, LVM_INSERTCOLUMNA, 0, (LPARAM)&c);
    c.cx = 100; c.pszText = (char *)"Make";   SendMessageA(lv_vehicles, LVM_INSERTCOLUMNA, 1, (LPARAM)&c);
    c.cx = 120; c.pszText = (char *)"Model";  SendMessageA(lv_vehicles, LVM_INSERTCOLUMNA, 2, (LPARAM)&c);
    c.cx = 150; c.pszText = (char *)"VIN";    SendMessageA(lv_vehicles, LVM_INSERTCOLUMNA, 3, (LPARAM)&c);
    c.cx = 220; c.pszText = (char *)"Damage"; SendMessageA(lv_vehicles, LVM_INSERTCOLUMNA, 4, (LPARAM)&c);
    y += 226;
    b_veh_add = CreateWindowExA(0, "BUTTON", "&Add...",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x, y, 70, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_VEH_ADD, g_app.hinst, NULL);
    b_veh_rm = CreateWindowExA(0, "BUTTON", "&Remove",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x + 76, y, 70, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_VEH_REMOVE, g_app.hinst, NULL);
}

static void build_step3(HWND parent)
{
    int x = 8, y = 8;
    CreateWindowExA(0, "STATIC", "Parties (claimant, other parties, witnesses)",
        WS_CHILD | WS_VISIBLE, x, y, 360, 16, parent, NULL, g_app.hinst, NULL);
    y += 18;
    lv_parties = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS,
        x, y, 700, 220,
        parent, (HMENU)(LONG_PTR)IDC_FNOL_PARTY_LIST, g_app.hinst, NULL);
    LVCOLUMNA c = {0}; c.mask = LVCF_TEXT | LVCF_WIDTH;
    c.cx = 110; c.pszText = (char *)"Role";    SendMessageA(lv_parties, LVM_INSERTCOLUMNA, 0, (LPARAM)&c);
    c.cx = 180; c.pszText = (char *)"Name";    SendMessageA(lv_parties, LVM_INSERTCOLUMNA, 1, (LPARAM)&c);
    c.cx = 140; c.pszText = (char *)"Phone";   SendMessageA(lv_parties, LVM_INSERTCOLUMNA, 2, (LPARAM)&c);
    c.cx = 240; c.pszText = (char *)"Address"; SendMessageA(lv_parties, LVM_INSERTCOLUMNA, 3, (LPARAM)&c);
    y += 226;
    b_party_add = CreateWindowExA(0, "BUTTON", "&Add...",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x, y, 70, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_PARTY_ADD, g_app.hinst, NULL);
    b_party_rm = CreateWindowExA(0, "BUTTON", "&Remove",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x + 76, y, 70, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_PARTY_REMOVE, g_app.hinst, NULL);
}

static void build_step4(HWND parent)
{
    int x = 8, y = 8;
    CreateWindowExA(0, "STATIC", "Coverage Application - check coverages that apply to this loss:",
        WS_CHILD | WS_VISIBLE, x, y, 420, 16, parent, NULL, g_app.hinst, NULL);
    y += 18;
    lv_cov = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS,
        x, y, 700, 220,
        parent, (HMENU)(LONG_PTR)IDC_FNOL_COV_LIST, g_app.hinst, NULL);
    DWORD ex = (DWORD)SendMessageA(lv_cov, LVM_GETEXTENDEDLISTVIEWSTYLE, 0, 0);
    SendMessageA(lv_cov, LVM_SETEXTENDEDLISTVIEWSTYLE, 0, ex | LVS_EX_CHECKBOXES | LVS_EX_FULLROWSELECT);
    LVCOLUMNA c = {0}; c.mask = LVCF_TEXT | LVCF_WIDTH;
    c.cx = 120; c.pszText = (char *)"Code";       SendMessageA(lv_cov, LVM_INSERTCOLUMNA, 0, (LPARAM)&c);
    c.cx = 240; c.pszText = (char *)"Description"; SendMessageA(lv_cov, LVM_INSERTCOLUMNA, 1, (LPARAM)&c);
    c.cx = 120; c.pszText = (char *)"Limit";      SendMessageA(lv_cov, LVM_INSERTCOLUMNA, 2, (LPARAM)&c);
    c.cx = 110; c.pszText = (char *)"Deductible"; SendMessageA(lv_cov, LVM_INSERTCOLUMNA, 3, (LPARAM)&c);
    y += 226;
    CreateWindowExA(0, "STATIC", "Combined Deductible:",
        WS_CHILD | WS_VISIBLE, x, y, 160, 16, parent, NULL, g_app.hinst, NULL);
    e_ded = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "$0.00",
        WS_CHILD | WS_VISIBLE | ES_READONLY,
        x + 170, y - 2, 120, 22, parent, (HMENU)(LONG_PTR)IDC_FNOL_COV_DEDUCTIBLE,
        g_app.hinst, NULL);
}

static void build_step5(HWND parent)
{
    int x = 8, y = 8;
    CreateWindowExA(0, "STATIC", "Review the FNOL below, then click Submit Claim:",
        WS_CHILD | WS_VISIBLE, x, y, 460, 16, parent, NULL, g_app.hinst, NULL);
    y += 18;
    e_review = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_READONLY | WS_VSCROLL,
        x, y, 700, 220,
        parent, (HMENU)(LONG_PTR)IDC_FNOL_REVIEW_TEXT, g_app.hinst, NULL);
    y += 226;
    g_result_label = CreateWindowExA(0, "STATIC", "Claim ID (after submission):",
        WS_CHILD | WS_VISIBLE, x, y, 200, 16, parent,
        (HMENU)(LONG_PTR)IDC_FNOL_RESULT_LABEL, g_app.hinst, NULL);
    g_result_edit = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 210, y - 2, 220, 22,
        parent, (HMENU)(LONG_PTR)IDC_FNOL_RESULT_CLAIMID, g_app.hinst, NULL);
}

void wgm_fnol_init(WgmApp *app)
{
    HWND pane = app->hwnd_tab_fnol;
    /* Header label and nav buttons live at the top of the pane and persist. */
    g_step_label = CreateWindowExA(0, "STATIC", STEP_LABELS[0],
        WS_CHILD | WS_VISIBLE,
        12, 8, 480, 18, pane, (HMENU)(LONG_PTR)IDC_FNOL_STEPLABEL, app->hinst, NULL);

    g_btn_back = CreateWindowExA(0, "BUTTON", "< &Back",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_DISABLED,
        500, 4, 70, 24, pane, (HMENU)(LONG_PTR)IDC_FNOL_BACK, app->hinst, NULL);
    g_btn_next = CreateWindowExA(0, "BUTTON", "&Next >",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
        576, 4, 70, 24, pane, (HMENU)(LONG_PTR)IDC_FNOL_NEXT, app->hinst, NULL);
    g_btn_cancel = CreateWindowExA(0, "BUTTON", "&Cancel",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        652, 4, 70, 24, pane, (HMENU)(LONG_PTR)IDC_FNOL_CANCEL, app->hinst, NULL);
    g_btn_submit = CreateWindowExA(0, "BUTTON", "S&ubmit Claim",
        WS_CHILD | WS_TABSTOP,
        500, 32, 110, 24, pane, (HMENU)(LONG_PTR)IDC_FNOL_SUBMIT, app->hinst, NULL);

    int sy = 64;
    for (int i = 0; i < WGM_FNOL_STEPS; ++i) {
        g_step_panels[i] = build_step_container(pane, 0, sy, 740, 480);
    }
    build_step1(g_step_panels[0]);
    build_step2(g_step_panels[1]);
    build_step3(g_step_panels[2]);
    build_step4(g_step_panels[3]);
    build_step5(g_step_panels[4]);

    /* Default current date/time into Step 1 */
    SYSTEMTIME st; GetLocalTime(&st);
    char d[16], t[8];
    int y = st.wYear; if (y > 2024) y = 2024;
    _snprintf(d, sizeof d, "%02d/%02d/%04d", st.wMonth, st.wDay, y);
    _snprintf(t, sizeof t, "%02d:%02d", st.wHour, st.wMinute);
    SetWindowTextA(e_loss_date, d);
    SetWindowTextA(e_loss_time, t);

    app->fnol.step = 0;
    wgm_strlcpy(app->fnol.loss_date, d, sizeof app->fnol.loss_date);
    wgm_strlcpy(app->fnol.loss_time, t, sizeof app->fnol.loss_time);
    wgm_strlcpy(app->fnol.loss_type, "COLLISION", sizeof app->fnol.loss_type);
    apply_font_recursive(pane);
    wgm_fnol_show_step(app, 0);
}

/* --- Add Vehicle dialog ----------------------------------------------- */
typedef struct VehCtx { WgmFnolVehicle v; } VehCtx;
static INT_PTR CALLBACK veh_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    VehCtx *ctx = (VehCtx *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (m == WM_INITDIALOG) {
        ctx = (VehCtx *)lp;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)ctx);
        /* Sensible defaults; Year must be 1980..2026 per spec */
        SetDlgItemTextA(h, IDC_VEH_YEAR,   "2024");
        SetDlgItemTextA(h, IDC_VEH_MAKE,   "");
        SetDlgItemTextA(h, IDC_VEH_MODEL,  "");
        SetDlgItemTextA(h, IDC_VEH_VIN,    "");
        SetDlgItemTextA(h, IDC_VEH_DAMAGE, "");
        SendDlgItemMessageA(h, IDC_VEH_VIN, EM_SETLIMITTEXT, (WPARAM)17, 0);
        SetFocus(GetDlgItem(h, IDC_VEH_MAKE));
        return FALSE;
    }
    if (m == WM_COMMAND) {
        if (LOWORD(wp) == IDOK) {
            char year[8] = {0};
            GetDlgItemTextA(h, IDC_VEH_YEAR, year, (int)sizeof year);
            int y = atoi(year);
            if (y < 1980 || y > 2026) {
                MessageBoxA(h,
                    "Year must be between 1980 and 2026.",
                    "Add Vehicle / Property", MB_OK | MB_ICONERROR);
                SetFocus(GetDlgItem(h, IDC_VEH_YEAR));
                SendDlgItemMessageA(h, IDC_VEH_YEAR, EM_SETSEL, 0, -1);
                return TRUE;
            }
            wgm_strlcpy(ctx->v.year, year, sizeof ctx->v.year);
            GetDlgItemTextA(h, IDC_VEH_MAKE,   ctx->v.make,   (int)sizeof ctx->v.make);
            GetDlgItemTextA(h, IDC_VEH_MODEL,  ctx->v.model,  (int)sizeof ctx->v.model);
            GetDlgItemTextA(h, IDC_VEH_VIN,    ctx->v.vin,    (int)sizeof ctx->v.vin);
            GetDlgItemTextA(h, IDC_VEH_DAMAGE, ctx->v.damage, (int)sizeof ctx->v.damage);
            EndDialog(h, IDOK);
            return TRUE;
        }
        if (LOWORD(wp) == IDCANCEL) { EndDialog(h, IDCANCEL); return TRUE; }
    }
    return FALSE;
}

/* --- Add Party dialog ----------------------------------------------- */
typedef struct PartyCtx { WgmFnolParty p; } PartyCtx;
static INT_PTR CALLBACK party_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    PartyCtx *ctx = (PartyCtx *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (m == WM_INITDIALOG) {
        ctx = (PartyCtx *)lp;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)ctx);
        HWND cb = GetDlgItem(h, IDC_PARTY_ROLE);
        static const char *ROLES[] = { "CLAIMANT", "OTHER DRIVER", "WITNESS", "PASSENGER" };
        for (int i = 0; i < 4; ++i)
            SendMessageA(cb, CB_ADDSTRING, 0, (LPARAM)ROLES[i]);
        SendMessageA(cb, CB_SETCURSEL, 0, 0);
        return TRUE;
    }
    if (m == WM_COMMAND) {
        if (LOWORD(wp) == IDOK) {
            HWND cb = GetDlgItem(h, IDC_PARTY_ROLE);
            int s = (int)SendMessageA(cb, CB_GETCURSEL, 0, 0);
            if (s >= 0) SendMessageA(cb, CB_GETLBTEXT, (WPARAM)s, (LPARAM)ctx->p.role);
            GetDlgItemTextA(h, IDC_PARTY_NAME,  ctx->p.name,  (int)sizeof ctx->p.name);
            GetDlgItemTextA(h, IDC_PARTY_PHONE, ctx->p.phone, (int)sizeof ctx->p.phone);
            GetDlgItemTextA(h, IDC_PARTY_ADDR,  ctx->p.addr,  (int)sizeof ctx->p.addr);
            EndDialog(h, IDOK);
            return TRUE;
        }
        if (LOWORD(wp) == IDCANCEL) { EndDialog(h, IDCANCEL); return TRUE; }
    }
    return FALSE;
}

static void refresh_vehicles(WgmApp *app)
{
    SendMessageA(lv_vehicles, LVM_DELETEALLITEMS, 0, 0);
    for (int i = 0; i < app->fnol.n_vehicles; ++i) {
        WgmFnolVehicle *v = &app->fnol.vehicles[i];
        LVITEMA it = {0}; it.mask = LVIF_TEXT; it.iItem = i; it.pszText = v->year;
        int r = (int)SendMessageA(lv_vehicles, LVM_INSERTITEMA, 0, (LPARAM)&it);
        LVITEMA s = {0}; s.mask = LVIF_TEXT; s.iItem = r;
        s.iSubItem = 1; s.pszText = v->make;   SendMessageA(lv_vehicles, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 2; s.pszText = v->model;  SendMessageA(lv_vehicles, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 3; s.pszText = v->vin;    SendMessageA(lv_vehicles, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 4; s.pszText = v->damage; SendMessageA(lv_vehicles, LVM_SETITEMA, 0, (LPARAM)&s);
    }
}

static void refresh_parties(WgmApp *app)
{
    SendMessageA(lv_parties, LVM_DELETEALLITEMS, 0, 0);
    for (int i = 0; i < app->fnol.n_parties; ++i) {
        WgmFnolParty *p = &app->fnol.parties[i];
        LVITEMA it = {0}; it.mask = LVIF_TEXT; it.iItem = i; it.pszText = p->role;
        int r = (int)SendMessageA(lv_parties, LVM_INSERTITEMA, 0, (LPARAM)&it);
        LVITEMA s = {0}; s.mask = LVIF_TEXT; s.iItem = r;
        s.iSubItem = 1; s.pszText = p->name;  SendMessageA(lv_parties, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 2; s.pszText = p->phone; SendMessageA(lv_parties, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 3; s.pszText = p->addr;  SendMessageA(lv_parties, LVM_SETITEMA, 0, (LPARAM)&s);
    }
}

static void refresh_coverages(WgmApp *app)
{
    SendMessageA(lv_cov, LVM_DELETEALLITEMS, 0, 0);
    app->fnol.n_covs = 0;
    if (app->selected_policy_idx < 0) {
        SetWindowTextA(e_ded, "$0.00");
        return;
    }
    const char *pid = app->model.policies[app->selected_policy_idx].id;
    int row = 0;
    double total = 0;
    for (int i = 0; i < app->model.n_coverages && row < 16; ++i) {
        WgmCoverage *c = &app->model.coverages[i];
        if (strcmp(c->policy_id, pid) != 0) continue;
        LVITEMA it = {0}; it.mask = LVIF_TEXT; it.iItem = row; it.pszText = c->code;
        int r = (int)SendMessageA(lv_cov, LVM_INSERTITEMA, 0, (LPARAM)&it);
        if (r < 0) continue;
        LVITEMA s = {0}; s.mask = LVIF_TEXT; s.iItem = r;
        s.iSubItem = 1; s.pszText = c->descr; SendMessageA(lv_cov, LVM_SETITEMA, 0, (LPARAM)&s);
        char lim[32]; wgm_format_money(lim, sizeof lim, c->limit);
        char ded[32]; wgm_format_money(ded, sizeof ded, c->deductible);
        s.iSubItem = 2; s.pszText = lim; SendMessageA(lv_cov, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 3; s.pszText = ded; SendMessageA(lv_cov, LVM_SETITEMA, 0, (LPARAM)&s);
        if (app->fnol.cov_applied[row]) {
            SendMessageA(lv_cov, LVM_SETITEMSTATE, (WPARAM)r, (LPARAM)0);
            ListView_SetCheckState(lv_cov, r, TRUE);
            total += c->deductible;
        }
        row++;
    }
    app->fnol.n_covs = row;
    char d[32]; wgm_format_money(d, sizeof d, total);
    SetWindowTextA(e_ded, d);
    app->fnol.total_deductible = total;
}

static void recompute_deductible(WgmApp *app)
{
    double total = 0;
    if (app->selected_policy_idx >= 0) {
        const char *pid = app->model.policies[app->selected_policy_idx].id;
        int row = 0;
        for (int i = 0; i < app->model.n_coverages && row < 16; ++i) {
            if (strcmp(app->model.coverages[i].policy_id, pid) != 0) continue;
            app->fnol.cov_applied[row] = ListView_GetCheckState(lv_cov, row) ? 1 : 0;
            if (app->fnol.cov_applied[row]) total += app->model.coverages[i].deductible;
            row++;
        }
        app->fnol.n_covs = row;
    }
    char d[32]; wgm_format_money(d, sizeof d, total);
    SetWindowTextA(e_ded, d);
    app->fnol.total_deductible = total;
}

static void populate_review(WgmApp *app)
{
    /* Grab live values from step 1 */
    GetWindowTextA(e_loss_date, app->fnol.loss_date, (int)sizeof app->fnol.loss_date);
    GetWindowTextA(e_loss_time, app->fnol.loss_time, (int)sizeof app->fnol.loss_time);
    GetWindowTextA(e_loss_loc,  app->fnol.loss_location, (int)sizeof app->fnol.loss_location);
    int sel = (int)SendMessageA(e_loss_type, CB_GETCURSEL, 0, 0);
    if (sel >= 0)
        SendMessageA(e_loss_type, CB_GETLBTEXT, (WPARAM)sel, (LPARAM)app->fnol.loss_type);
    GetWindowTextA(e_narrative, app->fnol.narrative, (int)sizeof app->fnol.narrative);

    char body[4096]; int bl = 0;
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "FIRST NOTICE OF LOSS - DRAFT\r\n"
                    "----------------------------\r\n");
    if (app->selected_policy_idx >= 0) {
        WgmPolicy *p = &app->model.policies[app->selected_policy_idx];
        bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                        "Policy:        %s (%s)\r\n", p->id, p->type);
    }
    if (app->selected_customer_idx >= 0) {
        WgmCustomer *c = &app->model.customers[app->selected_customer_idx];
        bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                        "Insured:       %s %s - %s\r\n", c->first, c->last, c->phone);
    }
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "Loss Date:     %s %s\r\n", app->fnol.loss_date, app->fnol.loss_time);
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "Loss Type:     %s\r\n", app->fnol.loss_type);
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "Loss Location: %s\r\n", app->fnol.loss_location);
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "Adjuster:      %s\r\n", "ADJ-NA-0142");
    char money[32]; wgm_format_money(money, sizeof money, app->fnol.total_deductible);
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "Combined Ded:  %s\r\n", money);
    bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                    "\r\nNARRATIVE:\r\n%s\r\n", app->fnol.narrative);
    if (app->fnol.n_vehicles > 0) {
        bl += _snprintf(body + bl, sizeof body - (size_t)bl, "\r\nVEHICLES / PROPERTY:\r\n");
        for (int i = 0; i < app->fnol.n_vehicles; ++i) {
            WgmFnolVehicle *v = &app->fnol.vehicles[i];
            bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                            "  %s %s %s  VIN:%s  - %s\r\n",
                            v->year, v->make, v->model, v->vin, v->damage);
        }
    }
    if (app->fnol.n_parties > 0) {
        bl += _snprintf(body + bl, sizeof body - (size_t)bl, "\r\nPARTIES:\r\n");
        for (int i = 0; i < app->fnol.n_parties; ++i) {
            WgmFnolParty *p = &app->fnol.parties[i];
            bl += _snprintf(body + bl, sizeof body - (size_t)bl,
                            "  %s - %s  %s  %s\r\n",
                            p->role, p->name, p->phone, p->addr);
        }
    }
    SetWindowTextA(e_review, body);
}

void wgm_fnol_set_loss_type(WgmApp *app, const char *lt)
{
    if (!lt || !*lt || !e_loss_type) return;
    int n = (int)SendMessageA(e_loss_type, CB_GETCOUNT, 0, 0);
    for (int i = 0; i < n; ++i) {
        char buf[24] = {0};
        SendMessageA(e_loss_type, CB_GETLBTEXT, (WPARAM)i, (LPARAM)buf);
        if (_stricmp(buf, lt) == 0) {
            SendMessageA(e_loss_type, CB_SETCURSEL, (WPARAM)i, 0);
            wgm_strlcpy(app->fnol.loss_type, lt, sizeof app->fnol.loss_type);
            return;
        }
    }
}

void wgm_fnol_set_narrative(WgmApp *app, const char *narrative)
{
    if (!narrative || !e_narrative) return;
    SetWindowTextA(e_narrative, narrative);
    wgm_strlcpy(app->fnol.narrative, narrative, sizeof app->fnol.narrative);
}

void wgm_fnol_show_step(WgmApp *app, int step)
{
    if (step < 0) step = 0;
    if (step >= WGM_FNOL_STEPS) step = WGM_FNOL_STEPS - 1;
    app->fnol.step = step;
    for (int i = 0; i < WGM_FNOL_STEPS; ++i)
        ShowWindow(g_step_panels[i], i == step ? SW_SHOW : SW_HIDE);
    SetWindowTextA(g_step_label, STEP_LABELS[step]);
    EnableWindow(g_btn_back, step > 0);
    EnableWindow(g_btn_next, step < WGM_FNOL_STEPS - 1);
    ShowWindow(g_btn_submit, step == WGM_FNOL_STEPS - 1 ? SW_SHOW : SW_HIDE);
    if (step == 3) refresh_coverages(app);
    if (step == 4) populate_review(app);
    /* Set focus to a sensible default on each step */
    if (step == 0) SetFocus(e_narrative);
    if (step == 4) SetFocus(g_btn_submit);
}

int wgm_fnol_submit(WgmApp *app)
{
    if (app->selected_policy_idx < 0) {
        MessageBoxA(app->hwnd_main, "No policy selected. Select a policy before submitting.",
                    "Submit Claim", MB_OK | MB_ICONERROR);
        return -1;
    }
    /* Refresh from fields */
    populate_review(app);
    recompute_deductible(app);

    WgmPolicy *p = &app->model.policies[app->selected_policy_idx];
    WgmCustomer *c = (app->selected_customer_idx >= 0) ?
        &app->model.customers[app->selected_customer_idx] : NULL;

    char claim_id[24];
    wgm_make_claim_id(&app->model, claim_id, sizeof claim_id);

    WgmClaim cl; memset(&cl, 0, sizeof cl);
    wgm_strlcpy(cl.id, claim_id, sizeof cl.id);
    wgm_strlcpy(cl.policy_id, p->id, sizeof cl.policy_id);
    if (c) wgm_strlcpy(cl.customer_id, c->id, sizeof cl.customer_id);
    wgm_strlcpy(cl.loss_type, app->fnol.loss_type, sizeof cl.loss_type);
    wgm_strlcpy(cl.status, "OPEN-ASGN", sizeof cl.status);
    wgm_strlcpy(cl.loss_date, app->fnol.loss_date, sizeof cl.loss_date);
    wgm_strlcpy(cl.loss_time, app->fnol.loss_time, sizeof cl.loss_time);
    wgm_strlcpy(cl.loss_location, app->fnol.loss_location, sizeof cl.loss_location);
    wgm_strlcpy(cl.narrative, app->fnol.narrative, sizeof cl.narrative);
    cl.reserve = app->fnol.total_deductible;
    wgm_strlcpy(cl.adjuster, "ADJ-NA-0142", sizeof cl.adjuster);
    wgm_strlcpy(cl.field_office, p->field_office, sizeof cl.field_office);
    wgm_strlcpy(cl.opened_by, app->user.agent_id, sizeof cl.opened_by);
    wgm_iso8601_utc(cl.opened_on, sizeof cl.opened_on);
    wgm_strlcpy(cl.modified_by, app->user.agent_id, sizeof cl.modified_by);
    wgm_strlcpy(cl.modified_on, cl.opened_on, sizeof cl.modified_on);

    wgm_model_add_claim(&app->model, &cl);

    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, claim_id, sizeof a.claim_id);
    wgm_iso8601_utc(a.ts, sizeof a.ts);
    wgm_strlcpy(a.who, app->user.agent_id, sizeof a.who);
    _snprintf(a.text, sizeof a.text, "OPENED VIA FNOL WIZARD. INTAKE BY %s.", app->user.agent_id);
    wgm_model_add_activity(&app->model, &a);

    wgm_model_save(&app->model);
    wgm_strlcpy(app->fnol.claim_id, claim_id, sizeof app->fnol.claim_id);
    app->fnol.submitted = 1;
    SetWindowTextA(g_result_edit, claim_id);

    /* Copy claim ID to clipboard */
    if (OpenClipboard(app->hwnd_main)) {
        EmptyClipboard();
        size_t n = strlen(claim_id) + 1;
        HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, n);
        if (hg) {
            char *dst = (char *)GlobalLock(hg);
            if (dst) {
                memcpy(dst, claim_id, n);
                GlobalUnlock(hg);
                SetClipboardData(CF_TEXT, hg);
            }
        }
        CloseClipboard();
    }

    /* Show confirmation dialog */
    extern INT_PTR CALLBACK wgm_confirm_proc(HWND, UINT, WPARAM, LPARAM);
    DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_CONFIRM_CLAIM),
                    app->hwnd_main, wgm_confirm_proc, (LPARAM)claim_id);

    wgm_log_audit("fnol_submit", app->user.agent_id, claim_id);

    /* Relay the outcome back to the orchestrator when running under handoff. */
    if (app->handoff_active) {
        wgm_strlcpy(app->hf_matched_policy, p->id, sizeof app->hf_matched_policy);
        wgm_handoff_write_result(app);
    }
    return 0;
}

INT_PTR CALLBACK wgm_confirm_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    const char *claim_id = (const char *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (m == WM_INITDIALOG) {
        claim_id = (const char *)lp;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)claim_id);
        SetDlgItemTextA(h, IDC_CONFIRM_CLAIM_ID, claim_id);
        return TRUE;
    }
    if (m == WM_COMMAND) {
        if (LOWORD(wp) == IDC_CONFIRM_OK || LOWORD(wp) == IDOK) {
            EndDialog(h, IDOK);
            return TRUE;
        }
        if (LOWORD(wp) == IDC_CONFIRM_COPY) {
            if (claim_id && OpenClipboard(h)) {
                EmptyClipboard();
                size_t n = strlen(claim_id) + 1;
                HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, n);
                if (hg) {
                    char *dst = (char *)GlobalLock(hg);
                    if (dst) {
                        memcpy(dst, claim_id, n);
                        GlobalUnlock(hg);
                        SetClipboardData(CF_TEXT, hg);
                    }
                }
                CloseClipboard();
            }
            return TRUE;
        }
        if (LOWORD(wp) == IDCANCEL) {
            EndDialog(h, IDCANCEL);
            return TRUE;
        }
    }
    return FALSE;
}

/* Pane WndProc dispatched from ui_main when h == app->hwnd_tab_fnol. */
LRESULT CALLBACK wgm_fnol_pane_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    WgmApp *app = &g_app;
    if (m == WM_NOTIFY) {
        NMHDR *nh = (NMHDR *)lp;
        if (nh && nh->idFrom == IDC_FNOL_COV_LIST && nh->code == LVN_ITEMCHANGED) {
            recompute_deductible(app);
            return 0;
        }
    }
    if (m == WM_COMMAND) {
        WORD id = LOWORD(wp);
        switch (id) {
        case IDC_FNOL_BACK:
            wgm_fnol_show_step(app, app->fnol.step - 1);
            return 0;
        case IDC_FNOL_NEXT:
            wgm_fnol_show_step(app, app->fnol.step + 1);
            return 0;
        case IDC_FNOL_CANCEL:
            if (MessageBoxA(h, "Cancel this FNOL and discard entered data?",
                            "Cancel FNOL", MB_YESNO | MB_ICONWARNING) == IDYES) {
                memset(&app->fnol, 0, sizeof app->fnol);
                wgm_fnol_init(app);
            }
            return 0;
        case IDC_FNOL_SUBMIT:
            wgm_fnol_submit(app);
            return 0;
        case IDC_FNOL_VEH_ADD: {
            if (app->fnol.n_vehicles >= 8) return 0;
            VehCtx ctx; memset(&ctx, 0, sizeof ctx);
            if (DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_ADD_VEHICLE),
                                h, veh_proc, (LPARAM)&ctx) == IDOK) {
                app->fnol.vehicles[app->fnol.n_vehicles++] = ctx.v;
                refresh_vehicles(app);
            }
            return 0;
        }
        case IDC_FNOL_VEH_REMOVE: {
            int sel = (int)SendMessageA(lv_vehicles, LVM_GETNEXTITEM, (WPARAM)-1, MAKELPARAM(LVNI_SELECTED, 0));
            if (sel >= 0 && sel < app->fnol.n_vehicles) {
                for (int i = sel; i < app->fnol.n_vehicles - 1; ++i)
                    app->fnol.vehicles[i] = app->fnol.vehicles[i + 1];
                app->fnol.n_vehicles--;
                refresh_vehicles(app);
            }
            return 0;
        }
        case IDC_FNOL_PARTY_ADD: {
            if (app->fnol.n_parties >= 8) return 0;
            PartyCtx ctx; memset(&ctx, 0, sizeof ctx);
            if (DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_ADD_PARTY),
                                h, party_proc, (LPARAM)&ctx) == IDOK) {
                app->fnol.parties[app->fnol.n_parties++] = ctx.p;
                refresh_parties(app);
            }
            return 0;
        }
        case IDC_FNOL_PARTY_REMOVE: {
            int sel = (int)SendMessageA(lv_parties, LVM_GETNEXTITEM, (WPARAM)-1, MAKELPARAM(LVNI_SELECTED, 0));
            if (sel >= 0 && sel < app->fnol.n_parties) {
                for (int i = sel; i < app->fnol.n_parties - 1; ++i)
                    app->fnol.parties[i] = app->fnol.parties[i + 1];
                app->fnol.n_parties--;
                refresh_parties(app);
            }
            return 0;
        }
        }
    }
    if (m == WM_CTLCOLORSTATIC || m == WM_CTLCOLOREDIT || m == WM_CTLCOLORBTN ||
        m == WM_CTLCOLORDLG || m == WM_CTLCOLORLISTBOX) {
        HDC dc = (HDC)wp;
        SetBkMode(dc, OPAQUE);
        SetBkColor(dc, GetSysColor(COLOR_3DFACE));
        return (LRESULT)GetSysColorBrush(COLOR_3DFACE);
    }
    if (m == WM_ERASEBKGND) {
        HDC dc = (HDC)wp;
        RECT r; GetClientRect(h, &r);
        FillRect(dc, &r, GetSysColorBrush(COLOR_3DFACE));
        return 1;
    }
    return DefWindowProcA(h, m, wp, lp);
}
