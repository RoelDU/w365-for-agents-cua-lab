#!/usr/bin/env python
"""Render or deploy the Zava Foundry hosted Claims agent definition.

The default action is read-only: it renders the hosted-agent definition from a
local JSON config. Creating a hosted version or changing the endpoint requires an
explicit flag from Deploy-FoundryAgent.ps1.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GUID_ZERO = "00000000-0000-0000-0000-000000000000"
# Known only after the first hosted version exists (its native blueprint and agent identity)
# and the agent user is created. Left empty, they are omitted, which is allowed only while
# both execution gates are off: the first deployment's purpose is to create the identity.
IDENTITY_VARIABLES = ("CLAIMS_TENANT_ID", "CLAIMS_BLUEPRINT_ID", "CLAIMS_AGENT_ID", "CLAIMS_AGENT_USER_ID")


def load_config(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise SystemExit("Config root must be a JSON object.")
    return data


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def image_from_config(config: dict[str, Any], digest_override: str | None = None) -> str:
    registry = str(config.get("containerRegistryName", "")).strip()
    repo = str(config.get("imageRepository", "")).strip()
    digest = str(digest_override or config.get("imageDigest", "")).strip()
    if not registry or not repo:
        raise SystemExit("containerRegistryName and imageRepository are required.")
    if not digest:
        raise SystemExit("imageDigest is empty. Run -BuildImage first or paste the ACR digest into the local config.")
    if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        raise SystemExit("imageDigest must look like sha256:<64 hex characters>.")
    return f"{registry}.azurecr.io/{repo}@{digest}"


def hosted_definition(config: dict[str, Any], image: str) -> dict[str, Any]:
    env = {
        "LIVE_EXECUTION_APPROVED": "no",
        "CLAIMS_EXECUTION_APPROVED": "no",
        "PYTHON_ENVIRONMENT": "Production",
        "HOST": "0.0.0.0",
        "AZURE_AI_MODEL_DEPLOYMENT_NAME": "gpt-4.1-mini",
    }
    env.update((config.get("hostedAgent") or {}).get("environmentVariables") or {})
    for key, value in list(env.items()):
        if value is None or (key in IDENTITY_VARIABLES and str(value).strip() == ""):
            env.pop(key)
        else:
            env[key] = str(value)
    return {
        "cpu": "0.5",
        "memory": "1Gi",
        "container_configuration": {"image": image},
        "protocol_versions": [{"protocol": "invocations", "version": "2.0.0"}],
        "session_configuration": {"idle_timeout_seconds": 1200},
        "environment_variables": env,
        "kind": "hosted",
    }


def validate_no_placeholders(config: dict[str, Any], definition: dict[str, Any]) -> None:
    required = ["tenantId", "foundryProjectEndpoint", "agentName"]
    for name in required:
        value = str(config.get(name, "")).strip()
        if not value or value == GUID_ZERO or "<" in value:
            raise SystemExit(f"{name} must be set in the local config before deployment.")
    env = definition["environment_variables"]
    for key, value in env.items():
        if "<" in value or value == GUID_ZERO:
            raise SystemExit(f"hostedAgent.environmentVariables.{key} still has a placeholder value.")
    missing = [key for key in IDENTITY_VARIABLES if key not in env]
    gates_on = env.get("LIVE_EXECUTION_APPROVED") == "yes" or env.get("CLAIMS_EXECUTION_APPROVED") == "yes"
    if missing and gates_on:
        raise SystemExit(
            f"{', '.join(missing)} must be set before an execution gate is turned on. Deploy once with "
            "both gates 'no', create the agent user (Set-FoundryAgentIdentity.ps1), then fill them in."
        )


def write_receipt(path: Path, data: dict[str, Any]) -> None:
    path = path if path.is_absolute() else repo_root() / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Receipt: {path}")


def receipt_path(config: dict[str, Any], action: str, override: Path | None = None) -> Path:
    """The deployment receipt (outputReceiptPath) is written only by deploy-version, so the
    identity it records survives later render and endpoint steps, which get sibling files."""
    if override:
        return override
    main = Path(str(config.get("outputReceiptPath") or "deploy/foundry/foundry-agent-deployment.local.json"))
    if action == "deploy-version":
        return main
    suffix = "endpoint" if action == "configure-endpoint" else "render"
    name = main.name
    if name.endswith(".local.json"):
        return main.with_name(f"{name[:-len('.local.json')]}-{suffix}.local.json")
    return main.with_name(f"{main.stem}-{suffix}{main.suffix}")


def render_receipt(config: dict[str, Any], definition: dict[str, Any], action: str) -> dict[str, Any]:
    return {
        "recordedUtc": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "agentName": config.get("agentName"),
        "foundryProjectEndpoint": config.get("foundryProjectEndpoint"),
        "definition": definition,
        "invocationPerformed": False,
        "newInfrastructureCreated": False,
    }


def get_existing_agent(project: Any, agent: str) -> dict[str, Any] | None:
    """The live agent, or None only when Foundry answers that it does not exist yet.
    Authentication, permission and other errors are raised unchanged."""
    from azure.core.exceptions import ResourceNotFoundError

    try:
        return project.agents.get(agent).as_dict()
    except ResourceNotFoundError:
        return None


def deploy_version(config: dict[str, Any], definition: dict[str, Any]) -> dict[str, Any]:
    try:
        from azure.ai.projects import AIProjectClient
        from azure.ai.projects.models import HostedAgentDefinition
        from azure.identity import AzureCliCredential
    except Exception as exc:  # pragma: no cover - depends on operator machine
        raise SystemExit(
            "Missing Foundry SDK packages. Install the sample dependencies first: "
            "py -3.12 -m pip install -e samples\\foundry-hosted-claims"
        ) from exc

    validate_no_placeholders(config, definition)
    tenant = str(config["tenantId"])
    endpoint = str(config["foundryProjectEndpoint"])
    agent = str(config["agentName"])
    expected_identity = str(config.get("expectedInstanceIdentityClientId", "")).strip()
    description = str((config.get("hostedAgent") or {}).get("description") or "Zava Claims hosted agent version")
    metadata = (config.get("hostedAgent") or {}).get("metadata") or {}

    with AzureCliCredential(tenant_id=tenant, process_timeout=45) as credential:
        with AIProjectClient(endpoint=endpoint, credential=credential, allow_preview=True, connection_timeout=30, read_timeout=90, retry_total=0) as project:
            current = get_existing_agent(project, agent)
            if current is None:
                if expected_identity:
                    raise SystemExit(
                        f"Agent '{agent}' does not exist, but expectedInstanceIdentityClientId is set. "
                        "Leave it empty for the first deployment, or check agentName and foundryProjectEndpoint."
                    )
                print(f"Agent '{agent}' does not exist yet; creating it with its first version.")
            elif expected_identity:
                actual = ((current.get("instance_identity") or {}).get("client_id") or "").lower()
                if actual != expected_identity.lower():
                    raise SystemExit("The live agent instance identity does not match expectedInstanceIdentityClientId.")
            created = project.agents.create_version(
                agent_name=agent,
                definition=HostedAgentDefinition(**definition),
                description=description,
                metadata=metadata,
            ).as_dict()
            version = created.get("version")
            status = created.get("status")
            for _ in range(36):
                if status in {"active", "failed"}:
                    break
                time.sleep(5)
                status = project.agents.get_version(agent, version).as_dict().get("status")
            after = project.agents.get(agent).as_dict()
            identity = {key: value for key, value in after.items() if "identity" in key or "blueprint" in key}
            return {"version": version, "status": status, "identity": identity, "created": created,
                    "agentExistedBefore": current is not None}


def configure_endpoint(config: dict[str, Any], pin_version: str | None = None) -> dict[str, Any]:
    """Invocations + Entra authorization. With pin_version, all traffic goes to that one version
    instead of the default @latest, so a later create_version receives no traffic until the
    endpoint is pinned to it (and rolling back is pinning the previous version again)."""
    try:
        from azure.ai.projects import AIProjectClient
        from azure.ai.projects.models import (
            AgentEndpointConfig,
            EntraAuthorizationScheme,
            InvocationsProtocolConfiguration,
            ProtocolConfiguration,
        )
        from azure.identity import AzureCliCredential
    except Exception as exc:  # pragma: no cover - depends on SDK version
        raise SystemExit("The installed Foundry SDK does not expose endpoint configuration models. Update azure-ai-projects.") from exc

    validate_no_placeholders(config, {"environment_variables": {"dummy": "set"}})
    tenant = str(config["tenantId"])
    endpoint = str(config["foundryProjectEndpoint"])
    agent = str(config["agentName"])
    with AzureCliCredential(tenant_id=tenant, process_timeout=45) as credential:
        with AIProjectClient(endpoint=endpoint, credential=credential, allow_preview=True, connection_timeout=30, read_timeout=90, retry_total=0) as project:
            settings: dict[str, Any] = {
                "protocol_configuration": ProtocolConfiguration(invocations=InvocationsProtocolConfiguration()),
                "authorization_schemes": [EntraAuthorizationScheme()],
            }
            if pin_version:
                from azure.ai.projects.models import FixedRatioVersionSelectionRule, VersionSelector

                status = project.agents.get_version(agent, pin_version).as_dict().get("status")
                if status != "active":
                    raise SystemExit(f"Version {pin_version} of '{agent}' is {status!r}, not active; the endpoint was not changed.")
                settings["version_selector"] = VersionSelector(
                    version_selection_rules=[FixedRatioVersionSelectionRule(agent_version=pin_version, traffic_percentage=100)]
                )
            updated = project.agents.update_details(agent, agent_endpoint=AgentEndpointConfig(**settings)).as_dict()
            return {"updated": updated, "pinnedVersion": pin_version}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--image-digest")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--deploy-version", action="store_true")
    parser.add_argument("--configure-endpoint", action="store_true")
    parser.add_argument("--pin-version", help="With --configure-endpoint: send all traffic to this version instead of @latest.")
    args = parser.parse_args()
    if args.pin_version and not args.configure_endpoint:
        parser.error("--pin-version needs --configure-endpoint")

    config = load_config(args.config)
    image = image_from_config(config, args.image_digest)
    definition = hosted_definition(config, image)
    action = "deploy-version" if args.deploy_version else "configure-endpoint" if args.configure_endpoint else "render-definition"
    receipt = render_receipt(config, definition, action)

    if args.deploy_version:
        receipt["deployment"] = deploy_version(config, definition)
    if args.configure_endpoint:
        receipt["endpoint"] = configure_endpoint(config, args.pin_version)

    out = receipt_path(config, action, args.out)
    write_receipt(out, receipt)
    print(json.dumps({"action": action, "agentName": config.get("agentName"), "image": image, "receipt": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
