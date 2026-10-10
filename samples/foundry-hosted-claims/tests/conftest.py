import pytest

from hosted_claims.gateway import clear_discovery_cache
from hosted_claims.identity import clear_token_cache


@pytest.fixture(autouse=True)
def fresh_process_caches():
    """Each test starts like a new hosted sandbox: no reused tokens or discovery."""
    clear_token_cache()
    clear_discovery_cache()
    yield
    clear_token_cache()
    clear_discovery_cache()


@pytest.fixture(autouse=True)
def no_startup_settle(monkeypatch):
    """The real start-up wait is 27 s; tests of it pass settle_seconds explicitly."""
    monkeypatch.setattr("hosted_claims.engine.SERVICE_BROWSER_SETTLE_SECONDS", 0)
