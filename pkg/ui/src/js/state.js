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
  // Shuffle Cloud AI
  {
    key: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    desc: "Shuffle AI Cloud",
    category: "Shuffle AI",
    provider: "shuffle"
  },
  {
    key: "gemini-3.8-pro",
    label: "Gemini 3.8 Pro",
    desc: "Shuffle AI Cloud",
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

function getModelConfigStatus(modelKey) {
  const curKey = (modelKey || activeAiModel || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash").trim();
  const effectiveKey = (currentAiKey || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_key")) || "").trim();
  const effectiveUrl = (currentAiUrl || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_url")) || "").trim().toLowerCase();
  const hasShuffleAuth = !!(isLoggedIn || (typeof window !== "undefined" && window.isLoggedIn));
  const hasLocalGPU = (typeof window !== "undefined" && window.localExecutorAvailable !== false);

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

  // 2. Shuffle AI Models (Gemini 3.8 Flash, Gemini 3.8 Pro)
  const isShuffleModel = curKey === "gemini-3.8-flash" || curKey === "gemini-3.8-flash-high" || curKey === "gemini-3.8-pro";
  if (isShuffleModel) {
    const hasGoogleKey = (effectiveKey.startsWith("AIza") || effectiveKey.length >= 35) || effectiveUrl.includes("googleapis.com");
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
    } else if (hasGoogleKey) {
      return {
        configured: true,
        category: "Shuffle AI",
        badge: "Google Key",
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
        reason: "Requires Shuffle login or Google API key",
        actionText: "Log In to Shuffle",
        actionType: "auth",
        setupTip: "Prompts will fail: Not logged in. Log in to Shuffle or provide a Google API key in Settings."
      };
    }
  }

  // 3. OpenAI Models
  if (curKey === "gpt-4o" || curKey.startsWith("gpt-") || curKey.startsWith("o1") || curKey.startsWith("o3")) {
    const hasOpenAiKey = (effectiveKey.startsWith("sk-") && !effectiveKey.startsWith("sk-ant-")) || effectiveUrl.includes("openai.com");
    if (hasOpenAiKey) {
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
    } else if (hasShuffleAuth) {
      return {
        configured: true,
        category: "BYOK Models",
        badge: "Shuffle Cloud",
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
        reason: "Requires OpenAI API key in Settings",
        actionText: "Set OpenAI Key",
        actionType: "byok",
        setupTip: "Prompts will fail: OpenAI API key is missing. Add your API key in Settings > AI & Models."
      };
    }
  }

  // 4. Anthropic Models
  if (curKey.startsWith("claude-") || curKey.startsWith("anthropic")) {
    const hasClaudeKey = effectiveKey.startsWith("sk-ant-") || effectiveUrl.includes("anthropic.com");
    if (hasClaudeKey) {
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
    } else if (hasShuffleAuth) {
      return {
        configured: true,
        category: "BYOK Models",
        badge: "Shuffle Cloud",
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
        reason: "Requires Anthropic API key in Settings",
        actionText: "Set Anthropic Key",
        actionType: "byok",
        setupTip: "Prompts will fail: Anthropic API key is missing. Add your API key in Settings > AI & Models."
      };
    }
  }

  // 5. Custom Model / Unknown
  const savedCustom = (typeof localStorage !== "undefined" && localStorage.getItem("orborus_custom_model") || "").trim();
  const hasCustomConfig = (effectiveUrl !== "" && !effectiveUrl.startsWith("local://")) || (effectiveKey !== "");
  if (hasCustomConfig || (curKey && curKey !== "custom" && savedCustom === curKey && effectiveKey !== "")) {
    return {
      configured: true,
      category: "BYOK Models",
      badge: "Configured",
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
    badge: "Setup needed",
    badgeType: "unconfigured",
    reason: "No endpoint or API key configured",
    actionText: "Configure Model",
    actionType: "byok",
    setupTip: "Custom model requires an API URL and Key in Settings > AI & Models."
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

if (typeof window !== "undefined") {
  window.getModelConfigStatus = getModelConfigStatus;
  window.checkModelAvailability = checkModelAvailability;
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
  activeAiModel = (typeof window !== "undefined" && window.activeAiModel) || localStorage.getItem("orborus_ai_model") || "gemini-3.8-flash";
  if (typeof window !== "undefined") {
    window.activeAiModel = activeAiModel;
  }
  const isPredefined = AVAILABLE_AI_MODELS.some(m => m.key === activeAiModel && m.key !== "custom");
  if (!isPredefined && activeAiModel !== "custom" && !localStorage.getItem("orborus_custom_model")) {
    localStorage.setItem("orborus_custom_model", activeAiModel);
  }
  activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "low";
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
    if (state.ai_model) {
      activeAiModel = state.ai_model;
      localStorage.setItem("orborus_ai_model", state.ai_model);
      if (typeof window !== "undefined") window.activeAiModel = state.ai_model;
    }
    if ((!state.ai_api_key && !currentAiKey) && (state.local_executor_available || state.local_gpu_found)) {
      activeAiModel = "tendon-local";
      localStorage.setItem("orborus_ai_model", "tendon-local");
      if (typeof window !== "undefined") window.activeAiModel = "tendon-local";
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
