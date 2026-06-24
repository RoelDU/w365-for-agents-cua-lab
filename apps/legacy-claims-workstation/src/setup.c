/*
 * setup.c - native self-installer for claims.exe (no PowerShell). See setup.h.
 */
#include "setup.h"
#include "log.h"

#include <windows.h>
#include <shlobj.h>
#include <objbase.h>
#include <shlguid.h>
#include <stdio.h>
#include <string.h>

#define WGM_APP_NAME      "Zava Claims Workstation"
#define WGM_APP_ALIAS     "Zava Claims"
#define WGM_VENDOR_DIR    "Business Applications\\Zava Claims Workstation"
#define WGM_DISPLAY_VER   "1.0.0"
#define WGM_PUBLISHER     "Zava (demo)"
#define WGM_UNINSTALL_KEY "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZavaClaimsWorkstation"

/* Resolve the install directory: %ProgramFiles%\Business Applications\Zava Claims Workstation */
static int install_dir(char *out, size_t cap)
{
    /* Test/override hook: ZAVACLAIMS_SETUP_DIR forces the install directory
     * (used for non-elevated validation). Production uses Program Files. */
    const char *override = getenv("ZAVACLAIMS_SETUP_DIR");
    if (override && *override) {
        strncpy(out, override, cap - 1);
        out[cap - 1] = '\0';
        return 0;
    }
    char pf[MAX_PATH];
    if (SHGetFolderPathA(NULL, CSIDL_PROGRAM_FILES, NULL, 0, pf) != S_OK) {
        const char *env = getenv("ProgramFiles");
        if (!env) return -1;
        strncpy(pf, env, sizeof pf - 1);
        pf[sizeof pf - 1] = '\0';
    }
    _snprintf(out, cap, "%s\\%s", pf, WGM_VENDOR_DIR);
    out[cap - 1] = '\0';
    return 0;
}

/* Create an all-users shortcut (.lnk) via IShellLink. Best-effort. */
static HRESULT make_shortcut(const char *lnk, const char *target, const char *workdir, const char *desc)
{
    IShellLinkA *psl = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IShellLinkA, (void **)&psl);
    if (FAILED(hr) || !psl) return hr;

    psl->lpVtbl->SetPath(psl, target);
    psl->lpVtbl->SetWorkingDirectory(psl, workdir);
    psl->lpVtbl->SetDescription(psl, desc);
    psl->lpVtbl->SetIconLocation(psl, target, 0);

    IPersistFile *ppf = NULL;
    hr = psl->lpVtbl->QueryInterface(psl, &IID_IPersistFile, (void **)&ppf);
    if (SUCCEEDED(hr) && ppf) {
        WCHAR w[MAX_PATH];
        MultiByteToWideChar(CP_ACP, 0, lnk, -1, w, MAX_PATH);
        hr = ppf->lpVtbl->Save(ppf, w, TRUE);
        ppf->lpVtbl->Release(ppf);
    }
    psl->lpVtbl->Release(psl);
    return hr;
}

static void make_shortcuts(const char *exe, const char *dir)
{
    HRESULT hrco = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    char folder[MAX_PATH], lnk[MAX_PATH];
    /* Create both the primary name and the "Zava Claims" alias (parity with the
     * legacy Install.ps1), in the all-users Start menu and Desktop. */
    const char *names[2] = { WGM_APP_NAME, WGM_APP_ALIAS };
    const int csidls[2]  = { CSIDL_COMMON_PROGRAMS, CSIDL_COMMON_DESKTOPDIRECTORY };
    const char *labels[2] = { "Start menu", "Desktop" };

    for (int l = 0; l < 2; ++l) {
        if (SHGetFolderPathA(NULL, csidls[l], NULL, 0, folder) != S_OK) continue;
        for (int n = 0; n < 2; ++n) {
            _snprintf(lnk, sizeof lnk, "%s\\%s.lnk", folder, names[n]);
            lnk[sizeof lnk - 1] = '\0';
            if (SUCCEEDED(make_shortcut(lnk, exe, dir, WGM_APP_NAME)))
                wgm_log("setup: %s shortcut %s", labels[l], lnk);
            else
                wgm_log("setup: WARN failed %s shortcut %s", labels[l], lnk);
        }
    }
    if (SUCCEEDED(hrco)) CoUninitialize();
}

static void remove_shortcuts(void)
{
    char folder[MAX_PATH], lnk[MAX_PATH];
    const char *names[2] = { WGM_APP_NAME, WGM_APP_ALIAS };
    const int csidls[2]  = { CSIDL_COMMON_PROGRAMS, CSIDL_COMMON_DESKTOPDIRECTORY };
    for (int i = 0; i < 2; ++i) {
        if (SHGetFolderPathA(NULL, csidls[i], NULL, 0, folder) != S_OK) continue;
        for (int n = 0; n < 2; ++n) {
            _snprintf(lnk, sizeof lnk, "%s\\%s.lnk", folder, names[n]);
            lnk[sizeof lnk - 1] = '\0';
            DeleteFileA(lnk);
        }
    }
}

static int write_uninstall_reg(const char *dir, const char *exe)
{
    HKEY hk;
    LONG rc = RegCreateKeyExA(HKEY_LOCAL_MACHINE, WGM_UNINSTALL_KEY, 0, NULL,
                              REG_OPTION_NON_VOLATILE, KEY_WRITE, NULL, &hk, NULL);
    if (rc != ERROR_SUCCESS) {
        wgm_log("setup: WARN RegCreateKeyEx failed (%ld) - not registered in Add/Remove Programs", rc);
        return -1;
    }
    char uninstall[MAX_PATH + 32];
    _snprintf(uninstall, sizeof uninstall, "\"%s\" --uninstall", exe);
    uninstall[sizeof uninstall - 1] = '\0';

    RegSetValueExA(hk, "DisplayName", 0, REG_SZ, (const BYTE *)WGM_APP_NAME, (DWORD)strlen(WGM_APP_NAME) + 1);
    RegSetValueExA(hk, "DisplayVersion", 0, REG_SZ, (const BYTE *)WGM_DISPLAY_VER, (DWORD)strlen(WGM_DISPLAY_VER) + 1);
    RegSetValueExA(hk, "Publisher", 0, REG_SZ, (const BYTE *)WGM_PUBLISHER, (DWORD)strlen(WGM_PUBLISHER) + 1);
    RegSetValueExA(hk, "InstallLocation", 0, REG_SZ, (const BYTE *)dir, (DWORD)strlen(dir) + 1);
    RegSetValueExA(hk, "DisplayIcon", 0, REG_SZ, (const BYTE *)exe, (DWORD)strlen(exe) + 1);
    RegSetValueExA(hk, "UninstallString", 0, REG_SZ, (const BYTE *)uninstall, (DWORD)strlen(uninstall) + 1);
    RegSetValueExA(hk, "QuietUninstallString", 0, REG_SZ, (const BYTE *)uninstall, (DWORD)strlen(uninstall) + 1);
    DWORD one = 1;
    RegSetValueExA(hk, "NoModify", 0, REG_DWORD, (const BYTE *)&one, sizeof one);
    RegSetValueExA(hk, "NoRepair", 0, REG_DWORD, (const BYTE *)&one, sizeof one);
    RegCloseKey(hk);
    return 0;
}

int wgm_setup_install(void)
{
    char self[MAX_PATH], dir[MAX_PATH], dest[MAX_PATH];
    if (GetModuleFileNameA(NULL, self, sizeof self) == 0) {
        wgm_log("setup: FATAL GetModuleFileName failed");
        return 1;
    }
    if (install_dir(dir, sizeof dir) != 0) {
        wgm_log("setup: FATAL cannot resolve Program Files");
        return 1;
    }
    _snprintf(dest, sizeof dest, "%s\\claims.exe", dir);
    dest[sizeof dest - 1] = '\0';

    int hr = SHCreateDirectoryExA(NULL, dir, NULL);
    if (hr != ERROR_SUCCESS && hr != ERROR_ALREADY_EXISTS && hr != ERROR_FILE_EXISTS) {
        wgm_log("setup: FATAL could not create %s (%d)", dir, hr);
        return 1;
    }

    /* Copy self -> dest unless already running from there. */
    if (_stricmp(self, dest) != 0) {
        if (!CopyFileA(self, dest, FALSE)) {
            wgm_log("setup: FATAL CopyFile %s -> %s failed (%lu)", self, dest, GetLastError());
            return 1;
        }
    }
    wgm_log("setup: installed binary at %s", dest);

    write_uninstall_reg(dir, dest);   /* non-fatal */
    make_shortcuts(dest, dir);        /* non-fatal */

    wgm_log("setup: install complete");
    return 0;
}

int wgm_setup_uninstall(void)
{
    char dir[MAX_PATH], dest[MAX_PATH], self[MAX_PATH];
    install_dir(dir, sizeof dir);
    _snprintf(dest, sizeof dest, "%s\\claims.exe", dir);
    dest[sizeof dest - 1] = '\0';
    GetModuleFileNameA(NULL, self, sizeof self);

    remove_shortcuts();

    LONG rc = RegDeleteKeyA(HKEY_LOCAL_MACHINE, WGM_UNINSTALL_KEY);
    if (rc == ERROR_SUCCESS) wgm_log("setup: removed Add/Remove Programs entry");

    /* If we're running from the install dir we cannot delete ourselves now;
     * schedule the binary + dir for deletion on reboot. Otherwise delete now. */
    if (_stricmp(self, dest) == 0) {
        MoveFileExA(dest, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
        wgm_log("setup: scheduled %s for deletion on reboot", dest);
    } else {
        DeleteFileA(dest);
        RemoveDirectoryA(dir);
    }
    wgm_log("setup: uninstall complete");
    return 0;
}
