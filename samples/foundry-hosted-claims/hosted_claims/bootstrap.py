"""Initialize only the session data directory, then permanently drop root."""

import os
import sys

HOME = "/home/session"
STATE_NAME = ".claims-agent"
APP_UID = 10001
APP_GID = 10001


def prepare_runtime() -> None:
    if sys.platform != "linux":
        raise RuntimeError("This initializer is only for the Linux container.")
    if os.geteuid() != 0:
        raise RuntimeError("Container initialization requires root before dropping privileges.")
    if os.environ.get("HOME") != HOME:
        raise RuntimeError("Container HOME must be the approved /home/session mount.")
    if os.getenv("CLAIMS_STATE_DIR", f"{HOME}/{STATE_NAME}") != f"{HOME}/{STATE_NAME}":
        raise RuntimeError("Container state must remain in the approved session directory.")

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    home_fd = os.open(HOME, flags)
    try:
        try:
            os.mkdir(STATE_NAME, mode=0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        state_fd = os.open(STATE_NAME, flags, dir_fd=home_fd)
        try:
            os.fchown(state_fd, APP_UID, APP_GID)
            os.fchmod(state_fd, 0o700)
        finally:
            os.close(state_fd)
    finally:
        os.close(home_fd)

    os.setgroups([])
    os.setgid(APP_GID)
    os.setuid(APP_UID)
    os.umask(0o077)
    if (os.geteuid(), os.getegid(), os.getgroups()) != (APP_UID, APP_GID, []):
        raise RuntimeError("Refusing to start the agent without dropping privileges.")


def main() -> None:
    prepare_runtime()
    if os.getenv("CLAIMS_IDENTITY_PROBE_REQUEST_ID") or os.getenv("CLAIMS_TOOLING_PROBE_REQUEST_ID"):
        from .identity_probe import main as run_host
    else:
        from .host import main as run_host

    run_host()


if __name__ == "__main__":
    main()
