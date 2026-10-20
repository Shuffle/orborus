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
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch (_) {}
  }
  state = state || {};
  isBypassed = !!state.is_bypassed;
  if (state.oauth_logged_in === false || state.is_logged_in === false) {
    window.oauthLoggedIn = false;
    window.shuffleVerified = false;
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("orborus_oauth_logged_in");
    }
  }

  let isOAuthConnected = false;
  if (state.oauth_logged_in === true) {
    isOAuthConnected = true;
  } else if (state.oauth_logged_in === false || state.is_logged_in === false) {
    isOAuthConnected = false;
  } else if (state.auth && typeof state.auth === "string" && state.auth.startsWith("shfl_")) {
    isOAuthConnected = true;
  } else {
    isOAuthConnected = !!window.oauthLoggedIn;
  }

  if (isOAuthConnected) {
    window.oauthLoggedIn = true;
    isLoggedIn = true;
    isOAuthPending = false;
    const candidateToken = state.oauth_token || (typeof state.auth === "string" && state.auth ? state.auth : "") || (typeof state.ai_api_key === "string" && state.ai_api_key.startsWith("shfl_") ? state.ai_api_key : "");
    if (candidateToken) {
      window.activeShuffleToken = candidateToken;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("orborus_shuffle_token", candidateToken);
      }
    } else if (!window.activeShuffleToken && typeof localStorage !== "undefined") {
      window.activeShuffleToken = localStorage.getItem("orborus_shuffle_token") || "";
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_oauth_logged_in", "true");
    }
  } else {
    window.oauthLoggedIn = false;
    isLoggedIn = false;
    window.shuffleVerified = false;
    window.activeShuffleToken = "";
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("orborus_oauth_logged_in");
      localStorage.removeItem("orborus_shuffle_token");
    }
  }
  if (state.ai_api_url !== undefined) currentAiUrl = state.ai_api_url;
  if (state.ai_api_key !== undefined) currentAiKey = state.ai_api_key;
  if (state.permission_policy !== undefined) currentPermissionPolicy = state.permission_policy;
  if (state.sandbox_mode !== undefined) currentSandboxMode = state.sandbox_mode;
  if (state.queued_messages !== undefined) currentQueuedMessages = state.queued_messages;
  if (state.terminal_execution_policy !== undefined) currentTerminalExecutionPolicy = state.terminal_execution_policy;
  if (state.file_access_policy !== undefined) currentFileAccessPolicy = state.file_access_policy;
  if (state.project_permissions !== undefined) currentProjectPermissions = state.project_permissions;
  if (Array.isArray(state.shuffle_orgs) && state.shuffle_orgs.length > 0) {
    window.shuffleOrgs = state.shuffle_orgs;
    if (typeof localStorage !== "undefined") {
      try { localStorage.setItem("orborus_shuffle_orgs", JSON.stringify(state.shuffle_orgs)); } catch (_) {}
    }
  } else if (!Array.isArray(window.shuffleOrgs) || window.shuffleOrgs.length === 0) {
    let restored = [];
    if (typeof localStorage !== "undefined") {
      try {
        const rawOrgs = localStorage.getItem("orborus_shuffle_orgs");
        if (rawOrgs) {
          const parsed = JSON.parse(rawOrgs);
          if (Array.isArray(parsed)) restored = parsed;
        }
      } catch (_) {}
    }
    window.shuffleOrgs = restored;
  }
  if (state.org_id) {
    window.activeShuffleOrgId = state.org_id;
    if (typeof localStorage !== "undefined") localStorage.setItem("orborus_shuffle_org_id", state.org_id);
  } else if (!window.activeShuffleOrgId && typeof localStorage !== "undefined") {
    window.activeShuffleOrgId = localStorage.getItem("orborus_shuffle_org_id") || "";
  }
  if (state.org_name) {
    window.activeShuffleOrgName = state.org_name;
    if (typeof localStorage !== "undefined") localStorage.setItem("orborus_shuffle_org_name", state.org_name);
  } else if (!window.activeShuffleOrgName && typeof localStorage !== "undefined") {
    window.activeShuffleOrgName = localStorage.getItem("orborus_shuffle_org_name") || "";
  }
  if (state.base_url) {
    window.activeShuffleBaseUrl = state.base_url;
    if (typeof localStorage !== "undefined") localStorage.setItem("orborus_shuffle_base_url", state.base_url);
  } else if (!window.activeShuffleBaseUrl && typeof localStorage !== "undefined") {
    window.activeShuffleBaseUrl = localStorage.getItem("orborus_shuffle_base_url") || "";
  }

  if (currentAiKey || currentAiUrl || isLoggedIn || isBypassed || isOAuthConnected) {
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
  if (!isOAuthConnected) {
    if (inputAuthKey) inputAuthKey.value = "";
    if (inputOrgId && state.org_id !== undefined) inputOrgId.value = state.org_id || "";
    if (inputBaseUrl && state.base_url !== undefined) inputBaseUrl.value = state.base_url || "";
    if (inputEnvName && state.environment !== undefined) inputEnvName.value = (state.environment === "standalone") ? "" : (state.environment || "");
  } else {
    if (inputBaseUrl && state.base_url !== undefined) inputBaseUrl.value = state.base_url;
    if (inputOrgId && state.org_id !== undefined) inputOrgId.value = state.org_id;
    if (inputAuthKey && state.auth !== undefined) inputAuthKey.value = state.auth;
    if (inputEnvName && state.environment !== undefined) inputEnvName.value = state.environment;
  }

  const authStatusDot = document.getElementById("settings-auth-status-dot");
  const authStatusText = document.getElementById("settings-auth-status-text");
  const btnOAuthLabel = document.getElementById("lbl-btn-oauth-login");
  const btnOAuth = document.getElementById("btn-oauth-login");
  const btnOAuthCancel = document.getElementById("btn-oauth-cancel");
  const btnOAuthLogout = document.getElementById("btn-oauth-logout");
  const btnSidebarAuthLogout = document.getElementById("btn-sidebar-auth-logout");

  const btnTestShuffle = document.getElementById("btn-test-shuffle-ai");
  const statusTestShuffle = document.getElementById("shuffle-ai-test-status");
  const tenantSelectorSection = document.getElementById("shuffle-tenant-selector-section");

  const envLabel = (state.environment && state.environment !== "standalone") ? state.environment : "Active";

  if (isOAuthConnected) {
    if (authStatusDot) authStatusDot.className = "status-dot connected";
    if (authStatusText) {
      authStatusText.innerText = window.shuffleVerified
        ? "Verified & Connected (" + envLabel + ")"
        : "Connected via OAuth2 (" + envLabel + ")";
      authStatusText.style.color = "var(--text-primary)";
    }
    if (btnOAuthLabel) btnOAuthLabel.innerText = "Shuffle Connected ✓";
    if (btnOAuth) btnOAuth.title = "Connected with Shuffle OAuth2 (Click to re-authenticate)";
    if (btnOAuthCancel) btnOAuthCancel.style.display = "none";
    if (btnOAuthLogout) btnOAuthLogout.style.display = "inline-flex";
    if (btnSidebarAuthLogout) btnSidebarAuthLogout.style.display = "inline-flex";
    if (btnTestShuffle) btnTestShuffle.style.display = "inline-flex";
    if (tenantSelectorSection) tenantSelectorSection.style.display = "flex";
    if (typeof renderShuffleTenantDropdown === "function") {
      renderShuffleTenantDropdown();
    }
    if ((!window.shuffleOrgs || window.shuffleOrgs.length === 0) && !window._fetchingShuffleTenants && !window._initialTenantsFetched && !window._tenantBridgeUnsupported && typeof refreshShuffleTenants === "function") {
      window._initialTenantsFetched = true;
      refreshShuffleTenants();
    }
  } else if (isOAuthPending) {
    if (authStatusDot) authStatusDot.className = "status-dot standalone";
    if (authStatusText) {
      authStatusText.innerText = "Waiting for browser login...";
      authStatusText.style.color = "var(--text-secondary)";
    }
    if (btnOAuthLabel) btnOAuthLabel.innerText = "Waiting for Login... (Re-open)";
    if (btnOAuth) btnOAuth.title = "Click to re-open Shuffle AI login in browser";
    if (btnOAuthCancel) btnOAuthCancel.style.display = "inline-flex";
    if (btnOAuthLogout) btnOAuthLogout.style.display = "none";
    if (btnSidebarAuthLogout) btnSidebarAuthLogout.style.display = "none";
    if (btnTestShuffle) btnTestShuffle.style.display = "none";
    if (statusTestShuffle) statusTestShuffle.style.display = "none";
    if (tenantSelectorSection) tenantSelectorSection.style.display = "none";
  } else {
    window._initialTenantsFetched = false;
    if (authStatusDot) authStatusDot.className = "status-dot disconnected";
    if (authStatusText) {
      authStatusText.innerText = "Disconnected (Not Verified)";
      authStatusText.style.color = "var(--text-muted)";
    }
    if (btnOAuthLabel) btnOAuthLabel.innerText = "Connect Shuffle AI";
    if (btnOAuth) btnOAuth.title = "Connect Shuffle AI";
    if (btnOAuthCancel) btnOAuthCancel.style.display = "none";
    if (btnOAuthLogout) btnOAuthLogout.style.display = "none";
    if (btnSidebarAuthLogout) btnSidebarAuthLogout.style.display = "none";
    if (btnTestShuffle) btnTestShuffle.style.display = "none";
    if (statusTestShuffle) statusTestShuffle.style.display = "none";
    if (tenantSelectorSection) tenantSelectorSection.style.display = "none";
  }

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
  if (isOAuthConnected) {
    if (dot) dot.className = "status-dot connected";
    if (label) label.innerText = window.shuffleVerified ? "Shuffle AI Verified" : "Shuffle AI Connected";
    if (subtext) subtext.innerText = "Authenticated with Shuffle OAuth2. Workflows and cloud models enabled.";
    if (details) details.classList.add("visible");
    if (lblOrg) lblOrg.innerText = window.activeShuffleOrgName || state.org_id || "Shuffle";
    if (lblEnv) lblEnv.innerText = envLabel;
    if (btnAuth) {
      btnAuth.className = "status-btn btn-manage";
      if (btnLabel) btnLabel.innerText = "Shuffle Connected ✓";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (footerDot) footerDot.className = "status-dot connected";
    if (footerEnv) footerEnv.innerText = "Shuffle Connected";
  } else if (isOAuthPending) {
    if (dot) dot.className = "status-dot standalone";
    if (label) label.innerText = "Waiting for Login...";
    if (subtext) subtext.innerText = "Complete login in your browser or cancel in Shuffle AI settings.";
    if (details) details.classList.remove("visible");
    if (btnAuth) {
      btnAuth.className = "status-btn btn-login";
      if (btnLabel) btnLabel.innerText = "Waiting for Login...";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (footerDot) footerDot.className = "status-dot standalone";
    if (footerEnv) footerEnv.innerText = "Waiting for Login";
  } else if (hasCustomAi) {
    if (dot) dot.className = "status-dot standalone";
    if (label) label.innerText = "Shuffle AI: Disconnected (BYOK)";
    if (subtext) subtext.innerText = currentAiKey ? "Custom API key configured. Shuffle AI is disconnected." : "Custom LLM endpoint active. Shuffle AI is disconnected.";
    if (details) details.classList.add("visible");
    if (lblOrg) lblOrg.innerText = state.org_id || "standalone";
    if (lblEnv) lblEnv.innerText = state.environment || "standalone";
    if (btnAuth) {
      btnAuth.className = "status-btn btn-manage";
      if (btnLabel) btnLabel.innerText = "Connect Shuffle AI";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (footerDot) footerDot.className = "status-dot connected";
    if (footerEnv) footerEnv.innerText = "Custom AI Configured";
  } else {
    if (dot) dot.className = "status-dot standalone";
    if (label) label.innerText = "Shuffle AI: Disconnected";
    if (subtext) subtext.innerText = "Shuffle login is optional. Configure AI credentials or connect Shuffle AI.";
    if (details) details.classList.remove("visible");
    if (btnAuth) {
      btnAuth.className = "status-btn btn-login";
      if (btnLabel) btnLabel.innerText = "Connect Shuffle AI";
      btnAuth.onclick = () => handleAuthAction();
    }
    if (footerDot) footerDot.className = "status-dot disconnected";
    if (footerEnv) footerEnv.innerText = "Shuffle Standalone";
  }

  updateEnvDisplayInModal();
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
  if (typeof updateShuffleToolsButtonVisibility === "function") {
    updateShuffleToolsButtonVisibility();
  }
  if (typeof syncGlobalApprovalQueueUI === "function") {
    syncGlobalApprovalQueueUI();
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

function openSettingsForModel(modelKey, focusField) {
  const targetTab = (typeof getSettingsTabForModel === "function")
    ? getSettingsTabForModel(modelKey)
    : ((modelKey === "shuffle-ai" || modelKey === "shuffle" || modelKey === "default")
        ? "mode-shuffle"
        : ((modelKey && (modelKey === "tendon-local" || String(modelKey).startsWith("tendon") || String(modelKey).startsWith("local")))
            ? "mode-local"
            : "mode-direct"));
  openSettingsModal(targetTab, focusField, modelKey);
}

function openSettingsModal(initialTab, focusField, modelKey) {
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

    setQueuedMessageMode(currentQueuedMessages || "queue", true);
  } catch (err) {
    console.warn("Error setting modal input values:", err);
  }

  try {
    renderSettingsProjectsList();
    if (typeof loadApprovalRules === "function") {
      loadApprovalRules();
    } else if (typeof renderPermissionsSummaries === "function") {
      renderPermissionsSummaries();
    }
  } catch (err) {
    console.warn("Error rendering settings projects:", err);
  }

  try {
    let targetTab = initialTab || (activeSettingsTab && !activeSettingsTab.startsWith("project:") ? activeSettingsTab : "general");
    if (targetTab === "models") {
      targetTab = (typeof getSettingsTabForModel === "function")
        ? getSettingsTabForModel(modelKey)
        : "mode-direct";
    }
    switchSettingsTab(targetTab);
    updateEnvDisplayInModal();
    updateModesDisplay();
    if (targetTab === "models" || targetTab === "mode-direct" || targetTab === "direct") {
      if (modelKey && modelKey !== "shuffle-ai" && modelKey !== "shuffle" && modelKey !== "tendon-local" && !String(modelKey).startsWith("local")) {
        const byokInput = document.getElementById("input-byok-model-name");
        if (byokInput) byokInput.value = modelKey;
        const modelSelect = document.getElementById("select-ai-model");
        if (modelSelect && Array.from(modelSelect.options || []).some(opt => opt.value === modelKey)) {
          modelSelect.value = modelKey;
        }
      }
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
        const loginBtn = document.getElementById("btn-oauth-login");
        if (loginBtn) loginBtn.focus();
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

function setQueuedMessageMode(mode, skipSave) {
  currentQueuedMessages = mode;
  localStorage.setItem("orborus_queued_messages", mode);
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
  if (!skipSave) {
    autoSaveGeneralSettings();
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
  autoSaveGeneralSettings();
}

function autoSaveGeneralSettings() {
  const globalPreset = document.getElementById("select-global-preset");
  const globalFileAccess = document.getElementById("select-global-file-access");
  const globalTerminal = document.getElementById("select-global-terminal-policy");
  const globalSandbox = document.getElementById("toggle-global-sandbox");

  if (globalPreset) currentPermissionPolicy = globalPreset.value;
  if (globalFileAccess) currentFileAccessPolicy = globalFileAccess.value;
  if (globalTerminal) currentTerminalExecutionPolicy = globalTerminal.value;
  if (globalSandbox) currentSandboxMode = !!globalSandbox.checked;

  localStorage.setItem("orborus_permission_policy", currentPermissionPolicy || "ask_all");
  localStorage.setItem("orborus_file_access_policy", currentFileAccessPolicy || "ask");
  localStorage.setItem("orborus_terminal_execution_policy", currentTerminalExecutionPolicy || "sandbox");
  localStorage.setItem("orborus_sandbox_mode", currentSandboxMode ? "true" : "false");

  const payload = {
    permission_policy: currentPermissionPolicy || "ask_all",
    file_access_policy: currentFileAccessPolicy || "ask",
    terminal_execution_policy: currentTerminalExecutionPolicy || "sandbox",
    sandbox_mode: currentSandboxMode !== false,
    queued_messages: currentQueuedMessages || "queue",
    project_permissions: currentProjectPermissions || {},
    ai_api_url: currentAiUrl || "",
    ai_api_key: currentAiKey || "",
    ai_model: activeAiModel || "tendon-local",
    local_models_dir: window.localModelsDir || "",
    local_model_path: window.localModelPath || "",
    active_execution_mode: window.activeExecutionMode || localStorage.getItem("orborus_active_execution_mode") || "local"
  };

  if (typeof window.saveAllSettings === "function") {
    window.saveAllSettings(payload).catch(() => {});
  } else if (typeof window.bridgeCall === "function") {
    window.bridgeCall("saveAllSettings", JSON.stringify(payload)).catch(() => {});
  }
  if (typeof syncGlobalApprovalQueueUI === "function") {
    syncGlobalApprovalQueueUI();
  }
}

function switchSettingsTab(tabName) {
  const backBtn = document.getElementById("btn-permissions-detail-back");
  if (backBtn) backBtn.style.display = "none";

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

  if (tabName === "modes-overview" || tabName === "mode-orborus") {
    switchSettingsTab("mode-shuffle");
    return;
  } else if (tabName === "mode-shuffle" || tabName === "auth") {
    activeSettingsTab = "mode-shuffle";
    const btn = document.getElementById("settings-tab-btn-mode-shuffle") || document.getElementById("settings-tab-btn-auth");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-mode-shuffle") || document.getElementById("settings-panel-auth");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Shuffle AI";
    if (descEl) descEl.innerText = "Managed Shuffle AI workflows and agent executions.";
    updateModesDisplay();
    if (typeof renderShuffleTenantDropdown === "function") {
      renderShuffleTenantDropdown();
    }
    if (window.oauthLoggedIn && (!window.shuffleOrgs || window.shuffleOrgs.length === 0) && typeof refreshShuffleTenants === "function") {
      refreshShuffleTenants();
    }
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
    const gpuLabel = window.localGpuName || "Local GPU";
    if (descEl) descEl.innerText = `Offline execution on ${gpuLabel}. Direct VRAM, 0 host RAM overhead.`;
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
    if (typeof renderPermissionsSummaries === "function") {
      renderPermissionsSummaries();
    }
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
  if (metaModelDirect) metaModelDirect.innerText = activeAiModel || "gemini-3.8-flash";
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
    targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    targetModel = "gemini-3.8-flash";
  } else if (preset === "deepseek") {
    targetUrl = "https://api.deepseek.com/v1";
    targetModel = "deepseek-chat";
  } else if (preset === "groq") {
    targetUrl = "https://api.groq.com/openai/v1";
    targetModel = "llama-3.3-70b-versatile";
  } else if (preset === "ollama") {
    targetUrl = "http://localhost:11434/v1";
    targetModel = "llama3.3";
  } else if (preset === "openrouter") {
    targetUrl = "https://openrouter.ai/api/v1";
    targetModel = "anthropic/claude-3.7-sonnet";
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

  const standardPresets = ["claude-3-7-sonnet", "gpt-4o", "gemini-3.8-flash", "deepseek-chat"];
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

async function testDirectLlmConfig() {
  const urlInput = document.getElementById("input-ai-url");
  const keyInput = document.getElementById("input-ai-key");
  const modelInput = document.getElementById("input-byok-model-name");
  const modelSelect = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");
  const testBtn = document.getElementById("btn-test-direct-llm");
  const statusSpan = document.getElementById("direct-llm-save-status");

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
  const targetModel = chosenModel || activeAiModel || "gemini-3.8-flash";

  const origText = "Test Connection";
  if (testBtn) {
    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
  }
  if (statusSpan) {
    statusSpan.textContent = "Testing " + targetModel + " via RunAiQuery()...";
    statusSpan.style.color = "var(--text-muted)";
    statusSpan.style.display = "inline";
  }

  let authOk = true;
  let authError = "";
  let parsed = null;

  try {
    if (typeof window.bridgeCall === "function") {
      const testPromise = window.bridgeCall("testAiConfig", JSON.stringify({
        url: aiUrl,
        key: aiKey,
        model: targetModel
      }));
      const timeoutPromise = new Promise(function(resolve) {
        setTimeout(resolve, 12000, JSON.stringify({ status: "error", message: "Connection test timed out after 12s" }));
      });
      const testRespRaw = await Promise.race([testPromise, timeoutPromise]);
      if (typeof testRespRaw === "string") {
        try {
          parsed = JSON.parse(testRespRaw);
        } catch (e) {
          parsed = { status: "ok", sample: testRespRaw };
        }
      } else {
        parsed = testRespRaw;
      }
      if (parsed && (parsed.status === "error" || parsed.error)) {
        authOk = false;
        authError = parsed.message || parsed.error || "Connection test failed";
      }
    }
  } catch (e) {
    console.warn("Direct LLM test error:", e);
    authOk = false;
    authError = e.message || String(e);
  } finally {
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.textContent = origText;
    }
  }

  if (!authOk) {
    if (statusSpan) {
      statusSpan.textContent = "✗ Test failed: " + authError;
      statusSpan.style.color = "var(--text-error, #f87171)";
      statusSpan.style.display = "inline";
    }
    showToast("Test failed: " + authError);
    return false;
  }

  const verifiedModel = (parsed && parsed.model) ? parsed.model : targetModel;
  const durText = (parsed && parsed.duration_ms !== undefined) ? " (" + parsed.duration_ms + "ms)" : "";
  const sampleText = (parsed && parsed.sample) ? " — \"" + parsed.sample + "\"" : "";

  if (statusSpan) {
    statusSpan.textContent = "✓ Verified " + verifiedModel + durText + sampleText;
    statusSpan.style.color = "var(--text-success, #4ade80)";
    statusSpan.style.display = "inline";
  }
  showToast("Verified " + verifiedModel + durText);
  return true;
}

async function testShuffleAiConfig() {
  const testBtn = document.getElementById("btn-test-shuffle-ai");
  const testLbl = document.getElementById("lbl-btn-test-shuffle-ai");
  const statusDiv = document.getElementById("shuffle-ai-test-status");

  const targetModel = "shuffle-ai";

  const origText = "Test Connection";
  if (testLbl) {
    testLbl.textContent = "Testing...";
  }
  if (testBtn) {
    testBtn.disabled = true;
  }
  if (statusDiv) {
    statusDiv.textContent = "Testing Shuffle AI via RunAiQuery()...";
    statusDiv.style.color = "var(--text-muted)";
    statusDiv.style.display = "block";
  }

  let authOk = true;
  let authError = "";
  let parsed = null;

  try {
    if (typeof window.bridgeCall === "function") {
      const testPromise = window.bridgeCall("testAiConfig", JSON.stringify({
        url: "shuffle",
        key: "",
        model: targetModel
      }));
      const timeoutPromise = new Promise(function(resolve) {
        setTimeout(resolve, 12000, JSON.stringify({ status: "error", message: "Shuffle AI test timed out after 12s" }));
      });
      const testRespRaw = await Promise.race([testPromise, timeoutPromise]);
      if (typeof testRespRaw === "string") {
        try {
          parsed = JSON.parse(testRespRaw);
        } catch (e) {
          parsed = { status: "ok", sample: testRespRaw };
        }
      } else {
        parsed = testRespRaw;
      }
      if (parsed && (parsed.status === "error" || parsed.error)) {
        authOk = false;
        authError = parsed.message || parsed.error || "Shuffle AI test failed";
      }
    }
  } catch (e) {
    console.warn("Shuffle AI test error:", e);
    authOk = false;
    authError = e.message || String(e);
  } finally {
    if (testLbl) {
      testLbl.textContent = origText;
    }
    if (testBtn) {
      testBtn.disabled = false;
    }
  }

  if (!authOk) {
    window.shuffleVerified = false;
    if (statusDiv) {
      statusDiv.textContent = "✗ Test failed: " + authError;
      statusDiv.style.color = "var(--text-error, #f87171)";
      statusDiv.style.display = "block";
    }
    const authStatusText = document.getElementById("settings-auth-status-text");
    if (authStatusText) {
      authStatusText.innerText = window.oauthLoggedIn ? "Connected (Verification Failed)" : "Disconnected (Not Verified)";
      authStatusText.style.color = "var(--text-muted)";
    }
    showToast("Shuffle AI test failed: " + authError);
    return false;
  }

  window.shuffleVerified = true;
  const verifiedModel = (parsed && parsed.model) ? parsed.model : targetModel;
  const durText = (parsed && parsed.duration_ms !== undefined) ? " (" + parsed.duration_ms + "ms)" : "";
  const sampleText = (parsed && parsed.sample) ? " — \"" + parsed.sample + "\"" : "";

  if (statusDiv) {
    statusDiv.textContent = "✓ Verified " + verifiedModel + durText + sampleText;
    statusDiv.style.color = "var(--text-success, #4ade80)";
    statusDiv.style.display = "block";
  }
  const authStatusDot = document.getElementById("settings-auth-status-dot");
  const authStatusText = document.getElementById("settings-auth-status-text");
  const sidebarLabel = document.getElementById("status-indicator-label");
  if (authStatusDot && window.oauthLoggedIn) authStatusDot.className = "status-dot connected";
  if (authStatusText) {
    authStatusText.innerText = "Verified (" + verifiedModel + ")";
    authStatusText.style.color = "var(--text-primary)";
  }
  if (sidebarLabel && window.oauthLoggedIn) {
    sidebarLabel.innerText = "Shuffle AI Verified";
  }
  showToast("Shuffle AI verified: " + verifiedModel + durText);
  return true;
}

async function saveDirectLlmSettings() {
  const urlInput = document.getElementById("input-ai-url");
  const keyInput = document.getElementById("input-ai-key");
  const modelInput = document.getElementById("input-byok-model-name");
  const modelSelect = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");
  const saveBtn = document.getElementById("btn-save-direct-llm");
  const statusSpan = document.getElementById("direct-llm-save-status");

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
  activeAiModel = chosenModel || "gemini-3.8-flash";

  if (activeAiModel && typeof addCustomByokModel === "function") {
    addCustomByokModel(activeAiModel);
  }

  localStorage.setItem("orborus_ai_url", aiUrl);
  localStorage.setItem("orborus_ai_key", aiKey);
  localStorage.setItem("orborus_ai_model", activeAiModel);
  localStorage.setItem("orborus_custom_model", activeAiModel);

  // Set testing UI state
  const origText = "Save & Verify Key";
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Testing authentication...";
  }
  if (statusSpan) {
    statusSpan.textContent = "Testing authentication...";
    statusSpan.style.color = "var(--text-muted)";
    statusSpan.style.display = "inline";
  }

  let authOk = true;
  let authError = "";

  try {
    if (typeof window.bridgeCall === "function") {
      const testPromise = window.bridgeCall("testAiConfig", JSON.stringify({
        url: aiUrl,
        key: aiKey,
        model: activeAiModel
      }));
      const timeoutPromise = new Promise(function(resolve) {
        setTimeout(resolve, 12000, JSON.stringify({ status: "error", message: "Authentication test timed out after 12s" }));
      });
      const testRespRaw = await Promise.race([testPromise, timeoutPromise]);
      let parsed = null;
      if (typeof testRespRaw === "string") {
        try {
          parsed = JSON.parse(testRespRaw);
        } catch (e) {
          parsed = { status: "ok" };
        }
      } else {
        parsed = testRespRaw;
      }
      if (parsed && (parsed.status === "error" || parsed.error)) {
        authOk = false;
        authError = parsed.message || parsed.error || "Authentication failed";
      }
    }
  } catch (e) {
    console.warn("Authentication test error:", e);
    authOk = false;
    authError = e.message || String(e);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = origText;
    }
  }

  if (!authOk) {
    if (statusSpan) {
      statusSpan.textContent = "Auth failed: " + authError;
      statusSpan.style.color = "var(--text-error, #f87171)";
      statusSpan.style.display = "inline";
    }
    updateEnvDisplayInModal();
    renderByokModelsSettings();
    showToast("Authentication failed: " + authError);
    return;
  }

  // Auth test passed: persist configuration to backend
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

  if (statusSpan) {
    statusSpan.textContent = "✓ Authentication verified & saved";
    statusSpan.style.color = "var(--text-success, #4ade80)";
    statusSpan.style.display = "inline";
    setTimeout(() => {
      if (statusSpan) statusSpan.style.display = "none";
    }, 3500);
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
  showToast("Credentials verified & direct LLM saved");
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

  if (typeof refreshShuffleSharedSkills === "function") {
    try { await refreshShuffleSharedSkills(); } catch (_) {}
  }
  renderSkillsView();
}

function renderSkillsView() {
  const sharedContainer = document.getElementById("shuffle-shared-skills-container");
  const injContainer = document.getElementById("injected-skills-container");

  if (sharedContainer) {
    const catalog = (Array.isArray(window.shuffleSharedSkillsCatalog) && window.shuffleSharedSkillsCatalog.length > 0)
      ? window.shuffleSharedSkillsCatalog
      : (Array.isArray(window.DEFAULT_SHUFFLE_SHARED_SKILLS) ? window.DEFAULT_SHUFFLE_SHARED_SKILLS : []);
    const attachedIds = new Set(Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills : []);
    sharedContainer.innerHTML = "";
    catalog.forEach(skill => {
      const sid = String(skill.id || "");
      const isAttached = attachedIds.has(sid);
      const reqApps = Array.isArray(skill.required_apps) && skill.required_apps.length > 0
        ? skill.required_apps
        : (Array.isArray(skill.tools) ? skill.tools.map(t => t.app_name).filter(Boolean) : []);
      const toolBadgesHtml = reqApps.map(app => `<span class="skill-badge global">TOOL: ${escapeHtml(app)}</span>`).join("");
      const descHtml = skill.description
        ? `<div class="skill-card-desc">${escapeHtml(skill.description)}</div>`
        : "";
      const instructionsHtml = skill.instructions
        ? `<details style="margin-top:8px;">
             <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; user-select:none;">View Predefined Template &amp; Tool Instructions</summary>
             <pre class="skill-card-instructions">${escapeHtml(skill.instructions)}</pre>
           </details>`
        : "";
      const card = document.createElement("div");
      card.className = "skill-card";
      card.innerHTML = `
        <div class="skill-card-header">
          <div class="skill-card-title-group" style="flex-wrap:wrap;">
            <span class="skill-card-name">${escapeHtml(skill.name || sid)}</span>
            <span class="skill-badge project">TEMPLATE: ${escapeHtml(skill.template || sid)}</span>
            ${toolBadgesHtml}
          </div>
          <button type="button" class="btn-skill-revoke" onclick="toggleAttachShuffleSkill('${escapeJsAttr(sid)}', event)">${isAttached ? "Attached ✓" : "Attach"}</button>
        </div>
        ${descHtml}
        ${instructionsHtml}
      `;
      sharedContainer.appendChild(card);
    });
  }
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
            <button type="button" class="btn-skill-revoke" onclick="removeInjectedSkill('${escapeJsAttr(skill.name)}')">Revoke</button>
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
    if (typeof window.removeInjectedSkillBackend === "function") {
      raw = await window.removeInjectedSkillBackend(skillName);
    } else if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("removeInjectedSkill", JSON.stringify({ name: skillName }));
    } else if (typeof callGo === "function") {
      raw = await callGo("removeInjectedSkill", JSON.stringify({ name: skillName }));
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

  // Collect unique projects from allProjects, appConversations, or activeProjectPath in stable order
  const projectsMap = new Map();
  const normKey = p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

  const orderedSource = (typeof sortProjectsByStoredOrder === "function" && Array.isArray(allProjects))
    ? sortProjectsByStoredOrder(allProjects)
    : (Array.isArray(allProjects) ? allProjects : []);

  orderedSource.forEach(p => {
    if (!p) return;
    const pPath = typeof p === "string" ? p : (p.Path || p.path || "");
    if (!pPath || pPath === ".") return;
    let pName = "";
    if (typeof p === "object" && (p.Name || p.name)) {
      pName = p.Name || p.name;
    } else {
      const parts = pPath.split(/[/\\]/).filter(Boolean);
      pName = parts.length > 0 ? parts[parts.length - 1] : pPath;
    }
    const key = normKey(pPath);
    if (key && !projectsMap.has(key)) {
      projectsMap.set(key, { name: pName, path: pPath });
    }
  });

  if (Array.isArray(appConversations)) {
    appConversations.forEach(c => {
      if (!c) return;
      const pPath = c.projectId || c.project_id || "";
      if (!pPath || pPath === ".") return;
      const key = normKey(pPath);
      if (key && !projectsMap.has(key)) {
        const pName = c.projectName || c.project_name || pPath.split(/[/\\]/).filter(Boolean).pop() || "Project";
        projectsMap.set(key, { name: pName, path: pPath });
      }
    });
  }

  if (activeProjectPath && activeProjectPath !== ".") {
    const activeKey = normKey(activeProjectPath);
    if (activeKey && !projectsMap.has(activeKey)) {
      let activeName = (document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : "") || "";
      if (!activeName || activeName === "Orborus Agent Runner" || activeName === "No project") {
        const parts = activeProjectPath.split(/[/\\]/).filter(Boolean);
        activeName = parts.length > 0 ? parts[parts.length - 1] : "Project";
      }
      projectsMap.set(activeKey, { name: activeName, path: activeProjectPath });
    }
  }

  if (activeSettingsProject && !projectsMap.has(normKey(activeSettingsProject))) {
    const fallbackName = activeSettingsProject === "." ? "Active Workspace" : (activeSettingsProject.split(/[/\\]/).filter(Boolean).pop() || "Project");
    projectsMap.set(normKey(activeSettingsProject), { name: fallbackName, path: activeSettingsProject });
  }

  if (projectsMap.size === 0) {
    container.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:6px 8px;">No projects detected</div>';
    return;
  }

  const activeSettingsNorm = normKey(activeSettingsProject);
  const activeProjNorm = normKey(activeProjectPath);

  projectsMap.forEach(proj => {
    const btn = document.createElement("button");
    btn.type = "button";
    const projNorm = normKey(proj.path);
    const isSelectedInSettings = (activeSettingsNorm && projNorm === activeSettingsNorm) || activeSettingsTab === ("project:" + proj.path);
    btn.className = "settings-nav-item project-item" + (isSelectedInSettings ? " active" : "");
    btn.dataset.projectPath = proj.path;
    const isActiveProj = activeProjNorm && projNorm === activeProjNorm;

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

function openProjectSettings(projectPath, projectName, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const targetPath = projectPath || activeProjectPath || ".";
  const targetName = projectName || (targetPath === "." ? "Active Workspace" : targetPath.split(/[/\\]/).filter(Boolean).pop()) || "Project";
  activeSettingsProject = targetPath;
  openSettingsModal("project:" + targetPath);
  selectSettingsProject(targetPath, targetName);
}

function selectSettingsProject(path, name) {
  if (!path) return;
  const backBtn = document.getElementById("btn-permissions-detail-back");
  if (backBtn) backBtn.style.display = "none";
  activeSettingsTab = "project:" + path;
  activeSettingsProject = path;

  // Clear sidebar active highlights
  document.querySelectorAll(".settings-nav-item").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".settings-panel").forEach(el => el.classList.remove("active"));

  // Highlight this project button
  const normTarget = (path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  document.querySelectorAll(".settings-nav-item.project-item").forEach(btn => {
    const btnNorm = (btn.dataset.projectPath || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (btn.dataset.projectPath === path || (normTarget && btnNorm === normTarget)) {
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
    const normActive = (activeProjectPath || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (path === activeProjectPath || (normTarget && normTarget === normActive)) {
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
  if (typeof renderProjectAttachedFolders === "function") {
    renderProjectAttachedFolders(path);
  }
  if (typeof renderPermissionsSummaries === "function") {
    renderPermissionsSummaries();
  }
}

const MAX_PROJECT_FOLDERS = 5;

function getOrInitProjectPermissionEntry(projPath) {
  if (!projPath) return null;
  if (!currentProjectPermissions) currentProjectPermissions = {};
  if (currentProjectPermissions[projPath]) {
    return { key: projPath, perms: currentProjectPermissions[projPath] };
  }
  const norm = String(projPath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const k of Object.keys(currentProjectPermissions)) {
    if (String(k).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === norm) {
      return { key: k, perms: currentProjectPermissions[k] };
    }
  }
  currentProjectPermissions[projPath] = {
    permission_policy: "inherit",
    terminal_execution_policy: "inherit",
    file_access_policy: "inherit",
    sandbox_mode: null,
    allowed_commands: "",
    attached_folders: []
  };
  return { key: projPath, perms: currentProjectPermissions[projPath] };
}

function getProjectFoldersList(projPath) {
  const target = (projPath || activeSettingsProject || activeProjectPath || "").trim();
  if (!target || target === "." || target === "__NONE__") return [];
  const normFn = p => String(p || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const seen = new Set([normFn(target)]);
  const folders = [target];

  if (currentProjectPermissions) {
    let perms = currentProjectPermissions[target];
    if (!perms) {
      const targetNorm = normFn(target);
      for (const k of Object.keys(currentProjectPermissions)) {
        if (normFn(k) === targetNorm) {
          perms = currentProjectPermissions[k];
          break;
        }
      }
    }
    if (perms && Array.isArray(perms.attached_folders)) {
      for (const raw of perms.attached_folders) {
        const clean = String(raw || "").trim();
        if (!clean || clean === "." || clean === "__NONE__") continue;
        const n = normFn(clean);
        if (seen.has(n)) continue;
        seen.add(n);
        folders.push(clean);
        if (folders.length >= MAX_PROJECT_FOLDERS) break;
      }
    }
  }
  return folders.slice(0, MAX_PROJECT_FOLDERS);
}

function renderProjectAttachedFolders(projPath) {
  const targetPath = (projPath || activeSettingsProject || activeProjectPath || "").trim();
  const listEl = document.getElementById("project-attached-folders-list");
  const badgeEl = document.getElementById("project-folders-count-badge");
  const btnAttach = document.getElementById("btn-attach-project-folder");
  const btnInput = document.getElementById("btn-toggle-attach-folder-input");
  if (!listEl) return;

  const folders = getProjectFoldersList(targetPath);
  const count = folders.length;
  const atMax = count >= MAX_PROJECT_FOLDERS;

  if (badgeEl) {
    badgeEl.innerText = `${count} / ${MAX_PROJECT_FOLDERS}`;
  }
  if (btnAttach) {
    btnAttach.disabled = atMax || !targetPath || targetPath === ".";
    btnAttach.style.opacity = btnAttach.disabled ? "0.45" : "1";
    btnAttach.style.cursor = btnAttach.disabled ? "not-allowed" : "pointer";
    btnAttach.innerText = atMax ? "Max 5 Folders" : "+ Attach Folder";
  }
  if (btnInput) {
    btnInput.disabled = atMax || !targetPath || targetPath === ".";
    btnInput.style.opacity = btnInput.disabled ? "0.45" : "1";
    btnInput.style.cursor = btnInput.disabled ? "not-allowed" : "pointer";
  }
  if (atMax) {
    cancelAttachProjectFolderInput();
  }

  if (folders.length === 0) {
    listEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">Select a project workspace to attach folders.</div>`;
    return;
  }

  listEl.innerHTML = "";
  folders.forEach((folderPath, idx) => {
    const isPrimary = idx === 0;
    const parts = String(folderPath).split(/[/\\]/).filter(Boolean);
    const folderName = parts.length > 0 ? parts[parts.length - 1] : folderPath;

    const row = document.createElement("div");
    row.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 2px;" +
      (idx < folders.length - 1 ? " border-bottom:1px solid rgba(255, 255, 255, 0.05);" : "");

    const rolePill = isPrimary
      ? `<span style="font-size:10px; color:var(--text-muted); background:rgba(255, 255, 255, 0.06); padding:1px 6px; border-radius:4px; flex-shrink:0;">Primary Root</span>`
      : `<span style="font-size:10px; color:var(--text-muted); background:rgba(255, 255, 255, 0.05); padding:1px 6px; border-radius:4px; flex-shrink:0;">Attached #${idx + 1}</span>`;

    const actionHtml = isPrimary
      ? ""
      : `<button type="button" class="btn-perm-open" style="padding:2px 8px; font-size:11px; color:var(--text-muted);" title="Detach folder from project" onclick="removeProjectFolder('${escapeJsAttr(folderPath)}', '${escapeJsAttr(targetPath)}')">Detach</button>`;

    row.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:2px; min-width:0; flex:1;">
        <div style="display:flex; align-items:center; gap:7px; min-width:0;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted); flex-shrink:0;">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span style="font-size:12px; font-weight:500; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(folderName)}</span>
          ${rolePill}
        </div>
        <div style="font-size:11px; font-family:ui-monospace,Menlo,Monaco,monospace; color:var(--text-muted); padding-left:20px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(folderPath)}">${escapeHtml(folderPath)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
        ${actionHtml}
      </div>
    `;
    listEl.appendChild(row);
  });
}

function toggleAttachProjectFolderInput() {
  const row = document.getElementById("project-attach-folder-input-row");
  const input = document.getElementById("input-attach-project-folder");
  if (!row) return;
  const targetPath = (activeSettingsProject || activeProjectPath || "").trim();
  const folders = getProjectFoldersList(targetPath);
  if (folders.length >= MAX_PROJECT_FOLDERS) {
    showToast("Maximum of 5 primary folders can be attached to a project");
    return;
  }
  const isVisible = row.style.display === "flex";
  row.style.display = isVisible ? "none" : "flex";
  if (!isVisible && input) {
    input.value = "";
    input.focus();
  }
}

function cancelAttachProjectFolderInput() {
  const row = document.getElementById("project-attach-folder-input-row");
  const input = document.getElementById("input-attach-project-folder");
  if (row) row.style.display = "none";
  if (input) input.value = "";
}

function confirmAttachProjectFolderInput() {
  const input = document.getElementById("input-attach-project-folder");
  const rawVal = input ? input.value.trim() : "";
  if (!rawVal) {
    showToast("Please enter a folder path to attach");
    return;
  }
  const targetPath = (activeSettingsProject || activeProjectPath || "").trim();
  if (addAttachedFolderToProject(targetPath, rawVal)) {
    cancelAttachProjectFolderInput();
  }
}

function addAttachedFolderToProject(projPath, newFolderPath) {
  const targetPath = (projPath || activeSettingsProject || activeProjectPath || "").trim();
  const candidate = String(newFolderPath || "").trim();
  if (!targetPath || targetPath === ".") {
    showToast("Select a project first before attaching folders");
    return false;
  }
  if (!candidate) return false;

  const existing = getProjectFoldersList(targetPath);
  if (existing.length >= MAX_PROJECT_FOLDERS) {
    showToast("Maximum of 5 folders can be attached to a project");
    return false;
  }

  const normFn = p => String(p || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const candidateNorm = normFn(candidate);
  if (existing.some(f => normFn(f) === candidateNorm)) {
    showToast("That folder is already attached to this project");
    return false;
  }

  const entry = getOrInitProjectPermissionEntry(targetPath);
  if (!entry) return false;
  if (!Array.isArray(entry.perms.attached_folders)) {
    entry.perms.attached_folders = [];
  }
  if (entry.perms.attached_folders.length >= MAX_PROJECT_FOLDERS - 1) {
    showToast("Maximum of 5 folders can be attached to a project");
    return false;
  }
  entry.perms.attached_folders.push(candidate);
  persistProjectPermissions(entry.key);
  renderProjectAttachedFolders(targetPath);
  if (typeof renderProjectTree === "function") renderProjectTree();
  if (typeof renderSettingsProjectsList === "function") renderSettingsProjectsList();
  showToast("Attached folder to project (" + (existing.length + 1) + "/" + MAX_PROJECT_FOLDERS + ")");
  return true;
}

async function attachProjectFolder(projPath) {
  const targetPath = (projPath || activeSettingsProject || activeProjectPath || "").trim();
  if (!targetPath || targetPath === ".") {
    showToast("Select a project first before attaching folders");
    return;
  }
  const existing = getProjectFoldersList(targetPath);
  if (existing.length >= MAX_PROJECT_FOLDERS) {
    showToast("Maximum of 5 folders can be attached to a project");
    return;
  }

  if (typeof window.chooseDirectory === "function") {
    try {
      const raw = await window.chooseDirectory();
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (res && res.status === "ok" && res.path) {
        addAttachedFolderToProject(targetPath, res.path);
        return;
      }
      if (res && res.status === "cancelled") {
        return;
      }
    } catch (err) {
      console.warn("chooseDirectory failed, falling back to manual path input:", err);
    }
  }
  toggleAttachProjectFolderInput();
}

function removeProjectFolder(folderPath, projPath) {
  const targetPath = (projPath || activeSettingsProject || activeProjectPath || "").trim();
  if (!targetPath || !folderPath) return;
  const entry = getOrInitProjectPermissionEntry(targetPath);
  if (!entry || !Array.isArray(entry.perms.attached_folders)) return;

  const normFn = p => String(p || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const targetFolderNorm = normFn(folderPath);
  entry.perms.attached_folders = entry.perms.attached_folders.filter(f => normFn(f) !== targetFolderNorm);

  persistProjectPermissions(entry.key);
  renderProjectAttachedFolders(targetPath);
  if (typeof renderProjectTree === "function") renderProjectTree();
  if (typeof renderSettingsProjectsList === "function") renderSettingsProjectsList();
  showToast("Detached folder from project");
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
  if (typeof renderPermissionsSummaries === "function") {
    renderPermissionsSummaries();
  }
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
  await selectProject(activeSettingsProject, name, { preserveConversationProject: true });
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

  const orderedCategories = ["Shuffle AI", "Local Models", "BYOK Models"];
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
  let model = (byokInput && byokInput.value.trim()) || (modelSelect && modelSelect.value) || (activeAiModel || "tendon-local");

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
  const isShuffleEnv =
    window.oauthLoggedIn ||
    window.activeExecutionMode === "shuffle" ||
    model === "shuffle-ai" ||
    model === "shuffle" ||
    (currentAiKey && currentAiKey.startsWith("shfl_"));
  if (isShuffleEnv) {
    defaultUrl = "https://uk.shuffler.io/api/v1 (Shuffle AI)";
  } else if (model.startsWith("gemini")) {
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

    let url = urlInput ? urlInput.value.trim() : (currentAiUrl || "");
    let key = keyInput ? keyInput.value.trim() : "";
    if (!key && currentAiKey && activeSettingsTab !== "models" && activeSettingsTab !== "mode-direct") {
      key = currentAiKey;
    }
    if (!window.oauthLoggedIn) {
      if (key.startsWith("shfl_")) {
        key = "";
        if (keyInput && keyInput.value.trim().startsWith("shfl_")) keyInput.value = "";
        localStorage.removeItem("orborus_ai_key");
      }
      if (url.includes("shuffler.io") || url.includes("shuffle")) {
        url = "";
        if (urlInput && (urlInput.value.includes("shuffler.io") || urlInput.value.includes("shuffle"))) urlInput.value = "";
        localStorage.removeItem("orborus_ai_url");
      }
    }
    let model = (byokModelInput && byokModelInput.value.trim()) || (modelSelect ? modelSelect.value : (activeAiModel || "tendon-local"));
    if (model === "custom" && customModelInput && customModelInput.value.trim()) {
      model = customModelInput.value.trim();
    }
    if (!window.oauthLoggedIn && (model === "shuffle-ai" || model === "shuffle")) {
      model = "tendon-local";
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
    } else if (!window.oauthLoggedIn || activeSettingsTab === "models" || activeSettingsTab === "mode-direct") {
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
      is_logged_in: !!window.oauthLoggedIn,
      oauth_logged_in: !!window.oauthLoggedIn,
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
        is_logged_in: !!window.oauthLoggedIn,
        oauth_logged_in: !!window.oauthLoggedIn,
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
      const auth = (window.oauthLoggedIn && authKeyInput) ? authKeyInput.value.trim() : "";
      const env = envNameInput ? envNameInput.value.trim() : "";
      if (window.oauthLoggedIn && (orgId || auth || env || baseUrl)) {
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

async function logoutShuffle(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  isOAuthPending = false;
  window.shuffleVerified = false;
  window.oauthLoggedIn = false;
  isLoggedIn = false;

  const testStatusDiv = document.getElementById("shuffle-ai-test-status");
  if (testStatusDiv) testStatusDiv.style.display = "none";

  const inputAuthKey = document.getElementById("input-auth-key");
  const inputOrgId = document.getElementById("input-org-id");
  const inputEnvName = document.getElementById("input-env-name");
  const inputBaseUrl = document.getElementById("input-base-url");
  const inputAiKey = document.getElementById("input-ai-key");
  const inputAiUrl = document.getElementById("input-ai-url");
  if (inputAuthKey) inputAuthKey.value = "";
  if (inputOrgId) inputOrgId.value = "";
  if (inputEnvName) inputEnvName.value = "";
  if (inputBaseUrl) inputBaseUrl.value = "";
  if (inputAiKey && inputAiKey.value.trim().startsWith("shfl_")) inputAiKey.value = "";
  if (inputAiUrl && (inputAiUrl.value.includes("shuffler.io") || inputAiUrl.value.includes("shuffle"))) inputAiUrl.value = "";

  if (typeof currentAiKey !== "undefined" && currentAiKey && currentAiKey.startsWith("shfl_")) {
    currentAiKey = "";
  }
  if (typeof currentAiUrl !== "undefined" && currentAiUrl && (currentAiUrl.includes("shuffler.io") || currentAiUrl.includes("shuffle"))) {
    currentAiUrl = "";
  }

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("orborus_oauth_logged_in");
    const currentStoredKey = localStorage.getItem("orborus_ai_key") || "";
    const currentStoredUrl = localStorage.getItem("orborus_ai_url") || "";
    if (currentStoredKey.startsWith("shfl_") || currentStoredUrl.includes("shuffler.io") || currentStoredUrl.includes("shuffle")) {
      localStorage.removeItem("orborus_ai_key");
      if (typeof currentAiKey !== "undefined") currentAiKey = "";
    }
    if (currentStoredUrl.includes("shuffler.io") || currentStoredUrl.includes("shuffle")) {
      localStorage.removeItem("orborus_ai_url");
      if (typeof currentAiUrl !== "undefined") currentAiUrl = "";
    }
  }

  if (activeAiModel === "shuffle-ai" || activeAiModel === "shuffle") {
    activeAiModel = "tendon-local";
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_ai_model", "tendon-local");
      localStorage.setItem("orborus_active_ai_model", "tendon-local");
    }
  }
  if (activeExecutionMode === "cloud" || activeExecutionMode === "hybrid" || activeExecutionMode === "shuffle") {
    activeExecutionMode = "local";
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_active_execution_mode", "local");
    }
  }

  const immediateResetState = {
    oauth_logged_in: false,
    is_logged_in: false,
    oauth_token: "",
    auth: "",
    environment: "standalone",
    org_id: "",
    base_url: "",
    ai_api_key: currentAiKey || "",
    ai_api_url: currentAiUrl || "",
    ai_model: activeAiModel,
    active_execution_mode: activeExecutionMode
  };

  // Immediately update UI to disconnected before awaiting backend bridge
  updateAuthState(immediateResetState);
  if (typeof updateModesDisplay === "function") updateModesDisplay();
  if (typeof populateAiModelSelect === "function") populateAiModelSelect();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();

  try {
    let resp = null;
    const callLogoutBackend = async function() {
      if (typeof window.logoutShuffleBridge === "function") {
        return await window.logoutShuffleBridge();
      }
      if (typeof callGo === "function") {
        return await callGo("logoutShuffle", "{}");
      }
      if (typeof window.bridgeCall === "function") {
        return await window.bridgeCall("logoutShuffle", "{}");
      }
      return "{}";
    };
    const logoutPromise = callLogoutBackend();
    const timeoutPromise = new Promise(function(resolve) {
      setTimeout(resolve, 5000, "{}");
    });
    const respRaw = await Promise.race([logoutPromise, timeoutPromise]);
    if (typeof respRaw === "string") {
      try { resp = JSON.parse(respRaw); } catch (_) { resp = respRaw; }
    } else {
      resp = respRaw;
    }

    const backendState = (resp && resp.state) ? Object.assign({}, resp.state, {
      oauth_logged_in: false,
      is_logged_in: false,
      oauth_token: "",
      auth: ""
    }) : immediateResetState;

    updateAuthState(backendState);
    if (typeof updateModesDisplay === "function") updateModesDisplay();
    if (typeof populateAiModelSelect === "function") populateAiModelSelect();
    if (typeof renderModelDropdown === "function") renderModelDropdown();
    if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
    if (typeof showToast === "function") {
      showToast("Logged out of Shuffle AI. Configuration reset.");
    }
  } catch (err) {
    console.error("[OAUTH] Logout error:", err);
    updateAuthState(immediateResetState);
    if (typeof updateModesDisplay === "function") updateModesDisplay();
    if (typeof renderModelDropdown === "function") renderModelDropdown();
    if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
    if (typeof showToast === "function") {
      showToast("Logged out of Shuffle AI.");
    }
  }
}
window.logoutShuffle = logoutShuffle;

window.onAuthUpdated = function(state) {
  console.log("[OAUTH] Dynamic auth updated:", state);
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch (_) {}
  }
  state = state || {};
  const wasPending = isOAuthPending;
  isOAuthPending = false;
  const isNowConnected = (state.oauth_logged_in === true) && !!(state.oauth_token || (state.auth && state.auth !== "local-tendon" && !state.auth.startsWith("sk-") && !state.auth.startsWith("AIza")));
  if (isNowConnected) {
    window.oauthLoggedIn = true;
    window.shuffleVerified = true;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_oauth_logged_in", "true");
    }
  } else {
    window.oauthLoggedIn = false;
    window.shuffleVerified = false;
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("orborus_oauth_logged_in");
    }
  }
  const cancelBtn = document.getElementById("btn-oauth-cancel");
  if (cancelBtn) cancelBtn.style.display = "none";
  updateAuthState(state);
  updateModesDisplay();
  dismissAuthErrorsIfConfigured();
  if (typeof populateAiModelSelect === "function") populateAiModelSelect();
  if (typeof renderModelDropdown === "function") renderModelDropdown();
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof showToast === "function") {
    if (wasPending && isNowConnected) {
      showToast("Shuffle OAuth2 authentication complete! Shuffle AI models enabled.");
    } else if (wasPending && !isNowConnected) {
      showToast("Shuffle AI authentication failed or was cancelled.", "error");
    }
  }
};

async function loginWithOAuth() {
  isOAuthPending = true;

  const btnLabel = document.getElementById("lbl-btn-oauth-login") || document.getElementById("lbl-btn-auth");
  const cancelBtn = document.getElementById("btn-oauth-cancel");
  const authStatusText = document.getElementById("settings-auth-status-text");
  const authStatusDot = document.getElementById("settings-auth-status-dot");
  if (btnLabel) btnLabel.innerText = "Opening Browser...";
  if (cancelBtn) cancelBtn.style.display = "inline-flex";
  if (authStatusDot) authStatusDot.className = "status-dot standalone";
  if (authStatusText) {
    authStatusText.innerText = "Opening browser for login...";
    authStatusText.style.color = "var(--text-secondary)";
  }

  try {
    let authUrl = "";
    let respRaw = null;
    if (typeof window.startOAuthLogin === "function") {
      respRaw = await window.startOAuthLogin("https://shuffle.security");
    } else if (typeof callGo === "function") {
      respRaw = await callGo("startOAuthLogin", "https://shuffle.security");
    } else if (typeof window.bridgeCall === "function") {
      respRaw = await window.bridgeCall("startOAuthLogin", JSON.stringify({ base_url: "https://shuffle.security" }));
    }

    if (respRaw !== null && respRaw !== undefined) {
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

    if (btnLabel) btnLabel.innerText = "Waiting for Login... (Re-open)";
    if (authStatusText) authStatusText.innerText = "Waiting for browser login...";
    const btnOAuth = document.getElementById("btn-oauth-login");
    if (btnOAuth) btnOAuth.title = "Click to re-open Shuffle AI login in browser";
    showToast("Opening browser for Shuffle AI login...");
  } catch (err) {
    console.error("Failed to start OAuth login:", err);
    isOAuthPending = false;
    if (btnLabel) btnLabel.innerText = "Connect Shuffle AI";
    if (cancelBtn) cancelBtn.style.display = "none";
    updateAuthState({
      oauth_logged_in: !!window.oauthLoggedIn,
      is_logged_in: !!window.oauthLoggedIn
    });
    showToast("Error opening login: " + (err.message || err));
  }
}

async function cancelOAuthLogin(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  isOAuthPending = false;
  const btnLabel = document.getElementById("lbl-btn-oauth-login") || document.getElementById("lbl-btn-auth");
  const cancelBtn = document.getElementById("btn-oauth-cancel");
  if (btnLabel) btnLabel.innerText = "Connect Shuffle AI";
  if (cancelBtn) cancelBtn.style.display = "none";

  try {
    if (typeof window.cancelOAuthLoginBridge === "function") {
      await window.cancelOAuthLoginBridge();
    } else if (typeof window.bridgeCall === "function") {
      await window.bridgeCall("cancelOAuthLogin", "{}");
    }
  } catch (err) {
    console.warn("Cancel OAuth login error:", err);
  }
  updateAuthState({
    oauth_logged_in: !!window.oauthLoggedIn,
    is_logged_in: !!window.oauthLoggedIn
  });
  showToast("Cancelled pending Shuffle AI login");
}
window.cancelOAuthLogin = cancelOAuthLogin;

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
    const gpuName = window.localGpuName || "Local GPU";
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

    if (data && typeof updateLocalModelCatalogState === "function") {
      updateLocalModelCatalogState(
        data.catalog,
        data.free_disk_bytes,
        data.free_disk_gb,
        data.free_disk_display,
        data.download_state
      );
    }

    const diskSuffix = (data && data.free_disk_display) ? ` · ${data.free_disk_display}` : "";

    if (!data || !Array.isArray(data.models)) {
      if (container) {
        container.innerHTML = `<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:12px;">
          No .gguf models found in <code>${escapeHtml(targetDir)}</code>
        </div>`;
      }
      if (countEl) countEl.innerText = `0 models found${diskSuffix}`;
      return;
    }

    const models = data.models;
    const activePath = data.active_model_path || window.localModelPath || "";
    if (countEl) countEl.innerText = `${models.length} model${models.length === 1 ? "" : "s"} found${diskSuffix}`;

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
        const memFit = (typeof checkLocalModelMemoryFit === "function") ? checkLocalModelMemoryFit(m) : { isOutsideRange: false };
        const isOutOfRange = !!memFit.isOutsideRange;
        const row = document.createElement("div");
        const isActive = !!m.is_active || (activePath && (m.path === activePath || m.name === activePath.split(/[\\/]/).pop()));
        let rowClass = "local-model-row" + (isActive ? " active" : "");
        if (isOutOfRange) {
          rowClass += " disabled-range";
          row.title = memFit.tooltip || memFit.reason;
        }
        row.className = rowClass;

        const easyName = (typeof formatEasyModelName === "function") ? formatEasyModelName(m.name) : m.name;
        const ramEst = (typeof estimateModelRam === "function") ? estimateModelRam(m.name, m.size_bytes) : "";
        const quantHtml = m.quant ? `<span class="local-model-quant-badge">${escapeHtml(m.quant)}</span>` : "";
        const sizeHtml = m.size_display ? `<span class="local-model-size-badge">${escapeHtml(m.size_display)}</span>` : "";
        const ramBadgeClass = isOutOfRange ? "model-ram-badge outside-range" : "model-ram-badge";
        const ramHtml = ramEst ? `<span class="${ramBadgeClass}" title="${escapeHtml(memFit.tooltip || ramEst)}">${escapeHtml(ramEst)}</span>` : "";
        const statusPill = isOutOfRange ? `<span class="model-badge unavailable" title="${escapeHtml(memFit.tooltip || memFit.reason)}">Exceeds Range</span>` : "";

        let btnHtml = "";
        if (isActive) {
          btnHtml = `<button type="button" class="btn-activate-model active">Active Model</button>`;
        } else if (isOutOfRange) {
          btnHtml = `<button type="button" class="btn-activate-model disabled" disabled title="${escapeHtml(memFit.tooltip || memFit.reason)}" style="opacity:0.4; cursor:not-allowed;">Unavailable</button>`;
        } else {
          btnHtml = `<button type="button" class="btn-activate-model">Activate</button>`;
        }

        row.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:2px; overflow:hidden; flex:1;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="local-model-name" style="font-weight:600;" title="${escapeHtml(m.path || m.name)}">${escapeHtml(easyName)}</span>
              ${ramHtml}
              ${statusPill}
            </div>
            <div class="local-model-meta">
              <span style="font-size:11px; opacity:0.85; font-family:monospace;">${escapeHtml(m.name)}</span>
              ${sizeHtml}
              ${quantHtml}
              <span style="font-size:10.5px; opacity:0.7;">${escapeHtml(m.mod_time || "")}</span>
            </div>
          </div>
          ${btnHtml}
        `;

        const btn = row.querySelector(".btn-activate-model");
        if (btn && !isActive && !isOutOfRange) {
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

  const rawName = model ? model.name : (fallbackPath ? fallbackPath.split(/[\\/]/).pop() : "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf");
  const easyName = (typeof formatEasyModelName === "function") ? formatEasyModelName(rawName) : rawName;
  const size = model && model.size_display ? model.size_display : "~12.1 GB";
  const quant = model && model.quant ? ` &bull; ${model.quant}` : "";
  const ramEst = (typeof estimateModelRam === "function") ? estimateModelRam(rawName, model ? model.size_bytes : 0) : "~12 GB RAM";

  if (filenameEl) {
    filenameEl.innerHTML = `<span>${escapeHtml(easyName)}</span> <span class="model-ram-badge" style="margin-left:6px;">${escapeHtml(ramEst)}</span>`;
  }
  if (metaEl) {
    metaEl.innerHTML = `Weight: <code>${escapeHtml(rawName)}</code> &bull; Size: ${size}${quant}`;
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

// --- Shuffle Multi-Tenant Selector & Region Helpers ---
function parseShuffleRegionMeta(regionUrl) {
  let raw = (regionUrl || "").trim();
  if (!raw) raw = window.activeShuffleBaseUrl || "https://uk.shuffler.io";
  if (!/^https?:\/\//i.test(raw)) {
    if (raw.includes(".shuffler.io")) {
      raw = "https://" + raw;
    } else {
      raw = "https://" + raw.toLowerCase() + ".shuffler.io";
    }
  }
  raw = raw.replace(/\/+$/, "");

  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch (e) {
    host = raw.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  }

  let sub = "uk";
  if (host.endsWith(".shuffler.io")) {
    sub = host.slice(0, -".shuffler.io".length) || "uk";
  } else if (host === "shuffler.io") {
    sub = "eu";
  } else if (host) {
    sub = host.split(".")[0] || "uk";
  }

  let flag = "🌐";
  if (sub === "uk" || sub.startsWith("uk-") || sub === "gb") {
    flag = "🇬🇧";
  } else if (sub === "eu" || sub.startsWith("eu-")) {
    flag = "🇪🇺";
  } else if (sub === "us" || sub.startsWith("us-")) {
    flag = "🇺🇸";
  } else if (sub === "ca" || sub.startsWith("ca-")) {
    flag = "🇨🇦";
  } else if (sub === "de" || sub.startsWith("de-")) {
    flag = "🇩🇪";
  } else if (sub === "fr" || sub.startsWith("fr-")) {
    flag = "🇫🇷";
  } else if (sub === "jp" || sub.startsWith("jp-")) {
    flag = "🇯🇵";
  } else if (sub === "in" || sub.startsWith("in-")) {
    flag = "🇮🇳";
  } else if (sub === "au" || sub.startsWith("au-")) {
    flag = "🇦🇺";
  } else if (sub === "sg" || sub.startsWith("sg-")) {
    flag = "🇸🇬";
  }

  return {
    flag: flag,
    code: sub.toUpperCase(),
    baseUrl: raw
  };
}

function renderShuffleTenantDropdown() {
  const selectedDisplay = document.getElementById("shuffle-tenant-selected-display");
  const menu = document.getElementById("shuffle-tenant-dropdown-menu");
  const regionUrlLabel = document.getElementById("lbl-shuffle-tenant-region-url");
  if (!selectedDisplay || !menu) return;

  const orgs = Array.isArray(window.shuffleOrgs) ? window.shuffleOrgs : [];
  const activeId = window.activeShuffleOrgId || "";

  let activeOrg = orgs.find(o => o && o.id === activeId) || orgs[0] || null;
  const activeMeta = parseShuffleRegionMeta(activeOrg ? activeOrg.region_url : (window.activeShuffleBaseUrl || "https://uk.shuffler.io"));
  const activeName = activeOrg
    ? (activeOrg.name || activeOrg.id)
    : (window.activeShuffleOrgName || window.activeShuffleOrgId || "Default Tenant");

  selectedDisplay.innerHTML =
    `<span class="shuffle-tenant-flag">${escapeHtml(activeMeta.flag)}</span>` +
    `<span class="shuffle-tenant-region-tag">${escapeHtml(activeMeta.code)}</span>` +
    `<span class="shuffle-tenant-name">${escapeHtml(activeName)}</span>`;

  if (regionUrlLabel) {
    regionUrlLabel.innerText = activeMeta.baseUrl + (activeOrg && activeOrg.id ? ` • Org ID: ${activeOrg.id}` : "");
  }

  if (orgs.length === 0) {
    menu.innerHTML = `<div style="padding:8px 10px; font-size:11.5px; color:var(--text-muted);">No additional tenants found. Click Refresh to query /api/v1/getinfo.</div>`;
    return;
  }

  const orgIds = new Set(orgs.map(o => o && o.id).filter(Boolean));
  const parents = [];
  const childrenByParent = {};

  for (const org of orgs) {
    if (!org || !org.id) continue;
    const parentId = (org.creator_org || "").trim();
    if (parentId && parentId !== org.id && orgIds.has(parentId)) {
      if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
      childrenByParent[parentId].push(org);
    } else {
      parents.push(org);
    }
  }

  const ordered = [];
  const visited = new Set();
  for (const parent of parents) {
    if (visited.has(parent.id)) continue;
    visited.add(parent.id);
    ordered.push({ org: parent, isChild: false });
    const kids = childrenByParent[parent.id] || [];
    for (const child of kids) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      ordered.push({ org: child, isChild: true });
    }
  }
  for (const org of orgs) {
    if (org && org.id && !visited.has(org.id)) {
      visited.add(org.id);
      ordered.push({ org: org, isChild: !!(org.creator_org && org.creator_org !== org.id) });
    }
  }

  let html = "";
  for (const item of ordered) {
    const org = item.org;
    const isSelected = (activeOrg && org.id === activeOrg.id) || (activeId && org.id === activeId);
    const meta = parseShuffleRegionMeta(org.region_url);
    const safeId = escapeHtml(org.id);
    const safeName = escapeHtml(org.name || org.id);
    const rowClass = "shuffle-tenant-option" + (item.isChild ? " child-tenant" : "") + (isSelected ? " active" : "");
    html += `<button type="button" class="${rowClass}" onclick="selectShuffleTenant('${safeId}', event)" title="${safeName} (${escapeHtml(meta.baseUrl)})">` +
      `<div class="shuffle-tenant-option-left">` +
      (item.isChild ? `<span class="shuffle-tenant-child-branch">↳</span>` : ``) +
      `<span class="shuffle-tenant-flag">${escapeHtml(meta.flag)}</span>` +
      `<span class="shuffle-tenant-region-tag">${escapeHtml(meta.code)}</span>` +
      `<span class="shuffle-tenant-name">${safeName}</span>` +
      `</div>` +
      (isSelected ? `<span class="shuffle-tenant-check">✓</span>` : ``) +
      `</button>`;
  }
  menu.innerHTML = html;
}

function toggleShuffleTenantDropdown(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const menu = document.getElementById("shuffle-tenant-dropdown-menu");
  if (!menu) return;
  const willShow = !menu.classList.contains("visible");
  if (typeof closeAllDropdowns === "function") {
    closeAllDropdowns(["shuffle-tenant-dropdown-menu"]);
  }
  if (willShow) {
    renderShuffleTenantDropdown();
    menu.classList.add("visible");
  } else {
    menu.classList.remove("visible");
  }
}

async function resolveShuffleAuthToken() {
  if (window.activeShuffleToken && typeof window.activeShuffleToken === "string" && window.activeShuffleToken.trim()) {
    return window.activeShuffleToken.trim();
  }
  const inputAuthKey = document.getElementById("input-auth-key");
  if (inputAuthKey && inputAuthKey.value && inputAuthKey.value.trim()) {
    return inputAuthKey.value.trim();
  }
  if (typeof currentAiKey === "string" && currentAiKey.trim().startsWith("shfl_")) {
    return currentAiKey.trim();
  }
  if (typeof localStorage !== "undefined") {
    const cached = localStorage.getItem("orborus_shuffle_token");
    if (cached && cached.trim()) return cached.trim();
  }
  if (typeof window.bridgeCall === "function") {
    try {
      const raw = await window.bridgeCall("getInitialState", "{}");
      const st = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (st) {
        const tok = st.oauth_token || st.auth || (typeof st.ai_api_key === "string" && st.ai_api_key.startsWith("shfl_") ? st.ai_api_key : "");
        if (tok && typeof tok === "string" && tok.trim()) {
          window.activeShuffleToken = tok.trim();
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("orborus_shuffle_token", window.activeShuffleToken);
          }
          return window.activeShuffleToken;
        }
      }
    } catch (_) {}
  }
  return "";
}

async function fetchShuffleTenantsClientSide() {
  const token = await resolveShuffleAuthToken();
  const endpoints = ["https://uk.shuffler.io/api/v1/getinfo"];
  if (window.activeShuffleBaseUrl) {
    const meta = parseShuffleRegionMeta(window.activeShuffleBaseUrl);
    const customEp = meta.baseUrl.replace(/\/+$/, "") + "/api/v1/getinfo";
    if (!endpoints.includes(customEp)) endpoints.push(customEp);
  }
  if (!endpoints.includes("https://shuffler.io/api/v1/getinfo")) {
    endpoints.push("https://shuffler.io/api/v1/getinfo");
  }

  for (const endpoint of endpoints) {
    try {
      const headers = { "Accept": "application/json" };
      if (token) {
        headers["Authorization"] = token.toLowerCase().startsWith("bearer ") ? token : ("Bearer " + token);
      }
      const res = await fetch(endpoint, {
        method: "GET",
        headers: headers
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.orgs) && data.orgs.length > 0) {
        const normalized = data.orgs
          .filter(o => o && o.id)
          .map(o => ({
            id: String(o.id).trim(),
            name: String(o.name || o.id).trim(),
            region_url: String(o.region_url || "").trim(),
            creator_org: String(o.creator_org || "").trim()
          }));
        if (normalized.length > 0) {
          return {
            shuffle_orgs: normalized,
            active_org: data.active_org || null
          };
        }
      }
    } catch (_) {}
  }
  return null;
}

async function selectShuffleTenant(orgId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const menu = document.getElementById("shuffle-tenant-dropdown-menu");
  if (menu) menu.classList.remove("visible");
  if (!orgId) return;

  try {
    const matched = (window.shuffleOrgs || []).find(o => o && o.id === orgId);
    const matchedMeta = parseShuffleRegionMeta(matched ? matched.region_url : (window.activeShuffleBaseUrl || "https://uk.shuffler.io"));

    let raw = null;
    if (typeof window.bridgeCall === "function" && !window._tenantBridgeUnsupported) {
      raw = await window.bridgeCall("selectShuffleTenant", JSON.stringify({
        org_id: orgId,
        name: matched ? (matched.name || matched.id) : "",
        region_url: matchedMeta.baseUrl
      }));
    }
    let resp = null;
    if (raw) {
      try {
        resp = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (e) {}
    }
    if (resp && resp.error === "unknown action") {
      window._tenantBridgeUnsupported = true;
      resp = null;
    } else if (resp && resp.error) {
      showToast("Failed to switch tenant: " + resp.error);
      return;
    }

    if (window._tenantBridgeUnsupported && typeof window.bridgeCall === "function") {
      const fallbackPayload = {
        org_id: orgId,
        base_url: matchedMeta.baseUrl
      };
      const tok = await resolveShuffleAuthToken();
      if (tok) fallbackPayload.auth = tok;
      await window.bridgeCall("updateAuth", JSON.stringify(fallbackPayload));
      if (tok || (typeof currentAiKey === "string" && currentAiKey.startsWith("shfl_"))) {
        await window.bridgeCall("setAiConfig", JSON.stringify({
          url: matchedMeta.baseUrl,
          key: tok || currentAiKey,
          model: activeAiModel || "gemini-3.8-flash"
        }));
      }
    }

    if (resp && Array.isArray(resp.shuffle_orgs) && resp.shuffle_orgs.length > 0) {
      window.shuffleOrgs = resp.shuffle_orgs;
    }
    window.activeShuffleOrgId = (resp && resp.org_id) ? resp.org_id : orgId;
    if (resp && resp.org_name) {
      window.activeShuffleOrgName = resp.org_name;
    } else if (matched) {
      window.activeShuffleOrgName = matched.name || matched.id;
    }
    if (resp && resp.base_url) {
      window.activeShuffleBaseUrl = resp.base_url;
      currentAiUrl = resp.base_url;
    } else {
      window.activeShuffleBaseUrl = matchedMeta.baseUrl;
      currentAiUrl = matchedMeta.baseUrl;
    }

    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_shuffle_org_id", window.activeShuffleOrgId || "");
      localStorage.setItem("orborus_shuffle_org_name", window.activeShuffleOrgName || "");
      localStorage.setItem("orborus_shuffle_base_url", window.activeShuffleBaseUrl || "");
      if (Array.isArray(window.shuffleOrgs) && window.shuffleOrgs.length > 0) {
        try { localStorage.setItem("orborus_shuffle_orgs", JSON.stringify(window.shuffleOrgs)); } catch (_) {}
      }
    }

    const inputOrgId = document.getElementById("input-org-id");
    if (inputOrgId) inputOrgId.value = window.activeShuffleOrgId;
    const inputBaseUrl = document.getElementById("input-base-url");
    if (inputBaseUrl && window.activeShuffleBaseUrl) inputBaseUrl.value = window.activeShuffleBaseUrl;
    const lblOrg = document.getElementById("lbl-org");
    if (lblOrg) lblOrg.innerText = window.activeShuffleOrgName || window.activeShuffleOrgId || "Shuffle";

    renderShuffleTenantDropdown();
    window.shuffleAuthenticatedApps = [];
    if (typeof refreshShuffleAuthenticatedApps === "function") {
      refreshShuffleAuthenticatedApps();
    }
    showToast("Switched Shuffle tenant to " + (window.activeShuffleOrgName || window.activeShuffleOrgId));
  } catch (err) {
    console.error("selectShuffleTenant error:", err);
    showToast("Failed to switch tenant: " + (err.message || err));
  }
}

async function refreshShuffleTenants(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  if (window._fetchingShuffleTenants) return;
  window._fetchingShuffleTenants = true;
  try {
    let resp = null;
    if (typeof window.bridgeCall === "function" && !window._tenantBridgeUnsupported) {
      const raw = await window.bridgeCall("refreshShuffleTenants", "{}");
      if (raw) {
        try {
          resp = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {}
      }
      if (resp && resp.error === "unknown action") {
        window._tenantBridgeUnsupported = true;
        resp = null;
      }
    }

    if (!resp || resp.error || !Array.isArray(resp.shuffle_orgs) || resp.shuffle_orgs.length === 0) {
      const clientResult = await fetchShuffleTenantsClientSide();
      if (clientResult && Array.isArray(clientResult.shuffle_orgs) && clientResult.shuffle_orgs.length > 0) {
        const orgs = clientResult.shuffle_orgs;
        let chosen = orgs.find(o => o.id === window.activeShuffleOrgId) || null;
        if (!chosen && clientResult.active_org && clientResult.active_org.id) {
          chosen = orgs.find(o => o.id === clientResult.active_org.id) || null;
        }
        if (!chosen) chosen = orgs[0];
        const chosenMeta = parseShuffleRegionMeta(chosen ? chosen.region_url : window.activeShuffleBaseUrl);
        resp = {
          shuffle_orgs: orgs,
          org_id: chosen ? chosen.id : window.activeShuffleOrgId,
          org_name: chosen ? (chosen.name || chosen.id) : window.activeShuffleOrgName,
          base_url: chosenMeta.baseUrl
        };
        if (window._tenantBridgeUnsupported && chosen && typeof window.bridgeCall === "function") {
          const tok = await resolveShuffleAuthToken();
          const syncPayload = { org_id: chosen.id, base_url: chosenMeta.baseUrl };
          if (tok) syncPayload.auth = tok;
          await window.bridgeCall("updateAuth", JSON.stringify(syncPayload));
        }
      }
    }

    if (resp) {
      if (Array.isArray(resp.shuffle_orgs) && resp.shuffle_orgs.length > 0) {
        window.shuffleOrgs = resp.shuffle_orgs;
        if (typeof localStorage !== "undefined") {
          try { localStorage.setItem("orborus_shuffle_orgs", JSON.stringify(resp.shuffle_orgs)); } catch (_) {}
        }
      }
      if (resp.org_id) {
        window.activeShuffleOrgId = resp.org_id;
        if (typeof localStorage !== "undefined") localStorage.setItem("orborus_shuffle_org_id", resp.org_id);
      }
      if (resp.org_name) {
        window.activeShuffleOrgName = resp.org_name;
        if (typeof localStorage !== "undefined") localStorage.setItem("orborus_shuffle_org_name", resp.org_name);
      }
      if (resp.base_url) {
        window.activeShuffleBaseUrl = resp.base_url;
        if (typeof localStorage !== "undefined") localStorage.setItem("orborus_shuffle_base_url", resp.base_url);
      }
      const lblOrg = document.getElementById("lbl-org");
      if (lblOrg && (window.activeShuffleOrgName || window.activeShuffleOrgId)) {
        lblOrg.innerText = window.activeShuffleOrgName || window.activeShuffleOrgId;
      }
    }

    renderShuffleTenantDropdown();
    if (event) {
      const count = (window.shuffleOrgs && window.shuffleOrgs.length) || 0;
      showToast(count > 0 ? ("Synced " + count + " Shuffle tenant(s)") : "Could not load Shuffle tenants");
    }
  } catch (err) {
    console.error("refreshShuffleTenants error:", err);
  } finally {
    window._fetchingShuffleTenants = false;
  }
}

if (typeof window !== "undefined") {
  window.openSettingsForModel = openSettingsForModel;
  window.toggleShuffleTenantDropdown = toggleShuffleTenantDropdown;
  window.selectShuffleTenant = selectShuffleTenant;
  window.refreshShuffleTenants = refreshShuffleTenants;
  window.renderShuffleTenantDropdown = renderShuffleTenantDropdown;
}



