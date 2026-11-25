# Orchestra AI · 3D War-Room (1 Boss + 3 Thinkers)

A streaming FastAPI + WebGL2/Canvas 3D multi-agent chatbot where **1 Orchestra Boss** leads **3 Thinkers** (`Thinker 1`, `Thinker 2`, `Thinker 3`) through a 4-stage collaborative pipeline:

1. **Boss Thinks & Briefs**: The Orchestra Boss analyzes the prompt, forms its own initial angle, and briefs the 3 Thinkers.
2. **3 Thinkers Work in Parallel**: Each Thinker streams live thinking and independent work inside its own scrollable chatbox.
3. **Bounded Peer Cross-Talk & Handoff**: Thinkers talk directly to each other (`@Thinker-1`, `@Thinker-2`, `@Thinker-3`) and back to `@Boss`, stopping automatically on consensus (`CONSENSUS: READY`) or at the configured round limit (`1–3` rounds).
4. **Boss Audits, Removes Worse One & Merges**: The Boss reviews all 3 finalised outputs, discards the weakest/flawed one, adds its own verification/work, and merges the best parts into the Finalised Verdict.

## Features

- **Multi-Key Rotation & Free-Tier Failover**: Supports comma- or newline-separated API key pools per provider (`NVIDIA_API_KEY="key1,key2"`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, plus local Ollama) with automatic rotation and failover on rate limits or timeouts.
- **3D & CFX Obsidian UI**: Zero-CDN WebGL2 atmospheric void, procedural plasma energy filaments connecting Boss ↔ 3 Thinkers ↔ Finalised Verdict, Boss holographic core, per-Thinker streaming waveforms, and OLED-safe dark surfaces (`✨ 3D VFX: On/Off` toggle).

## Quick Start

```bash
uv venv .venv
uv pip install --python .venv/bin/python -e .
cp .env.example .env  # add one or comma-separated API keys
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/` in your browser.

## Tests

```bash
.venv/bin/pytest -v
```
