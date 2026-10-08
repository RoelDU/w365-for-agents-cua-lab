from typing import Any

from openai import AsyncOpenAI

from .claims import INSTRUCTIONS


class FoundryModel:
    def __init__(self, client: AsyncOpenAI, deployment: str) -> None:
        self.client = client
        self.deployment = deployment

    async def respond(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_output_tokens: int,
    ) -> dict[str, Any]:
        arguments: dict[str, Any] = {
            "model": self.deployment,
            "instructions": INSTRUCTIONS,
            "input": messages,
            "tools": tools,
            "parallel_tool_calls": True,
            # Run D: a text-only turn ended the task; stopping must use finish_claim.
            "tool_choice": "required",
            "store": False,
            # Sized per handoff from the longest text a turn must write (claims.output_token_limit).
            "max_output_tokens": max_output_tokens,
        }
        response = await self.client.responses.create(**arguments)
        return response.model_dump(mode="json", exclude_none=True)
