// --- Auth State, Settings Modal, AI Model Configuration & Skills Management ---
function isAuthErrorString(txt) {
  if (!txt) return false;
  const lower = String(txt).toLowerCase();
  return lower.includes("no llm apikey") ||
         lower.includes("missing_credentials") ||
         lower.includes("ai provider not configured") ||
         lower.includes("custom ai app authentication") ||
         lower.includes("no llm url") ||
         lower.includes("missing_onprem_ai_config") ||
         lower.includes("failed to start ai agent (6)") ||
         lower.includes("authorization can't be empty");
}

function dismissAuthErrorsIfConfigured() {
  const effectiveKey = currentAiKey || localStorage.getItem("orborus_ai_key") || "";
  const effectiveUrl = currentAiUrl || localStorage.getItem("orborus_ai_url") || "";
  if (!effectiveKey && !effectiveUrl && !isLoggedIn && !isBypassed) return;

  // 1. Clean appConversations turns across all stored conversations
  if (Array.isArray(appConversations)) {
    let changed = false;
    appConversations.forEach(conv => {
      if (Array.isArray(conv.turns)) {
        const initialLen = conv.turns.length;
        conv.turns = conv.turns.filter(t => {
          if (t.status === "error" || t.error) {
            const err = (t.error || t.output || "") + " " + (t.error_type || "");
            if (isAuthErrorString(err)) {
              return false; // remove stale auth failure turn
            }
          }
          return true;
        });
        if (conv.turns.length !== initialLen) {
          changed = true;
        }
      }
    });
    if (changed) {
      saveStoredConversations();
      renderActiveConversation();
    }
  }

  // 2. Remove any standalone DOM error cards in execution-cards-container or turns container
  document.querySelectorAll(".exec-card-error, .compact-error-area").forEach(el => {
    const text = el.innerText || "";
    if (isAuthErrorString(text)) {
      const parentCard = el.closest(".exec-card, .transcript-turn");
      if (parentCard) {
        parentCard.remove();
      } else {
        el.remove();
      }
    }
  });

  // 3. Clear active-user-prompt-card if it belongs to a failed auth execution
  const promptCard = document.getElementById("active-user-prompt-card");
  if (promptCard && (!activeRunningTasks || activeRunningTasks.length === 0)) {
    promptCard.style.display = "none";
    promptCard.innerText = "";
  }
}

function updateAuthState(state) {
  isLoggedIn = !!state.is_logged_in;
  isBypassed = !!state.is_bypassed;
  if (state.ai_api_url !== undefined) currentAiUrl = state.ai_api_url;
  if (state.ai_api_key !== undefined) currentAiKey = state.ai_api_key;
  if (state.permission_policy !== undefined) currentPermissionPolicy = state.permission_policy;
  if (state.sandbox_mode !== undefined) currentSandboxMode = state.sandbox_mode;
  if (state.queued_messages !== undefined) currentQueuedMessages = state.queued_messages;
  if (state.terminal_execution_policy !== undefined) currentTerminalExecutionPolicy = state.terminal_execution_policy;
  if (state.file_access_policy !== undefined) currentFileAccessPolicy = state.file_access_policy;
  if (state.project_permissions !== undefined) currentProjectPermissions = state.project_permissions;

  if (currentAiKey || currentAiUrl || isLoggedIn || isBypassed) {
    dismissAuthErrorsIfConfigured();
  }

  const dot = document.getElementById("status-indicator-dot");
  const label = document.getElementById("status-indicator-label");
  const subtext = document.getElementById("status-subtext");
  const details = document.getElementById("status-details-box");
  const btnAuth = document.getElementById("btn-auth-action");
  const btnLabel = document.getElementById("lbl-btn-auth");
  const lblOrg = document.getElementById("lbl-org");
  const lblEnv = document.getElementById("lbl-env");

  const inputBaseUrl = document.getElementById("input-base-url");
  const inputOrgId = document.getElementById("input-org-id");
  const inputAuthKey = document.getElementById("input-auth-key");
  const inputEnvName = document.getElementById("input-env-name");
  if (inputBaseUrl && state.base_url) inputBaseUrl.value = state.base_url;
  if (inputOrgId && state.org_id) inputOrgId.value = state.org_id;
  if (inputAuthKey && state.auth) inputAuthKey.value = state.auth;
  if (inputEnvName && state.environment) inputEnvName.value = state.environment;

  const authStatusDot = document.getElementById("settings-auth-status-dot");
  const authStatusText = document.getElementById("settings-auth-status-text");
  const footerDot = document.getElementById("footer-status-dot");
  const footerEnv = document.getElementById("footer-env-label");
  const footerModelSelect = document.getElementById("select-footer-model");
  const customInput = document.getElementById("input-custom-model");
  if (footerModelSelect) {
    if (activeAiModel === "gemini-3.8-flash") {
      footerModelSelect.value = "gemini-3.8-flash";
      if (customInput) customInput.style.display = "none";
    } else {
      footerModelSelect.value = "custom";
      if (customInput) {
        customInput.style.display = "inline-block";
        customInput.value = activeAiModel;
      }
    }
  }

  const hasCustomAi = !!(currentAiKey || currentAiUrl);
  if (hasCustomAi) {
    if (dot) dot.className = "status-dot connected";
    if (label) label.innerText = "Custom AI Configured";
    if (subtext) subtext.innerText = currentAiKey ? "Custom API key configured and active." : "Custom LLM endpoint active.";
    if (details) details.classList.add("visible");
    if (lblOrg) lblOrg.innerText = state.org_id || "standalone";
    if (lblEnv) lblEnv.innerText = state.environment || "standalone";
    if (btnAuth) {
      btnAuth.className = "status-btn btn-manage";
      if (btnLabel) btnLabel.innerText = "Manage Authentication";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (authStatusDot) authStatusDot.className = "status-dot connected";
    const endpointLabel = currentAiUrl ? currentAiUrl : (activeAiModel || "Gemini");
    if (authStatusText) authStatusText.innerText = "Custom AI Active (" + endpointLabel + ")";
    if (footerDot) footerDot.className = "status-dot connected";
    if (footerEnv) footerEnv.innerText = "Custom AI Configured";
  } else if (isLoggedIn) {
    if (dot) dot.className = "status-dot connected";
    if (label) {
      label.innerText = isBypassed ? "Ready (Standalone)" : "Connected via OAuth2";
    }
    if (subtext) {
      subtext.innerText = isBypassed ? "Local execution active. Shuffle login optional." : "Authenticated with Shuffle.";
    }
    if (details) details.classList.add("visible");
    if (lblOrg) lblOrg.innerText = state.org_id || "configured";
    if (lblEnv) lblEnv.innerText = state.environment || "configured";
    if (btnAuth) {
      btnAuth.className = "status-btn btn-manage";
      if (btnLabel) btnLabel.innerText = isBypassed ? "Manage Authentication" : "Connected to Shuffle";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (authStatusDot) authStatusDot.className = "status-dot connected";
    if (authStatusText) authStatusText.innerText = "Connected to Shuffle (" + (state.environment || "Active") + ")";
    if (footerDot) footerDot.className = "status-dot connected";
    if (footerEnv) footerEnv.innerText = isBypassed ? "Shuffle Standalone" : (state.environment || "Shuffle Connected");
  } else {
    if (dot) dot.className = "status-dot standalone";
    if (label) label.innerText = "Standalone Mode";
    if (subtext) subtext.innerText = "Shuffle login is optional. Configure AI credentials or log in with OAuth.";
    if (details) details.classList.remove("visible");
    if (btnAuth) {
      btnAuth.className = "status-btn btn-login";
      if (btnLabel) btnLabel.innerText = "Log in with Shuffle";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (authStatusDot) authStatusDot.className = "status-dot standalone";
    if (authStatusText) authStatusText.innerText = "Not Connected (Standalone / Local)";
    if (footerDot) footerDot.className = "status-dot disconnected";
    if (footerEnv) footerEnv.innerText = "Shuffle Standalone";
  }

  updateEnvDisplayInModal();
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
}

function handleAuthAction() {
  openSettingsModal();
  switchSettingsTab("auth");
}

function openLoginModal() {
  openSettingsModal();
  switchSettingsTab("auth");
}

function closeLoginModal() {
  closeSettingsModal();
}

async function submitOAuthToken() {
  const tokenInput = document.getElementById("input-oauth-token");
  const orgInput = document.getElementById("input-org-id");
  const envInput = document.getElementById("input-env-name");
  const token = tokenInput ? tokenInput.value.trim() : "";
  const org = orgInput ? orgInput.value.trim() : "";
  const env = envInput ? envInput.value.trim() : "";

  if (!token) {
    showToast("Please enter an OAuth2 token or session key");
    return;
  }

  if (window.setOAuthToken) {
    try {
      const raw = await window.setOAuthToken(token, org, env);
      const res = JSON.parse(raw);
      updateAuthState(res);
      showToast("Shuffle OAuth2 session connected");
    } catch (err) {
      console.error("Failed to set OAuth token:", err);
      showToast("Failed to connect OAuth session");
    }
  }
}

async function submitAuth() {
  const baseUrlInput = document.getElementById("input-base-url");
  const orgIdInput = document.getElementById("input-org-id");
  const authKeyInput = document.getElementById("input-auth-key");
  const envNameInput = document.getElementById("input-env-name");

  const baseUrl = baseUrlInput ? baseUrlInput.value.trim() : "";
  const orgId = orgIdInput ? orgIdInput.value.trim() : "";
  const auth = authKeyInput ? authKeyInput.value.trim() : "";
  const env = envNameInput ? envNameInput.value.trim() : "";

  if (window.updateAuth) {
    try {
      const raw = await window.updateAuth({
        base_url: baseUrl,
        org_id: orgId,
        auth: auth,
        environment: env
      });
      const state = JSON.parse(raw);
      updateAuthState(state);
      showToast("Credentials saved");
    } catch (err) {
      console.error("Failed to update credentials:", err);
      showToast("Failed to save credentials");
    }
  }
}

function getFriendlyModelName(modelId) {
  if (typeof resolveModelDisplayName === "function") {
    return resolveModelDisplayName(modelId);
  }
  const map = {
    "tendon-local": "Gemma-4-26B",
    "gemini-3.8-flash": "Gemini-3.8-Flash",
    "gemini-3.8-flash-high": "Gemini 3.8 Flash High",
    "gemini-3.8-pro": "Gemini 3.8 Pro",
    "claude-3-7-sonnet": "Claude 3.7 Sonnet",
    "claude-3-5-sonnet": "Claude 3.5 Sonnet",
    "gpt-4o": "GPT-4o"
  };
  return map[modelId] || modelId || "Gemini-3.8-Flash";
}

function openSettingsModal(initialTab, focusField) {
  const modal = document.getElementById("settings-modal");
  if (modal) {
    modal.classList.add("visible");
  }

  try {
    const urlInput = document.getElementById("input-ai-url");
    const keyInput = document.getElementById("input-ai-key");
    const modelSelect = document.getElementById("select-ai-model");
    const globalPreset = document.getElementById("select-global-preset");
    const globalFileAccess = document.getElementById("select-global-file-access");
    const globalTerminal = document.getElementById("select-global-terminal-policy");
    const globalSandbox = document.getElementById("toggle-global-sandbox");

    if (urlInput) urlInput.value = currentAiUrl || localStorage.getItem("orborus_ai_url") || "";
    if (keyInput) keyInput.value = currentAiKey || localStorage.getItem("orborus_ai_key") || "";
    populateAiModelSelect();
    if (globalPreset) globalPreset.value = currentPermissionPolicy || "ask_all";
    if (globalFileAccess) globalFileAccess.value = currentFileAccessPolicy || "ask";
    if (globalTerminal) globalTerminal.value = currentTerminalExecutionPolicy || "sandbox";
    if (globalSandbox) globalSandbox.checked = currentSandboxMode !== false;
    const modelsDirInput = document.getElementById("input-local-models-dir");
    if (modelsDirInput) {
      modelsDirInput.value = window.localModelsDir || localStorage.getItem("orborus_local_models_dir") || "models";
    }

    setQueuedMessageMode(currentQueuedMessages || "queue");
  } catch (err) {
    console.warn("Error setting modal input values:", err);
  }

  try {
    renderSettingsProjectsList();
  } catch (err) {
    console.warn("Error rendering settings projects:", err);
  }

  try {
    const targetTab = initialTab || (activeSettingsTab && !activeSettingsTab.startsWith("project:") ? activeSettingsTab : "general");
    switchSettingsTab(targetTab);
    updateEnvDisplayInModal();
    updateModesDisplay();
    if (targetTab === "models" || targetTab === "mode-direct" || targetTab === "direct") {
      setTimeout(() => {
        if (focusField === "model") {
          const byokInput = document.getElementById("input-byok-model-name");
          if (byokInput) {
            byokInput.focus();
            byokInput.select();
          } else {
            const customModelInput = document.getElementById("input-settings-custom-model");
            const modelSelect = document.getElementById("select-ai-model");
            if (customModelInput && (modelSelect && modelSelect.value === "custom" || customModelInput.style.display !== "none")) {
              customModelInput.style.display = "block";
              customModelInput.focus();
            } else if (modelSelect) {
              modelSelect.focus();
            }
          }
        } else if (focusField === "url") {
          const urlInput = document.getElementById("input-ai-url");
          if (urlInput) urlInput.focus();
        } else {
          const keyInput = document.getElementById("input-ai-key");
          if (keyInput) keyInput.focus();
        }
      }, 60);
    } else if (targetTab === "auth" || targetTab === "mode-shuffle") {
      setTimeout(() => {
        const tokenInput = document.getElementById("input-oauth-token");
        if (tokenInput) tokenInput.focus();
      }, 60);
    }
  } catch (err) {
    console.warn("Error switching tab in modal:", err);
  }
}

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
  if (typeof checkModalActive === "function") {
    checkModalActive();
  }
}

function setQueuedMessageMode(mode) {
  currentQueuedMessages = mode;
  const btnQueue = document.getElementById("btn-queue-mode-queue");
  const btnImm = document.getElementById("btn-queue-mode-immediate");
  if (btnQueue && btnImm) {
    if (mode === "immediate") {
      btnQueue.classList.remove("active");
      btnImm.classList.add("active");
    } else {
      btnQueue.classList.add("active");
      btnImm.classList.remove("active");
    }
  }
}

function handleGlobalPresetChange() {
  const presetEl = document.getElementById("select-global-preset");
  if (!presetEl) return;
  const preset = presetEl.value;
  const fileAccess = document.getElementById("select-global-file-access");
  const terminal = document.getElementById("select-global-terminal-policy");
  if (preset === "ask_all") {
    if (fileAccess) fileAccess.value = "ask";
    if (terminal) terminal.value = "sandbox";
  } else if (preset === "safe_auto") {
    if (fileAccess) fileAccess.value = "read_only";
    if (terminal) terminal.value = "safe_auto";
  } else if (preset === "full_auto") {
    if (fileAccess) fileAccess.value = "allow_all";
    if (terminal) terminal.value = "full_auto";
  }
}

function switchSettingsTab(tabName) {
  if (tabName && tabName.startsWith("project:")) {
    const projPath = tabName.replace("project:", "");
    selectSettingsProject(projPath);
    return;
  }

  activeSettingsTab = tabName;
  activeSettingsProject = null;

  // Clear sidebar active highlights
  document.querySelectorAll(".settings-nav-item").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".settings-panel").forEach(el => el.classList.remove("active"));

  const titleEl = document.getElementById("settings-view-title");
  const descEl = document.getElementById("settings-view-desc");

  if (tabName === "modes-overview") {
    switchSettingsTab("mode-shuffle");
    return;
  } else if (tabName === "mode-shuffle" || tabName === "auth") {
    activeSettingsTab = "mode-shuffle";
    const btn = document.getElementById("settings-tab-btn-mode-shuffle") || document.getElementById("settings-tab-btn-auth");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-mode-shuffle") || document.getElementById("settings-panel-auth");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Shuffle (OAuth2 Login) — Optional";
    if (descEl) descEl.innerText = "Optional: Connect to Shuffle via OAuth2 for managed Shuffle AI and workflow sync.";
    updateModesDisplay();
  } else if (tabName === "mode-orborus") {
    activeSettingsTab = "mode-orborus";
    const btn = document.getElementById("settings-tab-btn-mode-orborus");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-mode-orborus");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Shuffle (Self-Hosted / Org ID) — Optional";
    if (descEl) descEl.innerText = "Optional: Connect to a self-hosted Shuffle server/cluster via Org ID, Auth Key, and Base URL.";
    updateModesDisplay();
  } else if (tabName === "mode-direct" || tabName === "direct" || tabName === "models") {
    activeSettingsTab = "mode-direct";
    const btn = document.getElementById("settings-tab-btn-mode-direct") || document.getElementById("settings-tab-btn-models");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-mode-direct") || document.getElementById("settings-panel-models");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Direct LLM Connection (BYOK)";
    if (descEl) descEl.innerText = "Bring your own API key for OpenAI, Anthropic Claude, or Google Gemini.";
    updateEnvDisplayInModal();
    updateModesDisplay();
  } else if (tabName === "mode-local" || tabName === "local") {
    activeSettingsTab = "mode-local";
    const btn = document.getElementById("settings-tab-btn-mode-local");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-mode-local");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Local GPU Engine (CUDA)";
    if (descEl) descEl.innerText = "Offline execution on your RTX 3080 Ti (12GB VRAM). Direct VRAM, 0 host RAM overhead.";
    loadLocalModelsSettings();
    updateModesDisplay();
  } else if (tabName === "skills") {
    const btn = document.getElementById("settings-tab-btn-skills");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-skills");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Agent Skills & Capabilities";
    if (descEl) descEl.innerText = "Inject SKILL.md files or custom skill capabilities into the agent runner.";
    loadAndRenderSkills();
  } else {
    // Default: general
    activeSettingsTab = "general";
    const btn = document.getElementById("settings-tab-btn-general");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-general");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "General";
    if (descEl) descEl.innerText = "Configure agent execution, queued message delivery, and permissions.";
  }
}

// --- 4 Execution Modes Control & Telemetry ---
function updateModesDisplay() {
  const orgInput = document.getElementById("input-org-id");
  const envInput = document.getElementById("input-env-name");
  const metaOrg = document.getElementById("meta-org-orborus");
  const metaEnv = document.getElementById("meta-env-orborus");
  if (metaOrg && orgInput && orgInput.value.trim()) metaOrg.innerText = orgInput.value.trim();
  if (metaEnv && envInput && envInput.value.trim()) metaEnv.innerText = envInput.value.trim();

  const metaModelDirect = document.getElementById("meta-model-direct");
  const metaKeyDirect = document.getElementById("meta-key-direct");
  const hasDirectKey = !!(currentAiKey || localStorage.getItem("orborus_ai_key"));
  if (metaModelDirect) metaModelDirect.innerText = activeAiModel || "gpt-4o";
  if (metaKeyDirect) metaKeyDirect.innerText = hasDirectKey ? "Configured" : "Not configured";

  const metaWeightLocal = document.getElementById("meta-weight-local");
  const activeWeight = (window.localModelPath ? window.localModelPath.split(/[\\/]/).pop() : "No model loaded");
  if (metaWeightLocal) metaWeightLocal.innerText = activeWeight;
}

async function activateExecutionMode(mode) {
  if (!mode) return;
  const cleanMode = mode.toLowerCase().trim();
  window.activeExecutionMode = cleanMode;
  localStorage.setItem("orborus_active_execution_mode", cleanMode);

  if (typeof window.bridgeCall === "function") {
    try {
      await window.bridgeCall("setActiveExecutionMode", JSON.stringify({ mode: cleanMode }));
    } catch (e) {}
  }

  updateModesDisplay();
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
}

function applyDirectLlmPreset(preset) {
  const urlInput = document.getElementById("input-ai-url");
  const modelInput = document.getElementById("input-byok-model-name");
  const modelSelect = document.getElementById("select-ai-model");
  if (!preset) return;
  let targetUrl = "";
  let targetModel = "";

  if (preset === "openai") {
    targetUrl = "https://api.openai.com/v1";
    targetModel = "gpt-4o";
  } else if (preset === "anthropic") {
    targetUrl = "https://api.anthropic.com/v1";
    targetModel = "claude-3-7-sonnet";
  } else if (preset === "gemini") {
    targetUrl = "https://generativelanguage.googleapis.com/v1beta";
    targetModel = "gemini-2.5-flash";
  } else if (preset === "deepseek") {
    targetUrl = "https://api.deepseek.com/v1";
    targetModel = "deepseek-chat";
  } else if (preset === "groq") {
    targetUrl = "https://api.groq.com/openai/v1";
    targetModel = "llama-3.3-70b-versatile";
  } else if (preset === "ollama") {
    targetUrl = "http://localhost:11434/v1";
    targetModel = "llama3.2";
  } else if (preset === "openrouter") {
    targetUrl = "https://openrouter.ai/api/v1";
    targetModel = "openai/gpt-4o";
  } else if (preset === "custom") {
    targetUrl = "http://localhost:8000/v1";
    targetModel = modelInput && modelInput.value.trim() ? modelInput.value.trim() : "custom-model";
  }

  if (targetUrl && urlInput) urlInput.value = targetUrl;
  if (targetModel) {
    if (modelInput) modelInput.value = targetModel;
    if (modelSelect) modelSelect.value = targetModel;
    if (typeof addCustomByokModel === "function") {
      addCustomByokModel(targetModel);
    }
    activeAiModel = targetModel;
    localStorage.setItem("orborus_ai_model", targetModel);
  }

  updateEnvDisplayInModal();
  renderByokModelsSettings();
  populateAiModelSelect();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
}

function renderByokModelsSettings() {
  const container = document.getElementById("byok-models-tags-container");
  const modelInput = document.getElementById("input-byok-model-name");
  const curModel = (activeAiModel || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gpt-4o").trim();

  if (modelInput && (!modelInput.value || document.activeElement !== modelInput)) {
    modelInput.value = curModel;
  }

  if (!container) return;
  container.innerHTML = "";

  const standardPresets = ["gpt-4o", "claude-3-7-sonnet", "claude-3-5-sonnet"];
  const customList = (typeof getCustomByokModels === "function") ? getCustomByokModels() : [];
  const allModels = [];

  standardPresets.forEach(m => {
    allModels.push({ key: m, isCustom: false });
  });

  customList.forEach(m => {
    if (!allModels.some(existing => existing.key.toLowerCase() === m.toLowerCase())) {
      allModels.push({ key: m, isCustom: true });
    }
  });

  allModels.forEach(item => {
    const isSelected = item.key.toLowerCase() === curModel.toLowerCase();
    const tag = document.createElement("div");
    tag.className = "byok-model-tag" + (isSelected ? " active" : "");
    tag.onclick = () => selectByokModelTag(item.key);

    const labelSpan = document.createElement("span");
    labelSpan.textContent = item.key;
    tag.appendChild(labelSpan);

    if (isSelected) {
      const checkIcon = document.createElement("span");
      checkIcon.className = "byok-tag-check";
      checkIcon.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      tag.appendChild(checkIcon);
    }

    if (item.isCustom) {
      const removeBtn = document.createElement("span");
      removeBtn.className = "byok-tag-remove";
      removeBtn.title = "Remove model";
      removeBtn.textContent = "×";
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        handleRemoveByokModel(item.key);
      };
      tag.appendChild(removeBtn);
    }

    container.appendChild(tag);
  });
}

function selectByokModelTag(modelId) {
  if (!modelId) return;
  activeAiModel = modelId;
  localStorage.setItem("orborus_ai_model", modelId);
  const modelInput = document.getElementById("input-byok-model-name");
  if (modelInput) modelInput.value = modelId;
  const modelSelect = document.getElementById("select-ai-model");
  if (modelSelect) modelSelect.value = modelId;
  renderByokModelsSettings();
  updateEnvDisplayInModal();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
}

function handleByokModelInput(value) {
  const clean = String(value || "").trim();
  if (!clean) return;
  activeAiModel = clean;
  localStorage.setItem("orborus_ai_model", clean);
  const envDisplay = document.getElementById("env-display-model");
  if (envDisplay) envDisplay.textContent = clean;
  const modelSelect = document.getElementById("select-ai-model");
  if (modelSelect) modelSelect.value = clean;
  const customInput = document.getElementById("input-settings-custom-model");
  if (customInput) customInput.value = clean;
  renderByokModelsSettings();
}

function addCurrentByokModel() {
  const input = document.getElementById("input-byok-model-name");
  const raw = input ? input.value.trim() : "";
  if (!raw) {
    showToast("Please enter a model name or ID");
    if (input) input.focus();
    return;
  }
  const added = (typeof addCustomByokModel === "function") ? addCustomByokModel(raw) : raw;
  activeAiModel = added;
  localStorage.setItem("orborus_ai_model", added);
  localStorage.setItem("orborus_custom_model", added);
  renderByokModelsSettings();
  updateEnvDisplayInModal();
  populateAiModelSelect();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
  showToast("Added model: " + added);
}

function handleRemoveByokModel(modelId) {
  if (!modelId) return;
  if (typeof removeCustomByokModel === "function") {
    removeCustomByokModel(modelId);
  }
  renderByokModelsSettings();
  updateEnvDisplayInModal();
  populateAiModelSelect();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
  showToast("Removed model: " + modelId);
}

function quickSelectByokModel(modelId) {
  if (!modelId) return;
  if (typeof addCustomByokModel === "function") {
    addCustomByokModel(modelId);
  }
  activeAiModel = modelId;
  localStorage.setItem("orborus_ai_model", modelId);
  const input = document.getElementById("input-byok-model-name");
  if (input) input.value = modelId;
  renderByokModelsSettings();
  updateEnvDisplayInModal();
  populateAiModelSelect();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
  showToast("Selected model: " + modelId);
}

async function saveDirectLlmSettings() {
  const urlInput = document.getElementById("input-ai-url");
  const keyInput = document.getElementById("input-ai-key");
  const modelInput = document.getElementById("input-byok-model-name");
  const modelSelect = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");

  let chosenModel = "";
  if (modelInput && modelInput.value.trim()) {
    chosenModel = modelInput.value.trim();
  } else if (modelSelect && modelSelect.value) {
    chosenModel = modelSelect.value;
    if (chosenModel === "custom" && customModelInput && customModelInput.value.trim()) {
      chosenModel = customModelInput.value.trim();
    }
  }

  const aiUrl = urlInput ? urlInput.value.trim() : "";
  const aiKey = keyInput ? keyInput.value.trim() : "";

  currentAiUrl = aiUrl;
  currentAiKey = aiKey;
  activeAiModel = chosenModel || "gpt-4o";

  if (activeAiModel && typeof addCustomByokModel === "function") {
    addCustomByokModel(activeAiModel);
  }

  localStorage.setItem("orborus_ai_url", aiUrl);
  localStorage.setItem("orborus_ai_key", aiKey);
  localStorage.setItem("orborus_ai_model", activeAiModel);
  localStorage.setItem("orborus_custom_model", activeAiModel);

  if (typeof window.bridgeCall === "function") {
    try {
      await window.bridgeCall("setAiConfig", JSON.stringify({
        url: aiUrl,
        key: aiKey,
        model: activeAiModel
      }));
    } catch (e) {
      console.warn("bridgeCall setAiConfig failed:", e);
    }
  }
  updateEnvDisplayInModal();
  renderByokModelsSettings();
  updateModesDisplay();
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
  if (typeof renderModelDropdown === "function") {
    renderModelDropdown();
  }
  showToast("Direct LLM configuration saved");
}

async function submitOrborusAuth() {
  await submitAuth();
  const lbl = document.getElementById("lbl-orborus-saved-status");
  if (lbl) {
    lbl.style.display = "inline";
    setTimeout(() => { lbl.style.display = "none"; }, 2500);
  }
  updateModesDisplay();
}

async function loadAndRenderSkills() {
  try {
    let raw = null;
    if (window.listSkills) {
      raw = await window.listSkills(activeProjectPath || "");
    } else if (window.bridgeCall) {
      raw = await window.bridgeCall("listSkills", activeProjectPath || "");
    }

    if (raw) {
      let res;
      try {
        res = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (e) {
        res = null;
      }
      if (res) {
        if (Array.isArray(res)) {
          currentDiscoveredSkills = res.filter(s => s.source !== "injected");
          currentInjectedSkills = res.filter(s => s.source === "injected");
        } else {
          if (Array.isArray(res.injected_skills)) currentInjectedSkills = res.injected_skills;
          if (Array.isArray(res.skills)) currentDiscoveredSkills = res.skills.filter(s => s.source !== "injected");
        }
      }
    }
  } catch (err) {
    console.warn("Failed to query skills list:", err);
  }

  renderSkillsView();
}

function renderSkillsView() {
  const injContainer = document.getElementById("injected-skills-container");
  const discContainer = document.getElementById("discovered-skills-container");

  if (injContainer) {
    if (!currentInjectedSkills || currentInjectedSkills.length === 0) {
      injContainer.innerHTML = '<div style="font-size:12px; color:var(--text-muted); font-style:italic; padding:6px 0;">No injected skills yet. Click &quot;Inject Skill File&quot; or &quot;New Custom Skill&quot; above.</div>';
    } else {
      injContainer.innerHTML = "";
      currentInjectedSkills.forEach(skill => {
        const card = document.createElement("div");
        card.className = "skill-card";
        const controlBadge = skill.is_control
          ? '<span class="skill-badge control">CONTROL</span>'
          : '';
        const descHtml = skill.description
          ? `<div class="skill-card-desc">${escapeHtml(skill.description)}</div>`
          : '';
        const pathHtml = skill.path
          ? `<div class="skill-card-path" title="${escapeHtml(skill.path)}">Path: ${escapeHtml(skill.path)}</div>`
          : '';
        const instructionsHtml = skill.instructions
          ? `<details style="margin-top:8px;">
               <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; user-select:none;">View Instructions / Procedure</summary>
               <pre class="skill-card-instructions">${escapeHtml(skill.instructions)}</pre>
             </details>`
          : '';

        card.innerHTML = `
          <div class="skill-card-header">
            <div class="skill-card-title-group">
              <span class="skill-card-name">${escapeHtml(skill.name)}</span>
              <span class="skill-badge injected">INJECTED</span>
              ${controlBadge}
            </div>
            <button type="button" class="btn-skill-revoke" onclick="removeInjectedSkill('${escapeHtml(skill.name)}')">Revoke</button>
          </div>
          ${descHtml}
          ${pathHtml}
          ${instructionsHtml}
        `;
        injContainer.appendChild(card);
      });
    }
  }

  if (discContainer) {
    if (!currentDiscoveredSkills || currentDiscoveredSkills.length === 0) {
      discContainer.innerHTML = '<div style="font-size:12px; color:var(--text-muted); font-style:italic; padding:6px 0;">No workspace or built-in skills detected.</div>';
    } else {
      discContainer.innerHTML = "";
      currentDiscoveredSkills.forEach(skill => {
        const card = document.createElement("div");
        card.className = "skill-card";
        const sourceBadge = skill.source === "project"
          ? '<span class="skill-badge project">PROJECT</span>'
          : '<span class="skill-badge global">GLOBAL</span>';
        const controlBadge = skill.is_control
          ? '<span class="skill-badge control">CONTROL</span>'
          : '';
        const descHtml = skill.description
          ? `<div class="skill-card-desc">${escapeHtml(skill.description)}</div>`
          : '';
        const pathHtml = skill.path
          ? `<div class="skill-card-path" title="${escapeHtml(skill.path)}">Path: ${escapeHtml(skill.path)}</div>`
          : '';
        const instructionsHtml = skill.instructions
          ? `<details style="margin-top:8px;">
               <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; user-select:none;">View Instructions / Procedure</summary>
               <pre class="skill-card-instructions">${escapeHtml(skill.instructions)}</pre>
             </details>`
          : '';

        card.innerHTML = `
          <div class="skill-card-header">
            <div class="skill-card-title-group">
              <span class="skill-card-name">${escapeHtml(skill.name)}</span>
              ${sourceBadge}
              ${controlBadge}
            </div>
          </div>
          ${descHtml}
          ${pathHtml}
          ${instructionsHtml}
        `;
        discContainer.appendChild(card);
      });
    }
  }
}

function toggleCustomSkillForm(forceState) {
  const box = document.getElementById("custom-skill-form-box");
  if (!box) return;
  if (typeof forceState === "boolean") {
    box.style.display = forceState ? "block" : "none";
  } else {
    box.style.display = box.style.display === "none" ? "block" : "none";
  }
  if (box.style.display === "block") {
    const input = document.getElementById("input-skill-name");
    if (input) input.focus();
  }
}

async function browseAndInjectSkillFile() {
  try {
    let raw = null;
    if (window.injectSkillFile) {
      raw = await window.injectSkillFile("");
    } else if (window.bridgeCall) {
      raw = await window.bridgeCall("injectSkillFile", JSON.stringify({ path: "" }));
    } else if (window.chooseFile) {
      const chosen = await window.chooseFile();
      let path = "";
      if (typeof chosen === "string") {
        try {
          const parsed = JSON.parse(chosen);
          if (parsed && parsed.status === "ok" && parsed.path) path = parsed.path;
        } catch (e) {
          path = chosen;
        }
      }
      if (path && path.trim()) {
        if (window.injectSkillFile) {
          raw = await window.injectSkillFile(path.trim());
        } else if (window.bridgeCall) {
          raw = await window.bridgeCall("injectSkillFile", JSON.stringify({ path: path.trim() }));
        }
      }
    }

    if (!raw) return;
    const res = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (res.status === "cancelled") {
      return;
    }
    if (res.status === "ok") {
      const skillName = res.skill ? res.skill.name : "Skill";
      showToast("Injected skill: " + skillName);
      if (res.injected_skills) {
        currentInjectedSkills = res.injected_skills;
      }
      await loadAndRenderSkills();
    } else if (res.error) {
      showToast("Failed to inject skill: " + res.error);
    }
  } catch (err) {
    console.error("Error injecting skill file:", err);
    showToast("Error injecting skill file: " + (err.message || err));
  }
}

async function submitCustomSkillForm() {
  const nameEl = document.getElementById("input-skill-name");
  const descEl = document.getElementById("input-skill-description");
  const instEl = document.getElementById("input-skill-instructions");
  const ctrlEl = document.getElementById("check-skill-control");

  const name = nameEl ? nameEl.value.trim() : "";
  const desc = descEl ? descEl.value.trim() : "";
  const inst = instEl ? instEl.value.trim() : "";
  const isCtrl = ctrlEl ? ctrlEl.checked : false;

  if (!name) {
    showToast("Please provide a skill name");
    if (nameEl) nameEl.focus();
    return;
  }

  const payload = {
    name: name,
    description: desc,
    instructions: inst,
    is_control: isCtrl,
    source: "injected"
  };

  try {
    let raw = null;
    if (window.injectSkill) {
      raw = await window.injectSkill(JSON.stringify(payload));
    } else if (window.bridgeCall) {
      raw = await window.bridgeCall("injectSkill", JSON.stringify(payload));
    }

    if (raw) {
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (res.status === "ok") {
        showToast("Skill injected: " + name);
        if (nameEl) nameEl.value = "";
        if (descEl) descEl.value = "";
        if (instEl) instEl.value = "";
        if (ctrlEl) ctrlEl.checked = false;
        toggleCustomSkillForm(false);
        if (res.injected_skills) currentInjectedSkills = res.injected_skills;
        await loadAndRenderSkills();
        return;
      } else if (res.error) {
        showToast("Failed to inject skill: " + res.error);
        return;
      }
    }
    showToast("Skill injected: " + name);
    toggleCustomSkillForm(false);
    await loadAndRenderSkills();
  } catch (err) {
    console.error("Error submitting custom skill:", err);
    showToast("Error saving skill: " + (err.message || err));
  }
}

async function removeInjectedSkill(skillName) {
  if (!skillName) return;
  try {
    let raw = null;
    if (window.removeInjectedSkill) {
      raw = await window.removeInjectedSkill(skillName);
    } else if (window.bridgeCall) {
      raw = await window.bridgeCall("removeInjectedSkill", JSON.stringify({ name: skillName }));
    }

    if (raw) {
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (res && res.injected_skills) currentInjectedSkills = res.injected_skills;
    }
    showToast("Skill removed: " + skillName);
    await loadAndRenderSkills();
  } catch (err) {
    console.error("Error removing skill:", err);
    showToast("Error removing skill: " + (err.message || err));
  }
}

function renderSettingsProjectsList() {
  const container = document.getElementById("settings-projects-list");
  if (!container) return;
  container.innerHTML = "";

  // Helper to lookup project permissions with normalized path keys
  function getProjectPerms(pPath) {
    if (!currentProjectPermissions || !pPath) return {};
    if (currentProjectPermissions[pPath]) return currentProjectPermissions[pPath];
    const norm = pPath.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    for (const k of Object.keys(currentProjectPermissions)) {
      if (k.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === norm) {
        return currentProjectPermissions[k];
      }
    }
    return {};
  }

  // Collect unique projects from allProjects or activeProjectPath
  const projectsMap = new Map();
  if (activeProjectPath) {
    let activeName = (document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : "") || "";
    if (!activeName || activeName === "Orborus Agent Runner") {
      const parts = activeProjectPath === "." ? [] : activeProjectPath.split(/[/\\]/).filter(Boolean);
      activeName = parts.length > 0 ? parts[parts.length - 1] : "Orborus Agent Runner";
    }
    projectsMap.set(activeProjectPath, { name: activeName, path: activeProjectPath });
  }

  if (Array.isArray(allProjects)) {
    allProjects.forEach(p => {
      if (!p) return;
      const pPath = typeof p === "string" ? p : (p.Path || p.path || "");
      if (!pPath) return;
      let pName = "";
      if (typeof p === "object" && (p.Name || p.name)) {
        pName = p.Name || p.name;
      } else {
        const parts = pPath.split(/[/\\]/).filter(Boolean);
        pName = parts.length > 0 ? parts[parts.length - 1] : pPath;
      }
      projectsMap.set(pPath, { name: pName, path: pPath });
    });
  }

  if (projectsMap.size === 0) {
    container.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:6px 8px;">No projects detected</div>';
    return;
  }

  projectsMap.forEach(proj => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSelectedInSettings = activeSettingsProject === proj.path || activeSettingsTab === ("project:" + proj.path);
    btn.className = "settings-nav-item project-item" + (isSelectedInSettings ? " active" : "");
    btn.dataset.projectPath = proj.path;
    const isActiveProj = proj.path === activeProjectPath;

    const badgeHtml = isActiveProj ? '<span class="settings-project-badge">Active</span>' : '';
    btn.innerHTML = `
      <div class="settings-project-label-group">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span title="${escapeHtml(proj.name)}">${escapeHtml(proj.name)}</span>
      </div>
      ${badgeHtml}
    `;

    btn.onclick = () => selectSettingsProject(proj.path, proj.name);
    container.appendChild(btn);
  });
}

function selectSettingsProject(path, name) {
  if (!path) return;
  activeSettingsTab = "project:" + path;
  activeSettingsProject = path;

  // Clear sidebar active highlights
  document.querySelectorAll(".settings-nav-item").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".settings-panel").forEach(el => el.classList.remove("active"));

  // Highlight this project button
  document.querySelectorAll(".settings-nav-item.project-item").forEach(btn => {
    if (btn.dataset.projectPath === path) {
      btn.classList.add("active");
    }
  });

  const panel = document.getElementById("settings-panel-project");
  if (panel) panel.classList.add("active");

  const displayName = name || (path === "." ? "Orborus Agent Runner" : path.split(/[/\\]/).filter(Boolean).pop()) || "Project";
  const titleEl = document.getElementById("settings-view-title");
  const descEl = document.getElementById("settings-view-desc");
  if (titleEl) titleEl.innerText = displayName;
  if (descEl) descEl.innerText = path;

  const lblName = document.getElementById("lbl-project-name");
  const lblPath = document.getElementById("lbl-project-path");
  if (lblName) lblName.innerText = displayName;
  if (lblPath) lblPath.innerText = path;

  const btnActive = document.getElementById("btn-set-active-workspace");
  if (btnActive) {
    if (path === activeProjectPath) {
      btnActive.innerText = "Active Workspace";
      btnActive.classList.add("active");
      btnActive.disabled = true;
    } else {
      btnActive.innerText = "Set as Active Workspace";
      btnActive.classList.remove("active");
      btnActive.disabled = false;
    }
  }

  // Load project permission values with path-insensitive fallback
  let perms = (currentProjectPermissions && currentProjectPermissions[path]) ? currentProjectPermissions[path] : null;
  if (!perms && currentProjectPermissions) {
    const norm = path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    for (const k of Object.keys(currentProjectPermissions)) {
      if (k.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === norm) {
        perms = currentProjectPermissions[k];
        break;
      }
    }
  }
  if (!perms) perms = {};

  const selectPreset = document.getElementById("select-project-preset");
  const selectFileAccess = document.getElementById("select-project-file-access");
  const selectTerminal = document.getElementById("select-project-terminal-policy");
  const selectSandbox = document.getElementById("select-project-sandbox");
  const inputCmds = document.getElementById("input-project-allowed-commands");

  if (selectPreset) selectPreset.value = perms.permission_policy || "inherit";
  if (selectFileAccess) selectFileAccess.value = perms.file_access_policy || "inherit";
  if (selectTerminal) selectTerminal.value = perms.terminal_execution_policy || "inherit";
  if (selectSandbox) {
    if (perms.sandbox_mode === true) {
      selectSandbox.value = "enabled";
    } else if (perms.sandbox_mode === false) {
      selectSandbox.value = "disabled";
    } else {
      selectSandbox.value = "inherit";
    }
  }
  if (inputCmds) inputCmds.value = perms.allowed_commands || "";
}

function persistProjectPermissions(projPath) {
  if (!projPath || !currentProjectPermissions || !currentProjectPermissions[projPath]) return;
  const perms = currentProjectPermissions[projPath];
  const payload = JSON.stringify({ project: projPath, permissions: perms });
  if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setProjectPermissions", payload).catch(() => {});
  } else if (typeof callGo === "function") {
    callGo("setProjectPermissions", payload).catch(() => {});
  }
}

function updateProjectSettingField(field, value) {
  if (!activeSettingsProject) return;
  if (!currentProjectPermissions) currentProjectPermissions = {};
  if (!currentProjectPermissions[activeSettingsProject]) {
    currentProjectPermissions[activeSettingsProject] = {
      permission_policy: "inherit",
      terminal_execution_policy: "inherit",
      file_access_policy: "inherit",
      sandbox_mode: null,
      allowed_commands: ""
    };
  }
  currentProjectPermissions[activeSettingsProject][field] = value;
  persistProjectPermissions(activeSettingsProject);
}

function updateProjectSandboxField(value) {
  if (!activeSettingsProject) return;
  if (!currentProjectPermissions) currentProjectPermissions = {};
  if (!currentProjectPermissions[activeSettingsProject]) {
    currentProjectPermissions[activeSettingsProject] = {
      permission_policy: "inherit",
      terminal_execution_policy: "inherit",
      file_access_policy: "inherit",
      sandbox_mode: null,
      allowed_commands: ""
    };
  }
  if (value === "enabled") {
    currentProjectPermissions[activeSettingsProject].sandbox_mode = true;
  } else if (value === "disabled") {
    currentProjectPermissions[activeSettingsProject].sandbox_mode = false;
  } else {
    currentProjectPermissions[activeSettingsProject].sandbox_mode = null;
  }
  persistProjectPermissions(activeSettingsProject);
}

async function switchActiveWorkspaceFromSettings() {
  if (!activeSettingsProject) return;
  const nameEl = document.getElementById("lbl-project-name");
  const name = nameEl ? nameEl.innerText : activeSettingsProject.split(/[/\\]/).filter(Boolean).pop() || "Project";
  await selectProject(activeSettingsProject, name);
  selectSettingsProject(activeSettingsProject, name);
  renderSettingsProjectsList();
  showToast("Switched active workspace to: " + name);
}

function populateAiModelSelect() {
  const modelSelect = document.getElementById("select-ai-model");
  renderByokModelsSettings();
  if (!modelSelect) return;

  const curVal = activeAiModel || localStorage.getItem("orborus_ai_model") || "tendon-local";
  modelSelect.innerHTML = "";

  const categories = {};
  AVAILABLE_AI_MODELS.forEach(m => {
    const cat = m.category || "Other";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(m);
  });

  const orderedCategories = ["Local Models", "BYOK Models", "Shuffle AI"];
  Object.keys(categories).forEach(c => {
    if (!orderedCategories.includes(c)) orderedCategories.push(c);
  });

  orderedCategories.forEach(catName => {
    if (!categories[catName] || categories[catName].length === 0) return;
    const optgroup = document.createElement("optgroup");
    optgroup.label = catName;

    categories[catName].forEach(m => {
      const avail = checkModelAvailability(m.key);
      const opt = document.createElement("option");
      opt.value = m.key;
      if (avail.available) {
        opt.textContent = `${m.label} (${avail.badge})`;
      } else {
        opt.textContent = `${m.label} [Unavailable: ${avail.statusText}]`;
      }
      if (m.key === curVal) {
        opt.selected = true;
      }
      optgroup.appendChild(opt);
    });

    modelSelect.appendChild(optgroup);
  });

  const customModelInput = document.getElementById("input-settings-custom-model");
  const currentOpt = modelSelect.querySelector(`option[value="${curVal}"]`);
  if (!currentOpt) {
    modelSelect.value = "custom";
    if (customModelInput) {
      customModelInput.style.display = "block";
      customModelInput.value = curVal;
    }
  } else {
    modelSelect.value = curVal;
    if (customModelInput) customModelInput.style.display = "none";
  }
}

function updateEnvDisplayInModal() {
  const urlEl = document.getElementById("env-display-url");
  const keyEl = document.getElementById("env-display-key");
  const modelEl = document.getElementById("env-display-model");
  const urlInput = document.getElementById("input-ai-url");
  const keyInput = document.getElementById("input-ai-key");
  const byokInput = document.getElementById("input-byok-model-name");
  const modelSelect = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");
  let model = (byokInput && byokInput.value.trim()) || (modelSelect && modelSelect.value) || (activeAiModel || "gemini-3.8-flash");

  if (model === "custom") {
    if (customModelInput) {
      customModelInput.style.display = "block";
      if (customModelInput.value.trim()) {
        model = customModelInput.value.trim();
      }
    }
  } else if (customModelInput) {
    customModelInput.style.display = "none";
  }

  let defaultUrl = "";
  if (model.startsWith("gemini")) {
    defaultUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
  } else if (model.startsWith("gpt")) {
    defaultUrl = "https://api.openai.com/v1";
  } else if (model.startsWith("tendon") || model.startsWith("local")) {
    defaultUrl = "http://127.0.0.1:8000/v1 (In-Process GPU)";
  }

  if (urlInput && defaultUrl) {
    urlInput.placeholder = defaultUrl + " (default)";
  }

  const effectiveUrl = (urlInput && urlInput.value.trim()) || currentAiUrl || "";
  const effectiveKey = (keyInput && keyInput.value.trim()) || currentAiKey || "";

  if (urlEl) {
    if (effectiveUrl) {
      urlEl.innerText = effectiveUrl;
    } else if (defaultUrl) {
      urlEl.innerText = defaultUrl + " (default)";
    } else {
      urlEl.innerText = "not set";
    }
  }
  if (keyEl) {
    if (effectiveKey) {
      keyEl.innerText = effectiveKey.length > 8 ? effectiveKey.substring(0, 4) + "..." + effectiveKey.substring(effectiveKey.length - 4) : "configured";
    } else if (model.startsWith("tendon") || model.startsWith("local")) {
      keyEl.innerText = "native GPU runtime (no key needed)";
    } else {
      keyEl.innerText = "not set";
    }
  }
  if (modelEl) modelEl.innerText = model;
}

async function saveSettings() {
  try {
    const urlInput = document.getElementById("input-ai-url");
    const keyInput = document.getElementById("input-ai-key");
    const byokModelInput = document.getElementById("input-byok-model-name");
    const modelSelect = document.getElementById("select-ai-model");
    const customModelInput = document.getElementById("input-settings-custom-model");
    const globalPreset = document.getElementById("select-global-preset");
    const globalFileAccess = document.getElementById("select-global-file-access");
    const globalTerminal = document.getElementById("select-global-terminal-policy");
    const globalSandbox = document.getElementById("toggle-global-sandbox");

    const url = urlInput ? urlInput.value.trim() : (currentAiUrl || "");
    let key = keyInput ? keyInput.value.trim() : "";
    if (!key && currentAiKey && activeSettingsTab !== "models" && activeSettingsTab !== "mode-direct") {
      key = currentAiKey;
    }
    let model = (byokModelInput && byokModelInput.value.trim()) || (modelSelect ? modelSelect.value : (activeAiModel || "gemini-3.8-flash"));
    if (model === "custom" && customModelInput && customModelInput.value.trim()) {
      model = customModelInput.value.trim();
    }
    const preset = globalPreset ? globalPreset.value : (currentPermissionPolicy || "ask_all");
    const fileAccess = globalFileAccess ? globalFileAccess.value : (currentFileAccessPolicy || "ask");
    const terminal = globalTerminal ? globalTerminal.value : (currentTerminalExecutionPolicy || "sandbox");
    const sandbox = globalSandbox ? globalSandbox.checked : true;

    currentAiUrl = url;
    currentAiKey = key;
    currentPermissionPolicy = preset;
    currentFileAccessPolicy = fileAccess;
    currentTerminalExecutionPolicy = terminal;
    currentSandboxMode = sandbox;
    activeAiModel = model;

    if (model && model !== "custom" && !AVAILABLE_AI_MODELS.some(m => m.key === model && m.key !== "custom")) {
      localStorage.setItem("orborus_custom_model", model);
    } else if (customModelInput && customModelInput.value.trim()) {
      localStorage.setItem("orborus_custom_model", customModelInput.value.trim());
    }

    if (url) {
      localStorage.setItem("orborus_ai_url", url);
    } else {
      localStorage.removeItem("orborus_ai_url");
    }
    if (key) {
      localStorage.setItem("orborus_ai_key", key);
    } else if (activeSettingsTab === "models" || activeSettingsTab === "mode-direct") {
      localStorage.removeItem("orborus_ai_key");
    }
    localStorage.setItem("orborus_ai_model", model);
    localStorage.setItem("orborus_permission_policy", preset);
    localStorage.setItem("orborus_terminal_execution_policy", terminal);
    localStorage.setItem("orborus_file_access_policy", fileAccess);
    localStorage.setItem("orborus_sandbox_mode", sandbox ? "true" : "false");

    updateEnvDisplayInModal();

    // Optimistically update Auth State UI immediately
    updateAuthState({
      is_logged_in: !!(key || url),
      is_bypassed: true,
      ai_api_url: url,
      ai_api_key: key,
      ai_model: model,
      permission_policy: preset
    });

    const footerModelSelect = document.getElementById("select-footer-model");
    const customInput = document.getElementById("input-custom-model");
    if (footerModelSelect) {
      if (model === "gemini-3.8-flash") {
        footerModelSelect.value = "gemini-3.8-flash";
        if (customInput) customInput.style.display = "none";
      } else {
        footerModelSelect.value = "custom";
        if (customInput) {
          customInput.style.display = "inline-block";
          customInput.value = model;
        }
      }
    }

    // Dismiss settings modal immediately for instant UI feedback
    closeSettingsModal();
    showToast("Settings saved");

    if (activeSettingsProject) {
      const pPreset = document.getElementById("select-project-preset");
      const pFile = document.getElementById("select-project-file-access");
      const pTerm = document.getElementById("select-project-terminal-policy");
      const pSand = document.getElementById("select-project-sandbox");
      const pCmds = document.getElementById("input-project-allowed-commands");
      if (!currentProjectPermissions) currentProjectPermissions = {};
      if (!currentProjectPermissions[activeSettingsProject]) {
        currentProjectPermissions[activeSettingsProject] = {};
      }
      if (pPreset) currentProjectPermissions[activeSettingsProject].permission_policy = pPreset.value;
      if (pFile) currentProjectPermissions[activeSettingsProject].file_access_policy = pFile.value;
      if (pTerm) currentProjectPermissions[activeSettingsProject].terminal_execution_policy = pTerm.value;
      if (pSand) {
        currentProjectPermissions[activeSettingsProject].sandbox_mode = pSand.value === "enabled" ? true : (pSand.value === "disabled" ? false : null);
      }
      if (pCmds) currentProjectPermissions[activeSettingsProject].allowed_commands = pCmds.value;
    }

    const localModelsDirInput = document.getElementById("input-local-models-dir");
    const localModelsDir = localModelsDirInput ? localModelsDirInput.value.trim() : (window.localModelsDir || "");
    const localModelPath = window.localModelPath || "";
    if (localModelsDir) {
      window.localModelsDir = localModelsDir;
      localStorage.setItem("orborus_local_models_dir", localModelsDir);
    }

    const settingsPayload = {
      permission_policy: preset,
      terminal_execution_policy: terminal,
      file_access_policy: fileAccess,
      sandbox_mode: sandbox,
      queued_messages: currentQueuedMessages || "queue",
      project_permissions: currentProjectPermissions || {},
      ai_api_url: url,
      ai_api_key: key,
      ai_model: model,
      local_models_dir: localModelsDir,
      local_model_path: localModelPath,
      active_execution_mode: window.activeExecutionMode || localStorage.getItem("orborus_active_execution_mode") || "local"
    };

    let savedState = null;
    const payloadStr = JSON.stringify(settingsPayload);

    if (typeof window.saveAllSettings === "function") {
      try {
        const resp = await window.saveAllSettings(settingsPayload);
        savedState = typeof resp === "string" ? JSON.parse(resp) : resp;
      } catch (err) {
        console.warn("saveAllSettings error, falling back:", err);
      }
    }
    if (!savedState && typeof window.bridgeCall === "function") {
      try {
        const resp = await window.bridgeCall("saveAllSettings", payloadStr);
        savedState = typeof resp === "string" ? JSON.parse(resp) : resp;
      } catch (err) {
        console.warn("bridgeCall saveAllSettings error:", err);
      }
    }
    if (!savedState && typeof window.setAiConfig === "function") {
      try {
        const resp = await window.setAiConfig(url, key, preset, model);
        savedState = typeof resp === "string" ? JSON.parse(resp) : resp;
      } catch (err) {
        console.warn("setAiConfig error:", err);
      }
    }
    if (!savedState && typeof window.bridgeCall === "function") {
      try {
        const resp = await window.bridgeCall("setAiConfig", JSON.stringify({ url: url, key: key, permission_policy: preset, model: model }));
        savedState = typeof resp === "string" ? JSON.parse(resp) : resp;
      } catch (err) {
        console.warn("bridgeCall setAiConfig error:", err);
      }
    }

    if (savedState) {
      updateAuthState(savedState);
    } else {
      updateAuthState({
        is_logged_in: true,
        is_bypassed: true,
        ai_api_url: url,
        ai_api_key: key,
        ai_model: model,
        permission_policy: preset,
        sandbox_mode: sandbox,
        terminal_execution_policy: terminal,
        file_access_policy: fileAccess
      });
    }

    const baseUrlInput = document.getElementById("input-base-url");
    const orgIdInput = document.getElementById("input-org-id");
    const authKeyInput = document.getElementById("input-auth-key");
    const envNameInput = document.getElementById("input-env-name");

    if (baseUrlInput || orgIdInput || authKeyInput || envNameInput) {
      const baseUrl = baseUrlInput ? baseUrlInput.value.trim() : "";
      const orgId = orgIdInput ? orgIdInput.value.trim() : "";
      const auth = authKeyInput ? authKeyInput.value.trim() : "";
      const env = envNameInput ? envNameInput.value.trim() : "";
      if (orgId || auth || env || baseUrl) {
        if (typeof window.updateAuth === "function") {
          try {
            await window.updateAuth({
              base_url: baseUrl,
              org_id: orgId,
              auth: auth,
              environment: env
            });
          } catch (err) {
            console.warn("updateAuth error during saveSettings:", err);
          }
        } else if (typeof window.bridgeCall === "function") {
          try {
            await window.bridgeCall("updateAuth", JSON.stringify({
              base_url: baseUrl,
              org_id: orgId,
              auth: auth,
              environment: env
            }));
          } catch (err) {
            console.warn("bridgeCall updateAuth error:", err);
          }
        }
      }
    }

    dismissAuthErrorsIfConfigured();
    updateModesDisplay();
    showToast("Settings saved successfully");
    closeSettingsModal();
  } catch (err) {
    console.error("Critical error in saveSettings:", err);
    dismissAuthErrorsIfConfigured();
    updateModesDisplay();
    showToast("Settings saved locally");
    closeSettingsModal();
  }
}

window.onAuthUpdated = function(state) {
  console.log("[OAUTH] Dynamic auth updated:", state);
  isOAuthPending = false;
  updateAuthState(state);
  updateModesDisplay();
  dismissAuthErrorsIfConfigured();
};

async function loginWithOAuth() {
  if (isOAuthPending) return;
  isOAuthPending = true;

  const btnLabel = document.getElementById("lbl-btn-oauth-login") || document.getElementById("lbl-btn-auth");
  if (btnLabel) btnLabel.innerText = "Opening Browser...";

  try {
    let authUrl = "";
    if (typeof window.startOAuthLogin === "function") {
      const respRaw = await window.startOAuthLogin("https://shuffle.security");
      let resp = respRaw;
      if (typeof respRaw === "string") {
        try { resp = JSON.parse(respRaw); } catch (_) {}
      }
      if (resp && resp.status === "error") {
        throw new Error(resp.error || "Failed to start OAuth login");
      }
      if (resp && resp.url) authUrl = resp.url;
    } else if (typeof window.bridgeCall === "function") {
      const respRaw = await window.bridgeCall("startOAuthLogin", JSON.stringify({ base_url: "https://shuffle.security" }));
      let resp = respRaw;
      if (typeof respRaw === "string") {
        try { resp = JSON.parse(respRaw); } catch (_) {}
      }
      if (resp && resp.status === "error") {
        throw new Error(resp.error || "Failed to start OAuth login");
      }
      if (resp && resp.url) authUrl = resp.url;
    } else {
      authUrl = "https://shuffle.security/oauth2/authorize";
      window.open(authUrl, "_blank");
    }

    if (btnLabel) btnLabel.innerText = "Waiting for Login...";
    showToast("Opening browser for Shuffle OAuth2 login...");
  } catch (err) {
    console.error("Failed to start OAuth login:", err);
    if (btnLabel) btnLabel.innerText = "Open Shuffle OAuth2 Login";
    isOAuthPending = false;
    showToast("Error opening login: " + (err.message || err));
  }
}

// --- Local Models Management & Storage (Native Tendon Engine) ---
async function loadLocalModelsSettings() {
  const dirInput = document.getElementById("input-local-models-dir");
  const storedDir = window.localModelsDir || localStorage.getItem("orborus_local_models_dir") || "models";
  if (dirInput && !dirInput.value) {
    dirInput.value = storedDir;
  }

  // Update hardware telemetry badge
  const hwPill = document.getElementById("local-hardware-pill");
  if (hwPill) {
    const gpuName = window.localGpuName || "RTX 3080 Ti";
    const vramFree = window.localVramFreeMB ? ` (${Math.round(window.localVramFreeMB / 1024 * 10) / 10}GB free)` : "";
    hwPill.innerHTML = `${escapeHtml(gpuName)}${vramFree} &bull; Direct VRAM`;
  }

  await scanLocalModels();
}

async function browseLocalModelsDir() {
  try {
    let chosen = null;
    if (typeof window.chooseDirectory === "function") {
      chosen = await window.chooseDirectory("Select Models Storage Directory");
    } else if (typeof window.bridgeCall === "function") {
      chosen = await window.bridgeCall("chooseDirectory", JSON.stringify({ title: "Select Models Storage Directory" }));
    }

    let path = "";
    if (typeof chosen === "string") {
      try {
        const parsed = JSON.parse(chosen);
        if (parsed && parsed.status === "ok" && parsed.path) {
          path = parsed.path;
        }
      } catch (e) {
        path = chosen;
      }
    } else if (chosen && chosen.path) {
      path = chosen.path;
    }

    if (path && path.trim()) {
      const cleanPath = path.trim();
      const dirInput = document.getElementById("input-local-models-dir");
      if (dirInput) dirInput.value = cleanPath;
      window.localModelsDir = cleanPath;
      localStorage.setItem("orborus_local_models_dir", cleanPath);
      await scanLocalModels();
    }
  } catch (err) {
    console.error("browseLocalModelsDir error:", err);
    showToast("Error selecting folder: " + (err.message || err));
  }
}

function onLocalModelsDirChanged(newDir) {
  const cleanDir = (newDir || "").trim();
  if (cleanDir) {
    window.localModelsDir = cleanDir;
    localStorage.setItem("orborus_local_models_dir", cleanDir);
  }
  scanLocalModels();
}

async function scanLocalModels() {
  const dirInput = document.getElementById("input-local-models-dir");
  const targetDir = (dirInput && dirInput.value.trim()) || window.localModelsDir || localStorage.getItem("orborus_local_models_dir") || "models";
  const countEl = document.getElementById("local-models-count");
  const container = document.getElementById("local-models-list-container");

  if (countEl) countEl.innerText = "Scanning folder...";

  try {
    let raw = null;
    if (typeof window.listLocalModels === "function") {
      raw = await window.listLocalModels(targetDir);
    } else if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("listLocalModels", JSON.stringify({ directory: targetDir }));
    }

    let data = null;
    if (raw) {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    }

    if (!data || !Array.isArray(data.models)) {
      if (container) {
        container.innerHTML = `<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:12px;">
          No .gguf models found in <code>${escapeHtml(targetDir)}</code>
        </div>`;
      }
      if (countEl) countEl.innerText = "0 models found";
      return;
    }

    const models = data.models;
    const activePath = data.active_model_path || window.localModelPath || "";
    if (countEl) countEl.innerText = `${models.length} model${models.length === 1 ? "" : "s"} found`;

    // Update active model card
    const activeModel = models.find(m => m.is_active || m.path === activePath) || (models.length > 0 ? models[0] : null);
    updateActiveModelDisplay(activeModel, activePath);

    if (models.length === 0) {
      if (container) {
        container.innerHTML = `<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:12px;">
          No .gguf models found in <code>${escapeHtml(targetDir)}</code>.<br>
          <span style="font-size:11px; opacity:0.8;">Place quantized .gguf weights here or select a different directory.</span>
        </div>`;
      }
      return;
    }

    if (container) {
      container.innerHTML = "";
      models.forEach(m => {
        const row = document.createElement("div");
        const isActive = !!m.is_active || (activePath && (m.path === activePath || m.name === activePath.split(/[\\/]/).pop()));
        row.className = "local-model-row" + (isActive ? " active" : "");

        const quantHtml = m.quant ? `<span class="local-model-quant-badge">${escapeHtml(m.quant)}</span>` : "";
        const sizeHtml = m.size_display ? `<span class="local-model-size-badge">${escapeHtml(m.size_display)}</span>` : "";

        row.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:2px; overflow:hidden; flex:1;">
            <div class="local-model-name" title="${escapeHtml(m.path || m.name)}">${escapeHtml(m.name)}</div>
            <div class="local-model-meta">
              ${sizeHtml}
              ${quantHtml}
              <span style="font-size:10.5px; opacity:0.7;">${escapeHtml(m.mod_time || "")}</span>
            </div>
          </div>
          <button type="button" class="btn-activate-model${isActive ? " active" : ""}">
            ${isActive ? "Active Model" : "Activate"}
          </button>
        `;

        const btn = row.querySelector(".btn-activate-model");
        if (btn && !isActive) {
          btn.onclick = (e) => {
            e.stopPropagation();
            selectLocalModel(m.path, m.name);
          };
        }

        container.appendChild(row);
      });
    }
  } catch (err) {
    console.error("scanLocalModels error:", err);
    if (countEl) countEl.innerText = "Scan failed";
    if (container) {
      container.innerHTML = `<div style="padding:12px; text-align:center; color:var(--text-danger); font-size:12px;">
        Error scanning models: ${escapeHtml(err.message || String(err))}
      </div>`;
    }
  }
}

function updateActiveModelDisplay(model, fallbackPath) {
  const filenameEl = document.getElementById("active-model-filename");
  const metaEl = document.getElementById("active-model-meta");
  const pillEl = document.getElementById("active-model-status-pill");

  const name = model ? model.name : (fallbackPath ? fallbackPath.split(/[\\/]/).pop() : "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf");
  const size = model && model.size_display ? model.size_display : "~12.1 GB";
  const quant = model && model.quant ? ` &bull; ${model.quant}` : "";

  if (filenameEl) filenameEl.innerText = name;
  if (metaEl) {
    metaEl.innerHTML = `Size: ${size}${quant} &bull; Direct GPU Allocation (0 Host RAM)`;
  }
  if (pillEl) {
    pillEl.innerText = "ACTIVE";
    pillEl.style.display = "inline-block";
  }
}

async function selectLocalModel(modelPath, modelName) {
  if (!modelPath) return;
  try {
    const dirInput = document.getElementById("input-local-models-dir");
    const targetDir = (dirInput && dirInput.value.trim()) || window.localModelsDir || "";

    const payload = {
      path: modelPath,
      directory: targetDir
    };

    let raw = null;
    if (typeof window.setLocalModel === "function") {
      raw = await window.setLocalModel(JSON.stringify(payload));
    } else if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("setLocalModel", JSON.stringify(payload));
    }

    window.localModelPath = modelPath;
    localStorage.setItem("orborus_local_model_path", modelPath);

    // Switch active LLM to local Tendon engine
    activeAiModel = "tendon-local";
    localStorage.setItem("orborus_ai_model", "tendon-local");
    if (typeof window !== "undefined") window.activeAiModel = "tendon-local";

    const modelSelect = document.getElementById("select-ai-model");
    if (modelSelect) modelSelect.value = "tendon-local";
    updateEnvDisplayInModal();

    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }

    showToast("Activated local model: " + (modelName || modelPath.split(/[\\/]/).pop()));
    await scanLocalModels();
  } catch (err) {
    console.error("selectLocalModel error:", err);
    showToast("Failed to switch model: " + (err.message || err));
  }
}

