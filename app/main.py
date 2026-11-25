"""FastAPI entrypoint for the Multi-LLM Playground & Arena."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.orchestra import AgentSlot, DEFAULT_WORKER_PERSONAS, stream_orchestra_council
from app.providers import (
    get_provider,
    resolve_api_key,
    save_api_keys,
    serialize_providers,
)
from app.streaming import fetch_provider_models, stream_gemini, stream_openai_compatible

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Multi-LLM Playground & Arena", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ChatMessage(BaseModel):
    """Single conversation turn."""

    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    """Streaming chat completion request."""

    provider: str = "groq"
    model: str = "openai/gpt-oss-120b"
    messages: list[ChatMessage] = Field(min_length=1)
    temperature: float = Field(default=1.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=2048, ge=1, le=32768)
    top_p: float = Field(default=1.0, ge=0.0, le=1.0)
    reasoning_effort: Literal["low", "medium", "high"] | None = "medium"
    api_key: str | None = None


class SaveKeysRequest(BaseModel):
    """Map of provider ID -> API key to persist in local .env."""

    keys: dict[str, str]


class OrchestraAgentConfig(BaseModel):
    """Provider and model assignment for a Boss or Thinker role."""

    provider: str
    model: str
    label: str | None = None
    title: str | None = None


class OrchestraRequest(BaseModel):
    """Request payload for the 1 Boss + 3 Thinkers Orchestra pipeline."""

    prompt: str = Field(min_length=1)
    system_prompt: str = ""
    boss: OrchestraAgentConfig
    workers: list[OrchestraAgentConfig] = Field(min_length=3, max_length=3)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1536, ge=128, le=8192)
    discussion_rounds: int = Field(default=2, ge=1, le=3)
    api_keys: dict[str, str] = Field(default_factory=dict)


@app.get("/")
async def serve_index() -> FileResponse:
    """Serve the single-page Playground & Arena web UI."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@app.get("/api/providers")
async def list_providers() -> dict[str, list[dict]]:
    """Return configured providers and curated defaults without exposing secrets."""
    return {"providers": serialize_providers()}


@app.get("/api/providers/{provider_id}/models")
async def list_provider_models(
    provider_id: str,
    x_provider_key: str | None = Header(default=None),
) -> dict[str, object]:
    """Fetch live model IDs for a provider using override header or stored key."""
    try:
        spec = get_provider(provider_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    key = resolve_api_key(spec, override_key=x_provider_key)
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            models = await fetch_provider_models(client, spec, key)
        except httpx.HTTPError:
            models = list(spec.default_models)
    return {"provider": provider_id, "models": models}


@app.post("/api/settings/keys")
async def update_keys(body: SaveKeysRequest) -> dict[str, object]:
    """Persist API keys to local .env and return refreshed provider statuses."""
    updated = save_api_keys(body.keys)
    return {"updated": updated, "providers": serialize_providers()}


@app.post("/api/chat/stream")
async def chat_stream(
    body: ChatRequest,
    x_provider_key: str | None = Header(default=None),
) -> StreamingResponse:
    """Stream SSE chat deltas from the chosen provider and model."""
    try:
        spec = get_provider(body.provider)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    api_key = resolve_api_key(spec, override_key=x_provider_key or body.api_key)
    if spec.requires_key and not api_key:
        async def missing_key_stream() -> AsyncIterator[str]:
            payload = {
                "type": "error",
                "code": "missing_api_key",
                "message": (
                    f"Missing API key for {spec.name}. Open API Keys in the top bar "
                    f"or set {spec.env_var} in .env."
                ),
            }
            yield f"data: {json.dumps(payload)}\n\n"

        return StreamingResponse(missing_key_stream(), media_type="text/event-stream")

    msg_dicts = [{"role": m.role, "content": m.content} for m in body.messages]

    async def event_generator() -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
            if spec.api_style == "gemini":
                async for event in stream_gemini(
                    client=client,
                    provider=spec,
                    api_key=api_key,
                    model=body.model,
                    messages=msg_dicts,
                    temperature=body.temperature,
                    max_tokens=body.max_tokens,
                    top_p=body.top_p,
                ):
                    yield event
            else:
                async for event in stream_openai_compatible(
                    client=client,
                    provider=spec,
                    api_key=api_key,
                    model=body.model,
                    messages=msg_dicts,
                    temperature=body.temperature,
                    max_tokens=body.max_tokens,
                    top_p=body.top_p,
                    reasoning_effort=body.reasoning_effort,
                ):
                    yield event

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/orchestra/stream")
async def orchestra_stream(body: OrchestraRequest) -> StreamingResponse:
    """Stream the 1 Boss + 3 Thinkers collaborative council SSE workflow."""
    boss_slot = AgentSlot(
        role_id="boss",
        label=body.boss.label or "Orchestra Boss",
        title=body.boss.title or "Lead & Merger",
        provider_id=body.boss.provider,
        model=body.boss.model,
        persona="Lead orchestrator who thinks, checks, removes the weakest output, and merges the best parts.",
    )
    worker_slots = []
    for idx, w in enumerate(body.workers):
        default_label, default_title, default_persona = DEFAULT_WORKER_PERSONAS[idx]
        worker_slots.append(
            AgentSlot(
                role_id=f"worker_{idx + 1}",
                label=w.label or default_label,
                title=w.title or default_title,
                provider_id=w.provider,
                model=w.model,
                persona=default_persona,
            )
        )

    return StreamingResponse(
        stream_orchestra_council(
            prompt=body.prompt,
            system_prompt=body.system_prompt,
            boss=boss_slot,
            workers=worker_slots,
            api_keys=body.api_keys,
            temperature=body.temperature,
            max_tokens=body.max_tokens,
            discussion_rounds=body.discussion_rounds,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
