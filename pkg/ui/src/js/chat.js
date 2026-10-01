// --- Running Tasks & Activity Steps Formatting ---
function extractRunningTasksFromDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) return [];
  const tasks = [];
  decisions.forEach(d => {
    if (!d) return;
    const rd = d.run_details || {};
    const st = String(rd.status || d.status || "").toUpperCase();
    const runs = String(d.runs || "").toLowerCase();
    if (st === "RUNNING" || st === "WAITING" || runs === "background") {
      const taskName = d.action || d.tool || rd.action_name || (d.fields && d.fields[0] ? d.fields[0].value : "") || "Background Task";
      tasks.push({
        id: rd.id || ("task-" + (d.i || Math.random())),
        name: taskName,
        status: st || "RUNNING"
      });
    }
  });
  return tasks;
}

function renderRunningTasks() {
  const panel = document.getElementById("running-tasks-panel");
  const countLabel = document.getElementById("running-tasks-count-label");
  const listEl = document.getElementById("running-tasks-list");
  if (!panel || !countLabel || !listEl) return;

  if (!activeRunningTasks || activeRunningTasks.length === 0) {
    panel.style.display = "none";
    listEl.innerHTML = "";
    return;
  }

  panel.style.display = "flex";
  const count = activeRunningTasks.length;
  countLabel.innerText = `${count} task${count === 1 ? "" : "s"} running`;

  listEl.innerHTML = "";
  activeRunningTasks.forEach(task => {
    const item = document.createElement("div");
    item.className = "running-task-item";
    item.innerHTML = `
      <svg class="running-task-spinner" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="12" cy="12" r="9" stroke-dasharray="28 28"/>
      </svg>
      <span class="running-task-cmd">${escapeHtml(task.name || task.cmd || "Task")}</span>
    `;
    listEl.appendChild(item);
  });
}

function toggleRunningTasks() {
  const panel = document.getElementById("running-tasks-panel");
  if (panel) {
    panel.classList.toggle("collapsed");
  }
}

function renderModelDropdown() {
  const menu = document.getElementById("model-dropdown-menu");
  if (!menu) return;
  menu.innerHTML = "";
  AVAILABLE_AI_MODELS.forEach(m => {
    const item = document.createElement("div");
    item.className = "model-option-item" + (m.key === activeAiModel ? " selected" : "");
    item.onclick = (e) => {
      e.stopPropagation();
      selectAiModel(m.key, m.label);
    };
    item.innerHTML = `
      <div class="model-option-title">
        <span>${escapeHtml(m.label)}</span>
        ${m.key === activeAiModel ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f85f38" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
      </div>
      <div class="model-option-desc">${escapeHtml(m.desc)}</div>
    `;
    menu.appendChild(item);
  });
}

function toggleModelDropdown(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("model-dropdown-menu");
  if (!menu) return;
  renderModelDropdown();
  menu.classList.toggle("visible");
}

function selectAiModel(key, label) {
  if (key === "custom") {
    openSettingsModal("models", "model");
    const menu = document.getElementById("model-dropdown-menu");
    if (menu) menu.classList.remove("visible");
    return;
  }

  activeAiModel = key;
  if (typeof window !== "undefined") {
    window.activeAiModel = key;
  }
  localStorage.setItem("orborus_ai_model", key);

  if (key.includes("high")) {
    activeReasoningEffort = "high";
  } else {
    activeReasoningEffort = "medium";
  }
  localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);

  const nameEl = document.getElementById("lbl-active-model-name");
  if (nameEl) nameEl.innerText = label;

  const selectFooter = document.getElementById("select-footer-model");
  if (selectFooter) {
    let found = false;
    for (let i = 0; i < selectFooter.options.length; i++) {
      if (selectFooter.options[i].value === key) {
        selectFooter.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      selectFooter.value = "custom";
    }
  }

  const selectSettings = document.getElementById("select-ai-model");
  if (selectSettings) {
    for (let i = 0; i < selectSettings.options.length; i++) {
      if (selectSettings.options[i].value === key) {
        selectSettings.selectedIndex = i;
        break;
      }
    }
  }

  const menu = document.getElementById("model-dropdown-menu");
  if (menu) menu.classList.remove("visible");

  if (typeof window.setAiConfig === "function") {
    try {
      window.setAiConfig(currentAiUrl, currentAiKey, activeAiModel, activeReasoningEffort);
    } catch (e) {
      console.warn("setAiConfig failed:", e);
    }
  }
  showToast(`Switched model to ${label}`);
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("model-dropdown-menu");
  const btn = document.getElementById("btn-model-picker");
  if (menu && menu.classList.contains("visible")) {
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove("visible");
    }
  }
});

function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("Voice input not supported in this environment");
    return;
  }
  const btnMic = document.getElementById("btn-mic");
  if (isListeningVoice) {
    if (speechRecognitionInstance) {
      try { speechRecognitionInstance.stop(); } catch (e) {}
    }
    isListeningVoice = false;
    if (btnMic) btnMic.style.color = "";
    showToast("Voice input stopped");
    return;
  }

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      isListeningVoice = true;
      if (btnMic) btnMic.style.color = "#f85f38";
      showToast("Listening...");
    };

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      const input = document.getElementById("prompt-input");
      if (input && transcript) {
        input.value = (input.value ? input.value + " " : "") + transcript;
        handleInput(input);
      }
    };

    recognition.onend = () => {
      isListeningVoice = false;
      if (btnMic) btnMic.style.color = "";
    };

    recognition.onerror = (e) => {
      isListeningVoice = false;
      if (btnMic) btnMic.style.color = "";
      console.warn("Speech recognition error:", e);
    };

    speechRecognitionInstance = recognition;
    recognition.start();
  } catch (err) {
    console.warn("SpeechRecognition start failed:", err);
    showToast("Could not access microphone");
  }
}

function stopExecution() {
  if (window.currentAbortController) {
    try { window.currentAbortController.abort(); } catch (e) {}
  }
  activeRunningTasks = [];
  renderRunningTasks();
  const btnStop = document.getElementById("btn-stop-execution");
  const btnSend = document.getElementById("btn-send");
  if (btnStop) btnStop.style.display = "none";
  if (btnSend) btnSend.style.display = "flex";

  const stepsContainer = document.getElementById("activity-steps-container");
  if (stepsContainer) {
    const stopRow = document.createElement("div");
    stopRow.className = "activity-step-row";
    stopRow.innerHTML = `
      <div class="activity-step-header" style="color:#ef4444;">
        <div class="activity-step-left">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          <span class="activity-step-title">Execution stopped by user</span>
        </div>
      </div>
    `;
    stepsContainer.appendChild(stopRow);
  }
  showToast("Execution stopped");
}

function formatStepTitleHtml(step) {
  const rawTitle = (step.title || step.name || "").trim();
  if (!rawTitle) return "Task";

  // Check for Analyzed file pattern: Analyzed </> filename #Llines
  const isFileStep = step.type === "file" || rawTitle.toLowerCase().startsWith("analyzed") || rawTitle.toLowerCase().startsWith("read file") || /\.(go|html|js|ts|py|json|md)\b/.test(rawTitle);

  if (isFileStep) {
    const clean = rawTitle.replace(/^Analyzed\s+(?:<\/>\s*)?/i, "").replace(/^(?:Read\s+file|View)\s+/i, "");
    const parts = clean.split(/\s+#L|\s+#/);
    const filePath = parts[0] ? parts[0].trim() : "file";
    const lineRange = parts[1] ? `#L${parts[1].trim()}` : (step.detail && step.detail.match(/#L[\d\-]+/i) ? step.detail.match(/#L[\d\-]+/i)[0] : "");
    return `Analyzed <span class="badge-code-tag">&lt;/&gt;</span> <span class="step-filepath">${escapeHtml(filePath)}</span> ${lineRange ? `<span class="step-line-range">${escapeHtml(lineRange)}</span>` : ""}`;
  }

  // Check for thought pattern: "Thought for 3s"
  if (step.type === "thought" || rawTitle.toLowerCase().startsWith("thought")) {
    const durMatch = rawTitle.match(/thought(?:\s+for\s+([\w\d\.]+))?/i);
    const dur = (durMatch && durMatch[1]) || step.duration || "2s";
    return `Thought for ${escapeHtml(dur)}`;
  }

  // Check for command pattern: "Ran git status"
  if (step.type === "cmd" || rawTitle.toLowerCase().startsWith("ran ") || rawTitle.toLowerCase().startsWith("run ")) {
    return escapeHtml(rawTitle);
  }

  return escapeHtml(rawTitle);
}

function computeStepsSummary(steps) {
  if (!steps || !steps.length) return "Completed execution";
  let fileCount = 0;
  let taskCount = 0;
  let cmdCount = 0;

  steps.forEach(s => {
    const text = (s.name || s.title || "").toLowerCase();
    const isFile = s.type === "file" || text.includes("analyzed") || text.includes("read_file") || text.includes("view_file") || /\.(go|html|js|ts|py|json|md)\b/.test(text);
    const isCmd = s.type === "cmd" || text.startsWith("ran ") || text.startsWith("run ");
    const isTask = text.includes("task") || text.includes("grep") || text.includes("search") || text.includes("worker") || s.type === "task";

    if (isFile) fileCount++;
    else if (isCmd) cmdCount++;
    else if (isTask) taskCount++;
  });

  const parts = [];
  if (fileCount > 0) parts.push(`Exploring ${fileCount} file${fileCount > 1 ? "s" : ""}`);
  if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""}`);
  if (cmdCount > 0) parts.push(`running ${cmdCount} command${cmdCount > 1 ? "s" : ""}`);

  if (parts.length > 0) {
    return parts.join(", ");
  }
  return `${steps.length} step${steps.length > 1 ? "s" : ""} completed`;
}

function toggleTurnSteps(turnId) {
  const container = document.getElementById("turn-steps-" + turnId);
  const banner = document.getElementById("summary-banner-" + turnId);
  if (container) {
    container.classList.toggle("collapsed");
  }
  if (banner) {
    banner.classList.toggle("collapsed");
  }
}

function toggleActiveSteps() {
  const container = document.getElementById("activity-steps-container");
  const banner = document.getElementById("activity-summary-banner");
  if (container) {
    container.classList.toggle("collapsed");
  }
  if (banner) {
    banner.classList.toggle("collapsed");
  }
}


// --- Footer Model & Reasoning Controls ---
// ----------------- Model & Reasoning State -----------------
const AVAILABLE_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini-3.8-Flash", note: "Default" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", note: "High Reasoning" },
  { id: "gemini-3.8-pro", name: "Gemini 3.8 Pro", note: "Reasoning" },
  { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", note: "Anthropic" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", note: "Anthropic" },
  { id: "gpt-4o", name: "GPT-4o", note: "OpenAI" },
  { id: "ollama", name: "Ollama", note: "Local LLM" },
];

function selectModel(modelId) {
  activeAiModel = modelId;
  localStorage.setItem("orborus_ai_model", modelId);
  const sel = document.getElementById("select-ai-model");
  if (sel) sel.value = modelId;
  const footerModelSelect = document.getElementById("select-footer-model");
  const customInput = document.getElementById("input-custom-model");
  if (footerModelSelect) {
    if (modelId === "gemini-3.8-flash") {
      footerModelSelect.value = "gemini-3.8-flash";
      if (customInput) customInput.style.display = "none";
    } else {
      footerModelSelect.value = "custom";
      if (customInput) {
        customInput.style.display = "inline-block";
        customInput.value = modelId;
      }
    }
  }
}

function initFooterControls() {
  const footerModelSelect = document.getElementById("select-footer-model");
  const customInput = document.getElementById("input-custom-model");
  const footerReasoningSelect = document.getElementById("select-footer-reasoning");

  // Reasoning setup
  activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "medium";
  if (footerReasoningSelect) {
    footerReasoningSelect.value = activeReasoningEffort;
  }

  // Model setup
  const savedModel = localStorage.getItem("orborus_ai_model") || "gemini-3.8-flash";
  activeAiModel = savedModel;

  if (!savedModel || savedModel === "gemini-3.8-flash") {
    activeAiModel = "gemini-3.8-flash";
    localStorage.setItem("orborus_ai_model", "gemini-3.8-flash");
    if (footerModelSelect) footerModelSelect.value = "gemini-3.8-flash";
    if (customInput) customInput.style.display = "none";
  } else {
    if (footerModelSelect) footerModelSelect.value = "custom";
    if (customInput) {
      customInput.style.display = "inline-block";
      customInput.value = savedModel;
    }
  }
}

function handleFooterModelChange(val) {
  const customInput = document.getElementById("input-custom-model");
  if (val === "custom") {
    if (customInput) {
      customInput.style.display = "inline-block";
      const savedCustom = localStorage.getItem("orborus_custom_model") || "";
      if (savedCustom) {
        customInput.value = savedCustom;
        activeAiModel = savedCustom;
      } else if (activeAiModel && activeAiModel !== "gemini-3.8-flash") {
        customInput.value = activeAiModel;
      } else {
        customInput.value = "";
      }
      customInput.focus();
      if (customInput.value.trim()) {
        syncModelSettings(customInput.value.trim());
      }
    }
  } else {
    if (customInput) {
      customInput.style.display = "none";
    }
    activeAiModel = "gemini-3.8-flash";
    localStorage.setItem("orborus_ai_model", "gemini-3.8-flash");
    syncModelSettings("gemini-3.8-flash");
  }
}

function handleCustomModelInput(val) {
  const trimmed = val.trim();
  if (trimmed) {
    activeAiModel = trimmed;
    localStorage.setItem("orborus_ai_model", trimmed);
    localStorage.setItem("orborus_custom_model", trimmed);
    syncModelSettings(trimmed);
  }
}

function handleFooterReasoningChange(val) {
  activeReasoningEffort = val || "medium";
  localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  if (window.isDebug) {
    console.log("[DEBUG] Reasoning effort changed to:", activeReasoningEffort);
  }
}

function syncModelSettings(model) {
  const modelSelect = document.getElementById("select-ai-model");
  if (modelSelect) {
    let found = false;
    for (let i = 0; i < modelSelect.options.length; i++) {
      if (modelSelect.options[i].value === model) {
        modelSelect.value = model;
        found = true;
        break;
      }
    }
    if (!found && model) {
      const opt = document.createElement("option");
      opt.value = model;
      opt.innerText = `${model} (Custom)`;
      modelSelect.appendChild(opt);
      modelSelect.value = model;
    }
  }
  updateEnvDisplayInModal();
}


// --- Prompt Execution, Turn Rendering, Stream & Activity Steps ---
// ----------------- Session & Execution -----------------
function startNewSession() {
  activeConversationId = null;
  localStorage.removeItem("orborus_active_conv_id");
  setChatMode(false);
  activeRunningTasks = [];
  renderRunningTasks();

  const turnsContainer = document.getElementById("conversation-turns-container");
  if (turnsContainer) turnsContainer.innerHTML = "";
  const promptCard = document.getElementById("active-user-prompt-card");
  if (promptCard) {
    promptCard.innerText = "";
    promptCard.style.display = "none";
  }
  const summaryBanner = document.getElementById("activity-summary-banner");
  if (summaryBanner) summaryBanner.style.display = "none";
  const stepsContainer = document.getElementById("activity-steps-container");
  if (stepsContainer) stepsContainer.innerHTML = "";
  const container = document.getElementById("execution-cards-container");
  if (container) container.innerHTML = "";
  const approvalCard = document.getElementById("approval-card");
  if (approvalCard) approvalCard.classList.remove("visible");
  currentApprovalId = null;

  const btnStop = document.getElementById("btn-stop-execution");
  const btnSend = document.getElementById("btn-send");
  if (btnStop) btnStop.style.display = "none";
  if (btnSend) {
    btnSend.style.display = "flex";
    btnSend.classList.remove("active");
  }

  const topbarConv = document.getElementById("topbar-conv-title");
  if (topbarConv) topbarConv.innerText = "New Conversation";

  const mainContainer = document.getElementById("main-container");
  if (mainContainer) mainContainer.classList.remove("has-history");

  const input = document.getElementById("prompt-input");
  if (input) {
    input.value = "";
    input.style.height = "auto";
    setTimeout(() => input.focus(), 50);
  }

  renderProjectTree();
  showToast("Started new conversation session");
}

function handleInput(el) {
  const btn = document.getElementById("btn-send");
  if (el.value.trim().length > 0) {
    btn.classList.add("active");
  } else {
    btn.classList.remove("active");
  }

  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

function handleKeyDown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
}

async function submitPrompt() {
  const textarea = document.getElementById("prompt-input");
  const prompt = textarea.value.trim();
  if (!prompt) return;

  setChatMode(true);

  textarea.value = "";
  textarea.style.height = "auto";
  const btnSend = document.getElementById("btn-send");
  const btnStop = document.getElementById("btn-stop-execution");
  if (btnSend) {
    btnSend.classList.remove("active");
    btnSend.style.display = "none";
  }
  if (btnStop) btnStop.style.display = "flex";

  document.getElementById("main-container").classList.add("has-history");

  const promptCard = document.getElementById("active-user-prompt-card");
  if (promptCard) {
    promptCard.innerText = "";
    promptCard.style.display = "none";
  }

  // Only tasks reported by the agent as actively running background tasks should appear.
  activeRunningTasks = [];
  renderRunningTasks();

  const summaryBanner = document.getElementById("activity-summary-banner");
  if (summaryBanner) {
    summaryBanner.style.display = "none";
  }

  // 1. Create immediate optimistic turn in running state with initial progress steps
  const turnId = "turn-" + Date.now();
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const selectedModel = activeAiModel || "gemini-3.8-flash";
  const optimisticTurn = {
    id: turnId,
    prompt: prompt,
    timestamp: timeStr,
    steps: [
      { id: "step-init", name: "Agent Initialized", duration: "<1s", detail: "Workspace context and rules loaded.", type: "thought" },
      { id: "step-exec", name: "Querying AI Model", duration: "Active", detail: "Direct query in progress with " + selectedModel + "...", type: "cmd" }
    ],
    output: "",
    status: "running",
    duration: "0s"
  };

  const firstLine = prompt.split("\n")[0].substring(0, 36);
  if (!activeConversationId) {
    activeConversationId = "conv-" + Date.now();
    localStorage.setItem("orborus_active_conv_id", activeConversationId);
    const newConv = {
      id: activeConversationId,
      projectId: activeProjectPath,
      project_id: activeProjectPath,
      projectName: document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : (activeProjectPath.split("/").pop() || "Local Workspace"),
      project_name: document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : (activeProjectPath.split("/").pop() || "Local Workspace"),
      title: firstLine,
      pinned: false,
      turns: [optimisticTurn]
    };
    if (!Array.isArray(appConversations)) appConversations = [];
    appConversations.unshift(newConv);
    const topbarConv = document.getElementById("topbar-conv-title");
    if (topbarConv) topbarConv.innerText = firstLine;
  } else {
    if (!Array.isArray(appConversations)) appConversations = [];
    let curConv = appConversations.find(c => c.id === activeConversationId);
    if (!curConv) {
      curConv = {
        id: activeConversationId,
        projectId: activeProjectPath,
        project_id: activeProjectPath,
        projectName: document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : (activeProjectPath.split("/").pop() || "Local Workspace"),
        project_name: document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : (activeProjectPath.split("/").pop() || "Local Workspace"),
        title: firstLine,
        pinned: false,
        turns: []
      };
      appConversations.unshift(curConv);
    }
    if (!curConv.turns) curConv.turns = [];
    curConv.turns.push(optimisticTurn);
    curConv.updated_at = new Date().toISOString();
  }

  // Paint optimistic state immediately (0ms delay)
  renderProjectTree();
  renderActiveConversation();
  saveStoredConversations();

  const stream = document.getElementById("execution-stream");
  if (stream) {
    setTimeout(() => { stream.scrollTop = stream.scrollHeight; }, 30);
  }

  // Live duration timer
  const startTime = Date.now();
  const liveTimer = setInterval(() => {
    const elapsedSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    optimisticTurn.duration = `${elapsedSec}s`;
    const durEl = document.getElementById("live-dur-" + turnId);
    if (durEl) {
      durEl.innerText = `${elapsedSec}s`;
    }
  }, 1000);

  try {
    let raw;
    const effectiveKey = currentAiKey || localStorage.getItem("orborus_ai_key") || "";
    const effectiveUrl = currentAiUrl || localStorage.getItem("orborus_ai_url") || "";
    if (effectiveKey || effectiveUrl) {
      dismissAuthErrorsIfConfigured();
    }

    const promptPayload = JSON.stringify({
      prompt: prompt,
      bypass: false,
      conversation_id: activeConversationId || "",
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort || "medium",
      ai_api_key: effectiveKey,
      ai_api_url: effectiveUrl
    });

    console.log("[Shuffle Agent] Submitting prompt to backend:", {
      prompt: prompt,
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort || "medium",
      conversation_id: activeConversationId,
      has_key: Boolean(effectiveKey),
      has_url: Boolean(effectiveUrl)
    });

    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("runPrompt", promptPayload);
    } else if (typeof window.runPrompt === "function") {
      raw = await window.runPrompt(prompt, false, activeConversationId || "");
    } else {
      console.warn("[Shuffle Agent] Native bridge not found; running local fallback mock");
      await new Promise(r => setTimeout(r, 400));
      raw = JSON.stringify({
        prompt: prompt,
        output: "Completed local execution.",
        steps: [
          { id: "step-1", name: "Analyzed prompt", duration: "0.2s", detail: "Parsed input command.", type: "thought" },
          { id: "step-2", name: "Completed query", duration: "0.2s", detail: "Finished execution successfully.", type: "cmd" }
        ]
      });
    }

    console.log("[Shuffle Agent] Bridge response received:", raw);
    clearInterval(liveTimer);

    let res = null;
    if (typeof raw === "object" && raw !== null) {
      res = raw;
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      try {
        res = JSON.parse(raw);
      } catch (parseErr) {
        console.warn("Failed to parse bridge response as JSON:", raw, parseErr);
        res = {
          status: "error",
          error: raw || "Execution failed",
          error_type: "execution_error",
          fix_help: "Backend returned non-JSON output. Check application logs."
        };
      }
    } else {
      res = {
        status: "error",
        error: "Internal error: Backend returned an empty response",
        error_type: "execution_error",
        fix_help: "Check backend terminal logs for detailed traces."
      };
    }

    activeRunningTasks = [];
    renderRunningTasks();
    if (btnStop) btnStop.style.display = "none";
    if (btnSend) btnSend.style.display = "flex";

    const elapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    optimisticTurn.duration = res.duration || `${elapsed}s`;

    if (res.needs_approval) {
      optimisticTurn.status = "needs_approval";
      currentApprovalId = res.id;
      currentApprovalCmd = res.prompt;
      currentApprovalCmdPrefix = res.command_prefix || res.prompt.trim().split(/\s+/).slice(0, 2).join(" ");
      currentApprovalDesc = res.description || "Confirm the command is safe to run outside of the sandbox with full network and disk access.";
      currentApprovalProject = res.project || activeProjectPath;

      showApprovalCard({
        id: res.id,
        cmd: res.prompt,
        prefix: currentApprovalCmdPrefix,
        desc: currentApprovalDesc,
        project: currentApprovalProject
      });
      renderActiveConversation();
      await saveStoredConversations();
      return;
    }

    if (res.needs_login) {
      optimisticTurn.status = "error";
      optimisticTurn.error = res.error || "Authentication required. Please log in.";
      optimisticTurn.error_type = "auth_error";
      loginWithOAuth();
      renderActiveConversation();
      await saveStoredConversations();
      return;
    }

    if (res.needs_ai_config) {
      optimisticTurn.status = "error";
      optimisticTurn.error = res.error || res.output || "No LLM apikey supplied AND no organization-specific key found. Please create a custom AI app authentication.";
      optimisticTurn.error_type = "missing_credentials";
      optimisticTurn.debug_info = res.debug_info || res;
      renderActiveConversation();
      await saveStoredConversations();
      return;
    }

    const isError = res.status === "error" || (res.output && res.output.startsWith("Error:")) || !!res.error;
    optimisticTurn.status = isError ? "error" : "success";
    optimisticTurn.output = res.output || res.error || "";
    optimisticTurn.error = res.error || (isError ? res.output : "");
    optimisticTurn.error_type = res.error_type || "";
    optimisticTurn.fix_help = res.fix_help || "";
    if (res.steps && Array.isArray(res.steps) && res.steps.length > 0) {
      optimisticTurn.steps = res.steps;
    } else {
      optimisticTurn.steps = [
        { id: "step-init", name: "Agent Initialized", duration: "<1s", detail: "Workspace context and rules loaded.", type: "thought" },
        { id: "step-exec", name: isError ? "Query Failed" : "Query Completed", duration: optimisticTurn.duration, detail: isError ? (res.error || "Execution failed") : ("Finished direct query with " + (res.debug_info?.model || selectedModel)), type: "cmd" }
      ];
    }

    const rawDecisions = res.decisions || (res.workflow_execution && res.workflow_execution.decisions) || [];
    activeRunningTasks = extractRunningTasksFromDecisions(rawDecisions);
    renderRunningTasks();

    const summaryBanner = document.getElementById("activity-summary-banner");
    const summaryText = document.getElementById("activity-summary-text");
    if (summaryBanner && summaryText) {
      if (activeRunningTasks.length > 0) {
        summaryBanner.style.display = "flex";
        summaryText.innerText = `Running task: ${activeRunningTasks[0].name}`;
      } else {
        summaryBanner.style.display = "none";
      }
    }

    // If backend returned updated full conversation, adopt it
    if (res.conversation && Array.isArray(res.conversation.turns) && res.conversation.turns.length > 0) {
      const curConv = appConversations.find(c => c.id === activeConversationId);
      if (curConv) {
        curConv.turns = res.conversation.turns;
        if (res.conversation.title) curConv.title = res.conversation.title;
      }
    }

    renderProjectTree();
    await saveStoredConversations();
    renderActiveConversation();

    addExecutionHistory({
      prompt: optimisticTurn.prompt,
      output: optimisticTurn.output,
      timestamp: optimisticTurn.timestamp,
      duration: optimisticTurn.duration,
      status: optimisticTurn.status
    });
  } catch (err) {
    clearInterval(liveTimer);
    activeRunningTasks = [];
    renderRunningTasks();
    if (btnStop) btnStop.style.display = "none";
    if (btnSend) btnSend.style.display = "flex";

    const elapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    optimisticTurn.status = "error";
    optimisticTurn.duration = `${elapsed}s`;
    optimisticTurn.error = err.message || err.toString();
    optimisticTurn.output = err.message || err.toString();
    optimisticTurn.error_type = "execution_error";

    renderProjectTree();
    await saveStoredConversations();
    renderActiveConversation();
  }
}

function toggleResultCard(pillEl) {
  pillEl.classList.toggle("collapsed");
  const wrapper = pillEl.parentElement;
  if (!wrapper) return;
  const card = wrapper.querySelector(".exec-card");
  if (card) {
    card.classList.toggle("collapsed");
  }
}

async function copyCardOutput(btnEl) {
  const card = btnEl.closest(".exec-card");
  if (!card) return;
  const body = card.querySelector(".exec-body");
  if (!body) return;
  try {
    await navigator.clipboard.writeText(body.innerText);
    showToast("Copied output to clipboard");
  } catch (err) {
    console.error("Copy failed:", err);
  }
}

function retryPrompt(promptText) {
  if (!promptText) return;
  const textarea = document.getElementById("prompt-input");
  if (textarea) {
    textarea.value = promptText;
    handleInput(textarea);
    textarea.focus();
  }
  submitPrompt();
}

function retryCardPrompt(btnEl) {
  const card = btnEl.closest(".exec-card") || btnEl.closest(".transcript-turn");
  let promptText = "";
  if (card) {
    const promptEl = card.querySelector(".exec-prompt");
    if (promptEl) {
      promptText = promptEl.innerText.replace(/^\$\s*/, "").trim();
    }
  }
  if (!promptText && activeConversationId) {
    const conv = appConversations.find(c => c.id === activeConversationId);
    if (conv && conv.turns && conv.turns.length > 0) {
      promptText = conv.turns[conv.turns.length - 1].prompt;
    }
  }
  if (promptText) {
    retryPrompt(promptText);
  }
}

function buildErrorArea(isError, errText, info, prompt, rawOutput) {
  if (!isError) {
    return `<div style="white-space:pre-wrap; word-break:break-word;">${escapeHtml(rawOutput || "Completed with no output.")}</div>`;
  }

  const isAiConfigError = (info && info.needs_ai_config) ||
    (info && (info.error_type === "missing_credentials" || info.error_type === "missing_ai_config")) ||
    errText.includes("no llm apikey") ||
    errText.includes("apikey") ||
    errText.includes("no organization-specific key") ||
    errText.includes("custom ai app authentication") ||
    errText.includes("ai provider not configured") ||
    errText.includes("ai configuration");

  const isRateLimitError = (info && info.error_type === "rate_limited") ||
    errText.includes("rate limit") ||
    errText.includes("quota") ||
    errText.includes("429") ||
    errText.includes("resource_exhausted") ||
    errText.includes("too many requests");

  const isNetworkError = (info && info.error_type === "network_unreachable") ||
    errText.includes("connection refused") ||
    errText.includes("dial tcp") ||
    errText.includes("no such host");

  const displayMessage = rawOutput || (info && info.error) || errText || "An error occurred during execution.";

  let actionsHtml = "";
  if (isAiConfigError) {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="openSettingsModal('models', 'key')">Authenticate</button>
    `;
  } else if (isRateLimitError) {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="retryCardPrompt(this)">Retry</button>
      <button type="button" class="btn-error-secondary" onclick="openSettingsModal('models', 'model')">Switch Model</button>
    `;
  } else if (isNetworkError) {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="retryCardPrompt(this)">Retry</button>
      <button type="button" class="btn-error-secondary" onclick="openSettingsModal('models', 'url')">Settings</button>
    `;
  } else {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="retryCardPrompt(this)">Retry</button>
    `;
  }

  return `
    <div class="compact-error-area">
      <div class="compact-error-message">${escapeHtml(displayMessage)}</div>
      <div class="compact-error-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
}

function renderTurnElement(turn, index) {
  const turnEl = document.createElement("div");
  turnEl.className = "transcript-turn";
  turnEl.id = "transcript-turn-" + (turn.id || index);
  turnEl.style.display = "flex";
  turnEl.style.flexDirection = "column";
  turnEl.style.gap = "8px";

  // 1. Current Prompt Card at the TOP matching screenshot!
  if (turn.prompt) {
    const promptCard = document.createElement("div");
    promptCard.className = "user-prompt-card";
    promptCard.innerText = turn.prompt;
    turnEl.appendChild(promptCard);
  }

  // 2. Middle: Dynamic Agent Progress breakdown (summary header + step rows)
  if (turn.steps && Array.isArray(turn.steps) && turn.steps.length > 0) {
    const summaryText = computeStepsSummary(turn.steps);
    const summaryBanner = document.createElement("div");
    summaryBanner.className = "activity-summary-banner";
    summaryBanner.id = "summary-banner-" + (turn.id || index);
    summaryBanner.onclick = () => toggleTurnSteps(turn.id || index);
    summaryBanner.innerHTML = `
      <span>${escapeHtml(summaryText)}</span>
      <div class="activity-summary-chevron">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
    `;
    turnEl.appendChild(summaryBanner);

    const stepsDiv = document.createElement("div");
    stepsDiv.className = "activity-steps-container";
    stepsDiv.id = "turn-steps-" + (turn.id || index);

    turn.steps.forEach(step => {
      if (step.type === "approval_pending") return;
      const stepRow = document.createElement("div");
      stepRow.className = "activity-step-row" + (step.collapsed ? "" : " expanded");
      stepRow.id = "step-row-" + (step.id || Math.random().toString(36).substr(2, 6));

      const titleHtml = formatStepTitleHtml(step);
      const hasDetail = !!(step.output || step.detail);

      stepRow.innerHTML = `
        <div class="activity-step-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="activity-step-left">
            <span class="activity-step-title">${titleHtml}</span>
          </div>
          <div class="activity-step-chevron">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </div>
        ${hasDetail ? `<div class="activity-step-content">${escapeHtml(step.output || step.detail || "")}</div>` : ""}
      `;
      stepsDiv.appendChild(stepRow);
    });
    turnEl.appendChild(stepsDiv);
  }

  // 3. Execution Result Card (if any output or error, or running state)
  if (turn.status === "running") {
    const runningCard = document.createElement("div");
    runningCard.className = "exec-card";
    runningCard.style.borderColor = "var(--border-subtle)";
    runningCard.style.background = "rgba(255,255,255,0.02)";
    const currentModelName = (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || "gemini-3.8-flash";
    runningCard.innerHTML = `
      <div class="exec-header" style="border-bottom:none;">
        <div style="display:flex; align-items:center; gap:8px;">
          <svg class="running-task-spinner" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f85f38" stroke-width="2.5">
            <circle cx="12" cy="12" r="9" stroke-dasharray="28 28"/>
          </svg>
          <span style="font-size:12px; color:var(--text-normal);">Processing prompt with ${escapeHtml(currentModelName)}...</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span id="live-dur-${turn.id}" style="font-size:11px; padding:2px 7px; border-radius:4px; font-weight:600; font-family:ui-monospace,monospace; background:rgba(248,95,56,0.12); color:#f85f38;">${escapeHtml(turn.duration || "0s")}</span>
        </div>
      </div>
    `;
    turnEl.appendChild(runningCard);
  } else if (turn.output || turn.error || (turn.status && turn.status !== "running")) {
    const isError = turn.status === "error" || (turn.output && turn.output.startsWith("Error:")) || !!turn.error;
    const errText = (turn.error || turn.output || "").toLowerCase();
    const info = turn.debug_info || {};

    const card = document.createElement("div");
    card.className = isError ? "exec-card exec-card-error" : "exec-card";

    let debugBar = "";
    if (window.isDebug && turn.debug_info) {
      const currentModelName = (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || "gemini-3.8-flash";
      debugBar = `
        <div style="padding:4px 10px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-subtle); font-size:11px; color:var(--text-muted); font-family:ui-monospace,Menlo,Monaco,monospace; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <span style="color:${isError ? '#f87171' : '#f85f38'}; font-weight:600;">${isError ? 'ERROR' : 'DEBUG'}</span>
          <span>Target: ${escapeHtml(info.target || "local")}</span>
          <span>Model: ${escapeHtml(info.model || currentModelName)}</span>
          ${info.reasoning ? `<span>Reasoning: ${escapeHtml(info.reasoning)}</span>` : ""}
          <span>Engine: ${escapeHtml(info.engine || info.mode || "shuffle.HandleAiAgentExecutionStart")}</span>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="exec-header">
        <div style="display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden;">
          <span class="exec-prompt" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">$ ${escapeHtml(turn.prompt)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
          <span style="font-size:11px; padding:2px 7px; border-radius:4px; font-weight:600; font-family:ui-monospace,monospace; ${isError ? 'background:rgba(239,68,68,0.15); color:#f87171;' : 'background:rgba(34,197,94,0.15); color:#4ade80;'}">${isError ? 'Failed' : 'Worked'} (${escapeHtml(turn.duration || "0s")})</span>
          <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(turn.timestamp || "")}</span>
          <button class="nav-icon-btn" title="Copy Output" onclick="copyCardOutput(this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>
      ${debugBar}
      <div class="exec-body">
        ${buildErrorArea(isError, errText, info, turn.prompt, turn.output || turn.error)}
      </div>
    `;

    turnEl.appendChild(card);
  }

  return turnEl;
}

function renderExecutionResult(item, elapsedSec) {
  const container = document.getElementById("execution-cards-container");
  if (!container) return;

  const isError = item.status === "error" || (item.output && item.output.startsWith("Error:")) || !!item.error;
  const errText = (item.error || item.output || "").toLowerCase();
  const info = item.debug_info || {};

  const isAiConfigError = item.needs_ai_config || 
    (item.error_type === "missing_credentials") ||
    (item.error_type === "missing_ai_config") || 
    errText.includes("no llm apikey") || 
    errText.includes("apikey") || 
    errText.includes("no organization-specific key") || 
    errText.includes("custom ai app authentication") || 
    errText.includes("ai provider not configured") || 
    errText.includes("ai configuration");

  const isNetworkError = (item.error_type === "network_unreachable") ||
    errText.includes("connection refused") ||
    errText.includes("dial tcp") ||
    errText.includes("no such host");

  const isRateLimitError = (item.error_type === "rate_limited") ||
    errText.includes("rate limit") ||
    errText.includes("quota") ||
    errText.includes("429");

  const isCommandNotFound = (item.error_type === "command_not_found") ||
    (item.output && item.output.includes("command not found")) || 
    (item.error && item.error.includes("command not found"));

  const entry = {
    prompt: item.prompt,
    output: item.output || item.error || "Completed with no output.",
    timestamp: item.timestamp || new Date().toLocaleTimeString(),
    duration: item.duration || `${elapsedSec}s`,
    status: isError ? "error" : "success"
  };
  addExecutionHistory(entry);

  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.gap = "8px";

  const status = document.createElement("div");
  status.className = isError ? "status-pill status-pill-error" : "status-pill";
  status.title = "Click to toggle output";
  status.onclick = () => toggleResultCard(status);
  const statusLabel = isError 
    ? `Failed in ${elapsedSec}s (${item.duration || "0ms"})`
    : `Worked for ${elapsedSec}s (${item.duration || "0ms"})`;
  status.innerHTML = `
    <span>${escapeHtml(statusLabel)}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  `;


  let debugBar = "";
  if (window.isDebug && item.debug_info) {
    const currentModelName = (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || "gemini-3.8-flash";
    debugBar = `
      <div style="padding:4px 10px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-subtle); font-size:11px; color:var(--text-muted); font-family:ui-monospace,Menlo,Monaco,monospace; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <span style="color:${isError ? '#f87171' : '#f85f38'}; font-weight:600;">${isError ? 'ERROR' : 'DEBUG'}</span>
        <span>Target: ${escapeHtml(info.target || "local")}</span>
        <span>Model: ${escapeHtml(info.model || currentModelName)}</span>
        ${info.reasoning ? `<span>Reasoning: ${escapeHtml(info.reasoning)}</span>` : ""}
        <span>Engine: ${escapeHtml(info.engine || info.mode || "shuffle.HandleAiAgentExecutionStart")}</span>
      </div>
    `;
  }

  const card = document.createElement("div");
  card.className = isError ? "exec-card exec-card-error" : "exec-card";
  card.innerHTML = `
    <div class="exec-header">
      <div style="display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden;">
        <span class="exec-prompt" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">$ ${escapeHtml(item.prompt)}</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <span style="font-size:11px; padding:2px 7px; border-radius:4px; font-weight:600; font-family:ui-monospace,monospace; ${isError ? 'background:rgba(239,68,68,0.15); color:#f87171;' : 'background:rgba(34,197,94,0.15); color:#4ade80;'}">${isError ? 'Failed' : 'Worked'} (${escapeHtml(item.duration || (elapsedSec ? elapsedSec + "s" : "0s"))})</span>
        <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(item.timestamp || "")}</span>
        <button class="nav-icon-btn" title="Copy Output" onclick="copyCardOutput(this)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>
    </div>
    ${debugBar}
    <div class="exec-body">
      ${buildErrorArea(isError, errText, info, item.prompt, item.output || item.error)}
    </div>
  `;

  container.prepend(card);
}

function renderErrorResult(prompt, err, meta) {
  const container = document.getElementById("execution-cards-container");
  if (!container) return;

  if (window.isDebug) {
    console.error("[DEBUG] Prompt error:", { prompt, err, meta });
  }

  const errText = (err || "").toLowerCase();
  const entry = {
    prompt: prompt,
    error: err,
    timestamp: new Date().toLocaleTimeString(),
    status: "error"
  };
  addExecutionHistory(entry);

  const info = meta || {};

  const card = document.createElement("div");
  card.className = "exec-card exec-card-error";
  card.innerHTML = `
    <div class="exec-header">
      <div style="display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden;">
        <span class="exec-prompt" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">$ ${escapeHtml(prompt)}</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <span style="font-size:11px; padding:2px 7px; border-radius:4px; font-weight:600; font-family:ui-monospace,monospace; background:rgba(239,68,68,0.15); color:#f87171;">Failed (0s)</span>
        <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(entry.timestamp)}</span>
      </div>
    </div>
    <div class="exec-body">
      ${buildErrorArea(true, errText, info, prompt, err)}
    </div>
  `;

  container.prepend(card);
}

function renderActiveConversation() {
  const turnsContainer = document.getElementById("conversation-turns-container");
  const promptCard = document.getElementById("active-user-prompt-card");
  const stepsContainer = document.getElementById("activity-steps-container");
  const approvalCard = document.getElementById("approval-card");
  const topbarConv = document.getElementById("topbar-conv-title");
  const topbarProj = document.getElementById("topbar-project-name");
  const mainContainer = document.getElementById("main-container");

  if (!activeConversationId) {
    setChatMode(false);
    if (turnsContainer) turnsContainer.innerHTML = "";
    if (promptCard) {
      promptCard.innerText = "";
      promptCard.style.display = "none";
    }
    const summaryBanner = document.getElementById("activity-summary-banner");
    if (summaryBanner) summaryBanner.style.display = "none";
    if (stepsContainer) stepsContainer.innerHTML = "";
    if (approvalCard) approvalCard.classList.remove("visible");
    if (topbarConv) topbarConv.innerText = "New Conversation";
    if (mainContainer) mainContainer.classList.remove("has-history");
    return;
  }

  const conv = appConversations.find(c => c.id === activeConversationId);
  if (!conv) return;

  setChatMode(true);
  if (mainContainer) mainContainer.classList.add("has-history");
  if (topbarProj) topbarProj.innerText = conv.projectName || conv.project_name || "Orborus Agent Runner";
  if (topbarConv) topbarConv.innerText = conv.title || "Conversation";

  // Normalize legacy conversation structure to turns if needed
  if ((!conv.turns || conv.turns.length === 0) && conv.prompt) {
    conv.turns = [{
      id: conv.id + "-1",
      prompt: conv.prompt,
      timestamp: conv.created_at || "",
      steps: conv.steps || [],
      output: conv.output || "",
      status: "success"
    }];
  }

  // Render all conversation turns sequentially in the stream
  if (turnsContainer) {
    turnsContainer.innerHTML = "";
    (conv.turns || []).forEach((turn, idx) => {
      const turnEl = renderTurnElement(turn, idx);
      turnsContainer.appendChild(turnEl);
    });
  }

  // Clean in-flight active turn elements if not executing
  if (promptCard && (!stepsContainer || stepsContainer.children.length === 0)) {
    promptCard.style.display = "none";
    promptCard.innerText = "";
  }
  const summaryBanner = document.getElementById("activity-summary-banner");
  if (summaryBanner && (!stepsContainer || stepsContainer.children.length === 0)) {
    summaryBanner.style.display = "none";
  }

  // Extract running tasks strictly from decisions of in-flight turns
  let runningTasksFound = [];
  (conv.turns || []).forEach(turn => {
    if (turn.status === "running") {
      const turnDecisions = turn.decisions || (turn.workflow_execution && turn.workflow_execution.decisions) || [];
      const extracted = extractRunningTasksFromDecisions(turnDecisions);
      if (extracted.length > 0) {
        runningTasksFound.push(...extracted);
      }
    }
  });
  activeRunningTasks = runningTasksFound;
  renderRunningTasks();

  // Check if any step in any turn has a pending approval
  let hasPendingApproval = false;
  (conv.turns || []).forEach(turn => {
    (turn.steps || []).forEach(step => {
      if (step.type === "approval_pending") {
        hasPendingApproval = true;
        currentApprovalId = step.id;
        currentApprovalCmd = step.cmd || "~/git/orborus $ git show 1981257 --stat";
        currentApprovalCmdPrefix = step.cmdPrefix || "git show";
        currentApprovalDesc = step.desc || "Allow viewing commit 1981257?";
        currentApprovalProject = conv.projectName || conv.project_name;

        showApprovalCard({
          id: step.id,
          cmd: currentApprovalCmd,
          prefix: currentApprovalCmdPrefix,
          desc: currentApprovalDesc,
          project: currentApprovalProject
        });
      }
    });
  });

  if (!hasPendingApproval && approvalCard) {
    approvalCard.classList.remove("visible");
  }

  // Scroll to bottom of conversation stream
  const stream = document.getElementById("execution-stream");
  if (stream) {
    setTimeout(() => {
      stream.scrollTop = stream.scrollHeight;
    }, 40);
  }
}

function toggleStep(stepId) {
  const row = document.getElementById("step-row-" + stepId);
  if (!row) return;
  row.classList.toggle("expanded");
  const isExpanded = row.classList.contains("expanded");
  const conv = appConversations.find(c => c.id === activeConversationId);
  if (!conv) return;
  if (conv.steps) {
    const s = conv.steps.find(st => st.id === stepId);
    if (s) s.collapsed = !isExpanded;
  }
  if (conv.turns) {
    conv.turns.forEach(t => {
      if (t.steps) {
        const s = t.steps.find(st => st.id === stepId);
        if (s) s.collapsed = !isExpanded;
      }
    });
  }
}
