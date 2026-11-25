"""Unified async SSE streaming adapters for OpenAI-compatible and Gemini APIs."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.providers import ProviderSpec


def _sse_event(payload: dict[str, Any]) -> str:
    """Format a JSON payload as a Server-Sent Event line."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _build_openai_payload(
    provider: ProviderSpec,
    model: str,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
    top_p: float,
    reasoning_effort: str | None,
) -> dict[str, Any]:
    """Build a Chat Completions request body tailored to provider capabilities."""
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "stream": True,
    }
    if provider.id == "groq":
        payload["max_completion_tokens"] = max_tokens
    else:
        payload["max_tokens"] = max_tokens

    if reasoning_effort and any(
        model.startswith(prefix) for prefix in provider.reasoning_models_prefix
    ):
        payload["reasoning_effort"] = reasoning_effort
    return payload


async def _extract_error_detail(response: httpx.Response) -> str:
    """Extract a concise human-readable error message from a failed HTTP response."""
    raw = (await response.aread()).decode("utf-8", errors="replace").strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            err = parsed.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
            if parsed.get("message"):
                return str(parsed["message"])
    except json.JSONDecodeError:
        pass
    return raw[:400] or f"HTTP {response.status_code}"


async def stream_openai_compatible(
    client: httpx.AsyncClient,
    provider: ProviderSpec,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 1.0,
    max_tokens: int = 2048,
    top_p: float = 1.0,
    reasoning_effort: str | None = "medium",
) -> AsyncIterator[str]:
    """Stream tokens and reasoning traces from any OpenAI-compatible SSE endpoint."""
    url = f"{provider.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        **provider.extra_headers,
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = _build_openai_payload(
        provider=provider,
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        top_p=top_p,
        reasoning_effort=reasoning_effort,
    )

    try:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                detail = await _extract_error_detail(resp)
                yield _sse_event(
                    {
                        "type": "error",
                        "message": f"{provider.name} ({resp.status_code}): {detail}",
                    }
                )
                return

            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning:
                    yield _sse_event({"type": "reasoning", "text": reasoning})

                content = delta.get("content")
                if content:
                    yield _sse_event({"type": "delta", "text": content})
    except httpx.HTTPError as exc:
        yield _sse_event({"type": "error", "message": f"{provider.name} network error: {exc}"})
        return

    yield _sse_event({"type": "done"})


async def stream_gemini(
    client: httpx.AsyncClient,
    provider: ProviderSpec,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 1.0,
    max_tokens: int = 2048,
    top_p: float = 1.0,
) -> AsyncIterator[str]:
    """Stream text chunks from Google Gemini's streamGenerateContent SSE endpoint."""
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role", "user")
        text = msg.get("content", "")
        if not text:
            continue
        if role == "system":
            system_parts.append(text)
        else:
            gemini_role = "model" if role == "assistant" else "user"
            contents.append({"role": gemini_role, "parts": [{"text": text}]})

    payload: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "topP": top_p,
            "maxOutputTokens": max_tokens,
        },
    }
    if system_parts:
        payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}

    url = f"{provider.base_url.rstrip('/')}/models/{model}:streamGenerateContent"
    params = {"alt": "sse", "key": api_key}

    try:
        async with client.stream("POST", url, params=params, json=payload) as resp:
            if resp.status_code >= 400:
                detail = await _extract_error_detail(resp)
                yield _sse_event(
                    {"type": "error", "message": f"Gemini ({resp.status_code}): {detail}"}
                )
                return

            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                for candidate in chunk.get("candidates") or []:
                    parts = (candidate.get("content") or {}).get("parts") or []
                    for part in parts:
                        text = part.get("text")
                        if not text:
                            continue
                        event_type = "reasoning" if part.get("thought") else "delta"
                        yield _sse_event({"type": event_type, "text": text})
    except httpx.HTTPError as exc:
        yield _sse_event({"type": "error", "message": f"Gemini network error: {exc}"})
        return

    yield _sse_event({"type": "done"})


async def fetch_provider_models(
    client: httpx.AsyncClient,
    provider: ProviderSpec,
    api_key: str,
) -> list[str]:
    """Query live model IDs from a provider, falling back to curated defaults."""
    if provider.api_style == "gemini":
        if not api_key:
            return list(provider.default_models)
        resp = await client.get(
            f"{provider.base_url.rstrip('/')}/models",
            params={"key": api_key},
        )
        if resp.status_code >= 400:
            return list(provider.default_models)
        models = [
            item["name"].removeprefix("models/")
            for item in (resp.json().get("models") or [])
            if "generateContent" in (item.get("supportedGenerationMethods") or [])
        ]
        return models or list(provider.default_models)

    headers = dict(provider.extra_headers)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    elif provider.requires_key:
        return list(provider.default_models)

    resp = await client.get(f"{provider.base_url.rstrip('/')}/models", headers=headers)
    if resp.status_code >= 400:
        return list(provider.default_models)

    data = resp.json().get("data") or []
    ids = sorted({item["id"] for item in data if isinstance(item, dict) and item.get("id")})
    return ids or list(provider.default_models)
