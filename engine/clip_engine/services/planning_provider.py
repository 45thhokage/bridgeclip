"""OpenAI-compatible clip-planning provider.

OpenCode Zen/Go, a custom endpoint and a local OpenAI-compatible server all
speak `POST {base}/chat/completions`. They may not support structured outputs,
so this adapter never sends `response_format`: the system message asks for one
JSON object, the reply is cleaned of code fences and the planner's existing
parser and validator stay in charge. Invalid output is retried by the planner
with the validation error appended, never fabricated into a clip plan.

Network rules match the OpenRouter calls: no redirects, identity encoding, a
bounded response and a 90-second timeout. A local server may use plain http,
but only on this computer and only while the caller holds the scoped loopback
exception from the bridge's network guard.
"""

import json
import logging
from contextlib import contextmanager, nullcontext
from typing import Any, Iterator, Optional

import httpx

logger = logging.getLogger(__name__)

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 90.0
CONNECT_TIMEOUT_SECONDS = 15.0
# A safe token estimate for English text; only used to refuse oversized prompts.
CHARS_PER_TOKEN = 3
# Reserved for the JSON answer before a local prompt is compared to the context window.
OUTPUT_ALLOWANCE_TOKENS = 2048

CONTEXT_WINDOW_ERROR = (
    "This video's transcript is too long for the configured context window. "
    "Raise the context window in your local server and in this setting, or use a cloud planner."
)

JSON_INSTRUCTION = (
    "Answer with a single JSON object only. No markdown, no code fences and no commentary "
    "outside the JSON object. The object must contain an \"insights\" string and a \"clips\" array."
)

RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}


class PlanningProviderError(Exception):
    """A compatible-provider request failed. `retryable` marks transient failures."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def strip_code_fences(content: str) -> str:
    """Remove a wrapping markdown code fence, if the model added one."""
    text = content.strip()
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def message_chars(messages: list[dict]) -> int:
    """Count text characters in a chat payload's messages."""
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    total += len(str(item.get("text", "")))
    return total


def estimated_tokens(messages: list[dict]) -> int:
    return (message_chars(messages) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def context_window_error(messages: list[dict], context_tokens: int) -> Optional[str]:
    """Return the refusal message when the prompt cannot fit, else None.

    Always checked before a request is sent; the planner never silently
    truncates a transcript.
    """
    if estimated_tokens(messages) > max(0, context_tokens - OUTPUT_ALLOWANCE_TOKENS):
        return CONTEXT_WINDOW_ERROR
    return None


@contextmanager
def loopback_exception(host: str, port: int) -> Iterator[None]:
    """Permit plain http to the saved loopback host:port for this call only.

    The bridge's guard checks the resolved address at connect time; this only
    widens that check to loopback addresses on one port. Outside this context
    every private, link-local and metadata range stays blocked.
    """
    try:
        from network_guard import allow_loopback_destination
    except ImportError:  # Engine tests import this module without the bridge on the path.
        allow_loopback_destination = None
    if allow_loopback_destination is None or not host or not port:
        with nullcontext():
            yield
        return
    with allow_loopback_destination(host, port):
        yield


class CompatiblePlanningProvider:
    """One OpenAI-compatible planning endpoint, resolved before the job starts."""

    def __init__(
        self,
        base_url: str,
        model_id: str,
        api_key: str = "",
        context_tokens: int = 0,
        loopback_host: str = "",
        loopback_port: int = 0,
    ):
        self.base_url = base_url
        self.model_id = model_id
        self.api_key = api_key
        self.context_tokens = context_tokens
        self.loopback_host = loopback_host
        self.loopback_port = loopback_port

    @property
    def is_local(self) -> bool:
        return bool(self.loopback_host and self.loopback_port)

    def check_prompt_fits(self, messages: list[dict]) -> None:
        """Raise before any request when a local prompt exceeds the context window."""
        if not self.is_local or self.context_tokens <= 0:
            return
        error = context_window_error(messages, self.context_tokens)
        if error:
            raise PlanningProviderError(error)

    async def chat(
        self,
        client: httpx.AsyncClient,
        messages: list[dict],
        max_tokens: int,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """POST /chat/completions and return (body, usage).

        Raises PlanningProviderError; `retryable=True` covers rate limits,
        timeouts and provider outages.
        """
        self.check_prompt_fits(messages)
        payload = {"model": self.model_id, "messages": messages, "max_tokens": max_tokens}
        context = (
            loopback_exception(self.loopback_host, self.loopback_port)
            if self.is_local
            else nullcontext()
        )
        headers = {"Accept-Encoding": "identity"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        with context:
            try:
                async with client.stream(
                    "POST",
                    "/chat/completions",
                    json=payload,
                    headers=headers,
                    follow_redirects=False,
                ) as response:
                    # Do not hand an attacker-controlled compressed body to an
                    # unbounded decompressor; the request asks for identity.
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise PlanningProviderError("The planning provider returned an unsupported response encoding")
                    status = response.status_code
                    body_bytes = bytearray()
                    if status == 200:
                        async for chunk in response.aiter_raw():
                            if len(chunk) > MAX_RESPONSE_BYTES - len(body_bytes):
                                raise PlanningProviderError("The planning provider response exceeds the size limit")
                            body_bytes.extend(chunk)
                    else:
                        # Error bodies are classified by status, never parsed;
                        # keep whatever fits in a small bound.
                        try:
                            raw = await response.aread()
                        except (httpx.HTTPError, ValueError):
                            raw = b""
                        body_bytes = bytearray(raw[:65536])
            except (httpx.TimeoutException, httpx.TransportError):
                raise PlanningProviderError(
                    "The planning provider request failed", retryable=True
                ) from None
        content = bytes(body_bytes)
        if status == 401 or status == 403:
            raise PlanningProviderError(
                "The planning provider rejected this key. Check the key in Settings."
            )
        if status == 404:
            raise PlanningProviderError(
                f'The planning provider does not offer the model "{self.model_id}". Pick another model.'
            )
        if status == 429:
            raise PlanningProviderError(
                "The planning provider is rate limiting requests. Try again in a moment.",
                retryable=True,
            )
        if status != 200:
            raise PlanningProviderError(
                f"Planning provider error (HTTP {status})",
                retryable=status in RETRYABLE_STATUS_CODES,
            )
        try:
            body = json.loads(content)
        except (ValueError, UnicodeError, RecursionError):
            raise PlanningProviderError("The planning provider returned invalid JSON") from None
        if not isinstance(body, dict):
            raise PlanningProviderError("The planning provider returned an invalid response")
        if body.get("error"):
            raise PlanningProviderError("The planning provider returned an error", retryable=True)
        usage = body.get("usage") or {}
        cost = usage.get("cost")
        usage_data = {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
            "cost": float(cost) if cost is not None else None,
        }
        return body, usage_data
