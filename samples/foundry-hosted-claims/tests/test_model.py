import json

import httpx2 as httpx
import pytest
from openai import AsyncOpenAI

from hosted_claims.model import FoundryModel


@pytest.mark.asyncio
async def test_model_uses_real_responses_api_with_ordered_tool_calls_and_no_saved_history():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "test-response",
                "object": "response",
                "created_at": 0,
                "status": "completed",
                "model": "gpt-4.1-mini",
                "output": [],
                "parallel_tool_calls": False,
                "tool_choice": "auto",
                "tools": [],
            },
        )

    async with AsyncOpenAI(
        api_key="test-only",
        base_url="https://model.invalid/openai/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(reply)),
    ) as client:
        model = FoundryModel(client, "gpt-4.1-mini")
        output = await model.respond([{"role": "user", "content": "test-only handoff"}], [], 1116)
    assert output["status"] == "completed"
    assert requests[0]["store"] is False
    # Several tool calls may come back in one reply; perform_claims runs them in order.
    assert requests[0]["parallel_tool_calls"] is True
    # Run D: a text-only turn ended the task; every turn must be a tool call (finish_claim to stop).
    assert requests[0]["tool_choice"] == "required"
    assert requests[0]["model"] == "gpt-4.1-mini"
    assert requests[0]["max_output_tokens"] == 1116
    assert "private reasoning" in requests[0]["instructions"]
