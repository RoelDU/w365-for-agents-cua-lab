/*
 * util.c - paths, time, atomic writes, etc. No dependencies beyond Win32.
 */
#include "util.h"

#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void joinp(char *dst, size_t cap, const char *a, const char *b)
{
    size_t la = strlen(a);
    int needs_sep = (la > 0 && a[la - 1] != '\\' && a[la - 1] != '/');
    if (needs_sep)
        _snprintf(dst, cap, "%s\\%s", a, b);
    else
        _snprintf(dst, cap, "%s%s", a, b);
    dst[cap - 1] = '\0';
}

void wgm_strlcpy(char *dst, const char *src, size_t cap)
{
    if (!cap)
        return;
    size_t i = 0;
    for (; i + 1 < cap && src[i]; ++i)
        dst[i] = src[i];
    dst[i] = '\0';
}

int wgm_ensure_dir(const char *path)
{
    if (!path || !*path)
        return -1;
    char buf[MAX_PATH];
    wgm_strlcpy(buf, path, sizeof buf);
    size_t n = strlen(buf);
    for (size_t i = 1; i < n; ++i) {
        if (buf[i] == '\\' || buf[i] == '/') {
            char saved = buf[i];
            buf[i] = '\0';
            if (buf[1] == ':' || (buf[0] == '\\' && buf[1] == '\\')) {
                /* skip drive root and UNC root */
            } else {
                CreateDirectoryA(buf, NULL);
            }
            buf[i] = saved;
            if (i > 0 && buf[i - 1] == ':') {
                /* root */
            } else {
                CreateDirectoryA(buf, NULL);
            }
        }
    }
    CreateDirectoryA(buf, NULL);
    DWORD attr = GetFileAttributesA(buf);
    if (attr == INVALID_FILE_ATTRIBUTES)
        return -1;
    if (!(attr & FILE_ATTRIBUTE_DIRECTORY))
        return -1;
    return 0;
}

int wgm_dir_writable(const char *dir)
{
    if (wgm_ensure_dir(dir) != 0)
        return 0;
    char probe[MAX_PATH];
    joinp(probe, sizeof probe, dir, ".wgm_probe.tmp");
    HANDLE h = CreateFileA(probe, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, NULL);
    if (h == INVALID_HANDLE_VALUE)
        return 0;
    CloseHandle(h);
    return 1;
}

static int try_make_root_under(const char *base, const char *leaf, char *dst, size_t cap)
{
    char root[MAX_PATH];
    joinp(root, sizeof root, base, leaf);
    if (wgm_dir_writable(root)) {
        wgm_strlcpy(dst, root, cap);
        return 1;
    }
    return 0;
}

/* Returns a writable ZavaClaims root, preferring ProgramData. */
static int wgm_root(char *dst, size_t cap)
{
    char pd[MAX_PATH];
    if (SHGetFolderPathA(NULL, CSIDL_COMMON_APPDATA, NULL, 0, pd) == S_OK) {
        if (try_make_root_under(pd, "ZavaClaims", dst, cap))
            return 0;
    }
    char la[MAX_PATH];
    if (SHGetFolderPathA(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, la) == S_OK) {
        if (try_make_root_under(la, "ZavaClaims", dst, cap))
            return 0;
    }
    /* Last-resort: current dir */
    GetCurrentDirectoryA((DWORD)cap, dst);
    return 0;
}

int wgm_data_dir(char *dst, size_t cap)
{
    char root[MAX_PATH];
    if (wgm_root(root, sizeof root) != 0)
        return -1;
    joinp(dst, cap, root, "data");
    wgm_ensure_dir(dst);
    return 0;
}

int wgm_log_dir(char *dst, size_t cap)
{
    char root[MAX_PATH];
    if (wgm_root(root, sizeof root) != 0)
        return -1;
    joinp(dst, cap, root, "logs");
    wgm_ensure_dir(dst);
    return 0;
}

int wgm_valid_claim_id(const char *id)
{
    if (!id) return 0;
    if (strncmp(id, "CLM-", 4) != 0) return 0;
    const char *p = id + 4;
    for (int i = 0; i < 4; ++i) if (p[i] < '0' || p[i] > '9') return 0;
    if (p[4] != '-') return 0;
    for (int i = 5; i < 11; ++i) if (p[i] < '0' || p[i] > '9') return 0;
    return p[11] == '\0';
}

int wgm_atomic_write(const char *path, const void *data, size_t len)
{
    char tmp[MAX_PATH];
    _snprintf(tmp, sizeof tmp, "%s.tmp", path);
    tmp[sizeof tmp - 1] = '\0';
    HANDLE h = CreateFileA(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE)
        return -1;
    DWORD written = 0;
    BOOL ok = WriteFile(h, data, (DWORD)len, &written, NULL);
    FlushFileBuffers(h);
    CloseHandle(h);
    if (!ok || written != (DWORD)len) {
        DeleteFileA(tmp);
        return -1;
    }
    /* MoveFileEx with REPLACE flag = atomic rename on NTFS */
    if (!MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileA(tmp);
        return -1;
    }
    return 0;
}

int wgm_read_file(const char *path, char **out_buf, size_t *out_len)
{
    HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE)
        return -1;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz)) {
        CloseHandle(h);
        return -1;
    }
    if (sz.QuadPart > 8 * 1024 * 1024) {
        CloseHandle(h);
        return -1;
    }
    size_t len = (size_t)sz.QuadPart;
    char *buf = (char *)malloc(len + 1);
    if (!buf) {
        CloseHandle(h);
        return -1;
    }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, (DWORD)len, &got, NULL);
    CloseHandle(h);
    if (!ok || got != (DWORD)len) {
        free(buf);
        return -1;
    }
    buf[len] = '\0';
    *out_buf = buf;
    if (out_len)
        *out_len = len;
    return 0;
}

void wgm_iso8601_utc(char *buf, size_t cap)
{
    SYSTEMTIME st;
    GetSystemTime(&st);
    _snprintf(buf, cap, "%04u-%02u-%02uT%02u:%02u:%02uZ",
              st.wYear, st.wMonth, st.wDay,
              st.wHour, st.wMinute, st.wSecond);
    buf[cap - 1] = '\0';
}

int wgm_current_year(void)
{
    SYSTEMTIME st;
    GetLocalTime(&st);
    int y = st.wYear;
    /* Per spec: seed data must not be future-dated past 2024. CLM IDs use the
     * current year for newly submitted claims, so we clamp to keep determinism
     * for the demo. */
    if (y > 2024)
        y = 2024;
    return y;
}

int wgm_ci_contains(const char *hay, const char *needle)
{
    if (!hay || !needle)
        return 0;
    if (!*needle)
        return 1;
    size_t nlen = strlen(needle);
    for (const char *p = hay; *p; ++p) {
        size_t i;
        for (i = 0; i < nlen; ++i) {
            char a = p[i];
            char b = needle[i];
            if (!a)
                return 0;
            if (a >= 'A' && a <= 'Z') a += 32;
            if (b >= 'A' && b <= 'Z') b += 32;
            if (a != b)
                break;
        }
        if (i == nlen)
            return 1;
    }
    return 0;
}

char *wgm_trim(char *s)
{
    if (!s)
        return s;
    char *p = s;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')
        p++;
    if (p != s)
        memmove(s, p, strlen(p) + 1);
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t' ||
                     s[n - 1] == '\r' || s[n - 1] == '\n')) {
        s[--n] = '\0';
    }
    return s;
}

void wgm_format_money(char *buf, size_t cap, double amount)
{
    if (!buf || cap == 0)
        return;
    int neg = amount < 0;
    if (neg) amount = -amount;
    long long cents = (long long)(amount * 100.0 + 0.5);
    long long whole = cents / 100;
    long long frac  = cents % 100;
    char wbuf[64];
    int wn = _snprintf(wbuf, sizeof wbuf, "%lld", whole);
    if (wn < 0) wn = 0;
    /* Insert thousand-separators */
    char gbuf[80];
    int gi = 0;
    int digits = wn;
    for (int i = 0; i < wn; ++i) {
        gbuf[gi++] = wbuf[i];
        int remaining = digits - i - 1;
        if (remaining > 0 && remaining % 3 == 0)
            gbuf[gi++] = ',';
    }
    gbuf[gi] = '\0';
    _snprintf(buf, cap, "%s$%s.%02lld", neg ? "-" : "", gbuf, frac);
    buf[cap - 1] = '\0';
}

/* ---- last-agent persistence ---- */
static void last_agent_path(char *dst, size_t cap)
{
    char dir[MAX_PATH];
    if (wgm_data_dir(dir, sizeof dir) != 0) {
        wgm_strlcpy(dst, "", cap);
        return;
    }
    _snprintf(dst, cap, "%s\\last_agent.txt", dir);
    dst[cap - 1] = '\0';
}

int wgm_read_last_agent(char *dst, size_t cap)
{
    if (!dst || cap < 2) return -1;
    dst[0] = '\0';
    char path[MAX_PATH];
    last_agent_path(path, sizeof path);
    if (!path[0]) return -1;
    char *buf = NULL;
    size_t len = 0;
    if (wgm_read_file(path, &buf, &len) != 0) return -1;
    /* Strip trailing whitespace/newlines and cap at first non-printable */
    size_t out = 0;
    for (size_t i = 0; i < len && out + 1 < cap; ++i) {
        unsigned char c = (unsigned char)buf[i];
        if (c < 0x20 || c > 0x7E) break;
        if (c == ' ') continue;
        dst[out++] = (char)c;
    }
    dst[out] = '\0';
    free(buf);
    return out > 0 ? 0 : -1;
}

int wgm_write_last_agent(const char *agent_id)
{
    if (!agent_id || !*agent_id) return -1;
    char path[MAX_PATH];
    last_agent_path(path, sizeof path);
    if (!path[0]) return -1;
    return wgm_atomic_write(path, agent_id, strlen(agent_id));
}
