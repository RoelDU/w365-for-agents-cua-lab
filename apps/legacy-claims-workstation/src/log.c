/*
 * log.c - append-only line logger; opens the file lazily.
 */
#include "log.h"
#include "util.h"

#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static char g_log_path[MAX_PATH] = {0};
static CRITICAL_SECTION g_log_cs;
static int g_log_ready = 0;

void wgm_log_init(void)
{
    if (g_log_ready)
        return;
    InitializeCriticalSection(&g_log_cs);
    char dir[MAX_PATH];
    if (wgm_log_dir(dir, sizeof dir) == 0) {
        _snprintf(g_log_path, sizeof g_log_path, "%s\\claims.log", dir);
        g_log_path[sizeof g_log_path - 1] = '\0';
    }
    g_log_ready = 1;
}

void wgm_log(const char *fmt, ...)
{
    if (!g_log_ready)
        wgm_log_init();
    if (!g_log_path[0])
        return;
    char ts[32];
    wgm_iso8601_utc(ts, sizeof ts);
    char body[1024];
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf(body, sizeof body, fmt, ap);
    va_end(ap);
    body[sizeof body - 1] = '\0';

    EnterCriticalSection(&g_log_cs);
    HANDLE h = CreateFileA(g_log_path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        char line[1200];
        int n = _snprintf(line, sizeof line, "%s %s\r\n", ts, body);
        if (n > 0) {
            DWORD wr;
            WriteFile(h, line, (DWORD)n, &wr, NULL);
        }
        CloseHandle(h);
    }
    LeaveCriticalSection(&g_log_cs);
}

void wgm_log_audit(const char *event, const char *who, const char *details)
{
    wgm_log("AUDIT event=%s who=%s details=\"%s\"",
            event ? event : "?",
            who ? who : "-",
            details ? details : "");
}
