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
  const map = {
    "gemini-3.8-flash": "Gemini-3.8-Flash",
    "gemini-3.8-flash-high": "Gemini 3.8 Flash High",
    "gemini-3.8-pro": "Gemini 3.8 Pro",
    "claude-3-7-sonnet": "Claude 3.7 Sonnet",
    "claude-3-5-sonnet": "Claude 3.5 Sonnet",
    "gpt-4o": "GPT-4o",
    "ollama": "Ollama"
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
    const curModel = activeAiModel || localStorage.getItem("orborus_ai_model") || "gemini-3.8-flash";
    const customModelInput = document.getElementById("input-settings-custom-model");
    if (modelSelect) {
      const exists = Array.from(modelSelect.options).some(o => o.value === curModel);
      if (exists) {
        modelSelect.value = curModel;
        if (customModelInput) customModelInput.style.display = "none";
      } else {
        modelSelect.value = "custom";
        if (customModelInput) {
          customModelInput.style.display = "block";
          customModelInput.value = curModel;
        }
      }
    }
    if (keyInput) keyInput.value = currentAiKey || localStorage.getItem("orborus_ai_key") || "";
    if (globalPreset) globalPreset.value = currentPermissionPolicy || "ask_all";
    if (globalFileAccess) globalFileAccess.value = currentFileAccessPolicy || "ask";
    if (globalTerminal) globalTerminal.value = currentTerminalExecutionPolicy || "sandbox";
    if (globalSandbox) globalSandbox.checked = currentSandboxMode !== false;

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
    if (targetTab === "models") {
      setTimeout(() => {
        if (focusField === "model") {
          const modelSelect = document.getElementById("select-ai-model");
          if (modelSelect) modelSelect.focus();
        } else if (focusField === "url") {
          const urlInput = document.getElementById("input-ai-url");
          if (urlInput) urlInput.focus();
        } else {
          const keyInput = document.getElementById("input-ai-key");
          if (keyInput) keyInput.focus();
        }
      }, 60);
    } else if (targetTab === "auth") {
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

  if (tabName === "auth") {
    const btn = document.getElementById("settings-tab-btn-auth");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-auth");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "Authentication & Account";
    if (descEl) descEl.innerText = "Manage Shuffle OAuth2 login, organization credentials, and API environment.";
  } else if (tabName === "models") {
    const btn = document.getElementById("settings-tab-btn-models");
    if (btn) btn.classList.add("active");
    const panel = document.getElementById("settings-panel-models");
    if (panel) panel.classList.add("active");
    if (titleEl) titleEl.innerText = "AI & Models";
    if (descEl) descEl.innerText = "Configure your LLM endpoint, credentials, and execution policy.";
    updateEnvDisplayInModal();
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

  // Collect unique projects from allProjects or activeProjectPath
  const projectsMap = new Map();
  if (activeProjectPath) {
    let activeName = (document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : "") || "";
    if (!activeName || activeName === "Orborus Agent Runner") {
      const parts = activeProjectPath === "." ? [] : activeProjectPath.split("/").filter(Boolean);
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
        const parts = pPath.split("/").filter(Boolean);
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

  const displayName = name || (path === "." ? "Orborus Agent Runner" : path.split("/").filter(Boolean).pop()) || "Project";
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

  // Load project permission values
  const perms = (currentProjectPermissions && currentProjectPermissions[path]) ? currentProjectPermissions[path] : {};
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
}

async function switchActiveWorkspaceFromSettings() {
  if (!activeSettingsProject) return;
  const nameEl = document.getElementById("lbl-project-name");
  const name = nameEl ? nameEl.innerText : activeSettingsProject.split("/").filter(Boolean).pop() || "Project";
  await selectProject(activeSettingsProject, name);
  selectSettingsProject(activeSettingsProject, name);
  renderSettingsProjectsList();
  showToast("Switched active workspace to: " + name);
}

function updateEnvDisplayInModal() {
  const urlEl = document.getElementById("env-display-url");
  const keyEl = document.getElementById("env-display-key");
  const modelEl = document.getElementById("env-display-model");
  const urlInput = document.getElementById("input-ai-url");
  const keyInput = document.getElementById("input-ai-key");
  const modelSelect = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");
  let model = (modelSelect && modelSelect.value) ? modelSelect.value : (activeAiModel || "gemini-3.8-flash");

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
  } else if (model.startsWith("ollama")) {
    defaultUrl = "http://localhost:11434/v1";
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
    const modelSelect = document.getElementById("select-ai-model");
    const customModelInput = document.getElementById("input-settings-custom-model");
    const globalPreset = document.getElementById("select-global-preset");
    const globalFileAccess = document.getElementById("select-global-file-access");
    const globalTerminal = document.getElementById("select-global-terminal-policy");
    const globalSandbox = document.getElementById("toggle-global-sandbox");

    const url = urlInput ? urlInput.value.trim() : (currentAiUrl || "");
    let key = keyInput ? keyInput.value.trim() : "";
    if (!key && currentAiKey && activeSettingsTab !== "models") {
      key = currentAiKey;
    }
    let model = modelSelect ? modelSelect.value : (activeAiModel || "gemini-3.8-flash");
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

    if (url) {
      localStorage.setItem("orborus_ai_url", url);
    } else {
      localStorage.removeItem("orborus_ai_url");
    }
    if (key) {
      localStorage.setItem("orborus_ai_key", key);
    } else if (activeSettingsTab === "models") {
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

    const settingsPayload = {
      permission_policy: preset,
      terminal_execution_policy: terminal,
      file_access_policy: fileAccess,
      sandbox_mode: sandbox,
      queued_messages: currentQueuedMessages || "queue",
      project_permissions: currentProjectPermissions || {},
      ai_api_url: url,
      ai_api_key: key,
      ai_model: model
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
    showToast("Settings saved successfully");
    closeSettingsModal();
  } catch (err) {
    console.error("Critical error in saveSettings:", err);
    dismissAuthErrorsIfConfigured();
    showToast("Settings saved locally");
    closeSettingsModal();
  }
}

window.onAuthUpdated = function(state) {
  console.log("[OAUTH] Dynamic auth updated:", state);
  isOAuthPending = false;
  updateAuthState(state);
  dismissAuthErrorsIfConfigured();
};

async function loginWithOAuth() {
  if (isOAuthPending) return;
  isOAuthPending = true;

  const btnLabel = document.getElementById("lbl-btn-auth");
  if (btnLabel) btnLabel.innerText = "Opening Browser...";

  try {
    if (window.startOAuthLogin) {
      await window.startOAuthLogin("https://shuffle.security");
      if (btnLabel) btnLabel.innerText = "Waiting for Login...";
    } else {
      window.open("https://shuffle.security/oauth2/authorize", "_blank");
      if (btnLabel) btnLabel.innerText = "Waiting for Login...";
    }
  } catch (err) {
    console.error("Failed to start OAuth login:", err);
    if (btnLabel) btnLabel.innerText = "Log in with Shuffle";
    isOAuthPending = false;
  }
}
