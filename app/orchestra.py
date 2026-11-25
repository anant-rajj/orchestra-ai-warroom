"""Company-style 1 Orchestra Boss + 3 Thinkers collaborative pipeline with key rotation & bounded cross-talk."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from app.providers import ProviderSpec, get_provider, resolve_api_keys
from app.streaming import stream_gemini, stream_openai_compatible


@dataclass(frozen=True)
class AgentSlot:
    """Configuration for a participant in the Orchestra Council."""

    role_id: str
    label: str
    title: str
    provider_id: str
    model: str
    persona: str


DEFAULT_WORKER_PERSONAS = (
    (
        "Thinker 1",
        "Systems Architect",
        "Focus on clean architecture, first-principles reasoning, and core structure. "
        "Address @Thinker-2, @Thinker-3, and @Boss directly when refining.",
    ),
    (
        "Thinker 2",
        "Pragmatic Builder",
        "Focus on concrete implementation, speed, clarity, and practical usability. "
        "Address @Thinker-1, @Thinker-3, and @Boss directly when refining.",
    ),
    (
        "Thinker 3",
        "Critical Reviewer",
        "Focus on edge cases, failure modes, security/correctness risks, and contrarian improvements. "
        "Address @Thinker-1, @Thinker-2, and @Boss directly when refining.",
    ),
)

# Verified fast free-tier fallback targets used if a primary key/model times out or hits 429/503.
FREE_FAILOVER_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b"),
    ("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b"),
    ("nvidia", "minimaxai/minimax-m3.1-flash"),
    ("gemini", "gemini-3.5-flash"),
    ("groq", "openai/gpt-oss-120b"),
    ("openrouter", "openai/gpt-oss-120b:free"),
)

ATTEMPT_TIMEOUT_SECONDS = 24.0


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _build_attempt_candidates(
    slot: AgentSlot,
    api_keys: dict[str, str],
) -> list[tuple[ProviderSpec, str, str]]:
    """Build ordered (provider, model, api_key) attempts starting with the slot's own key pool."""
    attempts: list[tuple[ProviderSpec, str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def _enqueue(pid: str, model: str) -> None:
        try:
            spec = get_provider(pid)
        except KeyError:
            return
        keys = resolve_api_keys(spec, override_key=api_keys.get(pid))
        if not spec.requires_key:
            keys = [""]
        for key in keys:
            sig = (pid, model, key)
            if sig not in seen:
                seen.add(sig)
                attempts.append((spec, model, key))

    _enqueue(slot.provider_id, slot.model)
    for fb_pid, fb_model in FREE_FAILOVER_CANDIDATES:
        _enqueue(fb_pid, fb_model)
    return attempts


async def _attempt_single_stream(
    client: httpx.AsyncClient,
    spec: ProviderSpec,
    api_key: str,
    model: str,
    slot: AgentSlot,
    stage: str,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
    queue: asyncio.Queue[dict[str, Any]] | None,
) -> dict[str, str]:
    """Run one provider/key/model attempt; buffers before emitting error so failover stays clean."""
    effective_max_tokens = max(max_tokens, 2048)
    if spec.api_style == "gemini":
        gen = stream_gemini(
            client=client,
            provider=spec,
            api_key=api_key,
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=effective_max_tokens,
        )
    else:
        gen = stream_openai_compatible(
            client=client,
            provider=spec,
            api_key=api_key,
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=effective_max_tokens,
            reasoning_effort="low",
        )

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    error_msg = ""

    async def _consume() -> None:
        nonlocal error_msg
        async for raw_line in gen:
            for line in raw_line.splitlines():
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:].strip())
                ev_type = ev.get("type")
                if ev_type == "reasoning":
                    text = ev.get("text", "")
                    reasoning_parts.append(text)
                    if queue is not None:
                        await queue.put(
                            {
                                "type": "agent_reasoning",
                                "stage": stage,
                                "role_id": slot.role_id,
                                "text": text,
                            }
                        )
                elif ev_type == "delta":
                    text = ev.get("text", "")
                    content_parts.append(text)
                    if queue is not None:
                        await queue.put(
                            {
                                "type": "agent_delta",
                                "stage": stage,
                                "role_id": slot.role_id,
                                "text": text,
                            }
                        )
                elif ev_type == "error":
                    error_msg = ev.get("message", "Unknown error")
                    return

    try:
        await asyncio.wait_for(_consume(), timeout=ATTEMPT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        if not content_parts and not reasoning_parts:
            error_msg = f"{spec.name} ({model}) timed out after {int(ATTEMPT_TIMEOUT_SECONDS)}s."

    if not content_parts and reasoning_parts and not error_msg:
        fallback_text = "".join(reasoning_parts).strip()
        content_parts.append(fallback_text)
        if queue is not None:
            await queue.put(
                {
                    "type": "agent_delta",
                    "stage": stage,
                    "role_id": slot.role_id,
                    "text": fallback_text,
                }
            )

    return {
        "content": "".join(content_parts).strip(),
        "reasoning": "".join(reasoning_parts).strip(),
        "error": error_msg,
    }


async def _run_slot_stream(
    client: httpx.AsyncClient,
    slot: AgentSlot,
    stage: str,
    messages: list[dict[str, str]],
    api_keys: dict[str, str],
    temperature: float,
    max_tokens: int,
    queue: asyncio.Queue[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """Execute one agent turn with automatic multi-key rotation and free-tier failover."""
    attempts = _build_attempt_candidates(slot, api_keys)
    if not attempts:
        err_msg = f"No API keys configured for {slot.provider_id} or any free fallback provider."
        if queue is not None:
            await queue.put(
                {
                    "type": "agent_error",
                    "stage": stage,
                    "role_id": slot.role_id,
                    "message": err_msg,
                }
            )
            await queue.put({"type": "agent_done", "stage": stage, "role_id": slot.role_id})
        return {"content": "", "reasoning": "", "error": err_msg}

    last_error = ""
    for idx, (spec, model, key) in enumerate(attempts):
        if idx > 0 and queue is not None:
            await queue.put(
                {
                    "type": "agent_failover",
                    "stage": stage,
                    "role_id": slot.role_id,
                    "provider": spec.id,
                    "model": model,
                    "reason": last_error,
                }
            )
        res = await _attempt_single_stream(
            client=client,
            spec=spec,
            api_key=key,
            model=model,
            slot=slot,
            stage=stage,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            queue=queue,
        )
        if res["content"] or not res["error"]:
            if queue is not None:
                await queue.put({"type": "agent_done", "stage": stage, "role_id": slot.role_id})
            return res
        last_error = res["error"]
        # Do not silently swap if partial tokens already streamed cleanly; otherwise rotate!
        if res["reasoning"] and not res["error"]:
            break

    if queue is not None:
        await queue.put(
            {
                "type": "agent_error",
                "stage": stage,
                "role_id": slot.role_id,
                "message": last_error or "All free API keys/models timed out.",
            }
        )
        await queue.put({"type": "agent_done", "stage": stage, "role_id": slot.role_id})
    return {"content": "", "reasoning": "", "error": last_error}


async def _run_parallel_stage(
    client: httpx.AsyncClient,
    stage: str,
    slots: list[AgentSlot],
    messages_by_role: dict[str, list[dict[str, str]]],
    api_keys: dict[str, str],
    temperature: float,
    max_tokens: int,
) -> AsyncIterator[tuple[str, dict[str, str] | dict[str, Any]]]:
    """Run the 3 Thinkers concurrently while yielding SSE events and keepalives."""
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def _worker(slot: AgentSlot) -> tuple[str, dict[str, str]]:
        res = await _run_slot_stream(
            client=client,
            slot=slot,
            stage=stage,
            messages=messages_by_role[slot.role_id],
            api_keys=api_keys,
            temperature=temperature,
            max_tokens=max_tokens,
            queue=queue,
        )
        return slot.role_id, res

    tasks = [asyncio.create_task(_worker(s)) for s in slots]

    async def _drain_sentinel() -> dict[str, dict[str, str]]:
        done_results = await asyncio.gather(*tasks)
        await queue.put({"type": "__stage_complete__"})
        return dict(done_results)

    collector = asyncio.create_task(_drain_sentinel())

    while True:
        try:
            item = await asyncio.wait_for(queue.get(), timeout=2.0)
        except asyncio.TimeoutError:
            yield ("keepalive", {})
            continue
        if item.get("type") == "__stage_complete__":
            break
        yield ("event", item)

    results = await collector
    yield ("results", results)


def _has_consensus(round_results: dict[str, dict[str, str]]) -> bool:
    """Return True when at least 2 of 3 Thinkers signal readiness to stop and hand off to Boss."""
    ready_votes = sum(
        1
        for res in round_results.values()
        if "CONSENSUS: READY" in (res.get("content") or "").upper()
    )
    return ready_votes >= 2


async def stream_orchestra_council(
    prompt: str,
    system_prompt: str,
    boss: AgentSlot,
    workers: list[AgentSlot],
    api_keys: dict[str, str],
    temperature: float = 0.7,
    max_tokens: int = 1536,
    discussion_rounds: int = 2,
) -> AsyncIterator[str]:
    """Run the 4-stage Boss + 3 Thinkers council with bounded cross-talk and stopping."""
    capped_rounds = max(1, min(discussion_rounds, 3))
    async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=12.0)) as client:
        # Stage 1: Boss thinks, works on an initial angle, and delegates to the 3 Thinkers
        yield _sse(
            {
                "type": "stage_start",
                "stage": "boss_plan",
                "title": "Stage 1 · Boss Thinks & Briefs the 3 Thinkers",
            }
        )
        boss_plan_messages = [
            {
                "role": "system",
                "content": (
                    f"{system_prompt}\n\n" if system_prompt else ""
                )
                + "You are the Orchestra Boss leading exactly 3 specialist Thinkers "
                "(@Thinker-1 Systems Architect, @Thinker-2 Pragmatic Builder, @Thinker-3 Critical Reviewer). "
                "You also think and work on the problem yourself. "
                "Give: (1) Your own concise initial thesis/solution angle, and "
                "(2) Clear focus assignments for @Thinker-1, @Thinker-2, and @Thinker-3. Keep it sharp and under 200 words.",
            },
            {"role": "user", "content": prompt},
        ]

        plan_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        plan_task = asyncio.create_task(
            _run_slot_stream(
                client=client,
                slot=boss,
                stage="boss_plan",
                messages=boss_plan_messages,
                api_keys=api_keys,
                temperature=temperature,
                max_tokens=max_tokens,
                queue=plan_queue,
            )
        )
        while not plan_task.done() or not plan_queue.empty():
            try:
                ev = await asyncio.wait_for(plan_queue.get(), timeout=2.0)
                yield _sse(ev)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
        boss_plan_res = await plan_task
        boss_plan_text = boss_plan_res["content"] or "(Boss proceeding directly to workers.)"

        # Stage 2: 3 Thinkers work in parallel
        yield _sse(
            {
                "type": "stage_start",
                "stage": "worker_draft",
                "title": "Stage 2 · 3 Thinkers Work in Parallel",
            }
        )
        draft_msgs = {
            w.role_id: [
                {
                    "role": "system",
                    "content": (
                        f"You are {w.label} ({w.title}) on a 3-Thinker engineering team reporting to @Boss. "
                        f"{w.persona} Respond concisely in under 220 words with concrete work."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"USER REQUEST:\n{prompt}\n\n"
                        f"@Boss INITIAL PLAN & THESIS:\n{boss_plan_text}\n\n"
                        f"Produce your independent work and thinking from your {w.title} perspective."
                    ),
                },
            ]
            for w in workers
        }

        draft_results: dict[str, dict[str, str]] = {}
        async for kind, payload in _run_parallel_stage(
            client, "worker_draft", workers, draft_msgs, api_keys, temperature, max_tokens
        ):
            if kind == "keepalive":
                yield ": keepalive\n\n"
            elif kind == "event":
                yield _sse(payload)
            else:
                draft_results = payload

        # Stage 3: Bounded Cross-Talk — Thinkers talk to each other AND to @Boss, then stop cleanly
        yield _sse(
            {
                "type": "stage_start",
                "stage": "worker_crosstalk",
                "title": f"Stage 3 · Thinkers Talk & Converge (max {capped_rounds} rounds)",
            }
        )

        transcript_parts = [
            f"--- {w.label} ({w.title}) Initial Work ---\n"
            f"{draft_results.get(w.role_id, {}).get('content') or draft_results.get(w.role_id, {}).get('error') or '(no output)'}"
            for w in workers
        ]
        final_worker_results = dict(draft_results)
        stop_reason = f"Reached round cap ({capped_rounds}/{capped_rounds})"

        for round_num in range(1, capped_rounds + 1):
            is_final_round = round_num == capped_rounds
            yield _sse(
                {
                    "type": "crosstalk_round",
                    "round": round_num,
                    "max_rounds": capped_rounds,
                }
            )
            board_text = "\n\n".join(transcript_parts)
            crosstalk_msgs = {
                w.role_id: [
                    {
                        "role": "system",
                        "content": (
                            f"You are {w.label} ({w.title}) in Cross-Talk Round {round_num}/{capped_rounds} "
                            "with your 2 teammate Thinkers and @Boss.\n"
                            "Talk BOTH to your peers (@Thinker-1, @Thinker-2, @Thinker-3) AND report clearly to @Boss:\n"
                            "- Critique or build on a teammate's point.\n"
                            "- Tell @Boss what should be kept vs dropped.\n"
                            + (
                                "This is the FINAL discussion round: end with your FINALISED PROPOSAL and `CONSENSUS: READY`."
                                if is_final_round
                                else "If you and your teammates already have enough agreement to stop debating and hand off to @Boss, end with `CONSENSUS: READY`; otherwise state what still needs fixing."
                            )
                            + " Keep under 180 words."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"USER REQUEST:\n{prompt}\n\n"
                            f"@Boss PLAN:\n{boss_plan_text}\n\n"
                            f"DISCUSSION SO FAR:\n{board_text}\n\n"
                            f"Respond in Round {round_num}/{capped_rounds}."
                        ),
                    },
                ]
                for w in workers
            }

            round_results: dict[str, dict[str, str]] = {}
            async for kind, payload in _run_parallel_stage(
                client, "worker_crosstalk", workers, crosstalk_msgs, api_keys, temperature, max_tokens
            ):
                if kind == "keepalive":
                    yield ": keepalive\n\n"
                elif kind == "event":
                    yield _sse(payload)
                else:
                    round_results = payload

            final_worker_results = round_results
            for w in workers:
                reply = round_results.get(w.role_id, {}).get("content") or "(no reply)"
                transcript_parts.append(f"--- {w.label} Round {round_num} ---\n{reply}")

            if _has_consensus(round_results):
                stop_reason = f"Consensus reached at Round {round_num}/{capped_rounds}"
                break

        yield _sse({"type": "crosstalk_stopped", "reason": stop_reason})

        # Stage 4: Boss checks, removes the worse worker, works too, and merges best parts
        yield _sse(
            {
                "type": "stage_start",
                "stage": "boss_merge",
                "title": "Stage 4 · Boss Audits, Removes Worse One, Works & Merges",
            }
        )
        final_board = "\n\n".join(
            f"=== {w.label} ({w.title} · {w.provider_id}/{w.model}) ===\n"
            f"Initial Work:\n{draft_results.get(w.role_id, {}).get('content') or '(none)'}\n\n"
            f"Finalised After Cross-Talk:\n{final_worker_results.get(w.role_id, {}).get('content') or final_worker_results.get(w.role_id, {}).get('error') or '(none)'}"
            for w in workers
        )
        boss_merge_messages = [
            {
                "role": "system",
                "content": (
                    f"{system_prompt}\n\n" if system_prompt else ""
                )
                + "You are the Orchestra Boss reviewing your 3 Thinkers' finalised work "
                f"(discussion stopped cleanly: {stop_reason}). "
                "You must check their work, add your own Boss work/improvements, discard the weakest worker, "
                "and merge the strongest parts into one authoritative final answer.\n\n"
                "Format your response with these exact markdown sections:\n"
                "### 1. Boss Review & Filter\n"
                "- **Kept & Taken From**: Name the strongest thinkers and the exact parts you took from each.\n"
                "- **Removed (Worse One)**: Explicitly name which Thinker contributed the weakest/flawed output and why it was removed.\n"
                "- **Boss Contribution**: State what you checked, fixed, or added yourself.\n\n"
                "### 2. Final Merged Answer\n"
                "Provide the complete, clean, ready-to-use final answer for the user.",
            },
            {
                "role": "user",
                "content": (
                    f"USER REQUEST:\n{prompt}\n\n"
                    f"YOUR INITIAL BOSS WORK:\n{boss_plan_text}\n\n"
                    f"FINALIZED TEAM OUTPUTS:\n{final_board}"
                ),
            },
        ]

        merge_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        merge_task = asyncio.create_task(
            _run_slot_stream(
                client=client,
                slot=boss,
                stage="boss_merge",
                messages=boss_merge_messages,
                api_keys=api_keys,
                temperature=temperature,
                max_tokens=max_tokens,
                queue=merge_queue,
            )
        )
        while not merge_task.done() or not merge_queue.empty():
            try:
                ev = await asyncio.wait_for(merge_queue.get(), timeout=2.0)
                yield _sse(ev)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
        await merge_task

    yield _sse({"type": "orchestra_done", "stop_reason": stop_reason})
