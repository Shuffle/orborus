// --- Core State & Configuration ---
var currentApprovalId = null;
var currentApprovalCmd = "";
var currentApprovalCmdPrefix = "";
var currentApprovalDesc = "";
var currentApprovalProject = "";
var selectedApprovalOption = 1;
var currentApprovalRules = [];
var pinnedConversationIds = new Set();
var activeConversationId = null;
var collapsedProjects = {};
var projectFilterQuery = "";
var isProjectsFilterOpen = false;
var appConversations = [];
var activeProjectPath = ".";
var allProjects = [];
var isLoggedIn = false;
var isBypassed = false;
var currentAiUrl = "";
var currentAiKey = "";
var activeAiModel = (typeof window !== "undefined" && window.activeAiModel) || localStorage.getItem("orborus_ai_model") || "tendon-local";
if (typeof window !== "undefined") {
  window.activeAiModel = activeAiModel;
  if (window.localExecutorAvailable === undefined) {
    window.localExecutorAvailable = true;
  }
}
var activeExecutionMode = (typeof window !== "undefined" && window.activeExecutionMode) || localStorage.getItem("orborus_active_execution_mode") || "local";
if (typeof window !== "undefined") {
  window.activeExecutionMode = activeExecutionMode;
}
var activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "low";
var currentPermissionPolicy = "ask_all";
var currentTerminalExecutionPolicy = "sandbox";
var currentFileAccessPolicy = "ask";
var currentSandboxMode = true;
var currentQueuedMessages = "queue";
var currentProjectPermissions = {};
var activeSettingsTab = "general";
var activeSettingsProject = null;
var currentInjectedSkills = [];
var currentDiscoveredSkills = [];
var isOAuthPending = false;
window.executionHistory = (typeof window !== "undefined" && Array.isArray(window.executionHistory)) ? window.executionHistory : [];
var executionHistory = window.executionHistory;

function addExecutionHistory(entry) {
  if (typeof window !== "undefined") {
    if (!Array.isArray(window.executionHistory)) {
      window.executionHistory = [];
    }
    executionHistory = window.executionHistory;
  } else if (!Array.isArray(executionHistory)) {
    executionHistory = [];
  }
  executionHistory.unshift(entry);
  try {
    localStorage.setItem("orborus_execution_history", JSON.stringify(executionHistory.slice(0, 100)));
  } catch (e) {}
}

async function callGo(action, payload) {
  if (window.agentBridge && typeof window.agentBridge.handleAction === "function") {
    return await window.agentBridge.handleAction(action, payload || "");
  }
  if (typeof window.bridgeCall === "function") {
    return await window.bridgeCall(action, payload || "");
  }
  console.warn("No Go bridge available for action:", action);
  return JSON.stringify({ error: "No Go bridge available" });
}
window.callGo = callGo;

var toastTimeout = null;
var activeRunningTasks = [];
var isChatModeActive = false;
var isPromptExecuting = false;
var runningConversationId = null;
var speechRecognitionInstance = null;
var isListeningVoice = false;

var AVAILABLE_AI_MODELS = [
  // Local Models
  {
    key: "tendon-local",
    label: "Gemma-4-26B",
    desc: "Local CUDA GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  // Shuffle AI (Optional)
  {
    key: "gemini-3.8-flash",
    label: "Default (Gemini 3.8 Flash)",
    desc: "Shuffle AI (Optional)",
    category: "Shuffle AI",
    provider: "shuffle"
  },
  // Remote Providers (BYOK)
  {
    key: "gpt-4o",
    label: "GPT-4o (OpenAI)",
    desc: "OpenAI BYOK",
    category: "BYOK Models",
    provider: "openai"
  },
  {
    key: "claude-3-7-sonnet",
    label: "Claude 3.7 Sonnet",
    desc: "Anthropic BYOK",
    category: "BYOK Models",
    provider: "anthropic"
  },
  {
    key: "claude-3-5-sonnet",
    label: "Claude 3.5 Sonnet",
    desc: "Anthropic BYOK",
    category: "BYOK Models",
    provider: "anthropic"
  },
  // Custom
  {
    key: "custom",
    label: "Custom Model...",
    desc: "Custom Endpoint",
    category: "BYOK Models",
    provider: "custom"
  }
];

function getCustomByokModels() {
  try {
    const raw = localStorage.getItem("orborus_byok_models");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(s => String(s).trim()).filter(Boolean);
      }
    }
  } catch (e) {}
  const legacy = (localStorage.getItem("orborus_custom_model") || "").trim();
  if (legacy && legacy !== "custom") return [legacy];
  return [];
}

function detectModelProvider(modelId) {
  const lower = String(modelId || "").toLowerCase();
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("chatgpt")) return "openai";
  if (lower.startsWith("claude-") || lower.startsWith("anthropic")) return "anthropic";
  if (lower.startsWith("gemini-")) return "gemini";
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("groq") || lower.startsWith("llama")) return "groq";
  if (lower.startsWith("mistral") || lower.startsWith("codestral")) return "mistral";
  if (lower.startsWith("qwen")) return "qwen";
  return "custom";
}

function syncAvailableAiModels() {
  const customModels = getCustomByokModels();
  AVAILABLE_AI_MODELS = AVAILABLE_AI_MODELS.filter(m => !m.isCustomByok);

  customModels.forEach(modelId => {
    const exists = AVAILABLE_AI_MODELS.some(m => m.key.toLowerCase() === modelId.toLowerCase());
    if (!exists) {
      AVAILABLE_AI_MODELS.push({
        key: modelId,
        label: modelId,
        desc: "BYOK Model",
        category: "BYOK Models",
        provider: detectModelProvider(modelId),
        isCustomByok: true
      });
    }
  });
}

function addCustomByokModel(modelId) {
  if (!modelId) return null;
  const clean = modelId.trim();
  if (!clean || clean === "custom") return null;

  const list = getCustomByokModels();
  if (!list.some(m => m.toLowerCase() === clean.toLowerCase())) {
    list.push(clean);
    localStorage.setItem("orborus_byok_models", JSON.stringify(list));
  }
  localStorage.setItem("orborus_custom_model", clean);
  syncAvailableAiModels();
  return clean;
}

function removeCustomByokModel(modelId) {
  if (!modelId) return;
  const clean = modelId.trim().toLowerCase();
  let list = getCustomByokModels();
  list = list.filter(m => m.toLowerCase() !== clean);
  localStorage.setItem("orborus_byok_models", JSON.stringify(list));
  syncAvailableAiModels();

  if (activeAiModel && activeAiModel.toLowerCase() === clean) {
    activeAiModel = "gpt-4o";
    localStorage.setItem("orborus_ai_model", "gpt-4o");
    if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  }
}

// Initial sync on load
syncAvailableAiModels();

function getModelConfigStatus(modelKey) {
  const curKey = (modelKey || activeAiModel || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash").trim();
  const effectiveKey = (currentAiKey || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_key")) || "").trim();
  const effectiveUrl = (currentAiUrl || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_url")) || "").trim().toLowerCase();
  const hasShuffleAuth = !!(isLoggedIn || (typeof window !== "undefined" && window.isLoggedIn));
  const hasLocalGPU = (typeof window !== "undefined" && window.localExecutorAvailable !== false);
  const hasGenericKey = effectiveKey.length > 0;
  const hasGenericUrl = effectiveUrl.length > 0 && !effectiveUrl.startsWith("local://");

  // 1. Local GPU Models
  if (curKey === "tendon-local" || curKey.startsWith("tendon") || curKey.startsWith("local") || curKey.includes("gemma")) {
    if (hasLocalGPU) {
      return {
        configured: true,
        category: "Local Models",
        badge: "Ready",
        badgeType: "ready",
        reason: "",
        actionText: "",
        actionType: "",
        setupTip: ""
      };
    } else {
      return {
        configured: false,
        category: "Local Models",
        badge: "Unavailable",
        badgeType: "unconfigured",
        reason: "Requires Local GPU Engine",
        actionText: "Hardware Setup",
        actionType: "hardware",
        setupTip: "Local engine is unavailable. Switch to a cloud model or configure CUDA."
      };
    }
  }

  // 2. Shuffle AI Models (Optional Shuffle Gemini 3.8 Flash via OAuth or Backend)
  const isShuffleCategory = curKey === "gemini-3.8-flash" || curKey === "gemini-3.8-flash-high" || curKey === "gemini-3.8-pro" || curKey === "default";
  if (isShuffleCategory && (activeExecutionMode === "shuffle" || activeExecutionMode === "orborus" || (!hasGenericKey && !hasGenericUrl))) {
    if (hasShuffleAuth) {
      return {
        configured: true,
        category: "Shuffle AI",
        badge: "Connected",
        badgeType: "ready",
        reason: "",
        actionText: "",
        actionType: "",
        setupTip: ""
      };
    } else {
      return {
        configured: false,
        category: "Shuffle AI",
        badge: "Login needed",
        badgeType: "unconfigured",
        reason: "Requires optional Shuffle login",
        actionText: "Log In to Shuffle",
        actionType: "auth",
        setupTip: "Optional Shuffle integration: log in to Shuffle in Settings or choose BYOK / Local GPU."
      };
    }
  }

  // 3. OpenAI Models (BYOK)
  if (curKey === "gpt-4o" || curKey.startsWith("gpt-") || curKey.startsWith("o1") || curKey.startsWith("o3")) {
    const hasOpenAiKey = (effectiveKey.startsWith("sk-") && !effectiveKey.startsWith("sk-ant-")) || effectiveUrl.includes("openai.com") || hasGenericKey;
    if (hasOpenAiKey || hasGenericUrl) {
      return {
        configured: true,
        category: "BYOK Models",
        badge: "API Key",
        badgeType: "ready",
        reason: "",
        actionText: "",
        actionType: "",
        setupTip: ""
      };
    } else {
      return {
        configured: false,
        category: "BYOK Models",
        badge: "Key needed",
        badgeType: "unconfigured",
        reason: "Requires OpenAI API key in BYOK Settings",
        actionText: "Set OpenAI Key",
        actionType: "byok",
        setupTip: "OpenAI API key is missing. Add your API key in Settings > Direct LLM (BYOK)."
      };
    }
  }

  // 4. Anthropic Models (BYOK)
  if (curKey.startsWith("claude-") || curKey.startsWith("anthropic")) {
    const hasClaudeKey = effectiveKey.startsWith("sk-ant-") || effectiveUrl.includes("anthropic.com") || hasGenericKey;
    if (hasClaudeKey || hasGenericUrl) {
      return {
        configured: true,
        category: "BYOK Models",
        badge: "API Key",
        badgeType: "ready",
        reason: "",
        actionText: "",
        actionType: "",
        setupTip: ""
      };
    } else {
      return {
        configured: false,
        category: "BYOK Models",
        badge: "Key needed",
        badgeType: "unconfigured",
        reason: "Requires Anthropic API key in BYOK Settings",
        actionText: "Set Anthropic Key",
        actionType: "byok",
        setupTip: "Anthropic API key is missing. Add your API key in Settings > Direct LLM (BYOK)."
      };
    }
  }

  // 5. Gemini Models as BYOK (using user Google API key or custom endpoint)
  if (curKey.startsWith("gemini")) {
    const hasGoogleKey = (effectiveKey.startsWith("AIza") || effectiveKey.startsWith("AI-")) || effectiveUrl.includes("googleapis.com") || hasGenericKey;
    if (hasGoogleKey || hasGenericUrl) {
      return {
        configured: true,
        category: "BYOK Models",
        badge: "API Key",
        badgeType: "ready",
        reason: "",
        actionText: "",
        actionType: "",
        setupTip: ""
      };
    } else {
      return {
        configured: false,
        category: "BYOK Models",
        badge: "Key needed",
        badgeType: "unconfigured",
        reason: "Requires Gemini API key in BYOK Settings",
        actionText: "Set Gemini Key",
        actionType: "byok",
        setupTip: "Gemini API key is missing. Add your key in Settings > Direct LLM (BYOK)."
      };
    }
  }

  // 6. User-added custom / other BYOK Models (e.g. DeepSeek, Groq, Mistral, Ollama)
  if (hasGenericKey || hasGenericUrl) {
    return {
      configured: true,
      category: "BYOK Models",
      badge: "API Key",
      badgeType: "ready",
      reason: "",
      actionText: "",
      actionType: "",
      setupTip: ""
    };
  }

  return {
    configured: false,
    category: "BYOK Models",
    badge: "Key needed",
    badgeType: "unconfigured",
    reason: "Requires API key or endpoint in BYOK Settings",
    actionText: "Configure BYOK",
    actionType: "byok",
    setupTip: "Add an API URL and Key in Settings > Direct LLM (BYOK)."
  };
}

function checkModelAvailability(modelKey) {
  const status = getModelConfigStatus(modelKey);
  return {
    available: status.configured,
    badge: status.badge,
    badgeClass: status.configured ? "available" : "unavailable",
    statusText: status.configured ? (status.badge + " Ready") : status.reason,
    actionText: status.actionText
  };
}

function isModelActiveAndValidated(modelKey) {
  if (!modelKey) return false;
  const status = getModelConfigStatus(modelKey);
  return !!(status && status.configured);
}

function getBestActiveValidatedModel(preferredModel) {
  if (preferredModel && isModelActiveAndValidated(preferredModel)) {
    return preferredModel;
  }
  if (activeAiModel && isModelActiveAndValidated(activeAiModel)) {
    return activeAiModel;
  }
  const globalLast = typeof localStorage !== "undefined" ? localStorage.getItem("orborus_last_model") : null;
  if (globalLast && isModelActiveAndValidated(globalLast)) {
    return globalLast;
  }
  const candidates = [
    "tendon-local",
    "gemini-3.8-flash",
    "gpt-4o",
    "claude-3-7-sonnet",
    "gemini-3.8-pro"
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (isModelActiveAndValidated(candidates[i])) {
      return candidates[i];
    }
  }
  return preferredModel || activeAiModel || "gemini-3.8-flash";
}

function getChatTypeKey(projectPath) {
  const p = (projectPath !== undefined ? projectPath : (typeof activeProjectPath !== "undefined" ? activeProjectPath : "")) || "";
  const clean = p.trim();
  if (!clean || clean === "__NONE__" || clean.toLowerCase() === "none" || clean.toLowerCase() === "no project") {
    return "__no_project__";
  }
  return "proj_" + clean.replace(/\\/g, "/").toLowerCase();
}

function getRememberedModelForType(projectPath) {
  const key = getChatTypeKey(projectPath);
  try {
    const stored = localStorage.getItem("orborus_model_by_type_" + key);
    if (stored) return stored;
  } catch (e) {}
  return (typeof localStorage !== "undefined" && localStorage.getItem("orborus_last_model")) || "";
}

function saveRememberedModelForType(projectPath, model) {
  if (!model) return;
  const key = getChatTypeKey(projectPath);
  try {
    localStorage.setItem("orborus_model_by_type_" + key, model);
    localStorage.setItem("orborus_last_model", model);
    localStorage.setItem("orborus_ai_model", model);
  } catch (e) {}
}

function getRememberedReasoningForType(projectPath) {
  const key = getChatTypeKey(projectPath);
  try {
    const stored = localStorage.getItem("orborus_reasoning_by_type_" + key);
    if (stored) return stored;
  } catch (e) {}
  return (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_reasoning")) || "low";
}

function saveRememberedReasoningForType(projectPath, reasoning) {
  if (!reasoning) return;
  const key = getChatTypeKey(projectPath);
  try {
    localStorage.setItem("orborus_reasoning_by_type_" + key, reasoning);
    localStorage.setItem("orborus_ai_reasoning", reasoning);
  } catch (e) {}
}

if (typeof window !== "undefined") {
  window.getModelConfigStatus = getModelConfigStatus;
  window.checkModelAvailability = checkModelAvailability;
  window.isModelActiveAndValidated = isModelActiveAndValidated;
  window.getBestActiveValidatedModel = getBestActiveValidatedModel;
  window.getRememberedModelForType = getRememberedModelForType;
  window.saveRememberedModelForType = saveRememberedModelForType;
  window.getRememberedReasoningForType = getRememberedReasoningForType;
  window.saveRememberedReasoningForType = saveRememberedReasoningForType;
}

function setChatMode(enabled) {
  isChatModeActive = !!enabled;
  const mainWorkspace = document.querySelector(".main-workspace");
  const mainContainer = document.getElementById("main-container");
  if (isChatModeActive) {
    if (mainWorkspace) mainWorkspace.classList.add("chat-mode");
    if (mainContainer) {
      mainContainer.classList.add("chat-mode");
      mainContainer.classList.remove("initial-mode");
    }
  } else {
    if (mainWorkspace) mainWorkspace.classList.remove("chat-mode");
    if (mainContainer) {
      mainContainer.classList.remove("chat-mode");
      mainContainer.classList.add("initial-mode");
    }
  }
}


// --- State Hydration & Backend Sync ---
function hydrateOptimisticState() {
  // 1. Synchronously restore configuration from localStorage
  currentAiUrl = localStorage.getItem("orborus_ai_url") || "";
  currentAiKey = localStorage.getItem("orborus_ai_key") || "";

  const storedProject = localStorage.getItem("orborus_active_project");
  if (storedProject !== null) {
    activeProjectPath = storedProject;
  }

  const rememberedModel = getRememberedModelForType(activeProjectPath);
  const preferred = (typeof window !== "undefined" && window.activeAiModel) || rememberedModel || localStorage.getItem("orborus_ai_model") || "gemini-3.8-flash";
  activeAiModel = getBestActiveValidatedModel(preferred);
  if (typeof window !== "undefined") {
    window.activeAiModel = activeAiModel;
  }
  localStorage.setItem("orborus_ai_model", activeAiModel);

  const isPredefined = AVAILABLE_AI_MODELS.some(m => m.key === activeAiModel && m.key !== "custom");
  if (!isPredefined && activeAiModel !== "custom" && !localStorage.getItem("orborus_custom_model")) {
    localStorage.setItem("orborus_custom_model", activeAiModel);
  }

  const rememberedReasoning = getRememberedReasoningForType(activeProjectPath);
  activeReasoningEffort = rememberedReasoning || localStorage.getItem("orborus_ai_reasoning") || "low";
  currentPermissionPolicy = localStorage.getItem("orborus_permission_policy") || "ask_all";
  currentTerminalExecutionPolicy = localStorage.getItem("orborus_terminal_execution_policy") || "sandbox";
  currentFileAccessPolicy = localStorage.getItem("orborus_file_access_policy") || "ask";
  const storedSandbox = localStorage.getItem("orborus_sandbox_mode");
  if (storedSandbox !== null) {
    currentSandboxMode = storedSandbox === "true";
  }

  const storedProject = localStorage.getItem("orborus_active_project");
  if (storedProject !== null) {
    activeProjectPath = storedProject;
  }

  const storedModelsDir = localStorage.getItem("orborus_local_models_dir");
  if (storedModelsDir) {
    window.localModelsDir = storedModelsDir;
  }
  const storedModelPath = localStorage.getItem("orborus_local_model_path");
  if (storedModelPath) {
    window.localModelPath = storedModelPath;
  }

  // 2. Synchronously restore cached conversations
  try {
    const rawConvs = localStorage.getItem("orborus_conversations");
    if (rawConvs) {
      const parsed = JSON.parse(rawConvs);
      if (Array.isArray(parsed)) {
        appConversations = parsed.filter(c => c && c.id && !c.id.startsWith("conv-demo-"));
      }
    }
    const rawPinned = localStorage.getItem("orborus_pinned_conversations");
    if (rawPinned) {
      const parsed = JSON.parse(rawPinned);
      if (Array.isArray(parsed)) {
        pinnedConversationIds = new Set(parsed.filter(id => typeof id === "string" && !id.startsWith("conv-demo-")));
      }
    }
    const rawHist = localStorage.getItem("orborus_execution_history");
    if (rawHist) {
      const parsed = JSON.parse(rawHist);
      if (Array.isArray(parsed)) {
        window.executionHistory = parsed;
        executionHistory = parsed;
      }
    }
  } catch (err) {
    console.warn("Failed to synchronously parse stored conversations:", err);
  }

  // Sync in-memory conv pinned state
  appConversations.forEach(c => {
    c.pinned = pinnedConversationIds.has(c.id);
  });

  // 3. Synchronously render UI with cached data (0ms latency, zero flash)
  try {
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
    if (typeof updateActiveReasoningLabel === "function") {
      updateActiveReasoningLabel();
    }
  } catch (e) {
    console.error("Failed to render initial model/reasoning label:", e);
  }

  try {
    updateAuthState({
      is_logged_in: !!(currentAiKey || currentAiUrl),
      is_bypassed: true,
      ai_api_url: currentAiUrl,
      ai_api_key: currentAiKey,
      ai_model: activeAiModel,
      permission_policy: currentPermissionPolicy
    });
  } catch (e) {
    console.error("Failed to update auth state:", e);
  }

  try {
    initFooterControls();
  } catch (e) {
    console.error("Failed to init footer controls:", e);
  }

  try {
    renderProjectTree();
  } catch (e) {
    console.error("Failed to render project tree:", e);
  }

  try {
    const savedActiveConvId = localStorage.getItem("orborus_active_conv_id");
    if (savedActiveConvId && appConversations.some(c => c.id === savedActiveConvId)) {
      activeConversationId = savedActiveConvId;
      renderActiveConversation();
    } else if (appConversations.length > 0) {
      activeConversationId = appConversations[0].id;
      renderActiveConversation();
    } else {
      startNewSession();
    }
  } catch (e) {
    console.error("Failed to render active conversation:", e);
  }

  // Focus prompt input immediately
  try {
    const inputEl = document.getElementById("prompt-input");
    if (inputEl) inputEl.focus();
  } catch (e) {}
}

async function syncBackendState() {
  if (!window.getInitialState) return;

  try {
    const raw = await window.getInitialState();
    const state = JSON.parse(raw);

    const isWindows = (state.os && state.os === "windows") || 
      (typeof navigator !== "undefined" && (navigator.platform.indexOf("Win") > -1 || navigator.userAgent.indexOf("Windows") > -1));
    const isMac = !isWindows && (!state.os || state.os === "darwin");
    const macEl = document.getElementById("mac-controls");
    const winEl = document.getElementById("win-controls");
    if (macEl) {
      macEl.style.display = isMac ? "flex" : "none";
    }
    if (winEl) {
      winEl.style.display = isWindows ? "flex" : "none";
    }

    // Merge backend projects into allProjects
    if (Array.isArray(state.projects) && state.projects.length > 0) {
      const existing = new Set(allProjects.map(p => (p.Path || p.path || "").toLowerCase()));
      state.projects.forEach(p => {
        const pPath = (p.Path || p.path || "").toLowerCase();
        if (pPath && !existing.has(pPath)) {
          allProjects.push(p);
          existing.add(pPath);
        }
      });
    }

    // Backend vs Frontend Credential Validation:
    if (state.ai_api_key) {
      currentAiKey = state.ai_api_key;
      localStorage.setItem("orborus_ai_key", state.ai_api_key);
    }
    if (state.ai_api_url) {
      currentAiUrl = state.ai_api_url;
      localStorage.setItem("orborus_ai_url", state.ai_api_url);
    }
    // Resolve model prioritizing active & validated model
    const candidateModel = (activeConversationId && Array.isArray(appConversations) && appConversations.find(c => c && c.id === activeConversationId)?.model)
      || getRememberedModelForType(activeProjectPath)
      || state.ai_model
      || activeAiModel;
    const validatedModel = getBestActiveValidatedModel(candidateModel);
    if (validatedModel) {
      activeAiModel = validatedModel;
      localStorage.setItem("orborus_ai_model", validatedModel);
      if (typeof window !== "undefined") window.activeAiModel = validatedModel;
    }

    // If frontend has credentials in localStorage that backend lacks, push to backend
    if ((!state.ai_api_key && currentAiKey) || (!state.ai_api_url && currentAiUrl)) {
      if (typeof window.bridgeCall === "function") {
        window.bridgeCall("setAiConfig", JSON.stringify({
          url: currentAiUrl || "",
          key: currentAiKey || "",
          model: activeAiModel || "gemini-3.8-flash",
          permission_policy: state.permission_policy || currentPermissionPolicy || "ask_all"
        })).catch(() => {});
      }
    }

    if (state.permission_policy) currentPermissionPolicy = state.permission_policy;
    if (state.terminal_execution_policy) currentTerminalExecutionPolicy = state.terminal_execution_policy;
    if (state.file_access_policy) currentFileAccessPolicy = state.file_access_policy;
    if (state.sandbox_mode !== undefined) currentSandboxMode = state.sandbox_mode;
    if (state.queued_messages) currentQueuedMessages = state.queued_messages;
    if (state.project_permissions) currentProjectPermissions = state.project_permissions;

    if (state.pinned_conversations && Array.isArray(state.pinned_conversations)) {
      pinnedConversationIds = new Set(state.pinned_conversations.filter(id => typeof id === "string" && !id.startsWith("conv-demo-")));
      appConversations.forEach(c => {
        c.pinned = pinnedConversationIds.has(c.id);
      });
    }

    if (state.approval_rules && Array.isArray(state.approval_rules)) {
      currentApprovalRules = state.approval_rules;
      updateApprovalRulesCount();
    }

    if (state.injected_skills && Array.isArray(state.injected_skills)) {
      currentInjectedSkills = state.injected_skills;
    }
    if (state.project_skills && Array.isArray(state.project_skills)) {
      currentDiscoveredSkills = state.project_skills;
    }

    updateAuthState(state);

    if (state.active_project !== undefined && state.active_project !== null) {
      if (state.active_project === "" || state.active_project === "__NONE__") {
        if (activeProjectPath !== "") {
          setActiveProject("", "No project");
        }
      } else if (state.active_project !== "." && state.active_project !== activeProjectPath) {
        setActiveProject(state.active_project);
      }
    }

    if (state.local_executor_available !== undefined) {
      window.localExecutorAvailable = !!state.local_executor_available;
      if (state.local_gpu_name) {
        window.localGpuName = state.local_gpu_name;
      }
      if (state.local_vram_free) {
        window.localVramFreeMB = state.local_vram_free;
      }
      if (state.local_vram_total) {
        window.localVramTotalMB = state.local_vram_total;
      }
    }

    if (state.local_models_dir) {
      window.localModelsDir = state.local_models_dir;
      localStorage.setItem("orborus_local_models_dir", state.local_models_dir);
    }
    if (state.local_model_path) {
      window.localModelPath = state.local_model_path;
      localStorage.setItem("orborus_local_model_path", state.local_model_path);
    }

    if (state.active_execution_mode) {
      activeExecutionMode = state.active_execution_mode;
      window.activeExecutionMode = state.active_execution_mode;
      localStorage.setItem("orborus_active_execution_mode", state.active_execution_mode);
    }
    if (state.projects && Array.isArray(state.projects) && state.projects.length > 0) {
      if (!Array.isArray(allProjects)) allProjects = [];
      const existing = new Set(allProjects.map(p => (p.Path || p.path || "").replace(/\\/g, "/").toLowerCase()));
      state.projects.forEach(p => {
        const rawPath = p.Path || p.path || "";
        const pNorm = rawPath.replace(/\\/g, "/").toLowerCase();
        if (pNorm && pNorm !== "." && !existing.has(pNorm)) {
          allProjects.push({
            Name: p.Name || p.name || rawPath.split(/[/\\]/).filter(Boolean).pop() || "Project",
            Path: rawPath
          });
          existing.add(pNorm);
        }
      });
      renderProjects(allProjects);
    }

    renderProjectTree();

    if (typeof updateModesDisplay === "function") {
      updateModesDisplay();
    }
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
    if (typeof populateAiModelSelect === "function") {
      populateAiModelSelect();
    }
  } catch (err) {
    console.warn("syncBackendState failed:", err);
  }

  // Load / merge disk conversations in background
  try {
    if (window.listConversations) {
      const raw = await window.listConversations();
      const diskConvs = JSON.parse(raw);
      if (Array.isArray(diskConvs) && diskConvs.length > 0) {
        const localById = new Map(appConversations.map(c => [c.id, c]));
        diskConvs.forEach(dc => {
          if (!dc || !dc.id || dc.id.startsWith("conv-demo-")) return;
          const local = localById.get(dc.id);
          if (!local) {
            appConversations.push(dc);
          } else {
            // Preserve archive status in both directions
            if (local.archived || local.is_archived) {
              dc.archived = true;
              dc.is_archived = true;
            } else if (dc.archived || dc.is_archived) {
              local.archived = true;
              local.is_archived = true;
            }

            // Keep local turns if in-flight running
            const hasRunning = (typeof isPromptExecuting !== "undefined" && isPromptExecuting) && local.turns && local.turns.some(t => t.status === "running");
            if (!hasRunning && dc.turns && dc.turns.length >= (local.turns ? local.turns.length : 0)) {
              local.turns = dc.turns;
              if (dc.title) local.title = dc.title;
            }
          }
        });

        // Extract and register projects from conversations
        const existingPaths = new Set(allProjects.map(p => (p.Path || p.path || "").toLowerCase()));
        appConversations.forEach(c => {
          const pId = c.projectId || c.project_id;
          const pName = c.projectName || c.project_name;
          if (pId && pId !== "." && !existingPaths.has(pId.toLowerCase())) {
            allProjects.push({
              Name: pName || pId.split(/[/\\]/).filter(Boolean).pop() || "Project",
              Path: pId
            });
            existingPaths.add(pId.toLowerCase());
          }
        });

        renderProjectTree();
        if (activeConversationId) {
          renderActiveConversation();
        } else if (appConversations.length > 0) {
          activeConversationId = appConversations[0].id;
          renderActiveConversation();
        }
        saveStoredConversations();
      }
    }
  } catch (err) {
    console.warn("Backend listConversations sync failed:", err);
  }

  scanRepositories();
}

async function init() {
  hydrateOptimisticState();
  syncBackendState();
}
