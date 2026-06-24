/*
 * ui_main.c - main window: menu, status bar, split pane (search + tabs).
 *
 * The right pane is a tab control whose pages each have a host child window.
 * Only the currently-selected page is shown. The New FNOL tab hosts the
 * in-window wizard implemented in ui_fnol.c.
 */
#include "app.h"
#include "log.h"
#include "resource.h"
#include "util.h"

#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *MAIN_CLASS = "WgmMainWindow";
static const char *PANE_CLASS = "WgmPaneWindow";

#define SEARCH_W            260
#define STATUS_H             24
#define MIN_W              1024
#define MIN_H               720

#define TAB_POLICY            0
#define TAB_COVERAGE          1
#define TAB_CLAIMS            2
#define TAB_FNOL              3
#define TAB_NOTES             4

extern LRESULT CALLBACK wgm_fnol_pane_proc(HWND h, UINT m, WPARAM wp, LPARAM lp);

/* ---------------------------------------------------------------------------
 * Demo readability: a single uniform UI scale so the small native controls are
 * legible in the streamed / expanded Windows 365 Cloud PC frames. 100 = the
 * original size. The layout uses fixed pixel coordinates, so rather than
 * rewriting hundreds of literals we scale the whole control tree once after
 * creation (scale_children_geometry) plus the font and the resize math. Build
 * with -DWGM_UI_SCALE=NNN to change it (e.g. 100 to disable).
 * ------------------------------------------------------------------------- */
#ifndef WGM_UI_SCALE
#define WGM_UI_SCALE 185
#endif

/* Runtime UI scale. Starts at the WGM_UI_SCALE cap, but wgm_init_scale() lowers
 * it so the scaled window always fits the monitor work area — otherwise a large
 * font scale (e.g. 185%) makes the window taller than a 1080p Cloud PC and the
 * bottom falls off screen. Everything (font, control geometry, window size) reads
 * this single value, so they stay consistent. */
static int g_ui_scale = WGM_UI_SCALE;

static int wgm_scale(int v)
{
    return (int)(((long)v * g_ui_scale + 50) / 100);
}

/* Pick the largest scale (capped at WGM_UI_SCALE) at which a wgm_scale(MIN_W) x
 * wgm_scale(MIN_H) window still fits the primary monitor work area, so the demo
 * is as large/readable as possible without ever overflowing the screen. */
static void wgm_init_scale(void)
{
    RECT wa = {0};
    int margin = 12; /* small breathing room from the work-area edges */
    if (!SystemParametersInfoA(SPI_GETWORKAREA, 0, &wa, 0)) {
        g_ui_scale = WGM_UI_SCALE;
        return;
    }
    int workW = wa.right - wa.left - margin;
    int workH = wa.bottom - wa.top - margin;
    if (workW <= 0 || workH <= 0) { g_ui_scale = WGM_UI_SCALE; return; }

    int byW = (int)(((long)workW * 100) / MIN_W);
    int byH = (int)(((long)workH * 100) / MIN_H);
    int s = WGM_UI_SCALE;
    if (byW < s) s = byW;
    if (byH < s) s = byH;
    if (s < 100) s = 100;           /* never shrink below native */
    g_ui_scale = s;
}

/* Recursively scale every child control's parent-relative geometry by the UI
 * scale. Child client coordinates are independent of the parent's size, so
 * scaling each control's x/y/w/h by the same factor keeps the layout uniform. */
static void scale_children_geometry(HWND parent)
{
    if (g_ui_scale == 100) return;
    HWND c = GetWindow(parent, GW_CHILD);
    while (c) {
        RECT r;
        GetWindowRect(c, &r);
        POINT tl = { r.left, r.top };
        ScreenToClient(parent, &tl);
        MoveWindow(c, wgm_scale(tl.x), wgm_scale(tl.y),
                   wgm_scale(r.right - r.left), wgm_scale(r.bottom - r.top), FALSE);
        scale_children_geometry(c);
        c = GetWindow(c, GW_HWNDNEXT);
    }
}

/* List-view column widths are not window geometry, so scale them separately. */
static void scale_listview_columns(HWND lv)
{
    if (g_ui_scale == 100 || !lv) return;
    for (int i = 0; ; ++i) {
        int w = (int)SendMessageA(lv, LVM_GETCOLUMNWIDTH, i, 0);
        if (w <= 0) break;
        SendMessageA(lv, LVM_SETCOLUMNWIDTH, i, wgm_scale(w));
    }
}


static HFONT g_hfont = NULL;

static HFONT create_ui_font(void)
{
    LOGFONTA lf = {0};
    lf.lfHeight = wgm_scale(-13);   /* MS Sans Serif ~13pt, enlarged for projected-demo readability (#fonts) */
    lf.lfWeight = FW_NORMAL;
    lf.lfCharSet = ANSI_CHARSET;
    wgm_strlcpy(lf.lfFaceName, "MS Sans Serif", sizeof lf.lfFaceName);
    HFONT f = CreateFontIndirectA(&lf);
    return f ? f : (HFONT)GetStockObject(DEFAULT_GUI_FONT);
}

static void set_font_on_all_children(HWND h, HFONT f)
{
    SendMessageA(h, WM_SETFONT, (WPARAM)f, TRUE);
    HWND c = GetWindow(h, GW_CHILD);
    while (c) {
        SendMessageA(c, WM_SETFONT, (WPARAM)f, TRUE);
        set_font_on_all_children(c, f);
        c = GetWindow(c, GW_HWNDNEXT);
    }
}

const char *wgm_intent_to_loss_type(const char *intent)
{
    /* Default to COLLISION (a real LOSS_TYPES value) for null/unknown intent.
     * "OTHER" is NOT in the Loss Type dropdown, so returning it would set an
     * invalid value on the native file-drop prefill path (#137). */
    if (!intent) return "COLLISION";
    if (strcmp(intent, "auto_collision") == 0)      return "COLLISION";
    if (strcmp(intent, "auto_theft") == 0)          return "THEFT";
    if (strcmp(intent, "auto_glass") == 0)          return "GLASS";
    if (strcmp(intent, "home_water") == 0)          return "WATER";
    if (strcmp(intent, "home_fire") == 0)           return "FIRE";
    if (strcmp(intent, "home_wind") == 0)           return "WIND";
    if (strcmp(intent, "liability") == 0)           return "LIABILITY";
    if (strcmp(intent, "fraud_investigation") == 0) return "LIABILITY";
    return "COLLISION";
}

/* ---------- Status bar ---------- */
static void make_status_bar(WgmApp *app)
{
    app->hwnd_status = CreateWindowExA(0, STATUSCLASSNAMEA, NULL,
        WS_CHILD | WS_VISIBLE | SBARS_SIZEGRIP, 0, 0, 0, 0,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_STATUS_BAR, app->hinst, NULL);
    int parts[6] = { 220, 380, 480, 620, 760, -1 };
    SendMessageA(app->hwnd_status, SB_SETPARTS, 6, (LPARAM)parts);
}

void wgm_main_refresh_status(WgmApp *app)
{
    if (!app->hwnd_status) return;
    char u[80], role[40], term[40], host[40], rec[40], clock[40];
    _snprintf(u,    sizeof u,    " USR: %s (%s)", app->user.display, app->user.agent_id);
    const char *rname = "CSR";
    if (app->user.role == ROLE_SR)  rname = "Sr.CSR";
    if (app->user.role == ROLE_MGR) rname = "Manager";
    _snprintf(role, sizeof role, " ROLE: %s", rname);
    _snprintf(term, sizeof term, " TERM: T-1001");
    _snprintf(host, sizeof host, " HOST: %s", app->host_linked ? "LINKED" : "RECONNECTING");
    _snprintf(rec,  sizeof rec,  " REC: %d", app->model.n_claims);
    SYSTEMTIME st; GetLocalTime(&st);
    _snprintf(clock, sizeof clock, " %02u:%02u:%02u %s",
              st.wHour, st.wMinute, st.wSecond, app->ready ? "READY" : app->aux_code);
    SendMessageA(app->hwnd_status, SB_SETTEXTA, 0, (LPARAM)u);
    SendMessageA(app->hwnd_status, SB_SETTEXTA, 1, (LPARAM)role);
    SendMessageA(app->hwnd_status, SB_SETTEXTA, 2, (LPARAM)term);
    SendMessageA(app->hwnd_status, SB_SETTEXTA, 3, (LPARAM)host);
    SendMessageA(app->hwnd_status, SB_SETTEXTA, 4, (LPARAM)rec);
    SendMessageA(app->hwnd_status, SB_SETTEXTA, 5, (LPARAM)clock);
}

/* ---------- Search panel ---------- */
typedef struct SearchPanelHandles {
    HWND radio_phone, radio_policy, radio_name, radio_claim;
    HWND label;
    HWND input;
    HWND btn_search, btn_clear;
    HWND list;
} SearchPanelHandles;

static SearchPanelHandles g_search;
static int g_search_mode = IDC_SEARCH_RADIO_PHONE;

static void build_search_panel(WgmApp *app)
{
    int x = 8, y = 8;
    CreateWindowExA(0, "STATIC", "Search by:",
        WS_CHILD | WS_VISIBLE, x, y, 200, 16,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_LABEL, app->hinst, NULL);
    y += 20;

    g_search.radio_phone = CreateWindowExA(0, "BUTTON", "Phone",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON | WS_GROUP,
        x, y, 100, 16,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_RADIO_PHONE, app->hinst, NULL);
    y += 18;
    g_search.radio_policy = CreateWindowExA(0, "BUTTON", "Policy #",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON,
        x, y, 100, 16,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_RADIO_POLICY, app->hinst, NULL);
    y += 18;
    g_search.radio_name = CreateWindowExA(0, "BUTTON", "Name",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON,
        x, y, 100, 16,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_RADIO_NAME, app->hinst, NULL);
    y += 18;
    g_search.radio_claim = CreateWindowExA(0, "BUTTON", "Claim #",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON,
        x, y, 100, 16,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_RADIO_CLAIM, app->hinst, NULL);
    y += 24;

    SendMessageA(g_search.radio_phone, BM_SETCHECK, BST_CHECKED, 0);

    g_search.input = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
        x, y, SEARCH_W - 16, 22,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_INPUT, app->hinst, NULL);
    app->hwnd_search_input = g_search.input;
    y += 28;

    g_search.btn_search = CreateWindowExA(0, "BUTTON", "&Search",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
        x, y, 90, 22,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_BUTTON, app->hinst, NULL);
    g_search.btn_clear = CreateWindowExA(0, "BUTTON", "C&lear",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x + 100, y, 60, 22,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_CLEAR, app->hinst, NULL);
    y += 30;

    g_search.list = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS,
        x, y, SEARCH_W - 16, 380,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_SEARCH_RESULTS, app->hinst, NULL);
    app->hwnd_search_results = g_search.list;

    LVCOLUMNA c = {0};
    c.mask = LVCF_TEXT | LVCF_WIDTH;
    c.cx = 60;  c.pszText = (char *)"ID";        SendMessageA(g_search.list, LVM_INSERTCOLUMNA, 0, (LPARAM)&c);
    c.cx = 100; c.pszText = (char *)"Last Name"; SendMessageA(g_search.list, LVM_INSERTCOLUMNA, 1, (LPARAM)&c);
    c.cx = 64;  c.pszText = (char *)"First";     SendMessageA(g_search.list, LVM_INSERTCOLUMNA, 2, (LPARAM)&c);
}

static void populate_search_results(WgmApp *app, int *idxs, int n)
{
    SendMessageA(g_search.list, LVM_DELETEALLITEMS, 0, 0);
    for (int i = 0; i < n; ++i) {
        WgmCustomer *c = &app->model.customers[idxs[i]];
        LVITEMA it = {0};
        it.mask = LVIF_TEXT | LVIF_PARAM;
        it.iItem = i;
        it.iSubItem = 0;
        it.pszText = c->id;
        it.lParam = (LPARAM)idxs[i];
        int row = (int)SendMessageA(g_search.list, LVM_INSERTITEMA, 0, (LPARAM)&it);
        if (row < 0) continue;
        LVITEMA s = {0};
        s.mask = LVIF_TEXT;
        s.iItem = row;
        s.iSubItem = 1; s.pszText = c->last;  SendMessageA(g_search.list, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 2; s.pszText = c->first; SendMessageA(g_search.list, LVM_SETITEMA, 0, (LPARAM)&s);
    }
    if (n > 0) {
        LVITEMA st = {0};
        st.mask = LVIF_STATE; st.stateMask = LVIS_SELECTED | LVIS_FOCUSED;
        st.state = LVIS_SELECTED | LVIS_FOCUSED;
        SendMessageA(g_search.list, LVM_SETITEMSTATE, 0, (LPARAM)&st);
    }
}

static int current_search_mode(void)
{
    if (SendMessageA(g_search.radio_phone,  BM_GETCHECK, 0, 0) == BST_CHECKED) return IDC_SEARCH_RADIO_PHONE;
    if (SendMessageA(g_search.radio_policy, BM_GETCHECK, 0, 0) == BST_CHECKED) return IDC_SEARCH_RADIO_POLICY;
    if (SendMessageA(g_search.radio_name,   BM_GETCHECK, 0, 0) == BST_CHECKED) return IDC_SEARCH_RADIO_NAME;
    if (SendMessageA(g_search.radio_claim,  BM_GETCHECK, 0, 0) == BST_CHECKED) return IDC_SEARCH_RADIO_CLAIM;
    return IDC_SEARCH_RADIO_PHONE;
}

static void run_search(WgmApp *app)
{
    char q[128];
    GetWindowTextA(g_search.input, q, sizeof q);
    int idxs[64];
    int n = 0;
    g_search_mode = current_search_mode();
    switch (g_search_mode) {
    case IDC_SEARCH_RADIO_PHONE:  n = wgm_search_by_phone (&app->model, q, idxs, 64); break;
    case IDC_SEARCH_RADIO_POLICY: n = wgm_search_by_policy(&app->model, q, idxs, 64); break;
    case IDC_SEARCH_RADIO_NAME:   n = wgm_search_by_name  (&app->model, q, idxs, 64); break;
    case IDC_SEARCH_RADIO_CLAIM:  n = wgm_search_by_claim (&app->model, q, idxs, 64); break;
    }
    populate_search_results(app, idxs, n);
    if (n == 1) {
        wgm_main_load_customer(app, idxs[0], -1);
    }
}

/* ---------- Pane host window proc (transparent host for each tab page) ---------- */
static LRESULT CALLBACK pane_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    /* FNOL pane has its own handler. */
    if (h == g_app.hwnd_tab_fnol)
        return wgm_fnol_pane_proc(h, m, wp, lp);

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
    /* Forward control notifications to the main window so the central
     * WM_COMMAND/WM_NOTIFY router (in main_proc) can dispatch them. */
    if (m == WM_COMMAND || m == WM_NOTIFY) {
        HWND parent = GetParent(h);
        if (parent) return SendMessageA(parent, m, wp, lp);
    }
    return DefWindowProcA(h, m, wp, lp);
}

static void register_pane_class(HINSTANCE hi)
{
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = pane_proc;
    wc.hInstance = hi;
    wc.hCursor = LoadCursorA(NULL, MAKEINTRESOURCEA(32512)); /* IDC_ARROW */
    wc.hbrBackground = (HBRUSH)(COLOR_3DFACE + 1);
    wc.lpszClassName = PANE_CLASS;
    RegisterClassA(&wc);
}

/* ---------- Policy / Coverage / Claims / Notes tab contents ---------- */
static void build_policy_tab(WgmApp *app, HWND pane)
{
    int x = 12, y = 12;
    CreateWindowExA(0, "STATIC", "Policy #:", WS_CHILD | WS_VISIBLE,
        x, y, 100, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 200, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_NUMBER, app->hinst, NULL);
    y += 26;

    CreateWindowExA(0, "STATIC", "Insured Last Name:", WS_CHILD | WS_VISIBLE,
        x, y, 110, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 200, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_INSURED, app->hinst, NULL);
    CreateWindowExA(0, "STATIC", "Phone:", WS_CHILD | WS_VISIBLE,
        x + 360, y, 50, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 420, y - 2, 140, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_PHONE, app->hinst, NULL);
    y += 26;

    CreateWindowExA(0, "STATIC", "Address:", WS_CHILD | WS_VISIBLE,
        x, y, 100, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 440, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_ADDRESS, app->hinst, NULL);
    y += 26;

    CreateWindowExA(0, "STATIC", "Policy Type:", WS_CHILD | WS_VISIBLE,
        x, y, 100, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 100, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_TYPE, app->hinst, NULL);
    CreateWindowExA(0, "STATIC", "Status:", WS_CHILD | WS_VISIBLE,
        x + 240, y, 50, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 290, y - 2, 100, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_STATUS, app->hinst, NULL);
    y += 26;

    CreateWindowExA(0, "STATIC", "Effective:", WS_CHILD | WS_VISIBLE,
        x, y, 100, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 110, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_EFFECTIVE, app->hinst, NULL);
    CreateWindowExA(0, "STATIC", "Expiration:", WS_CHILD | WS_VISIBLE,
        x + 240, y, 80, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 320, y - 2, 110, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_EXPIRATION, app->hinst, NULL);
    y += 26;

    CreateWindowExA(0, "STATIC", "Annual Premium:", WS_CHILD | WS_VISIBLE,
        x, y, 110, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 110, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_PREMIUM, app->hinst, NULL);
    CreateWindowExA(0, "STATIC", "Billing Status:", WS_CHILD | WS_VISIBLE,
        x + 240, y, 100, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 340, y - 2, 120, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_BILLING, app->hinst, NULL);
    y += 26;

    CreateWindowExA(0, "STATIC", "Servicing Agent:", WS_CHILD | WS_VISIBLE,
        x, y, 110, 16, pane, NULL, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_READONLY,
        x + 120, y - 2, 110, 20,
        pane, (HMENU)(LONG_PTR)IDC_POL_AGENT, app->hinst, NULL);
    y += 36;

    CreateWindowExA(0, "STATIC", "", WS_CHILD | WS_VISIBLE | SS_LEFT,
        x, y, 540, 16,
        pane, (HMENU)(LONG_PTR)IDC_POL_FOOTER, app->hinst, NULL);
}

static void fill_policy_tab(WgmApp *app)
{
    HWND p = app->hwnd_tab_policy;
    if (!p || app->selected_customer_idx < 0 || app->selected_policy_idx < 0) return;
    WgmCustomer *c = &app->model.customers[app->selected_customer_idx];
    WgmPolicy   *pol = &app->model.policies[app->selected_policy_idx];
    char buf[128];
    SetDlgItemTextA(p, IDC_POL_NUMBER, pol->id);
    _snprintf(buf, sizeof buf, "%s, %s", c->last, c->first);
    SetDlgItemTextA(p, IDC_POL_INSURED, buf);
    SetDlgItemTextA(p, IDC_POL_PHONE, c->phone);
    _snprintf(buf, sizeof buf, "%s, %s %s %s", c->addr, c->city, c->state, c->zip);
    SetDlgItemTextA(p, IDC_POL_ADDRESS, buf);
    SetDlgItemTextA(p, IDC_POL_TYPE, pol->type);
    SetDlgItemTextA(p, IDC_POL_STATUS, pol->status);
    SetDlgItemTextA(p, IDC_POL_EFFECTIVE, pol->effective);
    SetDlgItemTextA(p, IDC_POL_EXPIRATION, pol->expiration);
    char money[32];
    wgm_format_money(money, sizeof money, pol->premium);
    SetDlgItemTextA(p, IDC_POL_PREMIUM, money);
    SetDlgItemTextA(p, IDC_POL_BILLING, pol->billing);
    SetDlgItemTextA(p, IDC_POL_AGENT, pol->agent);
    _snprintf(buf, sizeof buf, "Last Modified by %s on 04/15/1998 14:22:36   |   Field Office: %s",
              pol->agent, pol->field_office);
    SetDlgItemTextA(p, IDC_POL_FOOTER, buf);
}

static void build_coverage_tab(WgmApp *app, HWND pane)
{
    CreateWindowExA(WS_EX_CLIENTEDGE, WC_TREEVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | TVS_HASLINES | TVS_HASBUTTONS |
        TVS_LINESATROOT | TVS_SHOWSELALWAYS,
        12, 12, 360, 380,
        pane, (HMENU)(LONG_PTR)IDC_COV_TREE, app->hinst, NULL);
    CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", "",
        WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_READONLY | WS_VSCROLL,
        384, 12, 280, 380,
        pane, (HMENU)(LONG_PTR)IDC_COV_DETAIL, app->hinst, NULL);
    CreateWindowExA(0, "STATIC", "",
        WS_CHILD | WS_VISIBLE,
        12, 400, 640, 16,
        pane, (HMENU)(LONG_PTR)IDC_COV_FOOTER, app->hinst, NULL);
}

static void fill_coverage_tab(WgmApp *app)
{
    HWND tree = GetDlgItem(app->hwnd_tab_coverage, IDC_COV_TREE);
    if (!tree) return;
    SendMessageA(tree, TVM_DELETEITEM, 0, (LPARAM)TVI_ROOT);
    if (app->selected_policy_idx < 0) return;
    WgmPolicy *p = &app->model.policies[app->selected_policy_idx];
    char text[160];
    TVINSERTSTRUCTA root = {0};
    root.hParent = TVI_ROOT;
    root.hInsertAfter = TVI_LAST;
    root.item.mask = TVIF_TEXT;
    _snprintf(text, sizeof text, "Policy %s (%s)", p->id, p->type);
    root.item.pszText = text;
    HTREEITEM hr = (HTREEITEM)SendMessageA(tree, TVM_INSERTITEMA, 0, (LPARAM)&root);
    char details[2048] = "";
    int dlen = 0;
    for (int i = 0; i < app->model.n_coverages; ++i) {
        WgmCoverage *c = &app->model.coverages[i];
        if (strcmp(c->policy_id, p->id) != 0) continue;
        TVINSERTSTRUCTA ci = {0};
        ci.hParent = hr;
        ci.hInsertAfter = TVI_LAST;
        ci.item.mask = TVIF_TEXT;
        char buf[160];
        char lim[32], ded[32];
        wgm_format_money(lim, sizeof lim, c->limit);
        wgm_format_money(ded, sizeof ded, c->deductible);
        _snprintf(buf, sizeof buf, "%s - Limit %s, Ded %s - %s", c->code, lim, ded, c->descr);
        ci.item.pszText = buf;
        SendMessageA(tree, TVM_INSERTITEMA, 0, (LPARAM)&ci);
        dlen += _snprintf(details + dlen, sizeof details - (size_t)dlen,
                          "%s  Limit %s  Ded %s\r\n  %s\r\n\r\n",
                          c->code, lim, ded, c->descr);
        if ((size_t)dlen >= sizeof details - 16) break;
    }
    SendMessageA(tree, TVM_EXPAND, TVE_EXPAND, (LPARAM)hr);
    SetDlgItemTextA(app->hwnd_tab_coverage, IDC_COV_DETAIL, details);
    char footer[160];
    _snprintf(footer, sizeof footer, "Coverage Verification: %s   Last Modified by %s",
              "VERIFIED", p->agent);
    SetDlgItemTextA(app->hwnd_tab_coverage, IDC_COV_FOOTER, footer);
}

static void build_claims_tab(WgmApp *app, HWND pane)
{
    HWND lv = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS,
        12, 12, 660, 360,
        pane, (HMENU)(LONG_PTR)IDC_CLM_LIST, app->hinst, NULL);
    LVCOLUMNA c = {0}; c.mask = LVCF_TEXT | LVCF_WIDTH;
    c.cx = 130; c.pszText = (char *)"Claim ID";   SendMessageA(lv, LVM_INSERTCOLUMNA, 0, (LPARAM)&c);
    c.cx = 90;  c.pszText = (char *)"Loss Type";  SendMessageA(lv, LVM_INSERTCOLUMNA, 1, (LPARAM)&c);
    c.cx = 90;  c.pszText = (char *)"Status";     SendMessageA(lv, LVM_INSERTCOLUMNA, 2, (LPARAM)&c);
    c.cx = 80;  c.pszText = (char *)"Loss Date";  SendMessageA(lv, LVM_INSERTCOLUMNA, 3, (LPARAM)&c);
    c.cx = 90;  c.pszText = (char *)"Reserve";    SendMessageA(lv, LVM_INSERTCOLUMNA, 4, (LPARAM)&c);
    c.cx = 110; c.pszText = (char *)"Adjuster";   SendMessageA(lv, LVM_INSERTCOLUMNA, 5, (LPARAM)&c);

    CreateWindowExA(0, "STATIC", "Adjuster Assigned",
        WS_CHILD | WS_VISIBLE,
        12, 384, 660, 14, pane, (HMENU)(LONG_PTR)IDC_CLM_FOOTER, app->hinst, NULL);

    /* Action buttons - enabled when a claim row is selected. */
    CreateWindowExA(0, "BUTTON", "&Reassign...", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_DISABLED,
        12, 404, 96, 22, pane, (HMENU)(LONG_PTR)IDC_CLM_REASSIGN, app->hinst, NULL);
    CreateWindowExA(0, "BUTTON", "&Close Claim", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_DISABLED,
        114, 404, 96, 22, pane, (HMENU)(LONG_PTR)IDC_CLM_CLOSE, app->hinst, NULL);
    CreateWindowExA(0, "BUTTON", "&Transfer...", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_DISABLED,
        216, 404, 96, 22, pane, (HMENU)(LONG_PTR)IDC_CLM_TRANSFER, app->hinst, NULL);
    CreateWindowExA(0, "BUTTON", "&Void", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_DISABLED,
        318, 404, 96, 22, pane, (HMENU)(LONG_PTR)IDC_CLM_VOID, app->hinst, NULL);
}

static void fill_claims_tab(WgmApp *app)
{
    HWND lv = GetDlgItem(app->hwnd_tab_claims, IDC_CLM_LIST);
    if (!lv) return;
    SendMessageA(lv, LVM_DELETEALLITEMS, 0, 0);
    if (app->selected_policy_idx < 0) return;
    WgmPolicy *p = &app->model.policies[app->selected_policy_idx];
    int row = 0;
    for (int i = 0; i < app->model.n_claims; ++i) {
        WgmClaim *c = &app->model.claims[i];
        if (strcmp(c->policy_id, p->id) != 0) continue;
        LVITEMA it = {0};
        it.mask = LVIF_TEXT | LVIF_PARAM;
        it.iItem = row; it.iSubItem = 0; it.pszText = c->id; it.lParam = i;
        int r = (int)SendMessageA(lv, LVM_INSERTITEMA, 0, (LPARAM)&it);
        if (r < 0) continue;
        LVITEMA s = {0}; s.mask = LVIF_TEXT; s.iItem = r;
        s.iSubItem = 1; s.pszText = c->loss_type;   SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 2; s.pszText = c->status;      SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 3; s.pszText = c->loss_date;   SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        char money[32]; wgm_format_money(money, sizeof money, c->reserve);
        s.iSubItem = 4; s.pszText = money;          SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 5; s.pszText = c->adjuster;    SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        row++;
    }
    char footer[120];
    _snprintf(footer, sizeof footer, "Prior Claims on %s: %d   Adjuster pool: ADJ-NA-* / ADJ-WC-*",
              p->id, row);
    SetDlgItemTextA(app->hwnd_tab_claims, IDC_CLM_FOOTER, footer);
}

static void build_notes_tab(WgmApp *app, HWND pane)
{
    HWND lv = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SHOWSELALWAYS,
        12, 12, 660, 360,
        pane, (HMENU)(LONG_PTR)IDC_NOTES_LIST, app->hinst, NULL);
    LVCOLUMNA c = {0}; c.mask = LVCF_TEXT | LVCF_WIDTH;
    c.cx = 80;  c.pszText = (char *)"Severity";  SendMessageA(lv, LVM_INSERTCOLUMNA, 0, (LPARAM)&c);
    c.cx = 150; c.pszText = (char *)"Timestamp"; SendMessageA(lv, LVM_INSERTCOLUMNA, 1, (LPARAM)&c);
    c.cx = 80;  c.pszText = (char *)"Who";       SendMessageA(lv, LVM_INSERTCOLUMNA, 2, (LPARAM)&c);
    c.cx = 350; c.pszText = (char *)"Note";      SendMessageA(lv, LVM_INSERTCOLUMNA, 3, (LPARAM)&c);

    CreateWindowExA(0, "BUTTON", "&Add Note...",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        12, 384, 90, 22, pane, (HMENU)(LONG_PTR)IDC_NOTES_ADD, app->hinst, NULL);
    CreateWindowExA(0, "STATIC", "",
        WS_CHILD | WS_VISIBLE,
        110, 388, 560, 16, pane, (HMENU)(LONG_PTR)IDC_NOTES_FOOTER, app->hinst, NULL);
}

static void fill_notes_tab(WgmApp *app)
{
    HWND lv = GetDlgItem(app->hwnd_tab_notes, IDC_NOTES_LIST);
    if (!lv) return;
    SendMessageA(lv, LVM_DELETEALLITEMS, 0, 0);
    int row = 0;
    for (int i = 0; i < app->model.n_notes; ++i) {
        WgmNote *n = &app->model.notes[i];
        if (app->selected_policy_idx >= 0) {
            int show = 0;
            for (int j = 0; j < app->model.n_claims; ++j) {
                if (strcmp(app->model.claims[j].id, n->claim_id) == 0 &&
                    strcmp(app->model.claims[j].policy_id, app->model.policies[app->selected_policy_idx].id) == 0) {
                    show = 1; break;
                }
            }
            if (!show) continue;
        }
        LVITEMA it = {0};
        it.mask = LVIF_TEXT; it.iItem = row; it.iSubItem = 0; it.pszText = n->severity;
        int r = (int)SendMessageA(lv, LVM_INSERTITEMA, 0, (LPARAM)&it);
        if (r < 0) continue;
        LVITEMA s = {0}; s.mask = LVIF_TEXT; s.iItem = r;
        s.iSubItem = 1; s.pszText = n->ts;   SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 2; s.pszText = n->who;  SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        s.iSubItem = 3; s.pszText = n->text; SendMessageA(lv, LVM_SETITEMA, 0, (LPARAM)&s);
        row++;
    }
    char footer[64];
    _snprintf(footer, sizeof footer, "Notes shown: %d", row);
    SetDlgItemTextA(app->hwnd_tab_notes, IDC_NOTES_FOOTER, footer);
}

/* ---------- Add Note dialog ---------- */
typedef struct NoteCtx { char severity[16]; char text[300]; } NoteCtx;
static INT_PTR CALLBACK note_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    NoteCtx *ctx = (NoteCtx *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (m == WM_INITDIALOG) {
        ctx = (NoteCtx *)lp;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)ctx);
        HWND cb = GetDlgItem(h, IDC_NOTE_SEVERITY);
        static const char *SEV[] = { "INFO", "WARNING", "CRITICAL" };
        for (int i = 0; i < 3; ++i)
            SendMessageA(cb, CB_ADDSTRING, 0, (LPARAM)SEV[i]);
        SendMessageA(cb, CB_SETCURSEL, 0, 0);
        return TRUE;
    }
    if (m == WM_COMMAND) {
        if (LOWORD(wp) == IDOK) {
            HWND cb = GetDlgItem(h, IDC_NOTE_SEVERITY);
            int s = (int)SendMessageA(cb, CB_GETCURSEL, 0, 0);
            if (s >= 0) SendMessageA(cb, CB_GETLBTEXT, (WPARAM)s, (LPARAM)ctx->severity);
            GetDlgItemTextA(h, IDC_NOTE_TEXT, ctx->text, (int)sizeof ctx->text);
            EndDialog(h, IDOK);
            return TRUE;
        }
        if (LOWORD(wp) == IDCANCEL) {
            EndDialog(h, IDCANCEL);
            return TRUE;
        }
    }
    return FALSE;
}

/* ---------- Reassign Adjuster (simple input via standard MessageBox + edit) ---------- */
static const char *ADJUSTER_OPTIONS[] = {
    "ADJ-NA-0142","ADJ-NA-0207","ADJ-WC-0419","ADJ-SE-0033","ADJ-MW-0185","ADJ-NE-0721"
};

/* Returns the index of the selected claim in app->model.claims, or -1. */
static int selected_claim_idx(WgmApp *app)
{
    if (!app->hwnd_tab_claims) return -1;
    HWND lv = GetDlgItem(app->hwnd_tab_claims, IDC_CLM_LIST);
    if (!lv) return -1;
    int sel = (int)SendMessageA(lv, LVM_GETNEXTITEM, (WPARAM)-1,
                                MAKELPARAM(LVNI_SELECTED, 0));
    if (sel < 0) return -1;
    LVITEMA it = {0}; it.mask = LVIF_PARAM; it.iItem = sel;
    SendMessageA(lv, LVM_GETITEMA, 0, (LPARAM)&it);
    return (int)it.lParam;
}

static void enable_claims_action_buttons(WgmApp *app, BOOL on)
{
    if (!app->hwnd_tab_claims) return;
    EnableWindow(GetDlgItem(app->hwnd_tab_claims, IDC_CLM_REASSIGN), on);
    EnableWindow(GetDlgItem(app->hwnd_tab_claims, IDC_CLM_CLOSE),    on);
    EnableWindow(GetDlgItem(app->hwnd_tab_claims, IDC_CLM_TRANSFER), on);
    EnableWindow(GetDlgItem(app->hwnd_tab_claims, IDC_CLM_VOID),     on);
}

static void action_reassign(WgmApp *app, HWND parent)
{
    int ci = selected_claim_idx(app);
    if (ci < 0) {
        MessageBoxA(parent, "Select a claim row first.", "Reassign Adjuster",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    WgmClaim *c = &app->model.claims[ci];
    /* Pick the next adjuster in the pool */
    int next = 0;
    for (int i = 0; i < (int)(sizeof ADJUSTER_OPTIONS / sizeof *ADJUSTER_OPTIONS); ++i) {
        if (strcmp(ADJUSTER_OPTIONS[i], c->adjuster) == 0) {
            next = (i + 1) % (int)(sizeof ADJUSTER_OPTIONS / sizeof *ADJUSTER_OPTIONS);
            break;
        }
    }
    char prompt[256];
    _snprintf(prompt, sizeof prompt,
              "Reassign %s from %s to %s?", c->id, c->adjuster, ADJUSTER_OPTIONS[next]);
    if (MessageBoxA(parent, prompt, "Reassign Adjuster",
                    MB_OKCANCEL | MB_ICONQUESTION) != IDOK)
        return;
    char old_adj[16];
    wgm_strlcpy(old_adj, c->adjuster, sizeof old_adj);
    wgm_strlcpy(c->adjuster, ADJUSTER_OPTIONS[next], sizeof c->adjuster);
    wgm_strlcpy(c->modified_by, app->user.agent_id, sizeof c->modified_by);
    wgm_iso8601_utc(c->modified_on, sizeof c->modified_on);
    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, c->id, sizeof a.claim_id);
    wgm_iso8601_utc(a.ts, sizeof a.ts);
    wgm_strlcpy(a.who, app->user.agent_id, sizeof a.who);
    _snprintf(a.text, sizeof a.text, "ADJUSTER REASSIGNED %s -> %s.",
              old_adj, c->adjuster);
    wgm_model_add_activity(&app->model, &a);
    wgm_model_save(&app->model);
    char audit[160];
    _snprintf(audit, sizeof audit, "%s %s->%s", c->id, old_adj, c->adjuster);
    wgm_log_audit("claim_reassign", app->user.agent_id, audit);
    fill_claims_tab(app);
}

static void action_close(WgmApp *app, HWND parent)
{
    int ci = selected_claim_idx(app);
    if (ci < 0) {
        MessageBoxA(parent, "Select a claim row first.", "Close Claim",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    if (app->user.role == ROLE_CSR) {
        MessageBoxA(parent,
            "Closing a claim requires Senior CSR (PIN 3456) or Claims Manager.",
            "Permission denied", MB_OK | MB_ICONERROR);
        return;
    }
    WgmClaim *c = &app->model.claims[ci];
    char prompt[200];
    _snprintf(prompt, sizeof prompt, "Close claim %s as CLSD-PAID?", c->id);
    if (MessageBoxA(parent, prompt, "Close Claim", MB_OKCANCEL | MB_ICONQUESTION) != IDOK)
        return;
    wgm_strlcpy(c->status, "CLSD-PAID", sizeof c->status);
    wgm_strlcpy(c->modified_by, app->user.agent_id, sizeof c->modified_by);
    wgm_iso8601_utc(c->modified_on, sizeof c->modified_on);
    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, c->id, sizeof a.claim_id);
    wgm_iso8601_utc(a.ts, sizeof a.ts);
    wgm_strlcpy(a.who, app->user.agent_id, sizeof a.who);
    _snprintf(a.text, sizeof a.text, "CLAIM CLOSED. STATUS=CLSD-PAID.");
    wgm_model_add_activity(&app->model, &a);
    wgm_model_save(&app->model);
    wgm_log_audit("claim_close", app->user.agent_id, c->id);
    fill_claims_tab(app);
}

static void action_void(WgmApp *app, HWND parent)
{
    int ci = selected_claim_idx(app);
    if (ci < 0) {
        MessageBoxA(parent, "Select a claim row first.", "Void Claim",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    if (app->user.role != ROLE_MGR) {
        MessageBoxA(parent,
            "Voiding a claim is a Claims Manager-only action (PIN 9999).",
            "Permission denied", MB_OK | MB_ICONERROR);
        return;
    }
    WgmClaim *c = &app->model.claims[ci];
    char prompt[200];
    _snprintf(prompt, sizeof prompt, "Void claim %s? This cannot be undone.", c->id);
    if (MessageBoxA(parent, prompt, "Void Claim", MB_OKCANCEL | MB_ICONWARNING) != IDOK)
        return;
    wgm_strlcpy(c->status, "VOID", sizeof c->status);
    wgm_strlcpy(c->modified_by, app->user.agent_id, sizeof c->modified_by);
    wgm_iso8601_utc(c->modified_on, sizeof c->modified_on);
    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, c->id, sizeof a.claim_id);
    wgm_iso8601_utc(a.ts, sizeof a.ts);
    wgm_strlcpy(a.who, app->user.agent_id, sizeof a.who);
    _snprintf(a.text, sizeof a.text, "CLAIM VOIDED BY %s.", app->user.agent_id);
    wgm_model_add_activity(&app->model, &a);
    wgm_model_save(&app->model);
    wgm_log_audit("claim_void", app->user.agent_id, c->id);
    fill_claims_tab(app);
}

static void action_transfer(WgmApp *app, HWND parent)
{
    int ci = selected_claim_idx(app);
    if (ci < 0) {
        MessageBoxA(parent, "Select a claim row first.", "Transfer Claim",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    WgmClaim *c = &app->model.claims[ci];
    /* Rotate to the next field office in the pool */
    static const char *FOS[] = {"FO-WST-014","FO-EST-002","FO-MID-007","FO-SOU-021","FO-NWE-009"};
    int next = 0;
    for (int i = 0; i < (int)(sizeof FOS / sizeof *FOS); ++i) {
        if (strcmp(FOS[i], c->field_office) == 0) {
            next = (i + 1) % (int)(sizeof FOS / sizeof *FOS);
            break;
        }
    }
    char prompt[256];
    _snprintf(prompt, sizeof prompt,
              "Transfer %s from field office %s to %s?",
              c->id, c->field_office, FOS[next]);
    if (MessageBoxA(parent, prompt, "Transfer Claim",
                    MB_OKCANCEL | MB_ICONQUESTION) != IDOK)
        return;
    char old_fo[16];
    wgm_strlcpy(old_fo, c->field_office, sizeof old_fo);
    wgm_strlcpy(c->field_office, FOS[next], sizeof c->field_office);
    wgm_strlcpy(c->modified_by, app->user.agent_id, sizeof c->modified_by);
    wgm_iso8601_utc(c->modified_on, sizeof c->modified_on);
    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, c->id, sizeof a.claim_id);
    wgm_iso8601_utc(a.ts, sizeof a.ts);
    wgm_strlcpy(a.who, app->user.agent_id, sizeof a.who);
    _snprintf(a.text, sizeof a.text, "TRANSFERRED %s -> %s.", old_fo, c->field_office);
    wgm_model_add_activity(&app->model, &a);
    wgm_model_save(&app->model);
    char audit[160];
    _snprintf(audit, sizeof audit, "%s %s->%s", c->id, old_fo, c->field_office);
    wgm_log_audit("claim_transfer", app->user.agent_id, audit);
    fill_claims_tab(app);
}

static void action_mark_suspicious(WgmApp *app, HWND parent)
{
    int ci = selected_claim_idx(app);
    if (ci < 0) {
        MessageBoxA(parent, "Select a claim row first.", "Mark Suspicious",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    WgmClaim *c = &app->model.claims[ci];
    c->suspicious = c->suspicious ? 0 : 1;
    wgm_strlcpy(c->modified_by, app->user.agent_id, sizeof c->modified_by);
    wgm_iso8601_utc(c->modified_on, sizeof c->modified_on);
    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, c->id, sizeof a.claim_id);
    wgm_iso8601_utc(a.ts, sizeof a.ts);
    wgm_strlcpy(a.who, app->user.agent_id, sizeof a.who);
    _snprintf(a.text, sizeof a.text, "MARK SUSPICIOUS=%d.", c->suspicious);
    wgm_model_add_activity(&app->model, &a);
    wgm_model_save(&app->model);
    char audit[64]; _snprintf(audit, sizeof audit, "%s flag=%d", c->id, c->suspicious);
    wgm_log_audit("mark_suspicious", app->user.agent_id, audit);
    fill_claims_tab(app);
}

static void action_audit_history(WgmApp *app, HWND parent)
{
    int ci = selected_claim_idx(app);
    if (ci < 0) {
        MessageBoxA(parent, "Select a claim row first.", "Audit History",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    WgmClaim *c = &app->model.claims[ci];
    char buf[4096] = "";
    int n = 0;
    n += _snprintf(buf + n, sizeof buf - (size_t)n, "Audit History for %s\r\n", c->id);
    n += _snprintf(buf + n, sizeof buf - (size_t)n, "Opened by %s on %s\r\n", c->opened_by, c->opened_on);
    n += _snprintf(buf + n, sizeof buf - (size_t)n, "Last Modified by %s on %s\r\n\r\n", c->modified_by, c->modified_on);
    for (int i = 0; i < app->model.n_activities && (size_t)n < sizeof buf - 80; ++i) {
        if (strcmp(app->model.activities[i].claim_id, c->id) != 0) continue;
        n += _snprintf(buf + n, sizeof buf - (size_t)n, "  %s  %s  %s\r\n",
                       app->model.activities[i].ts,
                       app->model.activities[i].who,
                       app->model.activities[i].text);
    }
    MessageBoxA(parent, buf, "Audit History", MB_OK | MB_ICONINFORMATION);
}

static void action_add_note(WgmApp *app, HWND parent)
{
    if (app->selected_policy_idx < 0) {
        MessageBoxA(parent, "Select a policy/claim first.", "Add Note",
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    NoteCtx nc = {0};
    if (DialogBoxParamA(app->hinst, MAKEINTRESOURCEA(IDD_ADD_NOTE), parent,
                        note_proc, (LPARAM)&nc) == IDOK) {
        /* CSR cannot file CRITICAL notes per spec */
        if (strcmp(nc.severity, "CRITICAL") == 0 && app->user.role == ROLE_CSR) {
            MessageBoxA(parent,
                "CRITICAL notes require Senior CSR or Claims Manager role.",
                "Permission denied", MB_OK | MB_ICONERROR);
            return;
        }
        /* Prefer the selected claim if any; else most recent claim on the policy. */
        const char *cid = NULL;
        int sel_ci = selected_claim_idx(app);
        if (sel_ci >= 0) {
            cid = app->model.claims[sel_ci].id;
        } else {
            const char *pid = app->model.policies[app->selected_policy_idx].id;
            for (int i = 0; i < app->model.n_claims; ++i)
                if (strcmp(app->model.claims[i].policy_id, pid) == 0)
                    cid = app->model.claims[i].id;
        }
        if (!cid) {
            MessageBoxA(parent, "No claims on this policy to attach a note to.",
                        "Add Note", MB_OK | MB_ICONINFORMATION);
            return;
        }
        WgmNote n; memset(&n, 0, sizeof n);
        wgm_strlcpy(n.claim_id, cid, sizeof n.claim_id);
        wgm_strlcpy(n.severity, nc.severity, sizeof n.severity);
        wgm_iso8601_utc(n.ts, sizeof n.ts);
        wgm_strlcpy(n.who, app->user.agent_id, sizeof n.who);
        wgm_strlcpy(n.text, nc.text, sizeof n.text);
        wgm_model_add_note(&app->model, &n);
        wgm_model_save(&app->model);
        fill_notes_tab(app);
        wgm_log_audit("note_add", app->user.agent_id, nc.severity);
    }
}

/* ---------- Tabs + layout ---------- */
static void show_tab_page(WgmApp *app, int page)
{
    HWND panes[5] = {
        app->hwnd_tab_policy, app->hwnd_tab_coverage,
        app->hwnd_tab_claims, app->hwnd_tab_fnol, app->hwnd_tab_notes
    };
    for (int i = 0; i < 5; ++i)
        ShowWindow(panes[i], (i == page) ? SW_SHOW : SW_HIDE);
    if (page == TAB_POLICY)   fill_policy_tab(app);
    if (page == TAB_COVERAGE) fill_coverage_tab(app);
    if (page == TAB_CLAIMS)   fill_claims_tab(app);
    if (page == TAB_NOTES)    fill_notes_tab(app);
}

static void create_tabs_and_panes(WgmApp *app, int x, int y, int w, int h)
{
    app->hwnd_tabs = CreateWindowExA(0, WC_TABCONTROLA, "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP, x, y, w, h,
        app->hwnd_main, (HMENU)(LONG_PTR)IDC_DETAIL_TABS, app->hinst, NULL);

    TCITEMA t = {0}; t.mask = TCIF_TEXT;
    t.pszText = (char *)"Policy";   SendMessageA(app->hwnd_tabs, TCM_INSERTITEMA, 0, (LPARAM)&t);
    t.pszText = (char *)"Coverage"; SendMessageA(app->hwnd_tabs, TCM_INSERTITEMA, 1, (LPARAM)&t);
    t.pszText = (char *)"Claims";   SendMessageA(app->hwnd_tabs, TCM_INSERTITEMA, 2, (LPARAM)&t);
    t.pszText = (char *)"New FNOL"; SendMessageA(app->hwnd_tabs, TCM_INSERTITEMA, 3, (LPARAM)&t);
    t.pszText = (char *)"Notes";    SendMessageA(app->hwnd_tabs, TCM_INSERTITEMA, 4, (LPARAM)&t);

    RECT tr; GetClientRect(app->hwnd_tabs, &tr);
    SendMessageA(app->hwnd_tabs, TCM_ADJUSTRECT, FALSE, (LPARAM)&tr);

    int pane_x = x + tr.left;
    int pane_y = y + tr.top;
    int pane_w = tr.right - tr.left;
    int pane_h = tr.bottom - tr.top;

    DWORD style = WS_CHILD | WS_CLIPCHILDREN;
    app->hwnd_tab_policy   = CreateWindowExA(0, PANE_CLASS, NULL, style, pane_x, pane_y, pane_w, pane_h, app->hwnd_main, NULL, app->hinst, NULL);
    app->hwnd_tab_coverage = CreateWindowExA(0, PANE_CLASS, NULL, style, pane_x, pane_y, pane_w, pane_h, app->hwnd_main, NULL, app->hinst, NULL);
    app->hwnd_tab_claims   = CreateWindowExA(0, PANE_CLASS, NULL, style, pane_x, pane_y, pane_w, pane_h, app->hwnd_main, NULL, app->hinst, NULL);
    app->hwnd_tab_fnol     = CreateWindowExA(0, PANE_CLASS, NULL, style, pane_x, pane_y, pane_w, pane_h, app->hwnd_main, NULL, app->hinst, NULL);
    app->hwnd_tab_notes    = CreateWindowExA(0, PANE_CLASS, NULL, style, pane_x, pane_y, pane_w, pane_h, app->hwnd_main, NULL, app->hinst, NULL);

    build_policy_tab(app, app->hwnd_tab_policy);
    build_coverage_tab(app, app->hwnd_tab_coverage);
    build_claims_tab(app, app->hwnd_tab_claims);
    wgm_fnol_init(app);
    build_notes_tab(app, app->hwnd_tab_notes);

    ShowWindow(app->hwnd_tab_policy, SW_SHOW);
}

static void resize_layout(WgmApp *app)
{
    RECT r; GetClientRect(app->hwnd_main, &r);
    int status_h = wgm_scale(STATUS_H);
    SendMessageA(app->hwnd_status, WM_SIZE, 0, 0);
    int avail_h = r.bottom - status_h;
    /* Layout: search panel on left, tabs on right (search panel width scaled). */
    int search_w = wgm_scale(SEARCH_W);
    int tabs_x = search_w;
    int tabs_y = 0;
    int tabs_w = r.right - search_w;
    int tabs_h = avail_h;
    if (app->hwnd_tabs)
        MoveWindow(app->hwnd_tabs, tabs_x, tabs_y, tabs_w, tabs_h, TRUE);
    /* Resize panes to fit tab display area */
    if (app->hwnd_tabs) {
        RECT tr; GetClientRect(app->hwnd_tabs, &tr);
        SendMessageA(app->hwnd_tabs, TCM_ADJUSTRECT, FALSE, (LPARAM)&tr);
        int pane_x = tabs_x + tr.left;
        int pane_y = tabs_y + tr.top;
        int pane_w = tr.right - tr.left;
        int pane_h = tr.bottom - tr.top;
        HWND panes[5] = {
            app->hwnd_tab_policy, app->hwnd_tab_coverage,
            app->hwnd_tab_claims, app->hwnd_tab_fnol, app->hwnd_tab_notes
        };
        for (int i = 0; i < 5; ++i)
            if (panes[i])
                MoveWindow(panes[i], pane_x, pane_y, pane_w, pane_h, TRUE);
    }
    /* Resize results list to fill leftover space in search panel */
    if (g_search.list) {
        RECT lr; GetClientRect(g_search.list, &lr);
        POINT pt = {0,0}; ClientToScreen(g_search.list, &pt);
        POINT pp = pt; ScreenToClient(app->hwnd_main, &pp);
        int lh = avail_h - pp.y - 8;
        if (lh < 80) lh = 80;
        MoveWindow(g_search.list, pp.x, pp.y, wgm_scale(SEARCH_W) - 16, lh, TRUE);
    }
}

void wgm_main_load_customer(WgmApp *app, int customer_idx, int prefer_policy_idx)
{
    app->selected_customer_idx = customer_idx;
    app->selected_policy_idx = -1;
    if (customer_idx < 0 || customer_idx >= app->model.n_customers)
        return;
    const char *cid = app->model.customers[customer_idx].id;
    if (prefer_policy_idx >= 0 && prefer_policy_idx < app->model.n_policies &&
        strcmp(app->model.policies[prefer_policy_idx].customer_id, cid) == 0) {
        app->selected_policy_idx = prefer_policy_idx;
    } else {
        for (int i = 0; i < app->model.n_policies; ++i) {
            if (strcmp(app->model.policies[i].customer_id, cid) == 0) {
                app->selected_policy_idx = i;
                break;
            }
        }
    }
    int page = (int)SendMessageA(app->hwnd_tabs, TCM_GETCURSEL, 0, 0);
    if (page < 0) page = TAB_POLICY;
    show_tab_page(app, page);
}

/* ---------- Main window proc ---------- */
static LRESULT CALLBACK main_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    WgmApp *app = &g_app;
    switch (m) {
    case WM_CREATE:
        return 0;
    case WM_SIZE:
        if (app->hwnd_status)
            SendMessageA(app->hwnd_status, WM_SIZE, 0, 0);
        resize_layout(app);
        return 0;
    case WM_GETMINMAXINFO: {
        MINMAXINFO *mm = (MINMAXINFO *)lp;
        mm->ptMinTrackSize.x = MIN_W;
        mm->ptMinTrackSize.y = MIN_H;
        return 0;
    }
    case WM_NOTIFY: {
        NMHDR *nh = (NMHDR *)lp;
        if (nh->hwndFrom == app->hwnd_tabs && nh->code == TCN_SELCHANGE) {
            int page = (int)SendMessageA(app->hwnd_tabs, TCM_GETCURSEL, 0, 0);
            if (page < 0) page = 0;
            show_tab_page(app, page);
            return 0;
        }
        if (nh->idFrom == IDC_SEARCH_RESULTS && nh->code == LVN_ITEMACTIVATE) {
            int sel = (int)SendMessageA(g_search.list, LVM_GETNEXTITEM, (WPARAM)-1, MAKELPARAM(LVNI_SELECTED, 0));
            if (sel >= 0) {
                LVITEMA it = {0}; it.mask = LVIF_PARAM; it.iItem = sel;
                SendMessageA(g_search.list, LVM_GETITEMA, 0, (LPARAM)&it);
                wgm_main_load_customer(app, (int)it.lParam, -1);
                SendMessageA(app->hwnd_tabs, TCM_SETCURSEL, TAB_POLICY, 0);
                show_tab_page(app, TAB_POLICY);
            }
            return 0;
        }
        if (nh->idFrom == IDC_CLM_LIST && nh->code == LVN_ITEMCHANGED) {
            int sel = (int)SendMessageA(GetDlgItem(app->hwnd_tab_claims, IDC_CLM_LIST),
                                        LVM_GETNEXTITEM, (WPARAM)-1,
                                        MAKELPARAM(LVNI_SELECTED, 0));
            enable_claims_action_buttons(app, sel >= 0);
            return 0;
        }
        if ((nh->idFrom == IDC_SEARCH_RESULTS || nh->idFrom == IDC_CLM_LIST) &&
            nh->code == NM_RCLICK) {
            HMENU root = LoadMenuA(app->hinst,
                nh->idFrom == IDC_CLM_LIST ?
                    MAKEINTRESOURCEA(IDR_CLAIMS_CONTEXT_MENU) :
                    MAKEINTRESOURCEA(IDR_LIST_CONTEXT_MENU));
            if (root) {
                HMENU pop = GetSubMenu(root, 0);
                POINT pt; GetCursorPos(&pt);
                TrackPopupMenu(pop, TPM_LEFTALIGN | TPM_RIGHTBUTTON, pt.x, pt.y, 0, h, NULL);
                DestroyMenu(root);
            }
            return 0;
        }
        return 0;
    }
    case WM_COMMAND: {
        WORD id = LOWORD(wp);
        switch (id) {
        case IDC_SEARCH_BUTTON: run_search(app); return 0;
        case IDC_SEARCH_CLEAR:
            SetWindowTextA(g_search.input, "");
            SendMessageA(g_search.list, LVM_DELETEALLITEMS, 0, 0);
            return 0;
        case IDM_FILE_NEW_FNOL:
        case IDM_ACT_NEWFNOL:
            SendMessageA(app->hwnd_tabs, TCM_SETCURSEL, TAB_FNOL, 0);
            show_tab_page(app, TAB_FNOL);
            return 0;
        case IDM_FILE_EXIT:
            DestroyWindow(h);
            return 0;
        case IDM_HELP_ABOUT:
            wgm_show_about(h);
            return 0;
        case IDM_EDIT_FIND:
            SetFocus(g_search.input);
            return 0;
        case IDM_VIEW_REFRESH:
            wgm_main_refresh_status(app);
            return 0;
        case IDM_TOOLS_HOSTLINK:
            MessageBoxA(h, app->host_linked ? "HOST: LINKED to WMHOST01" : "HOST: RECONNECTING...",
                        "Host Link Status", MB_OK | MB_ICONINFORMATION);
            return 0;
        case IDM_REPORTS_FRAUD: {
            int count = 0;
            char buf[2048] = "Suspicious round-dollar pattern detected on POL-2024-000777:\r\n\r\n";
            size_t bl = strlen(buf);
            for (int i = 0; i < app->model.n_claims; ++i) {
                if (app->model.claims[i].suspicious) {
                    char money[32];
                    wgm_format_money(money, sizeof money, app->model.claims[i].reserve);
                    int n = _snprintf(buf + bl, sizeof buf - bl, "  %s  %s  %s  %s\r\n",
                                      app->model.claims[i].id,
                                      app->model.claims[i].loss_date,
                                      money,
                                      app->model.claims[i].loss_location);
                    if (n > 0) bl += (size_t)n;
                    count++;
                }
            }
            MessageBoxA(h, buf, "Fraud Pattern Report", MB_OK | MB_ICONWARNING);
            (void)count;
            return 0;
        }
        case IDM_TOOLS_RESETDATA:
            if (app->user.role == ROLE_MGR) {
                if (MessageBoxA(h, "Reset and reseed all local data?\nAll un-persisted changes will be lost.",
                                "Reset Data", MB_OKCANCEL | MB_ICONWARNING) == IDOK) {
                    wgm_model_reset(&app->model);
                    wgm_log_audit("reset_data", app->user.agent_id, "");
                    wgm_main_refresh_status(app);
                }
            } else {
                MessageBoxA(h, "Reset All Data is a Manager-only action.",
                            "Permission denied", MB_OK | MB_ICONERROR);
            }
            return 0;
        case IDC_NOTES_ADD:
        case IDM_ACT_NOTE:
            action_add_note(app, h);
            return 0;
        case IDM_ACT_REASSIGN:
        case IDC_CLM_REASSIGN:
            action_reassign(app, h);
            return 0;
        case IDM_ACT_TRANSFER:
        case IDC_CLM_TRANSFER:
            action_transfer(app, h);
            return 0;
        case IDM_ACT_CLOSE:
        case IDC_CLM_CLOSE:
            action_close(app, h);
            return 0;
        case IDM_ACT_VOID:
        case IDC_CLM_VOID:
            action_void(app, h);
            return 0;
        case IDM_ACT_MARK_SUSPICIOUS:
            action_mark_suspicious(app, h);
            return 0;
        case IDM_ACT_AUDIT:
        case IDM_VIEW_AUDIT:
            action_audit_history(app, h);
            return 0;
        case IDM_ACT_OPEN: {
            int sel = (int)SendMessageA(g_search.list, LVM_GETNEXTITEM, (WPARAM)-1,
                                        MAKELPARAM(LVNI_SELECTED, 0));
            if (sel >= 0) {
                LVITEMA it = {0}; it.mask = LVIF_PARAM; it.iItem = sel;
                SendMessageA(g_search.list, LVM_GETITEMA, 0, (LPARAM)&it);
                wgm_main_load_customer(app, (int)it.lParam, -1);
                SendMessageA(app->hwnd_tabs, TCM_SETCURSEL, TAB_POLICY, 0);
                show_tab_page(app, TAB_POLICY);
            }
            return 0;
        }
        case IDM_ACT_PRINT:
        case IDM_FILE_PRINT: {
            MessageBoxA(h,
                "Print routed to local spooler queue 'WMHOST01-LP1'. "
                "(Demonstration build - no real spooler attached.)",
                "Print Record", MB_OK | MB_ICONINFORMATION);
            wgm_log_audit("print_record", app->user.agent_id, "");
            return 0;
        }
        case IDM_ACT_EXPORT:
        case IDM_FILE_EXPORT: {
            MessageBoxA(h,
                "Export queued. CSVs in %ProgramData%\\ZavaClaims\\data\\ "
                "are already the system-of-record export for this build.",
                "Export to Excel", MB_OK | MB_ICONINFORMATION);
            wgm_log_audit("export_record", app->user.agent_id, "");
            return 0;
        }
        case IDM_FILE_OPEN:
            SetFocus(g_search.input);
            return 0;
        }
        return 0;
    }
    case WM_TIMER:
        if (wp == 100) {
            wgm_main_refresh_status(app);
            return 0;
        }
        if (wp == 101) {
            /* Host link flutter: toggle for ~1s then return */
            app->host_linked = !app->host_linked;
            wgm_main_refresh_status(app);
            SetTimer(h, 102, 1000, NULL);
            return 0;
        }
        if (wp == 102) {
            KillTimer(h, 102);
            app->host_linked = 1;
            wgm_main_refresh_status(app);
            return 0;
        }
        break;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcA(h, m, wp, lp);
}

int wgm_main_create(WgmApp *app)
{
    INITCOMMONCONTROLSEX icex = { sizeof icex, ICC_LISTVIEW_CLASSES | ICC_TREEVIEW_CLASSES |
                                  ICC_TAB_CLASSES | ICC_BAR_CLASSES | ICC_PROGRESS_CLASS };
    InitCommonControlsEx(&icex);

    register_pane_class(app->hinst);
    wgm_init_scale();   /* pick a screen-fitting scale before sizing font/controls/window */
    g_hfont = create_ui_font();

    WNDCLASSA wc = {0};
    wc.lpfnWndProc = main_proc;
    wc.hInstance = app->hinst;
    wc.hCursor = LoadCursorA(NULL, MAKEINTRESOURCEA(32512));
    wc.hbrBackground = (HBRUSH)(COLOR_3DFACE + 1);
    wc.lpszClassName = MAIN_CLASS;
    wc.lpszMenuName = MAKEINTRESOURCEA(IDR_MAIN_MENU);
    wc.hIcon = LoadIconA(app->hinst, MAKEINTRESOURCEA(IDI_APP));
    RegisterClassA(&wc);

    app->hwnd_main = CreateWindowExA(0, MAIN_CLASS, WGM_MAIN_TITLE,
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        CW_USEDEFAULT, CW_USEDEFAULT, MIN_W, MIN_H,
        NULL, NULL, app->hinst, NULL);
    if (!app->hwnd_main) return -1;

    make_status_bar(app);
    build_search_panel(app);
    create_tabs_and_panes(app, SEARCH_W, 0, 800, MIN_H - STATUS_H);

    app->selected_customer_idx = -1;
    app->selected_policy_idx   = -1;
    app->host_linked = 1;
    if (app->user.display[0] == '\0') {
        /* If we got here without login (e.g., direct main_run path), default to A. Carter. */
        wgm_strlcpy(app->user.agent_id, "C1001", sizeof app->user.agent_id);
        wgm_strlcpy(app->user.display, "A. Carter", sizeof app->user.display);
        app->user.role = ROLE_CSR;
    }
    if (app->aux_code[0] == '\0' && !app->ready)
        app->ready = 1;

    set_font_on_all_children(app->hwnd_main, g_hfont);

    /* Scale the whole control tree + list-view columns for readable streamed
     * frames, then grow the window so the enlarged content fits. resize_layout
     * (on the SetWindowPos-triggered WM_SIZE) re-lays-out the tabs/panes/list
     * using the scaled search-panel width. */
    scale_children_geometry(app->hwnd_main);
    scale_listview_columns(g_search.list);
    scale_listview_columns(GetDlgItem(app->hwnd_tab_claims, IDC_CLM_LIST));
    scale_listview_columns(GetDlgItem(app->hwnd_tab_notes, IDC_NOTES_LIST));

    /* Size to the (screen-fitted) scaled dimensions and CENTER on the work area,
     * so the enlarged window never spills off the bottom/edges of the Cloud PC. */
    {
        int winW = wgm_scale(MIN_W);
        int winH = wgm_scale(MIN_H);
        RECT wa = {0};
        int x = CW_USEDEFAULT, y = CW_USEDEFAULT;
        UINT flags = SWP_NOZORDER;
        if (SystemParametersInfoA(SPI_GETWORKAREA, 0, &wa, 0)) {
            int workW = wa.right - wa.left;
            int workH = wa.bottom - wa.top;
            x = wa.left + (workW - winW) / 2;
            y = wa.top + (workH - winH) / 2;
            if (x < wa.left) x = wa.left;
            if (y < wa.top) y = wa.top;
        } else {
            flags |= SWP_NOMOVE;
        }
        SetWindowPos(app->hwnd_main, NULL, x, y, winW, winH, flags);
    }

    SetTimer(app->hwnd_main, 100, 1000, NULL); /* status bar tick */
    if (!app->stable_host) {
        SetTimer(app->hwnd_main, 101, 180000, NULL); /* host link flutter every 3min */
    }

    ShowWindow(app->hwnd_main, SW_SHOW);
    UpdateWindow(app->hwnd_main);
    wgm_main_refresh_status(app);
    return 0;
}

int wgm_main_run(WgmApp *app)
{
    HACCEL hAcc = LoadAcceleratorsA(app->hinst, MAKEINTRESOURCEA(IDR_ACCEL));
    MSG msg;
    while (GetMessageA(&msg, NULL, 0, 0) > 0) {
        if (hAcc && TranslateAcceleratorA(app->hwnd_main, hAcc, &msg)) continue;
        if (IsDialogMessageA(app->hwnd_main, &msg)) continue;
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }
    return (int)msg.wParam;
}
