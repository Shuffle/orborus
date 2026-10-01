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
var activeAiModel = (typeof window !== "undefined" && window.activeAiModel) || localStorage.getItem("orborus_ai_model") || "gemini-3.8-flash";
if (typeof window !== "undefined") {
  window.activeAiModel = activeAiModel;
}
var activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "medium";
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
}
var toastTimeout = null;
var activeRunningTasks = [];
var isChatModeActive = false;
var speechRecognitionInstance = null;
var isListeningVoice = false;

var AVAILABLE_AI_MODELS = [
  { key: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High", desc: "Fast agent with high reasoning effort" },
  { key: "gemini-3.8-flash", label: "Gemini 3.8 Flash", desc: "Default fast agent (recommended)" },
  { key: "gemini-3.8-pro", label: "Gemini 3.8 Pro", desc: "Advanced reasoning for complex codebase tasks" },
  { key: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet", desc: "Anthropic Claude with hybrid thinking" },
  { key: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", desc: "Fast Anthropic model" },
  { key: "gpt-4o", label: "GPT-4o", desc: "OpenAI multimodal flaghip" },
  { key: "ollama", label: "Ollama (Local)", desc: "Local open-source models" },
  { key: "custom", label: "Custom Model...", desc: "Specify custom model identifier" }
];

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
  activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "medium";
  currentPermissionPolicy = localStorage.getItem("orborus_permission_policy") || "ask_all";
  currentTerminalExecutionPolicy = localStorage.getItem("orborus_terminal_execution_policy") || "sandbox";
  currentFileAccessPolicy = localStorage.getItem("orborus_file_access_policy") || "ask";
  const storedSandbox = localStorage.getItem("orborus_sandbox_mode");
  if (storedSandbox !== null) {
    currentSandboxMode = storedSandbox === "true";
  }

  const storedProject = localStorage.getItem("orborus_active_project");
  if (storedProject) {
    activeProjectPath = storedProject;
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
  } catch (err) {
    console.warn("Failed to synchronously parse stored conversations:", err);
  }

  // Sync in-memory conv pinned state
  appConversations.forEach(c => {
    c.pinned = pinnedConversationIds.has(c.id);
  });

  // 3. Synchronously render UI with cached data (0ms latency, zero flash)
  updateAuthState({
    is_logged_in: !!(currentAiKey || currentAiUrl),
    is_bypassed: true,
    ai_api_url: currentAiUrl,
    ai_api_key: currentAiKey,
    ai_model: activeAiModel,
    permission_policy: currentPermissionPolicy
  });

  initFooterControls();
  renderProjectTree();

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

  // Focus prompt input immediately
  const inputEl = document.getElementById("prompt-input");
  if (inputEl) inputEl.focus();
}

async function syncBackendState() {
  if (!window.getInitialState) return;

  try {
    const raw = await window.getInitialState();
    const state = JSON.parse(raw);

    const isMac = !state.os || state.os === "darwin";
    const macControls = document.getElementById("mac-controls");
    const winControls = document.getElementById("win-controls");
    if (macControls && winControls) {
      if (isMac) {
        macControls.style.display = "flex";
        winControls.style.display = "none";
      } else {
        macControls.style.display = "none";
        winControls.style.display = "flex";
      }
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

    if (state.active_project && state.active_project !== "." && state.active_project !== activeProjectPath) {
      setActiveProject(state.active_project);
    } else if (activeProjectPath && activeProjectPath !== "." && (!state.active_project || state.active_project === ".")) {
      if (typeof window.selectProject === "function") {
        window.selectProject(activeProjectPath).catch(() => {});
      }
    }

    if (state.projects && state.projects.length > 0) {
      allProjects = state.projects;
    }

    renderProjectTree();
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
            // Keep local turns if in-flight running
            const hasRunning = local.turns && local.turns.some(t => t.status === "running");
            if (!hasRunning && dc.turns && dc.turns.length >= (local.turns ? local.turns.length : 0)) {
              local.turns = dc.turns;
              if (dc.title) local.title = dc.title;
            }
          }
        });
        renderProjectTree();
        if (activeConversationId) {
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
