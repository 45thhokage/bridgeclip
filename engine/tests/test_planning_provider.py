"""Offline tests for the OpenAI-compatible planning provider.

No live calls: every request goes through httpx.MockTransport and the planner
tests replace the provider call itself.
"""

import asyncio
import json
import sys
from unittest.mock import patch

import httpx
import pytest

from clip_engine.config import Settings
from clip_engine.services.intelligence_planner import (
    IntelligencePlannerService,
    IntelligencePlanningError,
)
from clip_engine.services.planning_provider import (
    CONTEXT_WINDOW_ERROR,
    CompatiblePlanningProvider,
    PlanningProviderError,
    context_window_error,
    estimated_tokens,
    strip_code_fences,
)
from clip_engine.services.transcription_service import (
    TranscriptSegment,
    TranscriptionResult,
)


class Body(httpx.AsyncByteStream):
    """A real stream for client.stream()/aiter_raw (MockTransport content is consumed)."""

    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self):
        pass


def client_for(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url="http://127.0.0.1:11434/v1", transport=httpx.MockTransport(handler))


def response(payload: bytes, status: int = 200) -> httpx.Response:
    return httpx.Response(status, stream=Body([payload]), headers={"content-type": "application/json"})


def completion(content: str, model: str = "local/model", cost=None, status: int = 200) -> httpx.Response:
    body = {
        "model": model,
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }
    if cost is not None:
        body["usage"]["cost"] = cost
    return response(json.dumps(body).encode(), status)


def provider(**overrides) -> CompatiblePlanningProvider:
    values = {
        "base_url": "http://127.0.0.1:11434/v1",
        "model_id": "local/model",
        "api_key": "",
        "context_tokens": 8192,
        "loopback_host": "127.0.0.1",
        "loopback_port": 11434,
    }
    values.update(overrides)
    return CompatiblePlanningProvider(**values)


class TestProviderAdapter:
    def test_chat_uses_plain_openai_payload_without_structured_outputs(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["headers"] = dict(request.headers)
            seen["body"] = json.loads(request.content)
            return completion('{"insights": "ok", "clips": []}')

        async def call():
            async with client_for(handler) as client:
                return await provider(api_key="secret-key").chat(client, [{"role": "user", "content": "hello"}], 512)

        body, usage = asyncio.run(call())
        assert seen["url"] == "http://127.0.0.1:11434/v1/chat/completions"
        assert seen["headers"]["authorization"] == "Bearer secret-key"
        assert seen["body"]["model"] == "local/model"
        assert seen["body"]["max_tokens"] == 512
        assert "response_format" not in seen["body"]
        assert "plugins" not in seen["body"]
        assert "provider" not in seen["body"]
        assert usage["total_tokens"] == 15

    def test_rate_limit_is_retryable_and_classified(self):
        async def call():
            async with client_for(lambda request: response(b"{}", 429)) as client:
                await provider().chat(client, [{"role": "user", "content": "hello"}], 32)

        with pytest.raises(PlanningProviderError) as error:
            asyncio.run(call())
        assert error.value.retryable is True
        assert "rate limiting" in str(error.value)

    def test_invalid_key_is_not_retryable(self):
        async def call():
            async with client_for(lambda request: response(b"{}", 401)) as client:
                await provider().chat(client, [{"role": "user", "content": "hello"}], 32)

        with pytest.raises(PlanningProviderError) as error:
            asyncio.run(call())
        assert error.value.retryable is False
        assert "rejected this key" in str(error.value)

    def test_context_window_check_blocks_before_any_request(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return completion("{}")

        async def call():
            async with client_for(handler) as client:
                await provider(context_tokens=2048).chat(
                    client, [{"role": "user", "content": "word " * 5000}], 512
                )

        with pytest.raises(PlanningProviderError) as error:
            asyncio.run(call())
        assert str(error.value) == CONTEXT_WINDOW_ERROR
        assert calls == [], "no request may be sent when the prompt cannot fit"

    def test_code_fences_are_stripped(self):
        assert strip_code_fences('```json\n{"clips": []}\n```') == '{"clips": []}'
        assert strip_code_fences('{"clips": []}') == '{"clips": []}'

    def test_estimated_tokens_and_allowance(self):
        messages = [{"role": "user", "content": "x" * 300}]
        assert estimated_tokens(messages) == 100
        assert context_window_error(messages, 2048 + 100) is None
        assert context_window_error(messages, 2048 + 99) == CONTEXT_WINDOW_ERROR


def make_transcript(seconds: int = 60) -> TranscriptionResult:
    segments = []
    for start in range(0, seconds, 5):
        segments.append(TranscriptSegment(
            start_time_ms=start * 1000,
            end_time_ms=start * 1000 + 4000,
            text=f"segment {start} words here end.",
            speaker_label=None,
            words=[],
            audio_events=[],
        ))
    return TranscriptionResult(segments=segments, full_text="", duration_seconds=seconds)


def make_compatible_planner() -> IntelligencePlannerService:
    planner = IntelligencePlannerService()
    planner.settings = Settings(
        _env_file=None,
        planning_source="local",
        planning_provider="local",
        planning_base_url="http://127.0.0.1:11434/v1",
        planning_model_id="local/model",
        planning_context_tokens=8192,
        planning_local_host="127.0.0.1",
        planning_local_port=11434,
    )
    return planner


class TestPlannerRetry:
    def _plan(self, planner):
        return asyncio.run(planner.plan_clips(make_transcript(), max_clips=3))

    def test_invalid_json_is_retried_with_the_validation_error(self):
        planner = make_compatible_planner()
        calls = []

        async def fake_call(model, messages, fallback_models=None):
            calls.append(messages)
            # The first answer is unparseable; the retry must succeed.
            content = "not json at all" if len(calls) == 1 else "{\"clips\": []}"
            return {"model": model, "choices": [{"message": {"content": content}, "finish_reason": "stop"}]}, {
                "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": None,
            }

        with patch.object(planner, "_call_openrouter", side_effect=fake_call):
            result = self._plan(planner)

        assert result.total_clips == 0
        assert len(calls) == 2, "one retry after the invalid answer"
        assert len(calls[0]) == 2
        assert "previous answer could not be used" in calls[1][-1]["content"].lower()

    def test_third_invalid_answer_fails_with_a_clear_error(self):
        planner = make_compatible_planner()
        calls = []

        async def fake_call(model, messages, fallback_models=None):
            calls.append(messages)
            return {"model": model, "choices": [{"message": {"content": "still not json"}, "finish_reason": "stop"}]}, {
                "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": None,
            }

        with patch.object(planner, "_call_openrouter", side_effect=fake_call):
            with pytest.raises(IntelligencePlanningError) as error:
                self._plan(planner)
        assert len(calls) == 3
        assert "did not return a usable clip plan after 3 attempts" in str(error.value)

    def test_local_planning_reports_zero_cost_and_no_invented_price(self):
        planner = make_compatible_planner()
        calls = 0

        async def fake_call(model, messages, fallback_models=None):
            nonlocal calls
            calls += 1
            return {"model": model, "choices": [{"message": {"content": "{\"clips\": []}"}, "finish_reason": "stop"}]}, {
                "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": None,
            }

        with patch.object(planner, "_call_openrouter", side_effect=fake_call):
            result = self._plan(planner)
        assert calls == 1
        assert result.api_costs.provider == "local"
        assert result.api_costs.estimated_cost_usd == 0
        assert result.api_costs.cost_incomplete is False

    def test_compatible_cloud_planning_marks_cost_as_incomplete(self):
        planner = make_compatible_planner()
        planner.settings = Settings(
            _env_file=None,
            planning_source="cloud",
            planning_provider="opencode-zen",
            planning_base_url="https://opencode.ai/zen/v1",
            planning_model_id="some-model",
        )

        async def fake_call(model, messages, fallback_models=None):
            return {"model": model, "choices": [{"message": {"content": "{\"clips\": []}"}, "finish_reason": "stop"}]}, {
                "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": None,
            }

        with patch.object(planner, "_call_openrouter", side_effect=fake_call):
            result = self._plan(planner)
        assert result.api_costs.provider == "opencode-zen"
        assert result.api_costs.cost_incomplete is True
        assert result.api_costs.estimated_cost_usd == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__]))
