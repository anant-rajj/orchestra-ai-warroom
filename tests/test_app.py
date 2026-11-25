"""Unit and integration tests for Multi-LLM Playground & Arena."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.orchestra import AgentSlot, _has_consensus, _run_slot_stream, stream_orchestra_council
from app.providers import get_provider, resolve_api_key, resolve_api_keys, save_api_keys
from app.streaming import fetch_provider_models, stream_gemini, stream_openai_compatible


async def _collect_events(gen) -> list[dict]:
    events = []
    async for raw in gen:
        for line in raw.splitlines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events


def test_health_and_index() -> None:
    client = TestClient(app)
    assert client.get("/api/health").json() == {"status": "ok"}
    index_res = client.get("/")
    assert index_res.status_code == 200
    assert "Orchestra AI · 3D War-Room" in index_res.text


def test_providers_metadata_hides_secrets() -> None:
    client = TestClient(app)
    res = client.get("/api/providers")
    assert res.status_code == 200
    providers = {p["id"]: p for p in res.json()["providers"]}
    expected_ids = {"groq", "nvidia", "deepseek", "qwen", "xai", "openrouter", "mistral", "gemini", "ollama"}
    assert expected_ids.issubset(providers.keys())
    assert "openai/gpt-oss-120b" in providers["groq"]["default_models"]
    for p in providers.values():
        assert "api_key" not in p


def test_key_persistence_and_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_file = tmp_path / ".env"
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    updated = save_api_keys({"groq": "gsk_test_123, gsk_test_456\ngsk_test_123", "unknown": "ignored"}, env_path=env_file)
    assert updated == ["groq"]
    assert resolve_api_key(get_provider("groq"), env_path=env_file) == "gsk_test_123"
    assert resolve_api_keys(get_provider("groq"), env_path=env_file) == ["gsk_test_123", "gsk_test_456"]
    assert resolve_api_keys(get_provider("groq"), override_key="gsk_override", env_path=env_file) == [
        "gsk_override",
        "gsk_test_123",
        "gsk_test_456",
    ]


def test_missing_api_key_streams_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    client = TestClient(app)
    res = client.post(
        "/api/chat/stream",
        json={
            "provider": "deepseek",
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert res.status_code == 200
    assert "missing_api_key" in res.text


def test_unknown_provider_returns_404() -> None:
    client = TestClient(app)
    res = client.post(
        "/api/chat/stream",
        json={
            "provider": "nonexistent",
            "model": "m",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert res.status_code == 404


@pytest.mark.anyio
async def test_stream_openai_compatible_groq_payload_and_sse() -> None:
    captured_body: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_body
        captured_body = json.loads(request.content.decode("utf-8"))
        sse = (
            'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"world"}}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        events = await _collect_events(
            stream_openai_compatible(
                client=client,
                provider=get_provider("groq"),
                api_key="gsk_mock",
                model="openai/gpt-oss-120b",
                messages=[{"role": "user", "content": "Hi"}],
                reasoning_effort="high",
            )
        )

    assert captured_body["max_completion_tokens"] == 2048
    assert captured_body["reasoning_effort"] == "high"
    assert events == [
        {"type": "reasoning", "text": "thinking..."},
        {"type": "delta", "text": "Hello "},
        {"type": "delta", "text": "world"},
        {"type": "done"},
    ]


@pytest.mark.anyio
async def test_stream_gemini_sse_and_error() -> None:
    captured_body: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_body
        captured_body = json.loads(request.content.decode("utf-8"))
        sse = (
            'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking"},{"text":"Hi from Gemini"}]}}]}\n\n'
        )
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        events = await _collect_events(
            stream_gemini(
                client=client,
                provider=get_provider("gemini"),
                api_key="gem_mock",
                model="gemini-3.8-flash",
                messages=[
                    {"role": "system", "content": "Be brief"},
                    {"role": "user", "content": "Hello"},
                ],
            )
        )

    assert captured_body["systemInstruction"]["parts"][0]["text"] == "Be brief"
    assert events == [
        {"type": "reasoning", "text": "thinking"},
        {"type": "delta", "text": "Hi from Gemini"},
        {"type": "done"},
    ]


@pytest.mark.anyio
async def test_orchestra_four_stage_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    async def fake_run_slot_stream(client, slot, stage, messages, api_keys, temperature, max_tokens, queue=None):
        calls.append((stage, slot.role_id))
        if queue is not None:
            await queue.put({"type": "agent_delta", "stage": stage, "role_id": slot.role_id, "text": f"{stage}:{slot.role_id}"})
            await queue.put({"type": "agent_done", "stage": stage, "role_id": slot.role_id})
        return {"content": f"output from {slot.role_id} in {stage}", "reasoning": "", "error": ""}

    monkeypatch.setattr("app.orchestra._run_slot_stream", fake_run_slot_stream)

    boss = AgentSlot("boss", "Orchestra Boss", "Lead", "nvidia", "m1", "boss")
    workers = [
        AgentSlot("worker_1", "Thinker 1", "Architect", "nvidia", "m1", "w1"),
        AgentSlot("worker_2", "Thinker 2", "Builder", "gemini", "m2", "w2"),
        AgentSlot("worker_3", "Thinker 3", "Critic", "nvidia", "m3", "w3"),
    ]
    events = await _collect_events(
        stream_orchestra_council("Build a cache", "", boss, workers, {})
    )

    stages = [e["stage"] for e in events if e.get("type") == "stage_start"]
    assert stages == ["boss_plan", "worker_draft", "worker_crosstalk", "boss_merge"]
    assert events[-1]["type"] == "orchestra_done"
    assert ("boss_plan", "boss") in calls
    assert ("boss_merge", "boss") in calls
    assert len([c for c in calls if c[0] == "worker_crosstalk"]) == 6


def test_consensus_stops_bounded_crosstalk() -> None:
    assert _has_consensus({"w1": {"content": "Agreed. CONSENSUS: READY"}, "w2": {"content": "Yes CONSENSUS: READY"}, "w3": {"content": "Wait"}})
    assert not _has_consensus({"w1": {"content": "Agreed. CONSENSUS: READY"}, "w2": {"content": "Need fix"}, "w3": {"content": "No"}})


@pytest.mark.anyio
async def test_multi_key_rotation_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    seen_keys: list[str] = []

    async def fake_attempt(client, spec, api_key, model, slot, stage, messages, temperature, max_tokens, queue):
        seen_keys.append(api_key)
        if api_key == "bad_key":
            return {"content": "", "reasoning": "", "error": "429 rate limited"}
        return {"content": "ok from backup key", "reasoning": "", "error": ""}

    monkeypatch.setattr("app.orchestra._attempt_single_stream", fake_attempt)
    monkeypatch.setattr("app.orchestra.FREE_FAILOVER_CANDIDATES", ())
    slot = AgentSlot("worker_1", "Thinker 1", "Architect", "groq", "openai/gpt-oss-120b", "p")
    res = await _run_slot_stream(
        client=httpx.AsyncClient(),
        slot=slot,
        stage="worker_draft",
        messages=[{"role": "user", "content": "hi"}],
        api_keys={"groq": "bad_key, good_key"},
        temperature=0.7,
        max_tokens=256,
    )
    assert seen_keys == ["bad_key", "good_key"]
    assert res["content"] == "ok from backup key"


@pytest.mark.anyio
async def test_fetch_provider_models() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "b-model"}, {"id": "a-model"}]})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        models = await fetch_provider_models(client, get_provider("nvidia"), "nvapi-test")
    assert models == ["a-model", "b-model"]
