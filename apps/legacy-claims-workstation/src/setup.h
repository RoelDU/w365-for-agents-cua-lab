/*
 * setup.h - native (no-PowerShell) self-installer for claims.exe.
 *
 * Mirrors the proven Intune Win32 pattern used by other LOB apps on these
 * Cloud PCs (a compiled "Setup.exe /S"-style installer) instead of a
 * powershell.exe -File Install.ps1 command, which fails with 0x80070001 on the
 * locked-down agent Cloud PCs (#132).
 *
 *   claims.exe --install     copies the binary to
 *                            %ProgramFiles%\Business Applications\Zava Claims Workstation\,
 *                            registers it in Add/Remove Programs, and creates
 *                            all-users Start menu + Desktop shortcuts.
 *   claims.exe --uninstall   reverses the above.
 *
 * Both return 0 on success, non-zero on a fatal failure (Intune success codes).
 */
#ifndef WGM_SETUP_H
#define WGM_SETUP_H

int wgm_setup_install(void);
int wgm_setup_uninstall(void);

#endif /* WGM_SETUP_H */
