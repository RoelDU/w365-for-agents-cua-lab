from hosted_claims.deployment import definition


def test_acr_definition_uses_platform_identity_not_external_registry_exchange():
    image = "approved.azurecr.io/claims-w365@sha256:" + "a" * 64
    payload = definition(image).as_dict()
    assert payload["container_configuration"] == {"image": image}
    assert payload["environment_variables"]["LIVE_EXECUTION_APPROVED"] == "no"
    assert payload["environment_variables"]["CLAIMS_EXECUTION_APPROVED"] == "no"
    assert payload["session_configuration"]["idle_timeout_seconds"] == 1200
