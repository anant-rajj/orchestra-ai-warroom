const STORAGE_KEYS = "multi_llm_api_keys_v1";
const STORAGE_HISTORY = "multi_llm_chat_history_v1";

const PRESETS = {
  assistant: "Be clear, accurate, and constructive.",
  architect: "Act like a sharp software engineering organization focused on clean, testable architecture.",
  security: "Focus on security risks, threat modeling, and defensive best practices.",
  concise: "Keep every reply tight, technical, and free of fluff.",
};

const state = {
  providers: [],
  modelsCache: {},
  localKeys: loadLocalKeys(),
  messages: loadHistory(),
  mode: "orchestra",
  staticMode: false,
  codeLang: "python",
  vfxEnabled: true,
  activeAbort: null,
  orchestraAbort: null,
  roster: [
    {
      role_id: "boss",
      label: "Orchestra Boss",
      title: "Lead & Merger",
      provider: "nvidia",
      model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    },
    {
      role_id: "worker_1",
      label: "Thinker 1",
      title: "Systems Architect",
      provider: "nvidia",
      model: "minimaxai/minimax-m3.1-flash",
    },
    {
      role_id: "worker_2",
      label: "Thinker 2",
      title: "Pragmatic Builder",
      provider: "gemini",
      model: "gemini-3.5-flash",
    },
    {
      role_id: "worker_3",
      label: "Thinker 3",
      title: "Critical Reviewer",
      provider: "nvidia",
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    },
  ],
  orchestraRun: null,
};

function createEmptyRun() {
  return {
    prompt: "",
    activeStage: null,
    doneStages: new Set(),
    bossPlan: { text: "", reasoning: "", error: "", status: "Idle" },
    bossMerge: { text: "", reasoning: "", error: "", status: "Idle" },
    workers: {
      worker_1: { draft: "", draftReasoning: "", talk: "", talkReasoning: "", error: "", status: "Idle" },
      worker_2: { draft: "", draftReasoning: "", talk: "", talkReasoning: "", error: "", status: "Idle" },
      worker_3: { draft: "", draftReasoning: "", talk: "", talkReasoning: "", error: "", status: "Idle" },
    },
  };
}

function loadLocalKeys() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS) || "{}");
  } catch {
    return {};
  }
}

function saveLocalKeys(keys) {
  localStorage.setItem(STORAGE_KEYS, JSON.stringify(keys));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_HISTORY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(STORAGE_HISTORY, JSON.stringify(state.messages));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text || "");
  const codeBlocks = [];
  const withPlaceholders = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="lang-${lang}">${code}</code></pre>`);
    return `@@CODE_BLOCK_${idx}@@`;
  });

  let html = withPlaceholders
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^###\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/@(Thinker-[123]|Boss)/g, '<span class="mention">@$1</span>')
    .replace(/\n/g, "<br>");

  codeBlocks.forEach((block, idx) => {
    html = html.replace(`@@CODE_BLOCK_${idx}@@`, block);
  });
  return html;
}

/* 3D Planetary Drafting Orrery VFX Engine (managed by /static/orrery_vfx.js) */
function syncProVfxEngine() {
  if (typeof initOrreryVfxEngine !== "function") return;
  if (!window.__orchestraOrrery) {
    const ctrl = initOrreryVfxEngine();
    ctrl?.setVfxEnabled(state.vfxEnabled);
  }
}

function attach3DTilt() {
  // Handled by 3D camera orbit & CAD glass pods
}

function getProviderById(id) {
  return state.providers.find((p) => p.id === id);
}

function isProviderConfigured(provider) {
  if (!provider) return false;
  if (!provider.requires_key) return true;
  return Boolean(provider.configured || state.localKeys[provider.id]);
}

function activeModel() {
  const custom = document.getElementById("custom-model-input").value.trim();
  return custom || document.getElementById("model-select").value;
}

function activeProviderId() {
  return document.getElementById("provider-select").value;
}

async function fetchProviders() {
  try {
    const res = await fetch("./api/providers");
    if (!res.ok) throw new Error("Static host");
    const data = await res.json();
    state.staticMode = false;
    state.providers = data.providers || [];
  } catch {
    state.staticMode = true;
    state.providers = (typeof STATIC_PROVIDERS_CATALOG !== "undefined" ? STATIC_PROVIDERS_CATALOG : []).map((p) => ({
      ...p,
      configured: !p.requires_key || Boolean(state.localKeys[p.id]),
      key_count: p.requires_key ? (typeof splitKeyPool === "function" ? splitKeyPool(state.localKeys[p.id]).length : 0) : 1,
    }));
  }
  alignRosterWithConfiguredProviders();
  populateProviderSelect();
  renderRosterControls();
  renderOrchestra();
  updateKeysBadge();
  updateCodePreview();
}

function alignRosterWithConfiguredProviders() {
  const ready = state.providers.filter((p) => isProviderConfigured(p) && p.id !== "ollama");
  if (!ready.length) return;
  state.roster.forEach((slot) => {
    const prov = getProviderById(slot.provider);
    if (!prov || !isProviderConfigured(prov)) {
      slot.provider = ready[0].id;
      slot.model = ready[0].default_models[0] || "";
    }
  });
}

function renderRosterControls() {
  const container = document.getElementById("roster-config-list");
  if (!state.providers.length) return;

  container.innerHTML = state.roster
    .map((slot, idx) => {
      const prov = getProviderById(slot.provider) || state.providers[0];
      const models = state.modelsCache[prov.id] || prov.default_models || [];
      if (!models.includes(slot.model)) slot.model = models[0] || "";

      const provOpts = state.providers
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === prov.id ? "selected" : ""}>${escapeHtml(
              p.name
            )}${isProviderConfigured(p) ? "" : " (key)"}</option>`
        )
        .join("");

      const modelOpts = models
        .map(
          (m) =>
            `<option value="${escapeHtml(m)}" ${m === slot.model ? "selected" : ""}>${escapeHtml(
              m
            )}</option>`
        )
        .join("");

      const badge = slot.role_id === "boss" ? "👑 Boss" : `🧠 ${slot.label}`;
      return `
        <div class="roster-item ${slot.role_id === "boss" ? "boss" : ""}">
          <div class="roster-item-title">
            <span>${escapeHtml(badge)}</span>
            <span class="muted">${escapeHtml(slot.title)}</span>
          </div>
          <div class="roster-selects">
            <select class="roster-provider" data-idx="${idx}">${provOpts}</select>
            <select class="roster-model" data-idx="${idx}">${modelOpts}</select>
          </div>
        </div>`;
    })
    .join("");

  container.querySelectorAll(".roster-provider").forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const pid = e.target.value;
      const prov = getProviderById(pid);
      state.roster[idx].provider = pid;
      state.roster[idx].model = prov?.default_models?.[0] || "";
      renderRosterControls();
      renderOrchestra();
    });
  });

  container.querySelectorAll(".roster-model").forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      state.roster[idx].model = e.target.value;
      renderOrchestra();
    });
  });
}

function populateProviderSelect() {
  const select = document.getElementById("provider-select");
  const prev = select.value || "nvidia";
  select.innerHTML = state.providers
    .map((p) => {
      const tag = isProviderConfigured(p) ? "Ready" : "Needs key";
      return `<option value="${p.id}">${escapeHtml(p.name)} (${tag})</option>`;
    })
    .join("");
  select.value = getProviderById(prev) ? prev : "nvidia";
  populateModelSelect(select.value);
}

function populateModelSelect(providerId) {
  const provider = getProviderById(providerId);
  if (!provider) return;
  const models = state.modelsCache[providerId] || provider.default_models || [];
  const select = document.getElementById("model-select");
  const current = select.value;
  select.innerHTML = models
    .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
    .join("");
  if (models.includes(current)) select.value = current;

  const pill = document.getElementById("provider-status-pill");
  const ready = isProviderConfigured(provider);
  pill.className = `status-pill ${ready ? "ok" : "warn"}`;
  pill.innerHTML = ready
    ? `<span>● Connected</span><a class="btn-link" href="${provider.console_url}" target="_blank" rel="noreferrer">Console ↗</a>`
    : `<span>○ API Key Needed</span><button type="button" class="btn-link" id="pill-add-key">Add Key</button>`;
  const pillBtn = document.getElementById("pill-add-key");
  if (pillBtn) pillBtn.onclick = openKeysModal;

  const showReasoning = (provider.reasoning_models_prefix || []).some((pfx) =>
    activeModel().startsWith(pfx)
  );
  document.getElementById("reasoning-effort-wrap").classList.toggle("hidden", !showReasoning);
  updateCodePreview();
}

async function refreshLiveModels() {
  const pid = activeProviderId();
  const btn = document.getElementById("btn-refresh-models");
  btn.textContent = "Loading…";
  try {
    const headers = {};
    if (state.localKeys[pid]) headers["X-Provider-Key"] = state.localKeys[pid];
    const res = await fetch(`/api/providers/${encodeURIComponent(pid)}/models`, { headers });
    const data = await res.json();
    if (Array.isArray(data.models) && data.models.length) {
      state.modelsCache[pid] = data.models;
      populateModelSelect(pid);
    }
  } finally {
    btn.textContent = "↻ Refresh";
  }
}

function updateKeysBadge() {
  const count = state.providers.filter((p) => p.requires_key && isProviderConfigured(p)).length;
  document.getElementById("keys-count-badge").textContent = String(count);
}

function renderCardContent(text, reasoning, error, placeholder, openThinking = false) {
  if (error) return `<div style="color:#fca5a5">${escapeHtml(error)}</div>`;
  const rHtml = reasoning
    ? `<details class="reasoning-box" ${openThinking ? "open" : ""}><summary>Thinking live…</summary><div>${renderMarkdown(reasoning)}</div></details>`
    : "";
  const body = text ? renderMarkdown(text) : `<span class="muted">${escapeHtml(placeholder)}</span>`;
  return `${rHtml}<div>${body}</div>`;
}

function renderWorkerChatlogHtml(slot, wState, isActive) {
  if (wState.error) {
    return `<div class="chat-bubble" style="border-color:rgba(239,68,68,0.5);color:#fca5a5">${escapeHtml(wState.error)}</div>`;
  }
  const blocks = [];
  if (wState.draftReasoning) {
    blocks.push(
      `<div class="chat-bubble thinking"><div class="worker-section-label">Thinking (Stage 2)</div>${renderMarkdown(wState.draftReasoning)}</div>`
    );
  }
  if (wState.draft) {
    blocks.push(
      `<div class="chat-bubble"><div class="worker-section-label">Stage 2 · Independent Work</div>${renderMarkdown(wState.draft)}</div>`
    );
  }
  if (wState.talkReasoning) {
    blocks.push(
      `<div class="chat-bubble thinking"><div class="worker-section-label">Thinking (Cross-Talk)</div>${renderMarkdown(wState.talkReasoning)}</div>`
    );
  }
  if (wState.talk) {
    blocks.push(
      `<div class="chat-bubble crosstalk"><div class="worker-section-label">Stage 3 · Peer Discussion &amp; Finalised</div>${renderMarkdown(wState.talk)}</div>`
    );
  }
  if (!blocks.length) {
    const msg = isActive ? "Connecting & thinking…" : `Waiting for Boss brief (${slot.model})…`;
    return `<div class="chat-bubble muted">${escapeHtml(msg)}</div>`;
  }
  return blocks.join("");
}

function ensureWorkerShells() {
  const workersGrid = document.getElementById("workers-grid");
  const chipClasses = ["w1", "w2", "w3"];
  const sig = state.roster.slice(1).map((s) => `${s.role_id}:${s.provider}:${s.model}`).join("|");
  if (workersGrid.dataset.sig === sig) return;

  workersGrid.dataset.sig = sig;
  workersGrid.innerHTML = state.roster
    .slice(1)
    .map(
      (slot, idx) => `
      <div class="worker-card glass-pod" id="worker-card-${slot.role_id}">
        <div class="pod-head">
          <span class="role-chip ${chipClasses[idx]}">● ${escapeHtml(slot.label)} · ${escapeHtml(slot.title)}</span>
          <span class="meta-tag" id="worker-meta-${slot.role_id}">${escapeHtml(slot.model.split("/").pop())} · Idle</span>
        </div>
        <div class="worker-chatlog" id="worker-log-${slot.role_id}"></div>
      </div>`
    )
    .join("");
  syncProVfxEngine();
}

function renderOrchestra() {
  const run = state.orchestraRun || createEmptyRun();

  document.querySelectorAll(".stage-pill").forEach((pill) => {
    const st = pill.dataset.stage;
    pill.classList.toggle("active", run.activeStage === st);
    pill.classList.toggle("done", run.doneStages.has(st));
  });

  window.__orchestraOrrery?.setStage(run.activeStage || "idle");

  const bossSlot = state.roster[0];
  document.getElementById("boss-plan-meta").textContent = `${bossSlot.model} · ${run.bossPlan.status}`;
  document.getElementById("boss-plan-card")?.classList.toggle("is-live", run.activeStage === "boss_plan");
  document.getElementById("boss-plan-body").innerHTML = renderCardContent(
    run.bossPlan.text,
    run.bossPlan.reasoning,
    run.bossPlan.error,
    "Drag anywhere to orbit 3D planets · Scroll to zoom · Send a prompt below to launch the 3D Thinkers.",
    run.activeStage === "boss_plan"
  );

  document.getElementById("boss-merge-meta").textContent = `${bossSlot.model} · ${run.bossMerge.status}`;
  document.getElementById("boss-merge-card")?.classList.toggle("is-live", run.activeStage === "boss_merge");
  document.getElementById("boss-merge-body").innerHTML = renderCardContent(
    run.bossMerge.text,
    run.bossMerge.reasoning,
    run.bossMerge.error,
    "After bounded cross-talk stops cleanly, the Boss audits all 3 Thinkers, removes the weakest output, adds Boss improvements, and merges the final answer here.",
    run.activeStage === "boss_merge"
  );

  ensureWorkerShells();
  const workersLive = run.activeStage === "worker_draft" || run.activeStage === "worker_crosstalk";
  state.roster.slice(1).forEach((slot) => {
    const wState = run.workers[slot.role_id];
    const card = document.getElementById(`worker-card-${slot.role_id}`);
    const meta = document.getElementById(`worker-meta-${slot.role_id}`);
    const log = document.getElementById(`worker-log-${slot.role_id}`);
    if (!card || !meta || !log) return;

    card.classList.toggle("is-live", workersLive);
    meta.textContent = `${slot.model.split("/").pop()} · ${wState.status}`;
    log.innerHTML = renderWorkerChatlogHtml(slot, wState, workersLive);
    log.scrollTop = log.scrollHeight;
  });
}

async function consumeSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      onEvent(parsed);
    }
  }
}

async function runOrchestra(event) {
  event.preventDefault();
  if (state.orchestraAbort) return;

  const input = document.getElementById("orchestra-input");
  const prompt = input.value.trim();
  if (!prompt) return;

  const run = createEmptyRun();
  run.prompt = prompt;
  run.activeStage = "boss_plan";
  run.bossPlan.status = "Connecting…";
  state.orchestraRun = run;
  renderOrchestra();

  const controller = new AbortController();
  state.orchestraAbort = controller;
  document.getElementById("btn-orchestra-stop").classList.remove("hidden");
  document.getElementById("btn-orchestra-send").disabled = true;

  const payload = {
    prompt,
    system_prompt: document.getElementById("system-prompt").value.trim(),
    boss: {
      provider: state.roster[0].provider,
      model: state.roster[0].model,
      label: state.roster[0].label,
      title: state.roster[0].title,
    },
    workers: state.roster.slice(1).map((w) => ({
      provider: w.provider,
      model: w.model,
      label: w.label,
      title: w.title,
    })),
    temperature: parseFloat(document.getElementById("temp-slider").value),
    max_tokens: parseInt(document.getElementById("tokens-slider").value, 10),
    discussion_rounds: parseInt(document.getElementById("discussion-rounds")?.value || "2", 10),
    api_keys: state.localKeys,
  };

  const handleOrchestraEvent = (ev) => {
    if (ev.type === "stage_start") {
      if (run.activeStage) run.doneStages.add(run.activeStage);
      run.activeStage = ev.stage;
      if (ev.stage === "boss_plan") run.bossPlan.status = "Thinking…";
      if (ev.stage === "boss_merge") run.bossMerge.status = "Auditing & Merging…";
    } else if (ev.type === "crosstalk_round") {
      state.roster.slice(1).forEach((s) => {
        const w = run.workers[s.role_id];
        if (w) {
          w.status = `Round ${ev.round}/${ev.max_rounds}`;
          if (ev.round > 1 && w.talk) w.talk += `\n\n---\n**Round ${ev.round}/${ev.max_rounds}:**\n`;
        }
      });
    } else if (ev.type === "crosstalk_stopped") {
      state.roster.slice(1).forEach((s) => {
        const w = run.workers[s.role_id];
        if (w) w.status = `Stopped (${ev.reason})`;
      });
    } else if (ev.type === "agent_failover") {
      if (ev.stage === "boss_plan") run.bossPlan.status = `Failover -> ${ev.model}`;
      else if (ev.stage === "boss_merge") run.bossMerge.status = `Failover -> ${ev.model}`;
      else if (run.workers[ev.role_id]) run.workers[ev.role_id].status = `Failover -> ${ev.model.split("/").pop()}`;
    } else if (ev.type === "agent_reasoning") {
      window.__orchestraOrrery?.spikeNode(ev.role_id || "boss");
      if (ev.stage === "boss_plan") run.bossPlan.reasoning += ev.text;
      else if (ev.stage === "boss_merge") run.bossMerge.reasoning += ev.text;
      else if (ev.stage === "worker_draft") run.workers[ev.role_id].draftReasoning += ev.text;
      else if (ev.stage === "worker_crosstalk") run.workers[ev.role_id].talkReasoning += ev.text;
    } else if (ev.type === "agent_delta") {
      window.__orchestraOrrery?.spikeNode(ev.role_id || "boss");
      if (ev.stage === "boss_plan") {
        run.bossPlan.status = "Briefing…";
        run.bossPlan.text += ev.text;
      } else if (ev.stage === "boss_merge") {
        run.bossMerge.status = "Merging…";
        run.bossMerge.text += ev.text;
      } else if (ev.stage === "worker_draft") {
        run.workers[ev.role_id].status = "Working…";
        run.workers[ev.role_id].draft += ev.text;
      } else if (ev.stage === "worker_crosstalk") {
        run.workers[ev.role_id].status = "Talking…";
        run.workers[ev.role_id].talk += ev.text;
      }
    } else if (ev.type === "agent_error") {
      if (ev.stage === "boss_plan") run.bossPlan.error = ev.message;
      else if (ev.stage === "boss_merge") run.bossMerge.error = ev.message;
      else if (run.workers[ev.role_id]) run.workers[ev.role_id].error = ev.message;
    } else if (ev.type === "agent_done") {
      if (ev.stage === "boss_plan") run.bossPlan.status = "Done";
      else if (ev.stage === "boss_merge") run.bossMerge.status = "Done";
      else if (ev.stage === "worker_draft" && run.workers[ev.role_id]) run.workers[ev.role_id].status = "Draft Ready";
      else if (ev.stage === "worker_crosstalk" && run.workers[ev.role_id]) run.workers[ev.role_id].status = "Finalised";
    } else if (ev.type === "orchestra_done") {
      if (run.activeStage) run.doneStages.add(run.activeStage);
      run.activeStage = null;
      window.__orchestraOrrery?.triggerMergeShockwave();
    }
    renderOrchestra();
  };

  try {
    if (state.staticMode && typeof runDirectOrchestra === "function") {
      await runDirectOrchestra({
        payload,
        providers: state.providers,
        localKeys: state.localKeys,
        signal: controller.signal,
        onEvent: handleOrchestraEvent,
      });
    } else {
      const res = await fetch("./api/orchestra/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await consumeSseStream(res, handleOrchestraEvent);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      const msg = err.message === "Failed to fetch"
        ? "Failed to reach backend at http://127.0.0.1:8000 — ensure the FastAPI server is running and reload."
        : err.message || "Orchestra failed";
      run.bossMerge.error = msg;
      renderOrchestra();
    }
  } finally {
    state.orchestraAbort = null;
    document.getElementById("btn-orchestra-stop").classList.add("hidden");
    document.getElementById("btn-orchestra-send").disabled = false;
  }
}

function renderMessages() {
  const container = document.getElementById("chat-messages");
  if (!state.messages.length) {
    container.innerHTML = `<div class="msg"><div class="msg-body"><span class="muted">Single Chat mode ready. Pick any provider/model in the left panel to stream directly.</span></div></div>`;
    return;
  }
  container.innerHTML = state.messages
    .map((m) => {
      const cls = m.error ? "msg error" : `msg ${m.role}`;
      const label = m.role === "user" ? "You" : `${m.providerName || "Assistant"} · ${m.model || ""}`;
      const reasoning = m.reasoning
        ? `<details class="reasoning-box"><summary>Thinking trace</summary><div>${renderMarkdown(m.reasoning)}</div></details>`
        : "";
      return `
        <article class="${cls}">
          <div class="msg-meta">
            <span class="msg-role">${escapeHtml(label)}</span>
            <span>${escapeHtml(m.meta || "")}</span>
          </div>
          ${reasoning}
          <div class="msg-body">${renderMarkdown(m.content || (m.streaming ? "…" : ""))}</div>
        </article>`;
    })
    .join("");
  container.scrollTop = container.scrollHeight;
}

async function sendSingleChat(event) {
  event.preventDefault();
  if (state.activeAbort) return;
  const input = document.getElementById("chat-input");
  const prompt = input.value.trim();
  if (!prompt) return;

  const providerId = activeProviderId();
  const provider = getProviderById(providerId);
  const model = activeModel();
  const sys = document.getElementById("system-prompt").value.trim();
  const apiMessages = [
    ...(sys ? [{ role: "system", content: sys }] : []),
    ...state.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: prompt },
  ];

  state.messages.push({ role: "user", content: prompt });
  const assistantMsg = {
    role: "assistant",
    providerId,
    providerName: provider?.name || providerId,
    model,
    content: "",
    reasoning: "",
    streaming: true,
    meta: "Streaming…",
  };
  state.messages.push(assistantMsg);
  input.value = "";
  renderMessages();

  const controller = new AbortController();
  state.activeAbort = controller;
  document.getElementById("btn-stop").classList.remove("hidden");
  document.getElementById("btn-send").disabled = true;

  try {
    if (state.staticMode && typeof runDirectSlot === "function") {
      await runDirectSlot({
        slot: { provider: providerId, model, role_id: "single" },
        stage: "single",
        messages: apiMessages,
        providers: state.providers,
        localKeys: state.localKeys,
        temperature: parseFloat(document.getElementById("temp-slider").value),
        maxTokens: parseInt(document.getElementById("tokens-slider").value, 10),
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === "agent_reasoning") assistantMsg.reasoning += ev.text;
          else if (ev.type === "agent_delta") assistantMsg.content += ev.text;
          else if (ev.type === "agent_error") {
            assistantMsg.error = true;
            assistantMsg.content = ev.message;
          } else if (ev.type === "agent_done") assistantMsg.meta = "Done";
          renderMessages();
        },
      });
    } else {
      const headers = { "Content-Type": "application/json" };
      if (state.localKeys[providerId]) headers["X-Provider-Key"] = state.localKeys[providerId];
      const res = await fetch("./api/chat/stream", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          provider: providerId,
          model,
          messages: apiMessages,
          temperature: parseFloat(document.getElementById("temp-slider").value),
          max_tokens: parseInt(document.getElementById("tokens-slider").value, 10),
          top_p: parseFloat(document.getElementById("topp-slider").value),
          reasoning_effort: document.getElementById("reasoning-effort").value,
        }),
      });
      await consumeSseStream(res, (ev) => {
        if (ev.type === "reasoning") assistantMsg.reasoning += ev.text;
        else if (ev.type === "delta") assistantMsg.content += ev.text;
        else if (ev.type === "error") {
          assistantMsg.error = true;
          assistantMsg.content = ev.message;
        } else if (ev.type === "done") assistantMsg.meta = "Done";
        renderMessages();
      });
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      assistantMsg.error = true;
      assistantMsg.content = err.message;
    }
  } finally {
    assistantMsg.streaming = false;
    state.activeAbort = null;
    document.getElementById("btn-stop").classList.add("hidden");
    document.getElementById("btn-send").disabled = false;
    saveHistory();
    renderMessages();
  }
}

function updateCodePreview() {
  const provider = getProviderById(activeProviderId());
  if (!provider) return;
  const model = activeModel();
  const preview = document.getElementById("code-preview");
  if (state.codeLang === "curl") {
    preview.textContent = `curl -X POST "http://127.0.0.1:8000/api/orchestra/stream" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt":"Design a cache layer","boss":{"provider":"${state.roster[0].provider}","model":"${state.roster[0].model}"},"workers":[]}'`;
    return;
  }
  preview.textContent = `from openai import OpenAI\nimport os\n\nclient = OpenAI(\n    base_url="${provider.base_url}",\n    api_key=os.environ.get("${provider.env_var}", ""),\n)\n\nstream = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello!"}],\n    stream=True,\n)\nfor chunk in stream:\n    print(chunk.choices[0].delta.content or "", end="")`;
}

function openKeysModal() {
  const list = document.getElementById("keys-list");
  list.innerHTML = state.providers
    .filter((p) => p.requires_key)
    .map((p) => {
      const configured = isProviderConfigured(p);
      const localVal = state.localKeys[p.id] || "";
      const keyCountNote = p.key_count > 1 ? ` (${p.key_count} keys pooled)` : "";
      const placeholder = p.configured && !localVal
        ? `Configured in .env${keyCountNote} (paste comma-separated keys to add/replace)`
        : `Paste ${p.env_var} (or key1,key2 for auto-rotation)`;
      return `
        <div class="key-row">
          <div class="key-row-info">
            <strong>${escapeHtml(p.name)}</strong>
            <span>${configured ? `Configured${keyCountNote}` : "Not set"} · ${escapeHtml(p.env_var)}</span>
          </div>
          <input type="password" class="key-input" data-provider="${p.id}" value="${escapeHtml(localVal)}" placeholder="${escapeHtml(placeholder)}" />
          <a class="btn btn-ghost" href="${p.console_url}" target="_blank" rel="noreferrer">Keys ↗</a>
        </div>`;
    })
    .join("");
  document.getElementById("keys-modal").classList.remove("hidden");
}

function closeKeysModal() {
  document.getElementById("keys-modal").classList.add("hidden");
}

async function saveKeysFromModal() {
  const nextLocal = { ...state.localKeys };
  const payload = {};
  document.querySelectorAll(".key-input").forEach((inp) => {
    const pid = inp.dataset.provider;
    const val = inp.value.trim();
    if (val) {
      nextLocal[pid] = val;
      payload[pid] = val;
    } else {
      delete nextLocal[pid];
    }
  });
  state.localKeys = nextLocal;
  saveLocalKeys(nextLocal);
  if (!state.staticMode && document.getElementById("persist-env-checkbox").checked && Object.keys(payload).length) {
    await fetch("./api/settings/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: payload }),
    });
  }
  closeKeysModal();
  await fetchProviders();
}

function wireEvents() {
  document.getElementById("provider-select").addEventListener("change", (e) => populateModelSelect(e.target.value));
  document.getElementById("model-select").addEventListener("change", () => populateModelSelect(activeProviderId()));
  document.getElementById("custom-model-input").addEventListener("input", updateCodePreview);
  document.getElementById("btn-refresh-models").addEventListener("click", refreshLiveModels);

  document.getElementById("btn-toggle-vfx").addEventListener("click", (e) => {
    state.vfxEnabled = !state.vfxEnabled;
    document.body.classList.toggle("vfx-off", !state.vfxEnabled);
    window.__orchestraOrrery?.setVfxEnabled(state.vfxEnabled);
    e.currentTarget.textContent = state.vfxEnabled ? "✨ 3D: On" : "✨ 3D: Off";
  });

  const drawerIds = ["drawer-roster", "drawer-params", "code-drawer"];
  function toggleDrawer(targetId) {
    drawerIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === targetId) el.classList.toggle("hidden");
      else el.classList.add("hidden");
    });
  }
  document.getElementById("btn-drawer-roster").addEventListener("click", () => toggleDrawer("drawer-roster"));
  document.getElementById("btn-drawer-params").addEventListener("click", () => toggleDrawer("drawer-params"));
  document.getElementById("btn-toggle-code").addEventListener("click", () => {
    toggleDrawer("code-drawer");
    updateCodePreview();
  });
  document.querySelectorAll(".drawer-close").forEach((btn) => {
    btn.addEventListener("click", () => document.getElementById(btn.dataset.close)?.classList.add("hidden"));
  });

  document.getElementById("btn-cam-orrery").addEventListener("click", (e) => {
    window.__orchestraOrrery?.setCameraPreset("orrery");
    e.currentTarget.classList.add("active");
    document.getElementById("btn-cam-blueprint").classList.remove("active");
  });
  document.getElementById("btn-cam-blueprint").addEventListener("click", (e) => {
    window.__orchestraOrrery?.setCameraPreset("blueprint");
    e.currentTarget.classList.add("active");
    document.getElementById("btn-cam-orrery").classList.remove("active");
  });
  document.getElementById("btn-cam-pods").addEventListener("click", (e) => {
    const layer = document.getElementById("workers-grid");
    const min = layer.classList.toggle("pods-minimized");
    e.currentTarget.textContent = min ? "Pods: Min" : "Pods: Open";
  });

  document.getElementById("btn-toggle-brief").addEventListener("click", (e) => {
    const collapsed = document.getElementById("boss-plan-card").classList.toggle("is-collapsed");
    e.currentTarget.textContent = collapsed ? "▸" : "▾";
  });
  document.getElementById("btn-toggle-verdict").addEventListener("click", (e) => {
    const collapsed = document.getElementById("boss-merge-card").classList.toggle("is-collapsed");
    e.currentTarget.textContent = collapsed ? "▸" : "▾";
  });

  document.getElementById("preset-select").addEventListener("change", (e) => {
    if (PRESETS[e.target.value]) {
      document.getElementById("system-prompt").value = PRESETS[e.target.value];
    }
    e.target.value = "";
  });

  [
    ["temp-slider", "temp-value"],
    ["tokens-slider", "tokens-value"],
    ["topp-slider", "topp-value"],
  ].forEach(([sliderId, labelId]) => {
    document.getElementById(sliderId).addEventListener("input", (e) => {
      document.getElementById(labelId).textContent = e.target.value;
    });
  });

  document.getElementById("tab-orchestra").addEventListener("click", () => {
    state.mode = "orchestra";
    document.getElementById("tab-orchestra").classList.add("active");
    document.getElementById("tab-chat").classList.remove("active");
    document.getElementById("orchestra-view").classList.add("active");
    document.getElementById("chat-view").classList.remove("active");
  });

  document.getElementById("tab-chat").addEventListener("click", () => {
    state.mode = "chat";
    document.getElementById("tab-chat").classList.add("active");
    document.getElementById("tab-orchestra").classList.remove("active");
    document.getElementById("chat-view").classList.add("active");
    document.getElementById("orchestra-view").classList.remove("active");
  });

  document.querySelectorAll(".code-lang").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".code-lang").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.codeLang = btn.dataset.lang;
      updateCodePreview();
    });
  });

  document.getElementById("btn-copy-code").addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("code-preview").textContent);
    document.getElementById("btn-copy-code").textContent = "Copied!";
    setTimeout(() => { document.getElementById("btn-copy-code").textContent = "Copy"; }, 1200);
  });

  document.getElementById("orchestra-form").addEventListener("submit", runOrchestra);
  document.getElementById("orchestra-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("orchestra-form").requestSubmit();
    }
  });
  document.getElementById("btn-orchestra-stop").addEventListener("click", () => state.orchestraAbort?.abort());

  document.getElementById("chat-form").addEventListener("submit", sendSingleChat);
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("chat-form").requestSubmit();
    }
  });
  document.getElementById("btn-stop").addEventListener("click", () => state.activeAbort?.abort());

  document.getElementById("btn-clear-chat").addEventListener("click", () => {
    if (state.mode === "orchestra") {
      state.orchestraRun = createEmptyRun();
      renderOrchestra();
    } else {
      state.messages = [];
      saveHistory();
      renderMessages();
    }
  });

  document.getElementById("btn-export-chat").addEventListener("click", () => {
    const run = state.orchestraRun;
    const text = state.mode === "orchestra" && run
      ? `# Orchestra Run\n\n## Prompt\n${run.prompt}\n\n## Boss Plan\n${run.bossPlan.text}\n\n## Thinker 1\n${run.workers.worker_1.draft}\n\n${run.workers.worker_1.talk}\n\n## Thinker 2\n${run.workers.worker_2.draft}\n\n${run.workers.worker_2.talk}\n\n## Thinker 3\n${run.workers.worker_3.draft}\n\n${run.workers.worker_3.talk}\n\n## Boss Review & Merged Answer\n${run.bossMerge.text}`
      : state.messages.map((m) => `## ${m.role}\n${m.content}`).join("\n\n");
    const blob = new Blob([text], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "orchestra-session.md";
    a.click();
  });

  document.getElementById("btn-open-keys").addEventListener("click", openKeysModal);
  document.getElementById("btn-close-keys").addEventListener("click", closeKeysModal);
  document.getElementById("btn-cancel-keys").addEventListener("click", closeKeysModal);
  document.getElementById("btn-save-keys").addEventListener("click", saveKeysFromModal);
}

wireEvents();
renderMessages();
renderOrchestra();
syncProVfxEngine();
fetchProviders();
