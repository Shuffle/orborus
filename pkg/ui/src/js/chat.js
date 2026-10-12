// --- Real-time Streamed Chunk Handler & Activity Steps Formatting ---
window.onAgentChunk = function(execId, chunk) {
  if (!chunk) return;
  if (!Array.isArray(appConversations)) return;
  const curConv = appConversations.find(c => c.id === activeConversationId);
  if (!curConv || !Array.isArray(curConv.turns) || curConv.turns.length === 0) return;
  const targetTurn = curConv.turns[curConv.turns.length - 1];
  if (targetTurn && targetTurn.status === "running") {
    targetTurn.output = (targetTurn.output || "") + chunk;
    if (targetTurn.steps && targetTurn.steps.length > 1) {
      targetTurn.steps[1].name = "Streaming Response";
      targetTurn.steps[1].detail = `Received ${targetTurn.output.length} characters...`;
    }
    renderActiveConversation();
    const stream = document.getElementById("execution-stream");
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }
};

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

function resolveModelDisplayName(rawModelKey) {
  const curModel = (rawModelKey || (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || localStorage.getItem("orborus_ai_model") || "").trim();
  const savedCustomModel = (localStorage.getItem("orborus_custom_model") || "").trim();

  // 1. If tendon / local GPU engine: just show the model name directly
  if (curModel === "tendon-local" || curModel.startsWith("tendon") || curModel.startsWith("local") || curModel.includes("gemma")) {
    if (window.localModelPath) {
      return window.localModelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, "");
    }
    return "Gemma-4-26B";
  }

  // 2. Predefined models (Gemini, Claude, GPT, etc.)
  if (curModel && curModel !== "custom") {
    const predefined = AVAILABLE_AI_MODELS.find(m => m.key === curModel && m.key !== "custom");
    if (predefined) {
      return predefined.label;
    }
  }

  // 3. Custom model - just show the model name directly
  const customName = (curModel && curModel !== "custom") ? curModel : savedCustomModel;
  if (customName) {
    return customName;
  }

  // If no custom name was configured, default to Local model if available
  const isLocalAvail = (window.localExecutorAvailable !== false);
  if (isLocalAvail) {
    if (window.localModelPath) {
      return window.localModelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, "");
    }
    return "Gemma-4-26B";
  }

  return "Gemini 3.8 Flash";
}

function updateActiveModelLabel() {
  const nameEl = document.getElementById("lbl-active-model-name");
  const pickerBtn = document.getElementById("btn-model-picker");
  const curModel = activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash";
  const display = resolveModelDisplayName(curModel);
  const queueCount = (promptMessageQueue && promptMessageQueue.length > 0) ? `<span class="queue-pill-counter">${promptMessageQueue.length} queued</span>` : "";
  const safeText = (typeof escapeHtml === "function") ? escapeHtml(display) : display;

  const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(curModel) : { configured: true };

  if (nameEl) {
    if (!status.configured) {
      const warningBadge = `<span class="pill-warning-badge">${escapeHtml(status.badge || "Unconfigured")}</span>`;
      nameEl.innerHTML = `<span>${safeText}</span>${warningBadge}${queueCount}`;
      nameEl.title = `Active Model: ${display} (${status.reason || "Not configured"})`;
    } else {
      nameEl.innerHTML = `<span>${safeText}</span>${queueCount}`;
      nameEl.title = `Active Model: ${display}`;
    }
  }

  if (pickerBtn) {
    pickerBtn.classList.toggle("unconfigured", !status.configured);
  }

  // Update in-card non-intrusive reminder
  updateModelConfigReminder(curModel, display, status);
}

function updateModelConfigReminder(modelKey, display, status) {
  const reminderEl = document.getElementById("model-config-reminder");
  const textEl = document.getElementById("model-config-reminder-text");
  const actionBtn = document.getElementById("btn-model-reminder-action");
  const localBtn = document.getElementById("btn-model-reminder-local");

  if (!reminderEl) return;

  if (!status || status.configured) {
    reminderEl.style.display = "none";
    return;
  }

  reminderEl.style.display = "flex";
  if (textEl) {
    textEl.innerText = `${display} is not configured: ${status.reason}. Prompts will fail until set up.`;
  }

  if (actionBtn) {
    actionBtn.innerText = status.actionText || "Configure";
    actionBtn.setAttribute("data-action-type", status.actionType || "byok");
  }

  if (localBtn) {
    const hasLocal = (typeof window !== "undefined" && window.localExecutorAvailable !== false);
    const isAlreadyLocal = modelKey === "tendon-local" || modelKey.startsWith("tendon") || modelKey.startsWith("local");
    if (hasLocal && !isAlreadyLocal) {
      localBtn.style.display = "inline-flex";
    } else {
      localBtn.style.display = "none";
    }
  }
}

function handleReminderAction() {
  const actionBtn = document.getElementById("btn-model-reminder-action");
  const actionType = actionBtn ? actionBtn.getAttribute("data-action-type") : "byok";
  if (actionType === "auth") {
    openSettingsModal("mode-shuffle");
  } else if (actionType === "hardware") {
    openSettingsModal("mode-local");
  } else {
    openSettingsModal("mode-direct", "key");
  }
}

function handleReminderUseLocal() {
  selectAiModel("tendon-local", "Gemma-4-26B");
}

function updateActiveReasoningLabel() {
  const lbl = document.getElementById("lbl-active-reasoning");
  if (!lbl) return;
  const current = activeReasoningEffort || localStorage.getItem("orborus_ai_reasoning") || "low";
  let display = "Low";
  if (current === "high") display = "High";
  else if (current === "medium") display = "Medium";
  else if (current === "minimal" || current === "off") display = "Off";
  else display = "Low";
  lbl.textContent = `Reasoning: ${display}`;
}

function positionDropdownUpOrDown(btn, menu) {
  if (!btn || !menu) return;
  const isChat = document.querySelector(".chat-mode") || document.querySelector(".center-container.chat-mode") || document.querySelector(".main-workspace.chat-mode");
  const rect = btn.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  // When text field is at the bottom of the screen (chat-mode) or space below is less than 350px, grow upwards
  if (isChat || spaceBelow < 350) {
    menu.classList.add("grow-up");
    menu.classList.remove("grow-down");
  } else {
    menu.classList.add("grow-down");
    menu.classList.remove("grow-up");
  }
}

function renderModelDropdown() {
  const menu = document.getElementById("model-dropdown-menu");
  if (!menu) return;
  menu.innerHTML = "";

  const curModel = activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash";
  const savedCustomModel = ((typeof localStorage !== "undefined" && localStorage.getItem("orborus_custom_model")) || "").trim();
  const isPredefined = AVAILABLE_AI_MODELS.some(m => m.key === curModel && m.key !== "custom");
  const activeCustomName = (!isPredefined && curModel !== "custom") ? curModel : savedCustomModel;

  // Organize cleanly into: Shuffle AI, BYOK Models, Local Models (per AGENTS.md Rule 2)
  const categories = {
    "Shuffle AI": [],
    "BYOK Models": [],
    "Local Models": []
  };

  AVAILABLE_AI_MODELS.forEach(m => {
    if (m.key === "custom") return; // Rendered dynamically below
    if (m.category === "Shuffle AI" || m.category === "Shuffle Cloud AI") {
      categories["Shuffle AI"].push(m);
    } else if (m.category === "Local Models" || m.category === "Local GPU Engine") {
      const copy = Object.assign({}, m);
      copy.label = resolveModelDisplayName("tendon-local");
      categories["Local Models"].push(copy);
    } else {
      categories["BYOK Models"].push(m);
    }
  });

  // If a custom model is configured or active, add it under BYOK Models if not already present
  if (activeCustomName && !categories["BYOK Models"].some(m => m.key.toLowerCase() === activeCustomName.toLowerCase())) {
    const isCustomSelected = (curModel === activeCustomName || curModel === "custom" || !isPredefined);
    categories["BYOK Models"].push({
      key: activeCustomName,
      label: activeCustomName,
      desc: currentAiUrl || "Custom Endpoint",
      category: "BYOK Models",
      provider: "custom",
      isSelected: isCustomSelected,
      isConfiguredCustom: true
    });
  }

  // Always provide the action to configure / add custom model
  categories["BYOK Models"].push({
    key: "custom",
    label: "+ Add / Type BYOK Model...",
    desc: "Type any model ID or set custom endpoint",
    category: "BYOK Models",
    provider: "custom",
    isSelected: !activeCustomName && (curModel === "custom" || !isPredefined),
    isConfigAction: true
  });

  const displayGroups = [];
  if (categories["Shuffle AI"].length > 0) {
    displayGroups.push({ title: "Shuffle AI", models: categories["Shuffle AI"] });
  }
  if (categories["BYOK Models"].length > 0) {
    displayGroups.push({ title: "BYOK Models", models: categories["BYOK Models"] });
  }
  if (categories["Local Models"].length > 0) {
    displayGroups.push({ title: "Local Models", models: categories["Local Models"] });
  }

  displayGroups.forEach(group => {
    const catHeader = document.createElement("div");
    catHeader.className = "model-category-header";

    // Category status summary pill in header
    let headerBadgeHtml = "";
    if (group.title === "Shuffle AI") {
      const shuffleStatus = (typeof getModelConfigStatus === "function") ? getModelConfigStatus("gemini-3.8-flash") : { configured: false };
      if (!shuffleStatus.configured) {
        headerBadgeHtml = `<span class="cat-status-badge unconfigured">Login needed</span>`;
      } else {
        headerBadgeHtml = `<span class="cat-status-badge ready">Connected</span>`;
      }
    } else if (group.title === "BYOK Models") {
      const anyByokConfigured = group.models.some(m => !m.isConfigAction && typeof getModelConfigStatus === "function" && getModelConfigStatus(m.key).configured);
      if (!anyByokConfigured) {
        headerBadgeHtml = `<span class="cat-status-badge unconfigured">API key needed</span>`;
      }
    } else if (group.title === "Local Models") {
      const localStatus = (typeof getModelConfigStatus === "function") ? getModelConfigStatus("tendon-local") : { configured: true };
      if (localStatus.configured) {
        headerBadgeHtml = `<span class="cat-status-badge ready">Ready</span>`;
      } else {
        headerBadgeHtml = `<span class="cat-status-badge unconfigured">Unavailable</span>`;
      }
    }

    catHeader.innerHTML = `<span>${escapeHtml(group.title)}</span>${headerBadgeHtml}`;
    menu.appendChild(catHeader);

    group.models.forEach(m => {
      const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(m.key) : { configured: true, badge: "Ready" };
      const isSelected = (typeof m.isSelected === "boolean") ? m.isSelected : (m.key === curModel);
      const item = document.createElement("div");
      const unconfClass = (m.isConfigAction || status.configured) ? " available" : " unconfigured";
      item.className = "model-option-item compact" + (isSelected ? " selected" : "") + unconfClass;

      if (!status.configured && !m.isConfigAction) {
        item.title = `${status.reason} (prompts will fail until configured)`;
      }

      if (m.isConfigAction) {
        item.onclick = (e) => {
          e.stopPropagation();
          openSettingsModal("mode-direct", "model");
          menu.classList.remove("visible");
        };
      } else {
        item.onclick = (e) => {
          e.stopPropagation();
          selectAiModel(m.key, m.label);
        };
      }

      let metaHtml = "";
      if (m.isConfigAction) {
        metaHtml = `<span class="model-badge">Settings</span>`;
      } else if (!status.configured) {
        metaHtml = `<span class="model-badge unconfigured" title="${escapeHtml(status.reason)}">${escapeHtml(status.badge)}</span>`;
      } else if (m.isConfiguredCustom) {
        metaHtml = `<span class="model-badge ready">Custom</span>`;
      } else if (group.title === "Local Models") {
        metaHtml = `<span class="model-badge ready">Local</span>`;
      } else if (group.title === "Shuffle AI") {
        metaHtml = `<span class="model-badge ready">Shuffle</span>`;
      } else {
        metaHtml = `<span class="model-badge ready">${escapeHtml(status.badge)}</span>`;
      }

      const safeLabel = (typeof escapeHtml === "function") ? escapeHtml(m.label) : m.label;
      const subnoteHtml = (!status.configured && !m.isConfigAction && status.reason)
        ? `<span class="model-option-subnote">${escapeHtml(status.reason)}</span>`
        : "";

      item.innerHTML = `
        <div class="model-option-title">
          <div class="model-option-label-group">
            <span class="model-option-label">${safeLabel}</span>
            ${subnoteHtml}
          </div>
          <div class="model-option-meta">
            ${metaHtml}
            ${isSelected ? `<svg class="active-check-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : `<span style="width:13px; display:inline-block;"></span>`}
          </div>
        </div>
      `;
      menu.appendChild(item);
    });
  });

  const hasShuffleAuth = !!(isLoggedIn || (typeof window !== "undefined" && window.isLoggedIn));
  if (!hasShuffleAuth) {
    const hint = document.createElement("div");
    hint.className = "model-dropdown-footer-hint";
    hint.innerHTML = `<span>Optional Shuffle login</span><a href="javascript:void(0)" onclick="openSettingsModal('mode-shuffle')">Connect</a>`;
    menu.appendChild(hint);
  }
}

function toggleModelDropdown(event) {
  if (event) event.stopPropagation();
  const reasoningMenu = document.getElementById("reasoning-dropdown-menu");
  if (reasoningMenu) reasoningMenu.classList.remove("visible");

  const menu = document.getElementById("model-dropdown-menu");
  if (!menu) return;
  renderModelDropdown();
  const btn = document.getElementById("btn-model-picker");
  positionDropdownUpOrDown(btn, menu);
  menu.classList.toggle("visible");
}

function renderReasoningDropdown() {
  const menu = document.getElementById("reasoning-dropdown-menu");
  if (!menu) return;
  menu.innerHTML = "";

  const current = activeReasoningEffort || localStorage.getItem("orborus_ai_reasoning") || "low";
  const options = [
    { key: "low", label: "Low", note: "Default" },
    { key: "medium", label: "Medium", note: "Balanced" },
    { key: "high", label: "High", note: "Deep" },
    { key: "minimal", label: "Off", note: "None" }
  ];

  const header = document.createElement("div");
  header.className = "model-category-header";
  header.textContent = "Reasoning Effort";
  menu.appendChild(header);

  options.forEach(opt => {
    const isSelected = (current === opt.key) || (opt.key === "minimal" && current === "off");
    const item = document.createElement("div");
    item.className = "model-option-item compact" + (isSelected ? " selected" : "");
    item.onclick = (e) => {
      e.stopPropagation();
      selectReasoningEffort(opt.key);
    };

    item.innerHTML = `
      <div class="model-option-title">
        <span class="model-option-label">${escapeHtml(opt.label)}</span>
        <div class="model-option-meta">
          <span class="model-sublabel">${escapeHtml(opt.note)}</span>
          ${isSelected ? `<svg class="active-check-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : `<span style="width:13px; display:inline-block;"></span>`}
        </div>
      </div>
    `;
    menu.appendChild(item);
  });
}

function toggleReasoningDropdown(event) {
  if (event) event.stopPropagation();
  const modelMenu = document.getElementById("model-dropdown-menu");
  if (modelMenu) modelMenu.classList.remove("visible");

  const menu = document.getElementById("reasoning-dropdown-menu");
  if (!menu) return;
  renderReasoningDropdown();
  const btn = document.getElementById("btn-reasoning-picker");
  positionDropdownUpOrDown(btn, menu);
  menu.classList.toggle("visible");
}

function selectReasoningEffort(key) {
  activeReasoningEffort = key || "low";
  localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  if (typeof saveRememberedReasoningForType === "function") {
    saveRememberedReasoningForType(activeProjectPath, activeReasoningEffort);
  }
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c && c.id === activeConversationId);
    if (curConv) {
      curConv.reasoning = activeReasoningEffort;
      if (typeof saveStoredConversations === "function") {
        saveStoredConversations();
      }
    }
  }
  updateActiveReasoningLabel();

  const footerReasoning = document.getElementById("select-footer-reasoning");
  if (footerReasoning) {
    footerReasoning.value = activeReasoningEffort;
  }

  const menu = document.getElementById("reasoning-dropdown-menu");
  if (menu) menu.classList.remove("visible");

  if (typeof window.setAiConfig === "function") {
    try {
      window.setAiConfig(currentAiUrl, currentAiKey, activeAiModel, activeReasoningEffort);
    } catch (e) {}
  } else if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setAiConfig", JSON.stringify({
      url: currentAiUrl || "",
      key: currentAiKey || "",
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort,
      permission_policy: currentPermissionPolicy || "ask_all"
    })).catch(() => {});
  }

  const display = key === "minimal" || key === "off" ? "Off" : (key.charAt(0).toUpperCase() + key.slice(1));
  showToast(`Reasoning effort set to ${display}`);
}

function selectAiModel(key, label) {
  if (key === "custom") {
    openSettingsModal("mode-direct", "model");
    const menu = document.getElementById("model-dropdown-menu");
    if (menu) menu.classList.remove("visible");
    return;
  }

  const isPredefined = AVAILABLE_AI_MODELS.some(m => m.key === key && m.key !== "custom");
  const avail = checkModelAvailability(key);

  activeAiModel = key;
  if (typeof window !== "undefined") {
    window.activeAiModel = key;
  }
  localStorage.setItem("orborus_ai_model", key);
  if (!isPredefined) {
    localStorage.setItem("orborus_custom_model", key);
  }
  if (typeof saveRememberedModelForType === "function") {
    saveRememberedModelForType(activeProjectPath, key);
  }
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c && c.id === activeConversationId);
    if (curConv) {
      curConv.model = key;
      if (typeof saveStoredConversations === "function") {
        saveStoredConversations();
      }
    }
  }

  // Set default endpoint URLs and execution mode based on model provider
  if (key === "tendon-local") {
    currentAiUrl = "";
    activeExecutionMode = "local";
    if (typeof window !== "undefined") {
      window.activeExecutionMode = "local";
    }
    localStorage.setItem("orborus_active_execution_mode", "local");
    if (typeof window.setActiveExecutionMode === "function") {
      window.setActiveExecutionMode("local").catch(() => {});
    }
    if (typeof window.getLocalExecutorStatus === "function") {
      window.getLocalExecutorStatus().catch(() => {});
    }
  } else {
    activeExecutionMode = "cloud";
    if (typeof window !== "undefined") {
      window.activeExecutionMode = "cloud";
    }
    localStorage.setItem("orborus_active_execution_mode", "cloud");
    if (typeof window.setActiveExecutionMode === "function") {
      window.setActiveExecutionMode("cloud").catch(() => {});
    }
    if (key.startsWith("gemini")) {
      if (!currentAiUrl || currentAiUrl.startsWith("local://") || currentAiUrl.includes("127.0.0.1:8000") || currentAiUrl.includes("localhost:8000")) {
        currentAiUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
      }
    } else if (key.startsWith("gpt")) {
      if (!currentAiUrl || currentAiUrl.startsWith("local://") || currentAiUrl.includes("127.0.0.1:8000") || currentAiUrl.includes("localhost:8000")) {
        currentAiUrl = "https://api.openai.com/v1";
      }
    } else if (key.startsWith("claude")) {
      if (!currentAiUrl || currentAiUrl.startsWith("local://") || currentAiUrl.includes("127.0.0.1:8000") || currentAiUrl.includes("localhost:8000")) {
        currentAiUrl = "https://api.anthropic.com/v1";
      }
    }
  }
  if (currentAiUrl) {
    localStorage.setItem("orborus_ai_url", currentAiUrl);
  }

  // Preserve user's reasoning choice independently
  updateActiveModelLabel();

  // Sync to settings modal dropdown
  const selectSettings = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");
  if (selectSettings) {
    if (isPredefined) {
      selectSettings.value = key;
      if (customModelInput) customModelInput.style.display = "none";
    } else {
      selectSettings.value = "custom";
      if (customModelInput) {
        customModelInput.style.display = "block";
        customModelInput.value = key;
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
  } else if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setAiConfig", JSON.stringify({
      url: currentAiUrl || "",
      key: currentAiKey || "",
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort || "low",
      permission_policy: currentPermissionPolicy || "ask_all"
    })).catch(() => {});
  }

  // Sync execution mode with model choice
  let targetMode = "local";
  if (key === "tendon-local") {
    targetMode = "local";
  } else if (key.startsWith("gpt") || key.startsWith("claude") || !isPredefined) {
    targetMode = "direct";
  } else if (key.startsWith("gemini") || key === "default") {
    targetMode = "shuffle";
  }
  if (typeof window !== "undefined") {
    window.activeExecutionMode = targetMode;
  }
  localStorage.setItem("orborus_active_execution_mode", targetMode);
  if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setActiveExecutionMode", JSON.stringify({ mode: targetMode })).catch(() => {});
  }
  if (typeof updateModesDisplay === "function") {
    updateModesDisplay();
  }

  const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(key) : { configured: true };
  if (!status.configured) {
    showToast(`Switched to ${label || key} (${status.reason})`);
  } else {
    showToast(`Switched model to ${label || key}`);
  }
}

document.addEventListener("click", (e) => {
  const modelMenu = document.getElementById("model-dropdown-menu");
  const modelBtn = document.getElementById("btn-model-picker");
  if (modelMenu && modelMenu.classList.contains("visible")) {
    if (!modelMenu.contains(e.target) && !modelBtn.contains(e.target)) {
      modelMenu.classList.remove("visible");
    }
  }

  const reasoningMenu = document.getElementById("reasoning-dropdown-menu");
  const reasoningBtn = document.getElementById("btn-reasoning-picker");
  if (reasoningMenu && reasoningMenu.classList.contains("visible")) {
    if (!reasoningMenu.contains(e.target) && !reasoningBtn.contains(e.target)) {
      reasoningMenu.classList.remove("visible");
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

var isPromptExecuting = false;
var promptMessageQueue = [];

function enqueuePrompt(promptText) {
  const queueId = "queue-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4);
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  promptMessageQueue.push({
    id: queueId,
    prompt: promptText,
    timestamp: timeStr,
    conversationId: activeConversationId
  });
  renderActiveConversation();
  updateActiveModelLabel();
  showToast(`Prompt queued (#${promptMessageQueue.length}). Waiting for active task...`, 2500);
}

function cancelQueuedPrompt(queueId) {
  const idx = promptMessageQueue.findIndex(q => q.id === queueId);
  if (idx !== -1) {
    promptMessageQueue.splice(idx, 1);
    renderActiveConversation();
    updateActiveModelLabel();
    showToast("Cancelled queued prompt");
  }
}

function processNextInQueue() {
  if (promptMessageQueue.length === 0) return;
  const next = promptMessageQueue.shift();
  renderActiveConversation();
  updateActiveModelLabel();
  submitPrompt(next.prompt);
}

function stopExecution() {
  if (window.currentAbortController) {
    try { window.currentAbortController.abort(); } catch (e) {}
  }
  isPromptExecuting = false;
  activeRunningTasks = [];
  renderRunningTasks();

  const btnStop = document.getElementById("btn-stop-execution");
  const btnSend = document.getElementById("btn-send");
  if (btnStop) btnStop.style.display = "none";
  if (btnSend) btnSend.style.display = "flex";

  // Mark in-flight running turn as cancelled
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c.id === activeConversationId);
    if (curConv && curConv.turns) {
      const runningTurn = curConv.turns.find(t => t.status === "running");
      if (runningTurn) {
        runningTurn.status = "error";
        runningTurn.error = "Generation cancelled by user";
        runningTurn.error_type = "user_cancelled";
        renderActiveConversation();
        saveStoredConversations();
      }
    }
  }

  showToast("Execution cancelled by user");

  // If there are queued messages, proceed to next
  if (promptMessageQueue.length > 0) {
    setTimeout(() => {
      processNextInQueue();
    }, 400);
  }
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

  // Check for thought pattern: "Thought for 3s" or "Thought for <1s"
  if (step.type === "thought" || rawTitle.toLowerCase().startsWith("thought")) {
    const durMatch = rawTitle.match(/thought(?:\s+for\s+([^\s]+))?/i);
    const dur = (durMatch && durMatch[1]) || step.duration || "<1s";
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
  { id: "gemini-3.8-pro", name: "Gemini 3.8 Pro", note: "Reasoning" },
  { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", note: "Anthropic" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", note: "Anthropic" },
  { id: "gpt-4o", name: "GPT-4o", note: "OpenAI" },
  { id: "tendon-local", name: "Tendon CUDA", note: "Local GPU" },
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

  // Reasoning setup (defaults to low)
  activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "low";
  if (footerReasoningSelect) {
    footerReasoningSelect.value = activeReasoningEffort;
  }
  updateActiveReasoningLabel();

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
  updateActiveModelLabel();
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
  activeReasoningEffort = val || "low";
  localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  updateActiveReasoningLabel();
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
  const topbarProj = document.getElementById("topbar-project-name");
  if (topbarProj) {
    const activeProjectEl = document.getElementById("active-project-name");
    const activeDisplay = activeProjectEl ? activeProjectEl.innerText : "";
    topbarProj.innerText = activeDisplay || (activeProjectPath ? (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "No project");
  }
  const archiveBtn = document.getElementById("btn-archive-active-chat");
  if (archiveBtn) archiveBtn.style.display = "none";

  const mainContainer = document.getElementById("main-container");
  if (mainContainer) mainContainer.classList.remove("has-history");

  const input = document.getElementById("prompt-input");
  if (input) {
    input.value = "";
    input.style.height = "auto";
    setTimeout(() => input.focus(), 50);
  }

  // Restore remembered model and reasoning for this chat type, prioritizing active and validated
  if (typeof getRememberedModelForType === "function" && typeof getBestActiveValidatedModel === "function") {
    const rememberedModel = getRememberedModelForType(activeProjectPath);
    const validatedModel = getBestActiveValidatedModel(rememberedModel);
    activeAiModel = validatedModel;
    if (typeof window !== "undefined") window.activeAiModel = validatedModel;
    localStorage.setItem("orborus_ai_model", validatedModel);
  }
  if (typeof getRememberedReasoningForType === "function") {
    activeReasoningEffort = getRememberedReasoningForType(activeProjectPath) || "low";
    if (typeof window !== "undefined") window.activeReasoningEffort = activeReasoningEffort;
    localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  }
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof updateActiveReasoningLabel === "function") updateActiveReasoningLabel();

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

async function submitPrompt(forcedPrompt) {
  const textarea = document.getElementById("prompt-input");
  const prompt = (typeof forcedPrompt === "string" ? forcedPrompt : (textarea ? textarea.value : "")).trim();
  if (!prompt) return;

  // Queue prompt if another execution is already in flight
  if (isPromptExecuting) {
    enqueuePrompt(prompt);
    if (textarea && typeof forcedPrompt !== "string") {
      textarea.value = "";
      textarea.style.height = "auto";
      const btn = document.getElementById("btn-send");
      if (btn) btn.classList.remove("active");
    }
    return;
  }

  isPromptExecuting = true;
  setChatMode(true);

  if (textarea && typeof forcedPrompt !== "string") {
    textarea.value = "";
    textarea.style.height = "auto";
  }
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
  const modelDisplayName = resolveModelDisplayName(selectedModel);
  const effectiveKey = (currentAiKey || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_key")) || "").trim();
  const isLocal = selectedModel.startsWith("tendon") || selectedModel.startsWith("local") || selectedModel === "custom" || !effectiveKey;
  const initialPhase = isLocal ? "Starting Local LLM..." : `Connecting to ${modelDisplayName}...`;

  const optimisticTurn = {
    id: turnId,
    prompt: prompt,
    timestamp: timeStr,
    steps: [
      { id: "step-init", name: "Agent Initialized", duration: "<1s", detail: "Workspace context and rules loaded.", type: "thought" },
      { id: "step-loading", name: isLocal ? "Starting Local LLM" : "Connecting to Model", duration: "Active", detail: isLocal ? `Starting native CUDA engine on ${window.localGpuName || "NVIDIA RTX 3080 Ti"} (Gemma-4 26B weights into VRAM)...` : `Connecting to ${modelDisplayName}...`, type: "thought" },
      { id: "step-exec", name: isLocal ? "Native GPU Inference" : "Querying AI Model", duration: "Pending", detail: isLocal ? "Awaiting model readiness to synthesize tokens..." : "Awaiting agent decision stream...", type: "cmd" }
    ],
    output: "",
    status: "running",
    duration: "0s",
    phase: initialPhase
  };

  const firstLine = prompt.split("\n")[0].substring(0, 36);
  const activeProjectEl = document.getElementById("active-project-name");
  const activeDisplay = activeProjectEl ? activeProjectEl.innerText : "";
  const effectiveProjName = activeDisplay || (activeProjectPath ? (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "No project");

  if (!activeConversationId) {
    activeConversationId = "conv-" + Date.now();
    localStorage.setItem("orborus_active_conv_id", activeConversationId);
    const newConv = {
      id: activeConversationId,
      projectId: activeProjectPath,
      project_id: activeProjectPath,
      projectName: effectiveProjName,
      project_name: effectiveProjName,
      title: firstLine,
      model: selectedModel,
      reasoning: activeReasoningEffort || "low",
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
        projectName: effectiveProjName,
        project_name: effectiveProjName,
        title: firstLine,
        model: selectedModel,
        reasoning: activeReasoningEffort || "low",
        pinned: false,
        turns: []
      };
      appConversations.unshift(curConv);
    } else {
      curConv.model = selectedModel;
      curConv.reasoning = activeReasoningEffort || "low";
    }
    if (!curConv.turns) curConv.turns = [];
    curConv.turns.push(optimisticTurn);
    curConv.updated_at = new Date().toISOString();
  }

  if (typeof saveRememberedModelForType === "function") {
    saveRememberedModelForType(activeProjectPath, selectedModel);
  }
  if (typeof saveRememberedReasoningForType === "function") {
    saveRememberedReasoningForType(activeProjectPath, activeReasoningEffort || "low");
  }

  runningConversationId = activeConversationId;

  // Paint optimistic state immediately (0ms delay)
  renderProjectTree();
  renderActiveConversation();
  saveStoredConversations();

  const stream = document.getElementById("execution-stream");
  if (stream) {
    setTimeout(() => { stream.scrollTop = stream.scrollHeight; }, 30);
  }

  // Live duration & phase update timer
  const startTime = Date.now();
  function getWaitingPhaseText(elapsedSec) {
    if (isLocal) {
      if (elapsedSec < 3) return "Starting Local LLM: Initializing CUDA runtime...";
      if (elapsedSec < 8) return `Loading Weights: Allocating VRAM on ${window.localGpuName || "Local GPU"}...`;
      if (elapsedSec < 15) return `Engine Ready: Ingesting prompt on ${window.localGpuName || "Local GPU"}...`;
      return `Native Inference: Generating tokens & reasoning (${elapsedSec}s)...`;
    } else {
      if (elapsedSec < 2) return `Connecting to ${modelDisplayName}...`;
      if (elapsedSec < 6) return "Analyzing prompt and workspace context...";
      return `Waiting for response & agent decisions (${elapsedSec}s)...`;
    }
  }

  const liveTimer = setInterval(() => {
    const elapsedSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    optimisticTurn.duration = `${elapsedSec}s`;
    const durEl = document.getElementById("live-dur-" + turnId);
    if (durEl) {
      durEl.innerText = `${elapsedSec}s`;
    }
    const phaseEl = document.getElementById("live-phase-" + turnId);
    if (phaseEl && !phaseEl.getAttribute("data-backend-driven")) {
      phaseEl.innerText = getWaitingPhaseText(elapsedSec);
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
      reasoning: activeReasoningEffort || "low",
      ai_api_key: effectiveKey,
      ai_api_url: effectiveUrl
    });

    console.log("[Shuffle Agent] Submitting prompt to backend:", {
      prompt: prompt,
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort || "low",
      conversation_id: activeConversationId,
      has_key: Boolean(effectiveKey),
      has_url: Boolean(effectiveUrl)
    });

    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("runPrompt", promptPayload);
    } else if (typeof window.runPrompt === "function") {
      raw = await window.runPrompt(prompt, false, activeConversationId || "");
    } else {
      console.warn("[Shuffle Agent] Native agent bridge not found");
      await new Promise(r => setTimeout(r, 400));
      raw = JSON.stringify({
        prompt: prompt,
        output: "Native agent bridge is not available. Please connect to a running backend or runner.",
        error: "Native agent bridge not connected",
        steps: []
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
    optimisticTurn.changed_files = res.changed_files || null;
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
    if (typeof loadRightSidebarOverview === "function") {
      loadRightSidebarOverview();
    }

    const curConvObj = appConversations.find(c => c.id === activeConversationId);
    addExecutionHistory({
      prompt: optimisticTurn.prompt,
      output: optimisticTurn.output,
      timestamp: optimisticTurn.timestamp,
      duration: optimisticTurn.duration,
      status: optimisticTurn.status,
      conversation_id: activeConversationId,
      conversation_title: curConvObj ? curConvObj.title : (optimisticTurn.prompt.split("\n")[0].substring(0, 36))
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
    if (typeof loadRightSidebarOverview === "function") {
      loadRightSidebarOverview();
    }

    const curConvObj = appConversations.find(c => c.id === activeConversationId);
    addExecutionHistory({
      prompt: optimisticTurn.prompt,
      output: optimisticTurn.output,
      timestamp: optimisticTurn.timestamp,
      duration: optimisticTurn.duration,
      status: optimisticTurn.status,
      conversation_id: activeConversationId,
      conversation_title: curConvObj ? curConvObj.title : (optimisticTurn.prompt.split("\n")[0].substring(0, 36))
    });
  } finally {
    isPromptExecuting = false;
    runningConversationId = null;
    clearInterval(liveTimer);
    activeRunningTasks = [];
    renderRunningTasks();
    renderProjectTree();
    const curBtnStop = document.getElementById("btn-stop-execution");
    const curBtnSend = document.getElementById("btn-send");
    if (curBtnStop) curBtnStop.style.display = "none";
    if (curBtnSend) curBtnSend.style.display = "flex";

    if (promptMessageQueue.length > 0) {
      setTimeout(() => {
        processNextInQueue();
      }, 350);
    }
  }
}

function stopExecution() {
  isPromptExecuting = false;
  runningConversationId = null;
  const curBtnStop = document.getElementById("btn-stop-execution");
  const curBtnSend = document.getElementById("btn-send");
  if (curBtnStop) curBtnStop.style.display = "none";
  if (curBtnSend) curBtnSend.style.display = "flex";
  renderProjectTree();
  showToast("Execution stopped");
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
    const promptEl = card.querySelector(".user-command-text") || card.querySelector(".exec-prompt") || card.querySelector(".user-turn-bubble");
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

function renderMarkdown(raw) {
  if (!raw) return '<div class="md-p">Completed with no output.</div>';

  // 1. Extract fenced code blocks first so inner content is preserved and not altered by subsequent regexes
  const codeBlocks = [];
  let processed = raw.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || "code", code: code.replace(/\r\n/g, "\n").trim() });
    return `\n\n__CODE_BLOCK_${idx}__\n\n`;
  });

  // 2. Escape HTML on the non-code text to prevent XSS
  processed = escapeHtml(processed);

  // 3. Detect and convert Markdown image syntax: ![alt](url)
  processed = processed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const cleanUrl = url.trim();
    const cleanAlt = (alt || cleanUrl).trim();
    return `<div class="md-inline-image-card" onclick="previewFileInSidebar('${cleanUrl}')" title="Click to view image in preview sidebar"><img src="${cleanUrl}" alt="${cleanAlt}" onerror="this.style.display='none'"/><span class="md-image-caption">${cleanAlt}</span></div>`;
  });

  // 4. Blockquotes (subtle styling, warm amber border)
  processed = processed.replace(/^>\s?(.*)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

  // 5. Explicit split lines between areas
  processed = processed.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="md-split-line">');

  // 6. Numbered Major Section Headings (e.g. 2. If it fails, is it obvious? or 3. Does the text it returns...)
  // Inserts clean horizontal split line between major numbered sections matching the screenshot
  let sectionIndex = 0;
  processed = processed.replace(/^(\d+)\.\s+([A-Z0-9][^\n]+)$/gm, (match, num, title) => {
    sectionIndex++;
    const splitLine = sectionIndex > 1 ? '<hr class="md-split-line">' : '';
    return `${splitLine}<h3 class="md-h3"><span style="color:var(--text-muted); margin-right:4px;">${num}.</span>${title}</h3>`;
  });

  // 7. Markdown Headings
  processed = processed.replace(/^###\s+(.*$)/gm, '<h3 class="md-h3">$1</h3>');
  processed = processed.replace(/^##\s+(.*$)/gm, '<hr class="md-split-line"><h2 class="md-h2">$1</h2>');
  processed = processed.replace(/^#\s+(.*$)/gm, '<h1 class="md-h1">$1</h1>');

  // 8. Bold & Italics
  processed = processed.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  processed = processed.replace(/__(.*?)__/g, '<strong>$1</strong>');
  processed = processed.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');

  // 9. Inline code, clickable files, and command pills
  processed = processed.replace(/`([^`\n]+)`/g, (match, code) => {
    const trimmed = code.trim();

    // Shell commands: starts with $ or >
    if (trimmed.startsWith("$ ") || trimmed.startsWith("&gt; ") || trimmed.startsWith("&gt;")) {
      const cmdText = trimmed.replace(/^(\$|&gt;)\s*/, "");
      return `<code class="md-cmd-pill" onclick="copySnippetText(this)" title="Click to copy command"><span class="md-cmd-prefix">$</span><span class="md-cmd-name">${cmdText}</span></code>`;
    }

    // Language badge + file path: e.g. `js pkg/ui/src/js/chat.js` or `</> pkg/ui/index.html`
    const langBadgeMatch = trimmed.match(/^(js|html|css|go|py|ts|sh|json|md|&lt;\/&gt;|<\/>)\s+([a-zA-Z0-9_\-\./\\]+)$/i);
    if (langBadgeMatch) {
      const badgeRaw = langBadgeMatch[1];
      let tagClass = badgeRaw.replace(/&lt;\/&gt;|<\/>/, "html").toLowerCase();
      const filePath = langBadgeMatch[2];
      return `<span class="md-file-pill" onclick="previewFileInSidebar('${filePath}')" title="Preview ${filePath} in sidebar"><span class="md-file-tag tag-${tagClass}">${badgeRaw}</span><span class="md-file-name">${filePath}</span></span>`;
    }

    // Standalone file paths or images (e.g. pkg/ui/src/js/chat.js or windows.go or index.html or app_icon.png)
    const fileMatch = trimmed.match(/^([a-zA-Z0-9_\-./\\]+\.([a-zA-Z0-9]{1,8}))(?::\d+(?::\d+)?)?$/);
    if (fileMatch) {
      const filePath = fileMatch[1];
      const ext = fileMatch[2].toLowerCase();
      let tagClass = ext;
      let displayTag = ext;
      if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) {
        tagClass = "img";
        displayTag = "img";
      } else if (["html", "htm"].includes(ext)) {
        tagClass = "html";
        displayTag = "&lt;/&gt;";
      }
      return `<span class="md-file-pill" onclick="previewFileInSidebar('${filePath}')" title="Preview ${filePath} in sidebar"><span class="md-file-tag tag-${tagClass}">${displayTag}</span><span class="md-file-name">${filePath}</span></span>`;
    }

    // Clean inline code pill with subtle low-saturation styling
    return `<code class="md-inline-code">${code}</code>`;
  });

  // 10. Lists (ordered and unordered)
  processed = processed.replace(/^\s*[-*+]\s+(.*)$/gm, '<li class="md-li">$1</li>');
  processed = processed.replace(/((?:<li class="md-li">.*<\/li>\s*)+)/g, '<ul class="md-ul">$1</ul>');

  processed = processed.replace(/^\s*(\d+)\.\s+(.*)$/gm, '<li class="md-oli" value="$1">$2</li>');
  processed = processed.replace(/((?:<li class="md-oli".*<\/li>\s*)+)/g, '<ol class="md-ol">$1</ol>');

  // 11. Paragraphs (split by double newlines)
  const paragraphs = processed.split(/\n{2,}/);
  let html = paragraphs.map(p => {
    p = p.trim();
    if (!p) return "";
    if (/^<(h1|h2|h3|ul|ol|blockquote|hr|div)/i.test(p) || p.startsWith("__CODE_BLOCK_")) {
      return p;
    }
    return `<p class="md-p">${p.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");

  // 12. Re-inject fenced code blocks
  codeBlocks.forEach((b, idx) => {
    const escapedCode = escapeHtml(b.code);
    const blockHtml = `
      <div class="code-block-box">
        <div class="code-block-bar">
          <span class="code-block-lang">${escapeHtml(b.lang)}</span>
          <button type="button" class="btn-copy-code" onclick="copyCodeSnippet(this)" title="Copy Code">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy</span>
          </button>
        </div>
        <pre class="code-block-pre"><code>${escapedCode}</code></pre>
      </div>
    `;
    html = html.replace(`__CODE_BLOCK_${idx}__`, blockHtml);
  });

  return `<div class="markdown-rendered-body">${html}</div>`;
}

async function copyCodeSnippet(btn) {
  const box = btn.closest(".code-block-box");
  if (!box) return;
  const codeEl = box.querySelector("code");
  if (!codeEl) return;
  try {
    await navigator.clipboard.writeText(codeEl.innerText);
    const span = btn.querySelector("span");
    if (span) {
      const orig = span.innerText;
      span.innerText = "Copied!";
      setTimeout(() => { span.innerText = orig; }, 2000);
    }
  } catch (err) {
    console.error("Failed to copy code snippet:", err);
  }
}

let currentPreviewPath = "";
let currentPreviewContentText = "";
let currentRightTab = "overview";
let rsFilesExpanded = false;
let rsFilesCache = [];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

async function previewFileInSidebar(filePath) {
  if (!filePath) return;
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;

  switchRightSidebarTab('review');
  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  const copyBtn = document.getElementById("btn-copy-preview");

  currentPreviewPath = filePath;
  sidebar.style.display = "flex";
  const btnTopbar = document.getElementById("btn-toggle-right-sidebar");
  if (btnTopbar) {
    btnTopbar.classList.add("active");
    btnTopbar.setAttribute("title", "Contract Right Sidebar");
  }
  if (titleEl) {
    titleEl.style.display = "inline-block";
    titleEl.innerText = filePath.split(/[/\\]/).pop() || filePath;
  }
  if (badgeEl) {
    badgeEl.style.display = "inline-block";
    badgeEl.innerText = "Loading...";
  }
  if (contentEl) {
    contentEl.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:200px; color:var(--text-muted); font-size:12px; gap:8px;"><div class="spinner"></div> Reading ${escapeHtml(filePath)}...</div>`;
  }

  try {
    let raw = "";
    if (window.agentBridge && window.agentBridge.handleAction) {
      raw = await window.agentBridge.handleAction("readFilePreview", JSON.stringify({ path: filePath }));
    } else {
      raw = await callGo("readFilePreview", JSON.stringify({ path: filePath }));
    }
    const res = typeof raw === "string" ? JSON.parse(raw) : raw;

    if (res.error) {
      if (badgeEl) badgeEl.innerText = "Error";
      if (contentEl) {
        contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px; font-family:ui-monospace,monospace;">${escapeHtml(res.error)}</div>`;
      }
      return;
    }

    if (res.is_image) {
      if (badgeEl) badgeEl.innerText = `${res.mime || 'image'} • ${formatBytes(res.size)}`;
      if (copyBtn) copyBtn.style.display = "none";
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="preview-image-wrap">
            <img class="preview-image-img" src="data:${res.mime};base64,${res.data}" alt="${escapeHtml(res.name)}" />
            <div class="preview-image-meta">${escapeHtml(res.full_path || res.path)}</div>
          </div>
        `;
      }
    } else {
      currentPreviewContentText = res.content || "";
      if (copyBtn) copyBtn.style.display = "inline-flex";
      if (badgeEl) badgeEl.innerText = `${res.lines || 1} lines • ${formatBytes(res.size)}`;
      
      const lineCount = res.lines || 1;
      const linesArray = Array.from({ length: lineCount }, (_, i) => `<span>${i + 1}</span>`).join("");
      const escapedContent = escapeHtml(res.content || "");

      if (contentEl) {
        contentEl.innerHTML = `
          <div class="preview-code-wrap">
            <div class="preview-code-lines">${linesArray}</div>
            <pre class="preview-code-pre"><code>${escapedContent}</code></pre>
          </div>
        `;
      }
    }
  } catch (err) {
    if (badgeEl) badgeEl.innerText = "Error";
    if (contentEl) {
      contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px;">Failed to preview file: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

function closePreviewSidebar() {
  const sidebar = document.getElementById("preview-sidebar");
  if (sidebar) sidebar.style.display = "none";
  const btn = document.getElementById("btn-toggle-right-sidebar");
  if (btn) {
    btn.classList.remove("active");
    btn.setAttribute("title", "Expand Right Sidebar");
  }
}

async function copyPreviewContent() {
  if (!currentPreviewContentText) return;
  try {
    await navigator.clipboard.writeText(currentPreviewContentText);
    const btn = document.getElementById("btn-copy-preview");
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  } catch (e) {}
}

async function copySnippetText(el) {
  if (!el) return;
  const text = el.innerText.replace(/^\$\s*/, "").trim();
  try {
    await navigator.clipboard.writeText(text);
    const origBorder = el.style.borderColor;
    el.style.borderColor = "#4ade80";
    setTimeout(() => { el.style.borderColor = origBorder; }, 1200);
  } catch (e) {}
}

// Review drawer for changed files
async function openReviewSidebar(turnIndex) {
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;

  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  const copyBtn = document.getElementById("btn-copy-preview");

  try {
    switchRightSidebarTab('review');
    if (copyBtn) copyBtn.style.display = "none";
  sidebar.style.display = "flex";
  const btnTopbar = document.getElementById("btn-toggle-right-sidebar");
  if (btnTopbar) {
    btnTopbar.classList.add("active");
    btnTopbar.setAttribute("title", "Contract Right Sidebar");
  }
  const isTurnReview = typeof turnIndex === "number";
  if (titleEl) {
    titleEl.style.display = "inline-block";
    titleEl.innerText = isTurnReview ? "Review Turn Changes" : "Review Changes";
  }
  if (badgeEl) {
    badgeEl.style.display = "inline-block";
    badgeEl.innerText = isTurnReview ? "Inspecting turn diff..." : "Loading git diff...";
  }
  if (contentEl) {
    contentEl.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:200px; color:var(--text-muted); font-size:12px; gap:8px;"><div class="spinner"></div> Checking changed files...</div>`;
  }

  let res = null;
  if (isTurnReview) {
    if (activeConversationId && Array.isArray(appConversations)) {
      const curConv = appConversations.find(c => c.id === activeConversationId);
      if (curConv && curConv.turns && curConv.turns[turnIndex]) {
        res = curConv.turns[turnIndex].changed_files;
      }
    }
  } else {
    try {
      let raw = "";
      if (window.agentBridge && window.agentBridge.handleAction) {
        raw = await window.agentBridge.handleAction("getChangedFiles", "{}");
      } else {
        raw = await callGo("getChangedFiles", "{}");
      }
      res = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      if (badgeEl) badgeEl.innerText = "Error";
      if (contentEl) {
        contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px;">Failed to inspect changed files: ${escapeHtml(err.message || String(err))}</div>`;
      }
      return;
    }
  }

  const files = (res && res.files) || [];
  if (files.length === 0) {
    if (badgeEl) badgeEl.innerText = isTurnReview ? "No changes in turn" : "Working tree clean";
    if (contentEl) {
      contentEl.innerHTML = `<div style="padding:28px 20px; text-align:center; color:var(--text-muted); font-size:12px;">${isTurnReview ? "No file changes were made during this turn." : "No uncommitted git changes detected in active repository."}</div>`;
    }
    return;
  }

    if (badgeEl) {
      badgeEl.innerText = `${res.total_files} file${res.total_files > 1 ? 's' : ''} (+${res.additions} -${res.deletions})`;
    }

    let filesHtml = `<div class="review-changes-list">`;
    files.forEach((f, i) => {
      const statusClass = f.status === "added" ? "status-added" : f.status === "deleted" ? "status-deleted" : "status-modified";
      const statusText = f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M";
      
      let diffLinesHtml = "";
      if (f.diff) {
        diffLinesHtml = f.diff.split("\n").map(l => {
          if (l.startsWith("+") && !l.startsWith("+++")) {
            return `<span class="diff-line-add">${escapeHtml(l)}</span>`;
          } else if (l.startsWith("-") && !l.startsWith("---")) {
            return `<span class="diff-line-del">${escapeHtml(l)}</span>`;
          } else if (l.startsWith("@@") || l.startsWith("diff --git")) {
            return `<span class="diff-line-info">${escapeHtml(l)}</span>`;
          }
          return `<span>${escapeHtml(l)}</span>`;
        }).join("");
      }

      filesHtml += `
        <div class="review-file-card">
          <div class="review-file-header" onclick="toggleFileDiff(${i})">
            <div class="review-file-left">
              <span class="review-file-status-badge ${statusClass}">${statusText}</span>
              <span class="review-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
            </div>
            <div class="review-file-stats">
              <span style="color:#4ade80;">+${f.additions || 0}</span>
              <span style="color:#f87171;">-${f.deletions || 0}</span>
            </div>
          </div>
          ${f.diff ? `<div id="diff-body-${i}" class="review-diff-body" style="display:block;">${diffLinesHtml}</div>` : ""}
        </div>
      `;
    });
    filesHtml += `</div>`;

    if (contentEl) {
      contentEl.innerHTML = filesHtml;
    }
  } catch (err) {
    if (badgeEl) badgeEl.innerText = "Error";
    if (contentEl) {
      contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px;">Failed to load changed files: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

function toggleFileDiff(index) {
  const el = document.getElementById("diff-body-" + index);
  if (el) {
    el.style.display = el.style.display === "none" ? "block" : "none";
  }
}

function switchRightSidebarTab(tabName) {
  currentRightTab = tabName;
  const tabs = ["overview", "review", "terminal"];
  tabs.forEach(t => {
    const btn = document.getElementById(`btn-rs-tab-${t}`);
    const panel = document.getElementById(`rs-panel-${t}`);
    if (btn) btn.classList.toggle("active", t === tabName);
    if (panel) panel.classList.toggle("active", t === tabName);
  });

  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const copyBtn = document.getElementById("btn-copy-preview");

  if (tabName === "overview") {
    if (titleEl) titleEl.style.display = "none";
    if (badgeEl) badgeEl.style.display = "none";
    if (copyBtn) copyBtn.style.display = "none";
    loadRightSidebarOverview();
  } else if (tabName === "review") {
    if (titleEl) titleEl.style.display = "inline-block";
    const content = document.getElementById("preview-sidebar-content");
    if (content && (!content.innerHTML || content.innerHTML.trim() === "")) {
      openReviewSidebar();
    }
  } else if (tabName === "terminal") {
    if (titleEl) {
      titleEl.style.display = "inline-block";
      titleEl.innerText = "Terminal Output";
    }
    if (badgeEl) badgeEl.style.display = "none";
    if (copyBtn) copyBtn.style.display = "none";
  }
}

function getFileTypeIcon(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  if (filePath.endsWith("go.mod") || filePath.endsWith("go.sum")) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="2.2" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  }
  if (ext === "go") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M4 12h5m6 0h5"/><path d="M12 4v5m0 6v5"/></svg>`;
  }
  if (ext === "js" || ext === "jsx" || ext === "json") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fde047" stroke-width="2.2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  if (ext === "ts" || ext === "tsx") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  if (ext === "py") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
  }
  if (ext === "html" || ext === "htm") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2.2" stroke-linecap="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
  }
  if (ext === "css") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2.2" stroke-linecap="round"><path d="M4 4l2 16 6 2 6-2 2-16z"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

async function loadRightSidebarOverview() {
  try {
    let raw = "";
    if (window.agentBridge && window.agentBridge.handleAction) {
      raw = await window.agentBridge.handleAction("getRightSidebarData", "{}");
    } else {
      raw = await callGo("getRightSidebarData", "{}");
    }
    const res = typeof raw === "string" ? JSON.parse(raw) : raw;

    // Files Changed
    const changes = res.git_changes || { total_files: 0, files: [] };
    const files = changes.files || [];
    rsFilesCache = files;
    const countFilesEl = document.getElementById("rs-count-files");
    if (countFilesEl) countFilesEl.innerText = files.length;

    renderRightSidebarFilesList();

    // Terminals
    const terminals = res.terminals || [];
    const countTerminalsEl = document.getElementById("rs-count-terminals");
    const bodyTerminalsEl = document.getElementById("rs-body-terminals");
    if (countTerminalsEl) countTerminalsEl.innerText = terminals.length;
    if (bodyTerminalsEl) {
      if (terminals.length === 0) {
        bodyTerminalsEl.innerHTML = `<div class="rs-empty-hint">No active terminals</div>`;
      } else {
        bodyTerminalsEl.innerHTML = terminals.map(term => `
          <div class="rs-item-row" onclick="switchRightSidebarTab('terminal')">
            <svg class="rs-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            <span class="rs-item-name">${escapeHtml(term.name || "terminal")}</span>
            <span class="rs-item-meta">PID ${escapeHtml(String(term.pid || ""))}</span>
          </div>
        `).join("");
      }
    }

    // Uploads
    const uploads = res.uploads || [];
    const countUploadsEl = document.getElementById("rs-count-uploads");
    const bodyUploadsEl = document.getElementById("rs-body-uploads");
    if (countUploadsEl) countUploadsEl.innerText = uploads.length;
    if (bodyUploadsEl) {
      if (uploads.length === 0) {
        bodyUploadsEl.innerHTML = `<div class="rs-empty-hint">No uploads yet</div>`;
      } else {
        bodyUploadsEl.innerHTML = uploads.map(u => `
          <div class="rs-item-row" onclick="previewUploadedMedia()">
            <svg class="rs-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            <span class="rs-item-name">${escapeHtml(u.name || "Media")}</span>
          </div>
        `).join("");
      }
    }

    // Background Tasks
    const countTasksEl = document.getElementById("rs-count-tasks");
    const tasksCount = (typeof activeRunningTasks !== "undefined" && Array.isArray(activeRunningTasks)) ? activeRunningTasks.length : 0;
    if (countTasksEl) countTasksEl.innerText = tasksCount;

    // Subagents
    const countSubagentsEl = document.getElementById("rs-count-subagents");
    if (countSubagentsEl) countSubagentsEl.innerText = "0";

    // Artifacts
    const countArtifactsEl = document.getElementById("rs-count-artifacts");
    if (countArtifactsEl) countArtifactsEl.innerText = "0";
  } catch (err) {
    console.warn("loadRightSidebarOverview error:", err);
  }
}

function renderRightSidebarFilesList() {
  const container = document.getElementById("rs-files-list");
  const seeAllBtn = document.getElementById("btn-see-all-files");
  const seeAllCount = document.getElementById("rs-see-all-count");
  if (!container) return;

  if (!rsFilesCache || rsFilesCache.length === 0) {
    container.innerHTML = `<div class="rs-empty-hint">Working tree clean</div>`;
    if (seeAllBtn) seeAllBtn.style.display = "none";
    return;
  }

  const total = rsFilesCache.length;
  const visibleFiles = (rsFilesExpanded || total <= 5) ? rsFilesCache : rsFilesCache.slice(0, 5);

  let html = "";
  visibleFiles.forEach(f => {
    const rawPath = f.path || "";
    const parts = rawPath.split(/[/\\]/);
    const fileName = parts.pop() || rawPath;
    const dir = parts.join("/");
    const icon = getFileTypeIcon(fileName);

    html += `
      <div class="rs-file-item" onclick="previewFileInSidebar('${escapeHtml(rawPath)}')">
        <div class="rs-file-left">
          <span class="rs-file-icon">${icon}</span>
          <span class="rs-file-name" title="${escapeHtml(rawPath)}">${escapeHtml(fileName)}</span>
        </div>
        ${dir ? `<span class="rs-file-dir">${escapeHtml(dir)}</span>` : ""}
      </div>
    `;
  });

  container.innerHTML = html;

  if (seeAllBtn) {
    if (total > 5) {
      seeAllBtn.style.display = "block";
      if (seeAllCount) seeAllCount.innerText = total;
      seeAllBtn.innerText = rsFilesExpanded ? "Show less" : `See all (${total})`;
    } else {
      seeAllBtn.style.display = "none";
    }
  }
}

function toggleSeeAllFiles() {
  rsFilesExpanded = !rsFilesExpanded;
  renderRightSidebarFilesList();
}

function toggleRightSidebarSection(sectionId) {
  const sec = document.getElementById(sectionId);
  if (sec) {
    sec.classList.toggle("expanded");
  }
}

function previewUploadedMedia() {
  const uploadTitle = document.getElementById("rs-upload-title");
  const name = uploadTitle ? uploadTitle.innerText : "Media";
  switchRightSidebarTab('review');
  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  if (titleEl) {
    titleEl.style.display = "inline-block";
    titleEl.innerText = name;
  }
  if (badgeEl) {
    badgeEl.style.display = "inline-block";
    badgeEl.innerText = "image • session asset";
  }
  if (contentEl) {
    contentEl.innerHTML = `
      <div class="preview-image-wrap">
        <div style="font-size:12px; color:var(--text-secondary); text-align:center; padding:20px;">
          Uploaded session media asset.<br><span style="color:var(--text-muted); font-size:11px;">Attached to conversation turns for vision and reference.</span>
        </div>
      </div>
    `;
  }
}

function triggerRightSidebarAction() {
  const input = document.getElementById("prompt-input") || document.getElementById("chat-input");
  if (input) {
    input.focus();
    input.scrollIntoView({ behavior: "smooth" });
  }
}

function clearTerminalView() {
  const out = document.getElementById("rs-terminal-output");
  if (out) out.innerText = "Ready.\n";
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePreviewSidebar();
  }
});

function buildErrorArea(isError, errText, info, prompt, rawOutput) {
  if (!isError) {
    const isShellCmd = prompt && (prompt.startsWith("$ ") || prompt.startsWith("> "));
    if (isShellCmd) {
      return `<div style="white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,Menlo,monospace; font-size:12px; line-height:1.45;">${escapeHtml(rawOutput || "Completed with no output.")}</div>`;
    }
    return renderMarkdown(rawOutput || "Completed with no output.");
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
    const curModel = (info && info.model) || (info && info.debug_info && info.debug_info.model) || activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash";
    const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(curModel) : { actionType: "auth" };
    const hasLocal = (typeof window !== "undefined" && window.localExecutorAvailable !== false);
    const isAlreadyLocal = curModel === "tendon-local" || curModel.startsWith("tendon") || curModel.startsWith("local");

    const isShuffleAi = curModel === "gemini-3.8-flash" || curModel.startsWith("gemini") || curModel === "default" ||
      (typeof window !== "undefined" && window.activeExecutionMode === "shuffle") ||
      errText.includes("no organization-specific key") ||
      errText.includes("custom ai app authentication") ||
      status.actionType === "auth";

    if (isShuffleAi) {
      actionsHtml = `
        <button type="button" class="btn-error-cta" onclick="openSettingsModal('mode-shuffle')">Log In to Shuffle Cloud</button>
        <button type="button" class="btn-error-secondary" onclick="openSettingsModal('mode-shuffle')">Configure in Settings</button>
        ${(hasLocal && !isAlreadyLocal) ? `<button type="button" class="btn-error-secondary" onclick="handleReminderUseLocal()">Switch to Local GPU</button>` : ""}
      `;
    } else {
      actionsHtml = `
        <button type="button" class="btn-error-cta" onclick="openSettingsModal('mode-direct', 'key')">Configure in Settings</button>
        ${(hasLocal && !isAlreadyLocal) ? `<button type="button" class="btn-error-secondary" onclick="handleReminderUseLocal()">Switch to Local GPU</button>` : ""}
      `;
    }
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

function toggleCommandExpansion(id, event) {
  if (event) event.stopPropagation();
  const textEl = document.getElementById("cmd-text-" + id);
  const btnEl = document.getElementById("cmd-exp-" + id);
  if (!textEl) return;
  const isExp = textEl.classList.toggle("expanded");
  if (btnEl) {
    btnEl.classList.toggle("expanded", isExp);
  }
}

function checkCommandClamping(id) {
  const textEl = document.getElementById("cmd-text-" + id);
  const btnEl = document.getElementById("cmd-exp-" + id);
  if (textEl && btnEl) {
    const isMultiLine = (textEl.innerText || "").split("\n").length > 3;
    const isOverflowing = textEl.scrollHeight > textEl.clientHeight + 2;
    if (isMultiLine || isOverflowing) {
      btnEl.style.display = "inline-flex";
      textEl.style.cursor = "pointer";
      textEl.title = "Click to expand / collapse full prompt";
    } else {
      btnEl.style.display = "none";
    }
  }
}

function renderTurnElement(turn, index) {
  const turnEl = document.createElement("div");
  turnEl.className = "transcript-turn";
  turnEl.id = "transcript-turn-" + (turn.id || index);
  turnEl.style.display = "flex";
  turnEl.style.flexDirection = "column";
  turnEl.style.gap = "8px";

  // 1. User Prompt (full width, max 3 rows unless expanded, sticky at the top, includes running status if active)
  const isActuallyRunning = (typeof isPromptExecuting !== "undefined" && isPromptExecuting) &&
    (activeConversationId === (typeof runningConversationId !== "undefined" ? runningConversationId : activeConversationId));
  const isRunning = (turn.status === "running" || turn.status === "in_progress") && isActuallyRunning;

  if ((turn.status === "running" || turn.status === "in_progress") && !isActuallyRunning) {
    turn.status = turn.output ? "success" : "interrupted";
  }

  if (turn.prompt) {
    const currentModelName = (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || "gemini-3.8-flash";
    const modelDisplay = resolveModelDisplayName(currentModelName);
    const isLocal = currentModelName.startsWith("tendon") || currentModelName.startsWith("local") || currentModelName === "custom";
    const initialPhase = turn.phase || (isLocal ? "Starting Local LLM..." : "Querying AI Model...");

    const promptRow = document.createElement("div");
    promptRow.className = "user-turn-row sticky-turn-command" + (isRunning ? " is-running" : "");
    promptRow.id = `turn-prompt-${turn.id || index}`;

    promptRow.innerHTML = `
      <div class="user-command-box">
        <div class="user-command-main">
          <div class="user-command-text" id="cmd-text-${turn.id || index}" onclick="toggleCommandExpansion('${turn.id || index}', event)">${escapeHtml(turn.prompt)}</div>
          <button type="button" class="btn-command-expand" id="cmd-exp-${turn.id || index}" title="Expand / collapse full prompt" onclick="toggleCommandExpansion('${turn.id || index}', event)">
            <svg class="cmd-expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
        ${isRunning ? `
          <div class="user-command-meta-bar" id="cmd-meta-${turn.id || index}">
            <div class="user-command-meta-left">
              <svg class="running-task-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="9" stroke-dasharray="28 28"/>
              </svg>
              <span class="cmd-meta-status">Processing with ${escapeHtml(modelDisplay)}</span>
              <span id="live-phase-${turn.id || index}" class="cmd-meta-phase">${escapeHtml(initialPhase)}</span>
              <span id="live-dur-${turn.id || index}" class="cmd-meta-dur">${escapeHtml(turn.duration || "0s")}</span>
            </div>
            <button class="btn-command-stop" type="button" onclick="stopExecution()" title="Stop prompt execution">
              Stop
            </button>
          </div>
        ` : ""}
      </div>
    `;
    turnEl.appendChild(promptRow);

    // Check if prompt exceeds 3 lines to reveal expansion button
    setTimeout(() => {
      checkCommandClamping(turn.id || index);
    }, 10);
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
      stepRow.id = `step-row-${turn.id || index}-${step.id || Math.random().toString(36).substr(2, 6)}`;

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

  // 3. Assistant Output Stream (no separate running indicator area at bottom!)
  if (turn.status === "running") {
    // If there is any streaming partial text in turn.output, display it cleanly
    if (turn.output && turn.output.trim().length > 0) {
      const assistantTurn = document.createElement("div");
      assistantTurn.className = "assistant-turn-content";
      assistantTurn.innerHTML = `
        <div class="assistant-markdown-stream">
          ${renderMarkdown(turn.output)}<span class="streaming-cursor"></span>
        </div>
      `;
      turnEl.appendChild(assistantTurn);
    }
  } else if (turn.output || turn.error || (turn.status && turn.status !== "running")) {
    const isCancelled = turn.error_type === "user_cancelled" ||
      (turn.error && turn.error.toLowerCase().includes("cancelled"));

    if (isCancelled) {
      // "Cancelled" is an expandable dropdown with no color, spacing only
      const cancelRow = document.createElement("div");
      cancelRow.className = "activity-step-row expanded cancellation-step";
      cancelRow.id = "cancel-row-" + (turn.id || index);
      cancelRow.innerHTML = `
        <div class="activity-step-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="activity-step-left">
            <span class="activity-step-title">${escapeHtml(turn.error || "Generation cancelled by user")}</span>
          </div>
          <div class="activity-step-chevron">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </div>
        <div class="activity-step-content cancellation-content">
          <div class="cancellation-actions">
            <button type="button" class="btn-clean-retry" onclick="retryCardPrompt(this)">Retry</button>
          </div>
        </div>
      `;
      turnEl.appendChild(cancelRow);
    } else {
      const isError = turn.status === "error" || (turn.output && turn.output.startsWith("Error:")) || !!turn.error;
      const errText = (turn.error || turn.output || "").toLowerCase();
      const info = turn.debug_info || {};

      let diffFooter = "";
      const changed = turn.changed_files;
      if (changed && changed.total_files > 0) {
        diffFooter = `
          <div class="turn-changes-footer" onclick="openReviewSidebar(${index})">
            <div class="turn-changes-left">
              <span class="turn-changes-count">${changed.total_files} file${changed.total_files > 1 ? 's' : ''} changed</span>
              <span class="turn-changes-add">+${changed.additions || 0}</span>
              <span class="turn-changes-del">-${changed.deletions || 0}</span>
              <svg class="turn-changes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
            <button type="button" class="btn-review-changes" onclick="event.stopPropagation(); openReviewSidebar(${index})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              <span>Review</span>
            </button>
          </div>
        `;
      }

      const assistantTurn = document.createElement("div");
      assistantTurn.className = isError ? "assistant-turn-content error" : "assistant-turn-content";
      assistantTurn.innerHTML = `
        <div class="assistant-markdown-stream">
          ${buildErrorArea(isError, errText, info, turn.prompt, turn.output || turn.error)}
        </div>
        ${diffFooter}
      `;
      turnEl.appendChild(assistantTurn);
    }
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

  let diffFooter = "";
  const changed = item.changed_files;
  if (changed && changed.total_files > 0) {
    diffFooter = `
      <div class="turn-changes-footer" onclick="openReviewSidebar()">
        <div class="turn-changes-left">
          <span class="turn-changes-count">${changed.total_files} file${changed.total_files > 1 ? 's' : ''} changed</span>
          <span class="turn-changes-add">+${changed.additions || 0}</span>
          <span class="turn-changes-del">-${changed.deletions || 0}</span>
          <svg class="turn-changes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <button type="button" class="btn-review-changes" onclick="event.stopPropagation(); openReviewSidebar()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Review</span>
        </button>
      </div>
    `;
  }

  const card = document.createElement("div");
  card.className = isError ? "assistant-turn-content error" : "assistant-turn-content";
  card.innerHTML = `
    <div class="assistant-markdown-stream">
      ${buildErrorArea(isError, errText, info, item.prompt, item.output || item.error)}
    </div>
    ${diffFooter}
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
  card.className = "assistant-turn-content error";
  card.innerHTML = `
    <div class="assistant-markdown-stream">
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
    const archiveBtn = document.getElementById("btn-archive-active-chat");
    if (archiveBtn) archiveBtn.style.display = "none";
    if (mainContainer) mainContainer.classList.remove("has-history");
    if (topbarProj) {
      const activeProjectEl = document.getElementById("active-project-name");
      const activeDisplay = activeProjectEl ? activeProjectEl.innerText : "";
      topbarProj.innerText = activeDisplay || (activeProjectPath ? (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "No project");
    }
    return;
  }

  const conv = appConversations.find(c => c.id === activeConversationId);
  if (!conv) return;

  setChatMode(true);
  if (mainContainer) mainContainer.classList.add("has-history");
  const activeProjName = conv.projectName || conv.project_name || (conv.projectId === "" || conv.project_id === "" ? "No project" : "Orborus Agent Runner");
  if (topbarProj) topbarProj.innerText = activeProjName;
  if (topbarConv) topbarConv.innerText = conv.title || "Conversation";
  const archiveBtn = document.getElementById("btn-archive-active-chat");
  if (archiveBtn) {
    archiveBtn.style.display = "inline-flex";
    if (conv.archived || conv.is_archived) {
      archiveBtn.title = "Restore conversation to sidebar";
      archiveBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="12" y1="16" x2="12" y2="11"/>
          <polyline points="9 13 12 10 15 13"/>
        </svg>
      `;
      archiveBtn.onclick = (e) => unarchiveConversation(conv.id, e);
    } else {
      archiveBtn.title = "Archive conversation (moves to Conversation History)";
      archiveBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
      `;
      archiveBtn.onclick = (e) => archiveConversation(conv.id, e);
    }
  }

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

    // Render queued prompts if any are pending in memory
    if (promptMessageQueue && promptMessageQueue.length > 0) {
      promptMessageQueue.forEach((queuedItem, qIdx) => {
        const queuedCard = document.createElement("div");
        queuedCard.className = "queued-turn-card";
        queuedCard.innerHTML = `
          <div class="queued-turn-header">
            <div class="queued-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              QUEUED (#${qIdx + 1})
            </div>
            <button class="btn-cancel-queued" type="button" onclick="cancelQueuedPrompt('${queuedItem.id}')" title="Remove from queue">
              Cancel
            </button>
          </div>
          <div class="queued-prompt-text">${escapeHtml(queuedItem.prompt)}</div>
          <div class="queued-status-hint">
            <span class="spinner" style="width:8px; height:8px; border-width:1.5px;"></span>
            Will run automatically once the current prompt completes
          </div>
        `;
        turnsContainer.appendChild(queuedCard);
      });
    }
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

// --- Real-time Local LLM & Engine Progress Handler ---
window.onAgentProgress = function(data) {
  if (!data) return;
  const phase = data.phase || "Processing";
  const detail = data.detail || "";
  const pct = typeof data.progress === "number" ? data.progress : null;

  const phaseText = pct !== null ? `${phase} (${pct}%): ${detail}` : `${phase}: ${detail}`;

  // 1. Update live phase in all active/running turn headers
  const phaseEls = document.querySelectorAll(".cmd-meta-phase");
  phaseEls.forEach(el => {
    el.innerText = phaseText;
    el.title = detail || phase;
    el.setAttribute("data-backend-driven", "true");
  });

  // 2. Also update running conversation turn steps if present
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c.id === activeConversationId);
    if (curConv && curConv.turns && curConv.turns.length > 0) {
      const activeTurn = curConv.turns[curConv.turns.length - 1];
      if (activeTurn && activeTurn.status === "running") {
        activeTurn.phase = phaseText;
        if (!activeTurn.steps) activeTurn.steps = [];

        // Check if step for this phase already exists
        const stepId = "step-" + phase.toLowerCase().replace(/[^a-z0-9]/g, "-");
        let existingStep = activeTurn.steps.find(s => s.id === stepId);
        if (!existingStep) {
          existingStep = {
            id: stepId,
            name: phase,
            duration: pct !== null ? `${pct}%` : "Active",
            detail: detail,
            type: "thought"
          };
          activeTurn.steps.push(existingStep);
        } else {
          existingStep.duration = pct !== null ? `${pct}%` : "Active";
          existingStep.detail = detail;
        }

        // Fast DOM update for steps if container exists
        const stepsContainer = document.getElementById("turn-steps-" + (activeTurn.id || (curConv.turns.length - 1)));
        if (stepsContainer) {
          const stepRow = document.getElementById("step-row-" + stepId);
          if (stepRow) {
            const titleEl = stepRow.querySelector(".activity-step-title");
            if (titleEl && typeof formatStepTitleHtml === "function") {
              titleEl.innerHTML = formatStepTitleHtml(existingStep);
            }
            const contentEl = stepRow.querySelector(".activity-step-content");
            if (contentEl) contentEl.innerText = detail;
          } else {
            const newRow = document.createElement("div");
            newRow.className = "activity-step-row expanded";
            newRow.id = "step-row-" + stepId;
            newRow.innerHTML = `
              <div class="activity-step-header" onclick="this.parentElement.classList.toggle('expanded')">
                <div class="activity-step-left">
                  <span class="activity-step-title">${typeof formatStepTitleHtml === "function" ? formatStepTitleHtml(existingStep) : escapeHtml(phase)}</span>
                </div>
                <div class="activity-step-chevron">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </div>
              </div>
              <div class="activity-step-content">${escapeHtml(detail)}</div>
            `;
            stepsContainer.appendChild(newRow);
          }
        }
      }
    }
  }
};

// Initialize controls and right sidebar overview on page load
document.addEventListener("DOMContentLoaded", () => {
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
  if (typeof updateActiveReasoningLabel === "function") {
    updateActiveReasoningLabel();
  }
  if (typeof loadRightSidebarOverview === "function") {
    loadRightSidebarOverview();
  }
});

