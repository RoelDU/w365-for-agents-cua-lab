"""Render an SDK-validated hosted definition locally; never create or deploy resources."""

import argparse
import json
from datetime import timedelta

from azure.ai.projects.models import (
    ContainerConfiguration,
    HostedAgentDefinition,
    ProtocolVersionRecord,
    SessionConfiguration,
)


def definition(image: str) -> HostedAgentDefinition:
    if ".azurecr.io/" not in image or "@sha256:" not in image:
        raise ValueError("Use the approved ACR image pinned by sha256 digest, not a mutable tag.")
    return HostedAgentDefinition(
        cpu="0.5",
        memory="1Gi",
        container_configuration=ContainerConfiguration(image=image),
        protocol_versions=[ProtocolVersionRecord(protocol="invocations", version="2.0.0")],
        # A disconnected viewer must not suspend a still-running 15-minute Claims task.
        session_configuration=SessionConfiguration(idle_timeout_seconds=timedelta(minutes=20)),
        environment_variables={
            "LIVE_EXECUTION_APPROVED": "no",
            "CLAIMS_EXECUTION_APPROVED": "no",
            "PYTHON_ENVIRONMENT": "Production",
            "HOST": "0.0.0.0",
            "AZURE_AI_MODEL_DEPLOYMENT_NAME": "gpt-4.1-mini",
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    print(json.dumps(definition(args.image).as_dict(), indent=2))


if __name__ == "__main__":
    main()
