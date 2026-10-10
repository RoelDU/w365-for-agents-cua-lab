import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(
    sys.platform == "linux"
    and os.getenv("CLAIMS_CONTAINER_STARTUP_TEST") == "1",
    "Requires the disposable Linux container validation build, never the shared workstation.",
)
class ContainerStartupTests(unittest.TestCase):
    def test_rejects_state_directory_symlink_without_changing_target(self):
        state = Path("/home/session/.claims-agent")
        if state.exists():
            state.rmdir()
        with tempfile.TemporaryDirectory(prefix="claims-startup-") as directory:
            target = Path(directory)
            before = target.stat()
            state.symlink_to(target, target_is_directory=True)
            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        "from hosted_claims.bootstrap import prepare_runtime; prepare_runtime()",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("NotADirectoryError", result.stderr)
                after = target.stat()
                self.assertEqual(
                    (after.st_uid, after.st_gid, after.st_mode),
                    (before.st_uid, before.st_gid, before.st_mode),
                )
            finally:
                state.unlink()

    def test_root_owned_session_home_becomes_writable_without_retaining_root(self):
        subprocess.run(
            [
                sys.executable,
                "-c",
                """
import os
from pathlib import Path
from hosted_claims.bootstrap import prepare_runtime
from hosted_claims.store import RunStore

home = Path("/home/session")
assert home.stat().st_uid == 0
prepare_runtime()
assert (os.getuid(), os.getgid(), os.getgroups()) == (10001, 10001, [])
try:
    os.setuid(0)
except PermissionError:
    pass
else:
    raise AssertionError("Agent could regain root")
assert home.stat().st_uid == 0
state = home / ".claims-agent"
assert state.stat().st_uid == 10001
assert state.stat().st_mode & 0o777 == 0o700
database = state / "startup-regression.sqlite"
RunStore(database)
assert database.is_file()
for name in ("startup-regression.sqlite", "startup-regression.sqlite-wal", "startup-regression.sqlite-shm"):
    (state / name).unlink(missing_ok=True)
""",
            ],
            check=True,
            timeout=20,
        )


if __name__ == "__main__":
    unittest.main()
