/**
 * Standalone browser-side CORS adapter for GitHub Pages deployment
 * Used automatically when no FastAPI backend is running on the current origin.
 */
const STATIC_PROVIDERS_CATALOG = [
  {
    id: "groq",
    name: "GroqCloud",
    api_style: "openai",
    base_url: "https://api.groq.com/openai/v1",
    env_var: "GROQ_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b", "llama-3.3-70b-versatile"],
    reasoning_models_prefix: ["openai/gpt-oss-"],
    console_url: "https://console.groq.com/keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    api_style: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    env_var: "GEMINI_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-flash-latest"],
    reasoning_models_prefix: [],
    console_url: "https://aistudio.google.com/api-keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api_style: "openai",
    base_url: "https://openrouter.ai/api/v1",
    env_var: "OPENROUTER_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: [
      "openai/gpt-oss-120b:free",
      "deepseek/deepseek-r1:free",
      "qwen/qwen3-coder:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ],
    reasoning_models_prefix: [],
    console_url: "https://openrouter.ai/keys",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    api_style: "openai",
    base_url: "https://integrate.api.nvidia.com/v1",
    env_var: "NVIDIA_API_KEY",
    requires_key: true,
    cors_ok: false,
    default_models: [
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
      "minimaxai/minimax-m3.1-flash",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "moonshotai/kimi-k3.1-pro",
    ],
    reasoning_models_prefix: [],
    console_url: "https://build.nvidia.com/",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api_style: "openai",
    base_url: "https://api.deepseek.com/v1",
    env_var: "DEEPSEEK_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: ["deepseek-chat", "deepseek-reasoner"],
    reasoning_models_prefix: [],
    console_url: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "qwen",
    name: "Qwen (DashScope)",
    api_style: "openai",
    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    env_var: "DASHSCOPE_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen3-235b-a22b"],
    reasoning_models_prefix: [],
    console_url: "https://chat.qwen.ai/",
  },
  {
    id: "xai",
    name: "xAI Grok",
    api_style: "openai",
    base_url: "https://api.x.ai/v1",
    env_var: "XAI_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: ["grok-4", "grok-3", "grok-3-mini"],
    reasoning_models_prefix: [],
    console_url: "https://console.x.ai/",
  },
  {
    id: "mistral",
    name: "Mistral",
    api_style: "openai",
    base_url: "https://api.mistral.ai/v1",
    env_var: "MISTRAL_API_KEY",
    requires_key: true,
    cors_ok: true,
    default_models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    reasoning_models_prefix: [],
    console_url: "https://console.mistral.ai/",
  },
  {
    id: "ollama",
    name: "Local Ollama",
    api_style: "openai",
    base_url: "http://127.0.0.1:11434/v1",
    env_var: "OLLAMA_API_KEY",
    requires_key: false,
    cors_ok: true,
    default_models: ["llama3.1:latest", "gemma4:12b"],
    reasoning_models_prefix: [],
    console_url: "http://127.0.0.1:11434",
  },
];

function splitKeyPool(raw) {
  if (!raw) return [];
  return [...new Set(String(raw).replace(/\n/g, ",").split(",").map((s) => s.trim()).filter(Boolean))];
}

async function streamDirectProvider({ provider, apiKey, model, messages, temperature, maxTokens, signal, onChunk }) {
  if (provider.api_style === "gemini") {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system" && m.content)
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: Math.max(maxTokens, 2048) },
    };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    const res = await fetch(
      `${provider.base_url}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }
    );
    if (!res.ok) throw new Error(`${provider.name} (${res.status}): ${(await res.text()).slice(0, 220)}`);
    await consumeSseStream(res, (ev) => {
      for (const cand of ev.candidates || []) {
        for (const part of cand.content?.parts || []) {
          if (part.text) onChunk(part.thought ? "reasoning" : "delta", part.text);
        }
      }
    });
    return;
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model,
    messages,
    temperature,
    stream: true,
    ...(provider.id === "groq" ? { max_completion_tokens: Math.max(maxTokens, 2048) } : { max_tokens: Math.max(maxTokens, 2048) }),
  };
  const res = await fetch(`${provider.base_url}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${provider.name} (${res.status}): ${(await res.text()).slice(0, 220)}`);
  await consumeSseStream(res, (ev) => {
    const delta = ev.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.reasoning_content || delta.reasoning) onChunk("reasoning", delta.reasoning_content || delta.reasoning);
    if (delta.content) onChunk("delta", delta.content);
  });
}

async function runDirectSlot({ slot, stage, messages, providers, localKeys, temperature, maxTokens, signal, onEvent }) {
  const candidates = [];
  const enqueue = (pid, model) => {
    const prov = providers.find((p) => p.id === pid);
    if (!prov || prov.cors_ok === false) return;
    const keys = prov.requires_key ? splitKeyPool(localKeys[pid]) : [""];
    keys.forEach((k) => candidates.push({ prov, model, k }));
  };
  enqueue(slot.provider, slot.model);
  [
    ["groq", "openai/gpt-oss-120b"],
    ["gemini", "gemini-3.5-flash"],
    ["openrouter", "openai/gpt-oss-120b:free"],
  ].forEach(([p, m]) => enqueue(p, m));

  if (!candidates.length) {
    const msg = "Browser Direct Mode (GitHub Pages): Add a Gemini, Groq, or OpenRouter API key in API Keys to run live.";
    onEvent({ type: "agent_error", stage, role_id: slot.role_id, message: msg });
    onEvent({ type: "agent_done", stage, role_id: slot.role_id });
    return "";
  }

  let lastErr = "";
  for (let i = 0; i < candidates.length; i++) {
    const { prov, model, k } = candidates[i];
    if (i > 0) onEvent({ type: "agent_failover", stage, role_id: slot.role_id, provider: prov.id, model, reason: lastErr });
    let content = "";
    let reasoning = "";
    try {
      await streamDirectProvider({
        provider: prov,
        apiKey: k,
        model,
        messages,
        temperature,
        maxTokens,
        signal,
        onChunk: (kind, text) => {
          if (kind === "reasoning") {
            reasoning += text;
            onEvent({ type: "agent_reasoning", stage, role_id: slot.role_id, text });
          } else {
            content += text;
            onEvent({ type: "agent_delta", stage, role_id: slot.role_id, text });
          }
        },
      });
      if (!content && reasoning) {
        content = reasoning;
        onEvent({ type: "agent_delta", stage, role_id: slot.role_id, text: reasoning });
      }
      onEvent({ type: "agent_done", stage, role_id: slot.role_id });
      return content;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastErr = err.message || "Request failed";
    }
  }
  onEvent({ type: "agent_error", stage, role_id: slot.role_id, message: lastErr });
  onEvent({ type: "agent_done", stage, role_id: slot.role_id });
  return "";
}

async function runDirectOrchestra({ payload, providers, localKeys, signal, onEvent }) {
  const { prompt, system_prompt, boss, workers, temperature, max_tokens, discussion_rounds } = payload;
  const bossSlot = { ...boss, role_id: "boss" };
  const workerSlots = workers.map((w, i) => ({ ...w, role_id: `worker_${i + 1}` }));

  onEvent({ type: "stage_start", stage: "boss_plan" });
  const bossPlan = await runDirectSlot({
    slot: bossSlot,
    stage: "boss_plan",
    messages: [
      {
        role: "system",
        content: `${system_prompt ? system_prompt + "\n\n" : ""}You are Orchestra Boss leading 3 Thinkers (@Thinker-1, @Thinker-2, @Thinker-3). Give your initial angle and brief them concisely.`,
      },
      { role: "user", content: prompt },
    ],
    providers,
    localKeys,
    temperature,
    maxTokens: max_tokens,
    signal,
    onEvent,
  });

  onEvent({ type: "stage_start", stage: "worker_draft" });
  const drafts = await Promise.all(
    workerSlots.map((w) =>
      runDirectSlot({
        slot: w,
        stage: "worker_draft",
        messages: [
          { role: "system", content: `You are ${w.label} (${w.title}) reporting to @Boss. Give concise independent work.` },
          { role: "user", content: `REQUEST:\n${prompt}\n\n@Boss PLAN:\n${bossPlan}` },
        ],
        providers,
        localKeys,
        temperature,
        maxTokens: max_tokens,
        signal,
        onEvent,
      })
    )
  );

  onEvent({ type: "stage_start", stage: "worker_crosstalk" });
  const rounds = Math.max(1, Math.min(discussion_rounds || 2, 3));
  let board = workerSlots.map((w, i) => `${w.label}: ${drafts[i] || "(empty)"}`).join("\n\n");
  let stopReason = `Reached round cap (${rounds}/${rounds})`;
  let finalReplies = drafts;

  for (let r = 1; r <= rounds; r++) {
    onEvent({ type: "crosstalk_round", round: r, max_rounds: rounds });
    finalReplies = await Promise.all(
      workerSlots.map((w) =>
        runDirectSlot({
          slot: w,
          stage: "worker_crosstalk",
          messages: [
            {
              role: "system",
              content: `You are ${w.label} in Round ${r}/${rounds}. Talk to @Thinker-1/@Thinker-2/@Thinker-3 and report to @Boss. End with CONSENSUS: READY when ready to converge.`,
            },
            { role: "user", content: `REQUEST:\n${prompt}\n\nDISCUSSION:\n${board}` },
          ],
          providers,
          localKeys,
          temperature,
          maxTokens: max_tokens,
          signal,
          onEvent,
        })
      )
    );
    board += "\n\n" + workerSlots.map((w, i) => `${w.label} R${r}: ${finalReplies[i]}`).join("\n\n");
    const votes = finalReplies.filter((txt) => txt.toUpperCase().includes("CONSENSUS: READY")).length;
    if (votes >= 2) {
      stopReason = `Consensus reached at Round ${r}/${rounds}`;
      break;
    }
  }
  onEvent({ type: "crosstalk_stopped", reason: stopReason });

  onEvent({ type: "stage_start", stage: "boss_merge" });
  await runDirectSlot({
    slot: bossSlot,
    stage: "boss_merge",
    messages: [
      {
        role: "system",
        content: "You are Orchestra Boss. Audit all 3 Thinkers, explicitly remove the weakest/worse output, add your own Boss improvements, and provide ### 1. Boss Review & Filter and ### 2. Final Merged Answer.",
      },
      {
        role: "user",
        content: `REQUEST:\n${prompt}\n\nBOSS PLAN:\n${bossPlan}\n\nTEAM FINAL:\n${workerSlots.map((w, i) => `${w.label}:\n${finalReplies[i]}`).join("\n\n")}`,
      },
    ],
    providers,
    localKeys,
    temperature,
    maxTokens: max_tokens,
    signal,
    onEvent,
  });

  onEvent({ type: "orchestra_done", stop_reason: stopReason });
}
