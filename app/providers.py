"""Provider registry and API key resolution for multi-LLM routing."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values, set_key

ENV_FILE_PATH = Path(__file__).resolve().parent.parent / ".env"

ApiStyle = Literal["openai", "gemini"]


@dataclass(frozen=True)
class ProviderSpec:
    """Metadata and connection defaults for an LLM provider."""

    id: str
    name: str
    base_url: str
    env_var: str
    fallback_env_vars: tuple[str, ...] = ()
    api_style: ApiStyle = "openai"
    requires_key: bool = True
    default_models: tuple[str, ...] = ()
    reasoning_models_prefix: tuple[str, ...] = ()
    console_url: str = ""
    extra_headers: dict[str, str] = field(default_factory=dict)


PROVIDERS: dict[str, ProviderSpec] = {
    "groq": ProviderSpec(
        id="groq",
        name="GroqCloud",
        base_url="https://api.groq.com/openai/v1",
        env_var="GROQ_API_KEY",
        default_models=(
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
            "qwen/qwen3.8-27b",
            "llama-3.3-70b-versatile",
        ),
        reasoning_models_prefix=("openai/gpt-oss-",),
        console_url="https://console.groq.com/keys",
    ),
    "nvidia": ProviderSpec(
        id="nvidia",
        name="NVIDIA NIM",
        base_url="https://integrate.api.nvidia.com/v1",
        env_var="NVIDIA_API_KEY",
        fallback_env_vars=("NVIDIA_NIM_API_KEY",),
        default_models=(
            "nvidia/nemotron-3.5-super-vl-120b-a12b",
            "minimaxai/minimax-m3.1-flash",
            "nvidia/nemotron-3.5-lightning-30b-a3b",
            "moonshotai/kimi-k3.1-pro",
        ),
        console_url="https://build.nvidia.com/",
    ),
    "deepseek": ProviderSpec(
        id="deepseek",
        name="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        env_var="DEEPSEEK_API_KEY",
        default_models=(
            "deepseek-chat",
            "deepseek-reasoner",
        ),
        console_url="https://platform.deepseek.com/api_keys",
    ),
    "qwen": ProviderSpec(
        id="qwen",
        name="Qwen (DashScope)",
        base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        env_var="DASHSCOPE_API_KEY",
        fallback_env_vars=("QWEN_API_KEY",),
        default_models=(
            "qwen-plus",
            "qwen-max",
            "qwen-turbo",
            "qwen3-235b-a22b",
        ),
        console_url="https://chat.qwen.ai/",
    ),
    "xai": ProviderSpec(
        id="xai",
        name="xAI Grok",
        base_url="https://api.x.ai/v1",
        env_var="XAI_API_KEY",
        default_models=(
            "grok-4",
            "grok-3",
            "grok-3-mini",
        ),
        console_url="https://console.x.ai/",
    ),
    "openrouter": ProviderSpec(
        id="openrouter",
        name="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        env_var="OPENROUTER_API_KEY",
        default_models=(
            "openai/gpt-oss-120b:free",
            "deepseek/deepseek-r1:free",
            "qwen/qwen3-coder:free",
            "meta-llama/llama-3.3-70b-instruct:free",
        ),
        console_url="https://openrouter.ai/keys",
        extra_headers={
            "HTTP-Referer": "http://127.0.0.1:8000",
            "X-Title": "Multi-LLM Playground",
        },
    ),
    "mistral": ProviderSpec(
        id="mistral",
        name="Mistral",
        base_url="https://api.mistral.ai/v1",
        env_var="MISTRAL_API_KEY",
        default_models=(
            "mistral-large-latest",
            "mistral-small-latest",
            "codestral-latest",
        ),
        console_url="https://console.mistral.ai/",
    ),
    "gemini": ProviderSpec(
        id="gemini",
        name="Google Gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        env_var="GEMINI_API_KEY",
        fallback_env_vars=("GOOGLE_API_KEY",),
        api_style="gemini",
        default_models=(
            "gemini-3.5-flash",
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-flash-latest",
        ),
        console_url="https://aistudio.google.com/api-keys",
    ),
    "ollama": ProviderSpec(
        id="ollama",
        name="Local Ollama",
        base_url="http://127.0.0.1:11434/v1",
        env_var="OLLAMA_API_KEY",
        requires_key=False,
        default_models=(
            "llama3.1:latest",
            "gemma4:12b",
        ),
        console_url="http://127.0.0.1:11434",
    ),
}


def get_provider(provider_id: str) -> ProviderSpec:
    """Return a ProviderSpec by ID or raise KeyError if unknown."""
    if provider_id not in PROVIDERS:
        raise KeyError(f"Unknown provider: {provider_id}")
    return PROVIDERS[provider_id]


def _split_key_pool(raw_value: str | None) -> list[str]:
    """Split comma- or newline-separated API keys into an ordered, deduplicated list."""
    if not raw_value:
        return []
    seen: set[str] = set()
    keys: list[str] = []
    for chunk in raw_value.replace("\n", ",").split(","):
        cleaned = chunk.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            keys.append(cleaned)
    return keys


def resolve_api_keys(
    provider: ProviderSpec,
    override_key: str | None = None,
    env_path: Path = ENV_FILE_PATH,
) -> list[str]:
    """Resolve all configured API keys (pool) from override, environment, or .env."""
    pool: list[str] = []
    seen: set[str] = set()

    def _add_many(raw: str | None) -> None:
        for item in _split_key_pool(raw):
            if item not in seen:
                seen.add(item)
                pool.append(item)

    _add_many(override_key)
    env_values = dotenv_values(env_path) if env_path.exists() else {}
    for var_name in (provider.env_var, *provider.fallback_env_vars):
        _add_many(os.getenv(var_name))
        _add_many(env_values.get(var_name))
    return pool


def resolve_api_key(
    provider: ProviderSpec,
    override_key: str | None = None,
    env_path: Path = ENV_FILE_PATH,
) -> str:
    """Resolve the primary API key from explicit override, environment, or local .env file."""
    pool = resolve_api_keys(provider, override_key=override_key, env_path=env_path)
    return pool[0] if pool else ""


def save_api_keys(
    keys_by_provider: dict[str, str],
    env_path: Path = ENV_FILE_PATH,
) -> list[str]:
    """Persist non-empty provider keys (single or comma-separated pool) to .env."""
    env_path.parent.mkdir(parents=True, exist_ok=True)
    if not env_path.exists():
        env_path.write_text("", encoding="utf-8")

    updated: list[str] = []
    for provider_id, raw_key in keys_by_provider.items():
        if provider_id not in PROVIDERS:
            continue
        spec = PROVIDERS[provider_id]
        if not spec.requires_key:
            continue
        normalized = ",".join(_split_key_pool(raw_key))
        if not normalized:
            continue
        set_key(str(env_path), spec.env_var, normalized)
        os.environ[spec.env_var] = normalized
        updated.append(provider_id)
    return updated


def serialize_providers(env_path: Path = ENV_FILE_PATH) -> list[dict]:
    """Return public provider metadata without exposing any API key values."""
    items: list[dict] = []
    for spec in PROVIDERS.values():
        keys = resolve_api_keys(spec, env_path=env_path)
        items.append(
            {
                "id": spec.id,
                "name": spec.name,
                "api_style": spec.api_style,
                "base_url": spec.base_url,
                "env_var": spec.env_var,
                "requires_key": spec.requires_key,
                "configured": (not spec.requires_key) or bool(keys),
                "key_count": len(keys) if spec.requires_key else 1,
                "default_models": list(spec.default_models),
                "reasoning_models_prefix": list(spec.reasoning_models_prefix),
                "console_url": spec.console_url,
            }
        )
    return items
