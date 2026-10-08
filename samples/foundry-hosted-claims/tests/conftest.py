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
