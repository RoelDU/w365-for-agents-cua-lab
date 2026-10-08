"""Offline tests for deploy_foundry_agent.py. A fake Foundry SDK is injected, so nothing
is sent to Azure. Run from the repository root:

    python -m unittest deploy/foundry/test_deploy_foundry_agent.py
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_foundry_agent as dfa  # noqa: E402


class ResourceNotFoundError(Exception):
    pass


class ClientAuthenticationError(Exception):
    pass


class _Obj:
    def __init__(self, data):
        self._data = data

    def as_dict(self):
        return dict(self._data)


class FakeAgents:
    def __init__(self, existing=None, get_error=None):
        self.existing = existing
        self.get_error = get_error
        self.created = []

    def get(self, name):
        if self.get_error:
            raise self.get_error
        if self.existing is None:
            raise ResourceNotFoundError(f"agent {name} not found")
        return _Obj(self.existing)

    def create_version(self, agent_name, definition, description, metadata):
        self.created.append(agent_name)
        self.existing = {"instance_identity": {"client_id": "new-identity"}, "blueprint": {"id": "bp"}}
        return _Obj({"version": "1", "status": "active"})

    def get_version(self, name, version):
        return _Obj({"status": "active"})

    def update_details(self, name, agent_endpoint):
        self.endpoint = (name, agent_endpoint)
        return _Obj({"name": name})


class FakeProject:
    agents: FakeAgents

    def __init__(self, **_):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeCredential(FakeProject):
    pass


def fake_sdk(agents: FakeAgents) -> dict[str, types.ModuleType]:
    FakeProject.agents = agents
    projects = types.ModuleType("azure.ai.projects")
    projects.AIProjectClient = FakeProject
    models = types.ModuleType("azure.ai.projects.models")
    models.HostedAgentDefinition = lambda **kw: kw

    # Keyword-only, like azure-ai-projects 2.7.0: an unknown keyword such as `protocols` fails.
    def endpoint_config(*, protocol_configuration=None, authorization_schemes=None):
        return {"protocol_configuration": protocol_configuration, "authorization_schemes": authorization_schemes}

    models.AgentEndpointConfig = endpoint_config
    models.ProtocolConfiguration = lambda *, invocations=None: {"invocations": invocations}
    models.InvocationsProtocolConfiguration = lambda: "invocations"
    models.EntraAuthorizationScheme = lambda: "entra"
    identity = types.ModuleType("azure.identity")
    identity.AzureCliCredential = FakeCredential
    exceptions = types.ModuleType("azure.core.exceptions")
    exceptions.ResourceNotFoundError = ResourceNotFoundError
    azure = types.ModuleType("azure")
    return {"azure": azure, "azure.ai": types.ModuleType("azure.ai"), "azure.ai.projects": projects,
            "azure.ai.projects.models": models, "azure.identity": identity, "azure.core": types.ModuleType("azure.core"),
            "azure.core.exceptions": exceptions}


CONFIG = {
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "foundryProjectEndpoint": "https://acct.services.ai.azure.com/api/projects/proj",
    "agentName": "claims-w365",
    "containerRegistryName": "reg",
    "imageRepository": "claims-w365",
    "imageDigest": "sha256:" + "a" * 64,
    "outputReceiptPath": "deploy/foundry/foundry-agent-deployment.local.json",
}


def definition():
    return dfa.hosted_definition(CONFIG, dfa.image_from_config(CONFIG))


class DeployVersionTests(unittest.TestCase):
    def run_deploy(self, agents, config=CONFIG):
        with mock.patch.dict(sys.modules, fake_sdk(agents)):
            return dfa.deploy_version(dict(config), definition())

    def test_first_deployment_creates_missing_agent(self):
        agents = FakeAgents(existing=None)
        result = self.run_deploy(agents)
        self.assertEqual(agents.created, ["claims-w365"])
        self.assertFalse(result["agentExistedBefore"])
        self.assertEqual(result["identity"]["instance_identity"]["client_id"], "new-identity")

    def test_missing_agent_with_expected_identity_stops(self):
        agents = FakeAgents(existing=None)
        with self.assertRaises(SystemExit):
            self.run_deploy(agents, {**CONFIG, "expectedInstanceIdentityClientId": "abc"})
        self.assertEqual(agents.created, [])

    def test_update_keeps_identity_check(self):
        agents = FakeAgents(existing={"instance_identity": {"client_id": "live-id"}})
        with self.assertRaises(SystemExit):
            self.run_deploy(agents, {**CONFIG, "expectedInstanceIdentityClientId": "other-id"})
        self.assertEqual(agents.created, [])
        self.run_deploy(agents, {**CONFIG, "expectedInstanceIdentityClientId": "LIVE-ID"})
        self.assertEqual(agents.created, ["claims-w365"])

    def test_other_errors_are_not_swallowed(self):
        agents = FakeAgents(get_error=ClientAuthenticationError("token rejected"))
        with self.assertRaises(ClientAuthenticationError):
            self.run_deploy(agents)
        self.assertEqual(agents.created, [])


class ConfigureEndpointTests(unittest.TestCase):
    def test_sets_invocations_with_entra_authorization(self):
        agents = FakeAgents(existing={"instance_identity": {"client_id": "live-id"}})
        with mock.patch.dict(sys.modules, fake_sdk(agents)):
            dfa.configure_endpoint(dict(CONFIG))
        name, endpoint = agents.endpoint
        self.assertEqual(name, "claims-w365")
        self.assertEqual(endpoint["protocol_configuration"], {"invocations": "invocations"})
        self.assertEqual(endpoint["authorization_schemes"], ["entra"])

    def test_keywords_match_the_installed_sdk(self):
        try:
            from azure.ai.projects.models import (
                AgentEndpointConfig,
                EntraAuthorizationScheme,
                InvocationsProtocolConfiguration,
                ProtocolConfiguration,
            )
        except ImportError:
            self.skipTest("azure-ai-projects is not installed")
        config = AgentEndpointConfig(
            protocol_configuration=ProtocolConfiguration(invocations=InvocationsProtocolConfiguration()),
            authorization_schemes=[EntraAuthorizationScheme()],
        ).as_dict()
        self.assertIn("invocations", config["protocol_configuration"])


class ReceiptPathTests(unittest.TestCase):
    def test_only_deploy_version_writes_the_identity_receipt(self):
        main = Path("deploy/foundry/foundry-agent-deployment.local.json")
        self.assertEqual(dfa.receipt_path(CONFIG, "deploy-version"), main)
        self.assertEqual(dfa.receipt_path(CONFIG, "configure-endpoint"),
                         Path("deploy/foundry/foundry-agent-deployment-endpoint.local.json"))
        self.assertEqual(dfa.receipt_path(CONFIG, "render-definition"),
                         Path("deploy/foundry/foundry-agent-deployment-render.local.json"))

    def test_explicit_out_wins(self):
        self.assertEqual(dfa.receipt_path(CONFIG, "configure-endpoint", Path("x.json")), Path("x.json"))


if __name__ == "__main__":
    unittest.main()
