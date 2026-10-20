// --- Core State & Configuration ---
var currentApprovalId = null;
var currentApprovalCmd = "";
var currentApprovalCmdPrefix = "";
var currentApprovalDesc = "";
var currentApprovalProject = "";
var selectedApprovalOption = 1;
var currentApprovalRules = [];
var globalApprovalQueue = [];
var approvalDecisionHistory = [];
var activeApprovalQueueTab = "pending";
var pinnedConversationIds = new Set();
var unreadConversationIds = (() => {
  try {
    const raw = localStorage.getItem("orborus_unread_conversations");
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : []);
  } catch (e) {
    return new Set();
  }
})();
var activeConversationId = null;

function saveUnreadConversations() {
  try {
    localStorage.setItem("orborus_unread_conversations", JSON.stringify(Array.from(unreadConversationIds)));
  } catch (e) {}
}

function markConversationUnread(convId) {
  if (!convId) return;
  unreadConversationIds.add(convId);
  if (Array.isArray(appConversations)) {
    const conv = appConversations.find(c => c && c.id === convId);
    if (conv) conv.unread = true;
  }
  saveUnreadConversations();
  if (typeof scheduleLocalConversationsSave === "function") scheduleLocalConversationsSave();
  if (typeof renderProjectTree === "function") renderProjectTree();
}

function markConversationRead(convId) {
  if (!convId) return;
  const had = unreadConversationIds.has(convId);
  unreadConversationIds.delete(convId);
  let convHad = false;
  if (Array.isArray(appConversations)) {
    const conv = appConversations.find(c => c && c.id === convId);
    if (conv && conv.unread) {
      conv.unread = false;
      convHad = true;
    }
  }
  if (had || convHad) {
    saveUnreadConversations();
    if (typeof scheduleLocalConversationsSave === "function") scheduleLocalConversationsSave();
    if (typeof renderProjectTree === "function") renderProjectTree();
  }
}
if (typeof window !== "undefined") {
  window.markConversationUnread = markConversationUnread;
  window.markConversationRead = markConversationRead;
}

var conversationScrollState = {};
var _isRestoringScroll = false;
var _scrollRestoreTimers = [];

function clearPendingScrollRestoreTimers() {
  if (Array.isArray(_scrollRestoreTimers) && _scrollRestoreTimers.length > 0) {
    _scrollRestoreTimers.forEach(t => clearTimeout(t));
    _scrollRestoreTimers = [];
  }
}

function updateScrollToBottomButton() {
  const wrap = document.getElementById("scroll-to-bottom-wrap");
  const stream = document.getElementById("execution-stream");
  if (!wrap || !stream || !activeConversationId) {
    if (wrap) wrap.classList.remove("visible");
    return;
  }
  const distFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
  const shouldShow = stream.scrollHeight > stream.clientHeight + 24 && distFromBottom > 36;
  wrap.classList.toggle("visible", shouldShow);
}

function saveCurrentConversationScrollState(convIdOverride) {
  if (_isRestoringScroll) return;
  const targetId = convIdOverride || activeConversationId;
  if (!targetId) return;
  const stream = document.getElementById("execution-stream");
  if (!stream || stream.clientHeight <= 0) return;
  const distFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
  const isAtBottom = distFromBottom <= 36;
  conversationScrollState[targetId] = {
    scrollTop: stream.scrollTop,
    isAtBottom: isAtBottom
  };
}

function scrollToBottomOfStream(smooth) {
  const stream = document.getElementById("execution-stream");
  if (!stream) return;
  clearPendingScrollRestoreTimers();
  _isRestoringScroll = true;
  if (activeConversationId) {
    conversationScrollState[activeConversationId] = {
      scrollTop: stream.scrollHeight,
      isAtBottom: true
    };
  }
  const wrap = document.getElementById("scroll-to-bottom-wrap");
  if (wrap) wrap.classList.remove("visible");

  if (smooth && typeof stream.scrollTo === "function") {
    try {
      stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    } catch (e) {
      stream.scrollTop = stream.scrollHeight;
    }
    _scrollRestoreTimers.push(setTimeout(() => {
      stream.scrollTop = stream.scrollHeight;
      if (activeConversationId) {
        conversationScrollState[activeConversationId] = {
          scrollTop: stream.scrollTop,
          isAtBottom: true
        };
      }
      _isRestoringScroll = false;
      updateScrollToBottomButton();
    }, 240));
  } else {
    stream.scrollTop = stream.scrollHeight;
    requestAnimationFrame(() => {
      stream.scrollTop = stream.scrollHeight;
    });
    _scrollRestoreTimers.push(setTimeout(() => {
      stream.scrollTop = stream.scrollHeight;
      if (activeConversationId) {
        conversationScrollState[activeConversationId] = {
          scrollTop: stream.scrollTop,
          isAtBottom: true
        };
      }
      _isRestoringScroll = false;
      updateScrollToBottomButton();
    }, 60));
  }
}

function applyConversationScrollState(convId) {
  const targetId = convId || activeConversationId;
  const stream = document.getElementById("execution-stream");
  if (!stream || !targetId) {
    _isRestoringScroll = false;
    updateScrollToBottomButton();
    return;
  }
  clearPendingScrollRestoreTimers();
  _isRestoringScroll = true;

  const saved = conversationScrollState[targetId];
  const shouldScrollToBottom = !saved || saved.isAtBottom;

  const syncScrollPosition = () => {
    if (activeConversationId !== targetId) return;
    if (shouldScrollToBottom) {
      stream.scrollTop = stream.scrollHeight;
    } else {
      const maxScroll = Math.max(0, stream.scrollHeight - stream.clientHeight);
      stream.scrollTop = Math.min(saved.scrollTop, maxScroll);
    }
    updateScrollToBottomButton();
  };

  syncScrollPosition();

  requestAnimationFrame(() => {
    syncScrollPosition();
  });
  [18, 65, 140].forEach((delay, idx, arr) => {
    _scrollRestoreTimers.push(setTimeout(() => {
      syncScrollPosition();
      if (idx === arr.length - 1) {
        _isRestoringScroll = false;
        if (activeConversationId === targetId) {
          conversationScrollState[targetId] = {
            scrollTop: stream.scrollTop,
            isAtBottom: shouldScrollToBottom ? true : ((stream.scrollHeight - stream.scrollTop - stream.clientHeight) <= 36)
          };
          updateScrollToBottomButton();
        }
      }
    }, delay));
  });
}

if (typeof window !== "undefined") {
  window.scrollToBottomOfStream = scrollToBottomOfStream;
  window.saveCurrentConversationScrollState = saveCurrentConversationScrollState;
  window.applyConversationScrollState = applyConversationScrollState;
  window.updateScrollToBottomButton = updateScrollToBottomButton;
}
var collapsedProjects = (() => {
  try {
    return JSON.parse(localStorage.getItem("orborus_collapsed_projects") || "{}") || {};
  } catch (e) {
    return {};
  }
})();
var projectFilterQuery = "";
var isProjectsFilterOpen = false;
var appConversations = [];
var activeProjectPath = ".";
var allProjects = [];

function normPath(p) {
  if (!p || typeof p !== "string") return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function escapeJsAttr(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
window.escapeJsAttr = escapeJsAttr;

var projectOrderPaths = (() => {
  try {
    const raw = localStorage.getItem("orborus_project_order");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
})();

var conversationOrderIds = (() => {
  try {
    const raw = localStorage.getItem("orborus_conversation_order");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
})();

function saveProjectOrder(orderPaths) {
  try {
    if (Array.isArray(orderPaths)) {
      const seen = new Set();
      const cleaned = [];
      orderPaths.forEach(p => {
        const k = normPath(p);
        if (k && !seen.has(k)) {
          seen.add(k);
          cleaned.push(k);
        }
      });
      projectOrderPaths = cleaned;
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_project_order", JSON.stringify(projectOrderPaths));
    }
  } catch (err) {
    console.warn("Failed to save project order:", err);
  }
}

function saveConversationOrder(orderIds) {
  try {
    if (Array.isArray(orderIds)) {
      const seen = new Set();
      const cleaned = [];
      orderIds.forEach(id => {
        if (id && typeof id === "string" && !seen.has(id)) {
          seen.add(id);
          cleaned.push(id);
        }
      });
      conversationOrderIds = cleaned;
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("orborus_conversation_order", JSON.stringify(conversationOrderIds));
    }
  } catch (err) {
    console.warn("Failed to save conversation order:", err);
  }
}

function sortProjectsByStoredOrder(list) {
  if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? list : [];
  if (!Array.isArray(projectOrderPaths)) projectOrderPaths = [];
  let orderChanged = false;
  list.forEach(p => {
    const k = normPath(p && (p.Path || p.path));
    if (k && !projectOrderPaths.includes(k)) {
      projectOrderPaths.push(k);
      orderChanged = true;
    }
  });
  if (orderChanged) {
    saveProjectOrder(projectOrderPaths);
  }
  const orderMap = new Map();
  projectOrderPaths.forEach((k, idx) => orderMap.set(k, idx));
  return [...list].sort((a, b) => {
    const ka = normPath(a && (a.Path || a.path));
    const kb = normPath(b && (b.Path || b.path));
    const ia = orderMap.has(ka) ? orderMap.get(ka) : 999999;
    const ib = orderMap.has(kb) ? orderMap.get(kb) : 999999;
    return ia - ib;
  });
}

function saveStoredProjects() {
  try {
    if (typeof localStorage !== "undefined" && Array.isArray(allProjects)) {
      localStorage.setItem("orborus_projects", JSON.stringify(allProjects));
    }
  } catch (err) {
    console.warn("Failed to save projects to localStorage:", err);
  }
}

function loadStoredProjects() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("orborus_projects");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          mergeProjects(parsed);
        }
      }
    }
  } catch (err) {
    console.warn("Failed to load projects from localStorage:", err);
  }
}

function mergeProjects(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return;
  if (!Array.isArray(allProjects)) allProjects = [];

  const existingMap = new Map();
  allProjects.forEach((p, idx) => {
    const key = normPath(p.Path || p.path);
    if (key) existingMap.set(key, idx);
  });

  incoming.forEach(p => {
    if (!p) return;
    const rawPath = typeof p === "string" ? p : (p.Path || p.path || "");
    const key = normPath(rawPath);
    if (!key) return;

    let name = (typeof p === "object" ? (p.Name || p.name) : "") || "";
    if (!name) {
      if (key === ".") {
        name = "Active Workspace";
      } else {
        const parts = rawPath.split(/[/\\]/).filter(Boolean);
        name = parts.length > 0 ? parts[parts.length - 1] : "Project";
      }
    }

    if (existingMap.has(key)) {
      const idx = existingMap.get(key);
      if (name && (!allProjects[idx].Name || allProjects[idx].Name === "Project" || allProjects[idx].Name === "Local Workspace")) {
        allProjects[idx].Name = name;
      }
      if (!allProjects[idx].Path && rawPath) {
        allProjects[idx].Path = rawPath;
      }
    } else {
      const newEntry = { Name: name, Path: rawPath };
      allProjects.push(newEntry);
      existingMap.set(key, allProjects.length - 1);
    }
  });

  allProjects = sortProjectsByStoredOrder(allProjects);
  saveStoredProjects();
}

if (typeof window !== "undefined") {
  window.normPath = normPath;
  window.saveProjectOrder = saveProjectOrder;
  window.saveConversationOrder = saveConversationOrder;
  window.sortProjectsByStoredOrder = sortProjectsByStoredOrder;
  window.saveStoredProjects = saveStoredProjects;
  window.loadStoredProjects = loadStoredProjects;
  window.mergeProjects = mergeProjects;
}
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
  const serialized = typeof payload === "string" ? payload : (payload != null ? JSON.stringify(payload) : "");
  if (window.agentBridge && typeof window.agentBridge.handleAction === "function") {
    return await window.agentBridge.handleAction(action, serialized);
  }
  if (typeof window.bridgeCall === "function") {
    return await window.bridgeCall(action, serialized);
  }
  if (action && typeof window[action] === "function" && window[action] !== callGo) {
    return await window[action](serialized);
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
  // Local Models — Gemma Family (Native GPU / Tendon Engine)
  {
    key: "local-gemma-2-2b",
    label: "Gemma 2 2B",
    cleanName: "Gemma 2 2B",
    family: "Gemma",
    sizeLabel: "2B",
    subnote: "Gemma 2 · Ultra-light",
    estimatedRam: "~2.5 GB RAM",
    filename: "gemma-2-2b-it-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf",
    sizeBytes: 1708510976,
    sizeGB: 1.6,
    sizeDisplay: "1.6 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-gemma-3-4b",
    label: "Gemma 3 4B",
    cleanName: "Gemma 3 4B",
    family: "Gemma",
    sizeLabel: "4B",
    subnote: "Gemma 3 · Fast",
    estimatedRam: "~3.5 GB RAM",
    filename: "gemma-3-4b-it-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf",
    sizeBytes: 2684354560,
    sizeGB: 2.5,
    sizeDisplay: "2.5 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-gemma-2-9b",
    label: "Gemma 2 9B",
    cleanName: "Gemma 2 9B",
    family: "Gemma",
    sizeLabel: "9B",
    subnote: "Gemma 2 · Balanced",
    estimatedRam: "~6.5 GB RAM",
    filename: "gemma-2-9b-it-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf",
    sizeBytes: 5765977984,
    sizeGB: 5.4,
    sizeDisplay: "5.4 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-gemma-3-12b",
    label: "Gemma 3 12B",
    cleanName: "Gemma 3 12B",
    family: "Gemma",
    sizeLabel: "12B",
    subnote: "Gemma 3 · Versatile",
    estimatedRam: "~8.5 GB RAM",
    filename: "gemma-3-12b-it-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/main/google_gemma-3-12b-it-Q4_K_M.gguf",
    sizeBytes: 7838315315,
    sizeGB: 7.3,
    sizeDisplay: "7.3 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "tendon-local",
    label: "Gemma 4 26B",
    cleanName: "Gemma 4 26B",
    family: "Gemma",
    sizeLabel: "26B",
    subnote: "Gemma 4 · Default MoE",
    estimatedRam: "~12 GB RAM",
    filename: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/unsloth/gemma-3-27b-it-GGUF/resolve/main/gemma-3-27b-it-Q4_K_M.gguf",
    sizeBytes: 16642998272,
    sizeGB: 15.5,
    sizeDisplay: "15.5 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-gemma-2-27b",
    label: "Gemma 2 27B",
    cleanName: "Gemma 2 27B",
    family: "Gemma",
    sizeLabel: "27B",
    subnote: "Gemma 2 · Deep",
    estimatedRam: "~18 GB RAM",
    filename: "gemma-2-27b-it-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/gemma-2-27b-it-GGUF/resolve/main/gemma-2-27b-it-Q4_K_M.gguf",
    sizeBytes: 17824115712,
    sizeGB: 16.6,
    sizeDisplay: "16.6 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },

  // Local Models — Llama Family (Native GPU / Tendon Engine)
  {
    key: "local-llama-3.2-1b",
    label: "Llama 3.2 1B",
    cleanName: "Llama 3.2 1B",
    family: "Llama",
    sizeLabel: "1B",
    subnote: "Llama 3.2 · Instant",
    estimatedRam: "~2 GB RAM",
    filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    sizeBytes: 807657472,
    sizeGB: 0.8,
    sizeDisplay: "0.8 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-llama-3.2-3b",
    label: "Llama 3.2 3B",
    cleanName: "Llama 3.2 3B",
    family: "Llama",
    sizeLabel: "3B",
    subnote: "Llama 3.2 · Compact",
    estimatedRam: "~3 GB RAM",
    filename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    sizeBytes: 2019377152,
    sizeGB: 1.9,
    sizeDisplay: "1.9 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-llama-3.1-8b",
    label: "Llama 3.1 8B",
    cleanName: "Llama 3.1 8B",
    family: "Llama",
    sizeLabel: "8B",
    subnote: "Llama 3.1 · General",
    estimatedRam: "~6.5 GB RAM",
    filename: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    sizeBytes: 4920739840,
    sizeGB: 4.6,
    sizeDisplay: "4.6 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-llama-3.3-70b",
    label: "Llama 3.3 70B",
    cleanName: "Llama 3.3 70B",
    family: "Llama",
    sizeLabel: "70B",
    subnote: "Llama 3.3 · Flagship",
    estimatedRam: "~42 GB RAM",
    filename: "Llama-3.3-70B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q4_K_M.gguf",
    sizeBytes: 42520176230,
    sizeGB: 39.6,
    sizeDisplay: "39.6 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },

  // Local Models — Qwen Family (Native GPU / Tendon Engine)
  {
    key: "local-qwen-2.5-3b",
    label: "Qwen 2.5 3B",
    cleanName: "Qwen 2.5 3B",
    family: "Qwen",
    sizeLabel: "3B",
    subnote: "Qwen 2.5 · Fast",
    estimatedRam: "~3 GB RAM",
    filename: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    sizeBytes: 2104533975,
    sizeGB: 2.0,
    sizeDisplay: "2.0 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-qwen-2.5-coder-7b",
    label: "Qwen 2.5 Coder 7B",
    cleanName: "Qwen 2.5 Coder 7B",
    family: "Qwen",
    sizeLabel: "7B",
    subnote: "Qwen 2.5 Coder",
    estimatedRam: "~5.5 GB RAM",
    filename: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    sizeBytes: 4683073945,
    sizeGB: 4.4,
    sizeDisplay: "4.4 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-qwen-2.5-coder-14b",
    label: "Qwen 2.5 Coder 14B",
    cleanName: "Qwen 2.5 Coder 14B",
    family: "Qwen",
    sizeLabel: "14B",
    subnote: "Qwen 2.5 Coder",
    estimatedRam: "~10 GB RAM",
    filename: "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    sizeBytes: 8988116582,
    sizeGB: 8.4,
    sizeDisplay: "8.4 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },
  {
    key: "local-qwen-2.5-coder-32b",
    label: "Qwen 2.5 Coder 32B",
    cleanName: "Qwen 2.5 Coder 32B",
    family: "Qwen",
    sizeLabel: "32B",
    subnote: "Qwen 2.5 Coder",
    estimatedRam: "~20 GB RAM",
    filename: "Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf",
    sizeBytes: 19852580454,
    sizeGB: 18.5,
    sizeDisplay: "18.5 GB",
    desc: "Local GPU Engine",
    category: "Local Models",
    provider: "local"
  },

  // Shuffle AI
  {
    key: "shuffle-ai",
    label: "Shuffle AI",
    cleanName: "Shuffle AI",
    desc: "Shuffle Cloud Agent",
    category: "Shuffle AI",
    provider: "shuffle"
  },

  // Remote Providers (BYOK) - Curated flagship modern models
  {
    key: "claude-3-7-sonnet",
    label: "Claude 3.7 Sonnet",
    cleanName: "Claude 3.7 Sonnet",
    desc: "Anthropic BYOK",
    category: "BYOK Models",
    provider: "anthropic"
  },
  {
    key: "gpt-4o",
    label: "GPT-4o",
    cleanName: "GPT-4o",
    desc: "OpenAI BYOK",
    category: "BYOK Models",
    provider: "openai"
  },
  {
    key: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    cleanName: "Gemini 3.8 Flash",
    desc: "Google Gemini BYOK",
    category: "BYOK Models",
    provider: "gemini"
  },
  {
    key: "deepseek-chat",
    label: "DeepSeek Chat (V3)",
    cleanName: "DeepSeek V3",
    desc: "DeepSeek BYOK",
    category: "BYOK Models",
    provider: "deepseek"
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

function formatEasyModelName(rawName) {
  if (!rawName) return "Local Model";
  const base = String(rawName).split(/[\\/]/).pop().replace(/\.gguf$/i, "").trim();
  const name = base.replace(/[_-]+/g, " ");

  // Gemma patterns
  if (/gemma\s*4\s*26b/i.test(name)) return "Gemma 4 26B";
  if (/gemma\s*3\s*12b/i.test(name)) return "Gemma 3 12B";
  if (/gemma\s*3\s*4b/i.test(name)) return "Gemma 3 4B";
  if (/gemma\s*2\s*27b/i.test(name)) return "Gemma 2 27B";
  if (/gemma\s*2\s*9b/i.test(name)) return "Gemma 2 9B";
  if (/gemma\s*2\s*2b/i.test(name)) return "Gemma 2 2B";

  // Qwen patterns
  if (/qwen\s*2\.?5\s*coder\s*32b/i.test(name)) return "Qwen 2.5 Coder 32B";
  if (/qwen\s*2\.?5\s*coder\s*14b/i.test(name)) return "Qwen 2.5 Coder 14B";
  if (/qwen\s*2\.?5\s*coder\s*7b/i.test(name)) return "Qwen 2.5 Coder 7B";
  if (/qwen\s*2\.?5\s*32b/i.test(name)) return "Qwen 2.5 32B";
  if (/qwen\s*2\.?5\s*14b/i.test(name)) return "Qwen 2.5 14B";
  if (/qwen\s*2\.?5\s*7b/i.test(name)) return "Qwen 2.5 7B";

  // DeepSeek patterns
  if (/deepseek\s*r1.*32b/i.test(name)) return "DeepSeek R1 32B";
  if (/deepseek\s*r1.*14b/i.test(name)) return "DeepSeek R1 14B";
  if (/deepseek\s*r1.*8b/i.test(name)) return "DeepSeek R1 8B";
  if (/deepseek\s*r1.*7b/i.test(name)) return "DeepSeek R1 7B";

  // Llama patterns
  if (/llama\s*3\.?3\s*70b/i.test(name)) return "Llama 3.3 70B";
  if (/llama\s*3\.?1\s*70b/i.test(name)) return "Llama 3.1 70B";
  if (/llama\s*3\.?1\s*8b/i.test(name)) return "Llama 3.1 8B";
  if (/llama\s*3\.?2\s*3b/i.test(name)) return "Llama 3.2 3B";
  if (/llama\s*3\.?2\s*1b/i.test(name)) return "Llama 3.2 1B";

  // Phi & Mistral
  if (/phi\s*4/i.test(name)) return "Phi-4 14B";
  if (/mistral\s*nemo/i.test(name)) return "Mistral NeMo 12B";
  if (/mistral\s*7b/i.test(name)) return "Mistral 7B";

  const paramMatch = name.match(/\b(\d+(?:\.\d+)?[bBmM])\b/);
  const firstWord = name.split(/\s+/)[0];
  if (paramMatch && firstWord) {
    const capitalized = firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
    return `${capitalized} ${paramMatch[1].toUpperCase()}`;
  }

  const clean = base.replace(/[-_](q[0-9]+[a-z0-9_]*|iq[0-9]+[a-z0-9_]*|f16|f32|bf16|it|instruct|chat|ud)/gi, "").replace(/[-_]+/g, " ").trim();
  return clean || base;
}

function resolveModelDisplayName(modelId) {
  if (!modelId) return "Gemma 4 26B";
  if (modelId === "shuffle-ai" || modelId === "shuffle") return "Shuffle AI";
  const def = (typeof AVAILABLE_AI_MODELS !== "undefined" && Array.isArray(AVAILABLE_AI_MODELS))
    ? AVAILABLE_AI_MODELS.find(m => m.key === modelId || m.label === modelId)
    : null;
  if (def && (def.cleanName || def.label)) {
    return def.cleanName || def.label;
  }
  if (typeof formatEasyModelName === "function") {
    const easy = formatEasyModelName(modelId);
    if (easy && easy !== "Local Model") return easy;
  }
  if (modelId === "tendon-local") return "Gemma 4 26B";
  if (modelId === "gemini-3.8-flash") return "Gemini 3.8 Flash";
  if (modelId === "gemini-3.8-pro") return "Gemini 3.8 Pro";
  if (modelId === "gpt-4o") return "GPT-4o";
  if (modelId === "claude-3-7-sonnet") return "Claude 3.7 Sonnet";
  if (modelId === "claude-3-5-sonnet") return "Claude 3.5 Sonnet";
  return modelId;
}

function isSelfHostedModel(modelId) {
  if (!modelId) {
    modelId = (typeof activeAiModel !== "undefined" && activeAiModel) || "";
  }
  const m = String(modelId).toLowerCase();

  // Explicit Cloud / Shuffle AI / BYOK providers are NEVER self-hosted
  if (m === "shuffle-ai" || m === "shuffle" || m.startsWith("gemini") || m.startsWith("gpt") ||
      m.startsWith("claude") || m.startsWith("anthropic") || m.startsWith("deepseek") ||
      m.startsWith("groq") || m.startsWith("openrouter") || m === "custom") {
    return false;
  }

  // If user is currently running in Shuffle cloud execution mode or authenticated via OAuth, it's not local
  if (typeof window !== "undefined" && (window.oauthLoggedIn || window.activeExecutionMode === "shuffle")) {
    return false;
  }

  // True local models (Tendon engine, local GGUF, or Ollama)
  if (m.startsWith("tendon") || m.startsWith("local") || m.includes("ollama") || m.includes(".gguf")) {
    return true;
  }
  const effUrl = ((typeof currentAiUrl !== "undefined" && currentAiUrl) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_url")) || "").toLowerCase();
  if (effUrl.includes("127.0.0.1") || effUrl.includes("localhost") || effUrl.startsWith("local://")) {
    return true;
  }

  return false;
}

if (typeof window !== "undefined") {
  window.resolveModelDisplayName = resolveModelDisplayName;
  window.isSelfHostedModel = isSelfHostedModel;
}

function estimateModelRam(rawName, sizeBytes) {
  if (typeof sizeBytes === "number" && sizeBytes > 0) {
    const gb = sizeBytes / (1024 * 1024 * 1024);
    const est = Math.round((gb * 1.15 + 1.2) * 10) / 10;
    return `~${est} GB RAM`;
  }
  const name = String(rawName || "").toLowerCase();
  if (name.includes("70b")) return "~42 GB RAM";
  if (name.includes("32b")) return "~20 GB RAM";
  if (name.includes("26b") || name.includes("27b")) return "~12 GB RAM";
  if (name.includes("14b")) return "~10 GB RAM";
  if (name.includes("12b")) return "~8.5 GB RAM";
  if (name.includes("8b") || name.includes("9b")) return "~6.5 GB RAM";
  if (name.includes("7b")) return "~5.5 GB RAM";
  if (name.includes("4b")) return "~3.5 GB RAM";
  if (name.includes("3b")) return "~3 GB RAM";
  if (name.includes("1b") || name.includes("2b")) return "~2 GB RAM";
  return "~8 GB RAM";
}

function getHardwareMemoryLimits() {
  // Total GPU VRAM in GB
  let vramGB = 12; // Default for RTX 3080 Ti
  if (typeof window !== "undefined" && typeof window.localVramTotalMB === "number" && window.localVramTotalMB > 0) {
    vramGB = Math.round((window.localVramTotalMB / 1024) * 10) / 10;
  }

  // Total System RAM in GB
  let ramGB = 16; // Default fallback for host
  if (typeof window !== "undefined" && typeof window.systemRamTotalMB === "number" && window.systemRamTotalMB > 0) {
    ramGB = Math.round((window.systemRamTotalMB / 1024) * 10) / 10;
  } else if (typeof navigator !== "undefined" && navigator.deviceMemory) {
    ramGB = navigator.deviceMemory;
  }

  const gpuName = (typeof window !== "undefined" && window.localGpuName) || "NVIDIA RTX 3080 Ti";

  return {
    vramGB,
    ramGB,
    gpuName
  };
}

function parseRequiredMemoryGB(modelObjOrRamString) {
  let str = "";
  if (typeof modelObjOrRamString === "string") {
    str = modelObjOrRamString;
  } else if (modelObjOrRamString && modelObjOrRamString.estimatedRam) {
    str = modelObjOrRamString.estimatedRam;
  } else if (modelObjOrRamString && (modelObjOrRamString.name || modelObjOrRamString.label || modelObjOrRamString.key)) {
    str = estimateModelRam(modelObjOrRamString.name || modelObjOrRamString.label || modelObjOrRamString.key, modelObjOrRamString.size_bytes);
  }
  const match = String(str).match(/([0-9]+(?:\.[0-9]+)?)\s*GB/i);
  if (match) {
    return parseFloat(match[1]);
  }
  return 8;
}

function checkLocalModelMemoryFit(model) {
  const reqGB = parseRequiredMemoryGB(model);
  const { vramGB, ramGB, gpuName } = getHardwareMemoryLimits();

  // A model is outside the hardware range if its required memory exceeds both VRAM and total system RAM
  const isOutsideRange = (reqGB > vramGB && reqGB > ramGB);
  const fitsVram = (reqGB <= vramGB);

  let reason = "";
  let tooltip = "";
  if (isOutsideRange) {
    reason = `Requires ~${reqGB} GB (exceeds ${vramGB} GB VRAM / ${ramGB} GB RAM)`;
    tooltip = `Requires ~${reqGB} GB RAM/VRAM, which is outside your hardware capacity (${vramGB} GB VRAM on ${gpuName}, ${ramGB} GB System RAM). Cannot run on this machine.`;
  } else if (!fitsVram) {
    reason = `Requires ~${reqGB} GB (exceeds ${vramGB} GB VRAM, fits in ${ramGB} GB RAM)`;
    tooltip = `Requires ~${reqGB} GB RAM. Exceeds pure ${vramGB} GB VRAM; requires host RAM offloading.`;
  } else {
    tooltip = `Requires ~${reqGB} GB RAM/VRAM. Fully fits in ${vramGB} GB GPU VRAM on ${gpuName}.`;
  }

  return {
    reqGB,
    vramGB,
    ramGB,
    gpuName,
    fitsVram,
    isOutsideRange,
    reason,
    tooltip
  };
}

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

if (typeof window !== "undefined") {
  window.localModelsCatalog = window.localModelsCatalog || {};
  window.localDiskFreeBytes = window.localDiskFreeBytes || 0;
  window.localDiskFreeGB = window.localDiskFreeGB || 0;
  window.localDiskFreeDisplay = window.localDiskFreeDisplay || "";
  window.localModelDownloadState = window.localModelDownloadState || { status: "idle" };
}

function updateLocalModelCatalogState(catalogArr, freeBytes, freeGB, freeDisplay, dlState) {
  if (typeof window === "undefined") return;
  if (Array.isArray(catalogArr)) {
    const map = {};
    catalogArr.forEach(item => {
      if (item && item.key) {
        map[item.key] = item;
      }
    });
    window.localModelsCatalog = map;
  }
  if (typeof freeBytes === "number" && freeBytes >= 0) {
    window.localDiskFreeBytes = freeBytes;
  }
  if (typeof freeGB === "number" && freeGB >= 0) {
    window.localDiskFreeGB = freeGB;
  }
  if (typeof freeDisplay === "string" && freeDisplay) {
    window.localDiskFreeDisplay = freeDisplay;
  }
  if (dlState && typeof dlState === "object") {
    window.localModelDownloadState = dlState;
    if (dlState.status === "completed" && dlState.model_key && window.localModelsCatalog && window.localModelsCatalog[dlState.model_key]) {
      window.localModelsCatalog[dlState.model_key].installed = true;
      window.localModelsCatalog[dlState.model_key].installed_path = dlState.target_path || "";
      window.localModelsCatalog[dlState.model_key].is_downloading = false;
    }
  }
}

if (typeof window !== "undefined") {
  window.updateLocalModelCatalogState = updateLocalModelCatalogState;
}

function getModelConfigStatus(modelKey) {
  const curKey = (modelKey || activeAiModel || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "tendon-local").trim();
  const effectiveKey = (currentAiKey || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_key")) || "").trim();
  const effectiveUrl = (currentAiUrl || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_url")) || "").trim().toLowerCase();
  const hasShuffleAuth = !!(
    (typeof window !== "undefined" && window.oauthLoggedIn === true) &&
    (typeof localStorage !== "undefined" && localStorage.getItem("orborus_oauth_logged_in") === "true")
  );
  const hasLocalGPU = (typeof window !== "undefined" && window.localExecutorAvailable !== false);
  const hasGenericKey = effectiveKey.length > 0;
  const hasGenericUrl = effectiveUrl.length > 0 && !effectiveUrl.startsWith("local://");

  const modelDef = (typeof AVAILABLE_AI_MODELS !== "undefined" && AVAILABLE_AI_MODELS.find(m => m.key === curKey)) || null;
  const category = modelDef ? modelDef.category : "";
  const provider = modelDef ? modelDef.provider : (typeof detectModelProvider === "function" ? detectModelProvider(curKey) : "custom");

  // 1. Local GPU Models
  if (category === "Local Models" || provider === "local" || curKey === "tendon-local" || curKey.startsWith("tendon") || curKey.startsWith("local") || curKey.includes("gemma")) {
    if (hasLocalGPU) {
      const def = modelDef || { key: curKey };
      const memFit = checkLocalModelMemoryFit(def);
      if (memFit.isOutsideRange) {
        return {
          configured: false,
          category: "Local Models",
          badge: "Exceeds Range",
          badgeType: "unconfigured",
          reason: memFit.reason,
          tooltip: memFit.tooltip,
          actionText: "Exceeds Hardware",
          actionType: "hardware_limit",
          setupTip: memFit.tooltip,
          isOutsideRange: true,
          estimatedRam: def.estimatedRam || `~${memFit.reqGB} GB RAM`
        };
      }

      const catMap = (typeof window !== "undefined" && window.localModelsCatalog) || {};
      const catEntry = catMap[curKey] || null;
      const dlState = (typeof window !== "undefined" && window.localModelDownloadState) || null;
      const sizeDisplay = (catEntry && catEntry.size_display) || def.sizeDisplay || (def.sizeGB ? `${def.sizeGB} GB` : "~4 GB");
      const sizeBytes = (catEntry && catEntry.size_bytes) || def.sizeBytes || 0;
      const freeBytes = (typeof window !== "undefined" && window.localDiskFreeBytes) || 0;
      const freeDisplay = (typeof window !== "undefined" && window.localDiskFreeDisplay) || (freeBytes > 0 ? `${(freeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : "");
      const downloadUrl = (catEntry && catEntry.download_url) || def.downloadUrl || "";

      // A) Actively downloading this model right now
      if (dlState && dlState.status === "downloading" && dlState.model_key === curKey) {
        const pct = typeof dlState.progress_pct === "number" ? dlState.progress_pct : 0;
        const dlGB = ((dlState.downloaded_bytes || 0) / (1024 * 1024 * 1024)).toFixed(2);
        const totGB = ((dlState.total_bytes || sizeBytes || 1) / (1024 * 1024 * 1024)).toFixed(2);
        const speedStr = dlState.speed_mbps ? ` · ${dlState.speed_mbps} MB/s` : "";
        return {
          configured: true,
          category: "Local Models",
          badge: `Downloading ${pct}%`,
          badgeType: "downloading",
          isDownloading: true,
          progressPct: pct,
          downloadedBytes: dlState.downloaded_bytes || 0,
          totalBytes: dlState.total_bytes || sizeBytes,
          speedMBps: dlState.speed_mbps || 0,
          reason: `Downloading ${def.cleanName || def.label} · ${pct}% (${dlGB} / ${totGB} GB${speedStr})`,
          tooltip: `Downloading ${def.filename || def.label} from HuggingFace (${pct}%)`,
          actionText: "Cancel",
          actionType: "cancel_download",
          setupTip: `Downloading ${def.filename || def.label} to local models folder.`,
          isOutsideRange: false,
          estimatedRam: def.estimatedRam || `~${memFit.reqGB} GB RAM`,
          sizeDisplay,
          downloadUrl
        };
      }

      // B) Determine if installed on disk
      const catalogHydrated = Object.keys(catMap).length > 0;
      const isInstalled = catEntry ? !!catEntry.installed : (!catalogHydrated && curKey === "tendon-local");

      if (isInstalled) {
        return {
          configured: true,
          category: "Local Models",
          badge: "Ready",
          badgeType: "ready",
          isInstalled: true,
          reason: "",
          tooltip: `${def.cleanName || def.label} is installed on disk. ${memFit.tooltip || "Ready for local GPU inference."}`,
          actionText: "",
          actionType: "",
          setupTip: "",
          isOutsideRange: false,
          estimatedRam: def.estimatedRam || `~${memFit.reqGB} GB RAM`,
          sizeDisplay,
          downloadUrl
        };
      }

      // C) Not installed on disk -> check available disk space (model size + 512 MB buffer)
      const safetyBuffer = 512 * 1024 * 1024;
      const fitsDisk = catEntry ? (catEntry.fits_disk_space !== false) : (freeBytes === 0 || freeBytes >= (sizeBytes + safetyBuffer));
      if (!fitsDisk) {
        const reqGBDisk = ((sizeBytes + safetyBuffer) / (1024 * 1024 * 1024)).toFixed(1);
        return {
          configured: false,
          category: "Local Models",
          badge: "Low Disk Space",
          badgeType: "unconfigured",
          isInstalled: false,
          isLowDisk: true,
          reason: `Insufficient disk space for ${def.cleanName || def.label}: requires ~${reqGBDisk} GB (${freeDisplay || "0 GB"} available)`,
          tooltip: `Requires ~${reqGBDisk} GB free disk space (only ${freeDisplay || "0 GB"} available). Free up space or change the models folder in Settings.`,
          actionText: "Storage Settings",
          actionType: "storage_settings",
          setupTip: `Not enough free disk space to download ${def.filename || def.label}.`,
          isOutsideRange: false,
          estimatedRam: def.estimatedRam || `~${memFit.reqGB} GB RAM`,
          sizeDisplay,
          downloadUrl
        };
      }

      // D) Not installed on disk, but fits in hardware and disk space -> ready for automatic or 1-click download
      const hasPartial = !!(catEntry && catEntry.has_partial);
      const recentError = (dlState && dlState.status === "error" && dlState.model_key === curKey && dlState.error) ? dlState.error : "";
      const freeSuffix = freeDisplay ? ` · ${freeDisplay} free` : "";
      return {
        configured: true,
        category: "Local Models",
        badge: hasPartial ? `Resume (${sizeDisplay})` : `Download · ${sizeDisplay}`,
        badgeType: "downloadable",
        isInstalled: false,
        needsDownload: true,
        hasPartial,
        downloadError: recentError,
        reason: recentError
          ? `Download failed for ${def.cleanName || def.label}: ${recentError}`
          : `${def.cleanName || def.label} (${sizeDisplay}) is not on disk yet${freeSuffix}. Will download automatically on run.`,
        tooltip: `${def.cleanName || def.label} (${sizeDisplay}) will be downloaded from HuggingFace (${def.filename || "GGUF"})${freeSuffix}. ${memFit.tooltip || ""}`,
        actionText: hasPartial ? "Resume Download" : `Download (${sizeDisplay})`,
        actionType: "download_model",
        setupTip: `Click Download (${sizeDisplay}) or send a prompt to automatically download ${def.filename || def.label}.`,
        isOutsideRange: false,
        estimatedRam: def.estimatedRam || `~${memFit.reqGB} GB RAM`,
        sizeDisplay,
        downloadUrl
      };
    } else {
      return {
        configured: false,
        category: "Local Models",
        badge: "Unavailable",
        badgeType: "unconfigured",
        reason: "Requires Local GPU Engine",
        tooltip: "Native local CUDA engine is not available on this device.",
        actionText: "Hardware Setup",
        actionType: "hardware",
        setupTip: "Local engine is unavailable. Switch to a cloud model or configure CUDA."
      };
    }
  }

  // 2. Shuffle AI (strictly requires Shuffle session)
  const isShuffleCategory = category === "Shuffle AI" || provider === "shuffle" || curKey === "shuffle-ai" || curKey === "shuffle" || curKey === "default";
  if (isShuffleCategory) {
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
        reason: "Requires Shuffle Cloud session",
        actionText: "Connect Shuffle AI",
        actionType: "auth",
        setupTip: "Shuffle AI requires an active Shuffle session. Connect in Settings or choose BYOK / Local GPU."
      };
    }
  }

  // 3. OpenAI Models (BYOK)
  if (provider === "openai" || curKey === "gpt-4o" || curKey.startsWith("gpt-") || curKey.startsWith("o1") || curKey.startsWith("o3")) {
    const hasOpenAiKey = (effectiveKey.startsWith("sk-") && !effectiveKey.startsWith("sk-ant-")) || (effectiveUrl.includes("openai.com") && effectiveKey.length > 0) || (effectiveUrl.length > 0 && !effectiveUrl.includes("anthropic") && !effectiveUrl.includes("google") && !effectiveUrl.startsWith("local://") && effectiveKey.length > 0);
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
    } else {
      return {
        configured: false,
        category: "BYOK Models",
        badge: "Key needed",
        badgeType: "unconfigured",
        reason: "OpenAI API key needed",
        actionText: "Set OpenAI Key",
        actionType: "byok",
        setupTip: "OpenAI API key is missing. Add your API key in Settings > Direct LLM (BYOK)."
      };
    }
  }

  // 4. Anthropic Models (BYOK)
  if (provider === "anthropic" || curKey.startsWith("claude-") || curKey.startsWith("anthropic")) {
    const hasClaudeKey = effectiveKey.startsWith("sk-ant-") || (effectiveUrl.includes("anthropic.com") && effectiveKey.length > 0);
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
    } else {
      return {
        configured: false,
        category: "BYOK Models",
        badge: "Key needed",
        badgeType: "unconfigured",
        reason: "Anthropic API key needed",
        actionText: "Set Anthropic Key",
        actionType: "byok",
        setupTip: "Anthropic API key is missing. Add your API key in Settings > Direct LLM (BYOK)."
      };
    }
  }

  // 5. Gemini Models as BYOK (using Google API key or custom endpoint)
  if (provider === "gemini" || curKey.startsWith("gemini")) {
    const hasGoogleKey = (effectiveKey.startsWith("AIza") || effectiveKey.startsWith("AI-")) || (effectiveUrl.includes("googleapis.com") && effectiveKey.length > 0);
    if (hasGoogleKey) {
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
        reason: "Gemini API key needed",
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
    "shuffle-ai",
    "gpt-4o",
    "claude-3-7-sonnet"
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (isModelActiveAndValidated(candidates[i])) {
      return candidates[i];
    }
  }
  return preferredModel || activeAiModel || "shuffle-ai";
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

function extractModelFromTurn(turn) {
  if (!turn || typeof turn !== "object") return "";
  if (typeof turn.model === "string") {
    const tm = turn.model.trim();
    if (tm && tm !== "local_shell") {
      return tm === "shuffle" ? "shuffle-ai" : tm;
    }
  }
  const dbg = turn.debug_info || turn.debugInfo;
  if (dbg && typeof dbg === "object") {
    if (typeof dbg.ui_model === "string") {
      const um = dbg.ui_model.trim();
      if (um && um !== "local_shell") {
        return um === "shuffle" ? "shuffle-ai" : um;
      }
    }
    if (typeof dbg.turn_model === "string") {
      const trm = dbg.turn_model.trim();
      if (trm && trm !== "local_shell") {
        return trm === "shuffle" ? "shuffle-ai" : trm;
      }
    }
    if (dbg.is_shuffle === true) {
      return "shuffle-ai";
    }
    const target = typeof dbg.target === "string" ? dbg.target.toLowerCase() : "";
    if (target.includes("shuffler.io")) {
      return "shuffle-ai";
    }
    if (typeof dbg.model === "string") {
      const dm = dbg.model.trim();
      if (dm && dm !== "local_shell") {
        if (dm === "shuffle" || dm === "shuffle-ai") return "shuffle-ai";
        if ((dm === "gemini-3.8-flash" || dm === "gemini-3.8-pro") && dbg.is_auth === true) {
          return "shuffle-ai";
        }
        return dm;
      }
    }
  }
  return "";
}

function getSettingsTabForModel(modelKey, info) {
  let resolved = typeof modelKey === "string" ? modelKey.trim() : "";
  if (resolved === "local_shell") resolved = "";
  if ((!resolved || resolved === "gemini-3.8-flash" || resolved === "gemini-3.8-pro") && info && typeof info === "object") {
    const extracted = extractModelFromTurn({
      model: info.ui_model || info.turn_model || resolved,
      debug_info: info.debug_info || info
    });
    if (extracted) resolved = extracted;
  }
  if (!resolved) {
    resolved = (typeof window !== "undefined" && window.activeAiModel) ||
      activeAiModel ||
      (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) ||
      "";
  }
  const low = String(resolved || "").trim().toLowerCase();
  if (low === "shuffle-ai" || low === "shuffle" || low === "default") {
    return "mode-shuffle";
  }
  if (info && typeof info === "object") {
    const dbg = info.debug_info || info;
    const um = String(info.ui_model || dbg.ui_model || info.turn_model || dbg.turn_model || "").trim().toLowerCase();
    if (um === "shuffle-ai" || um === "shuffle") {
      return "mode-shuffle";
    }
    if (info.is_shuffle === true || dbg.is_shuffle === true) {
      return "mode-shuffle";
    }
    const target = String(info.target || dbg.target || "").toLowerCase();
    if (target.includes("shuffler.io")) {
      return "mode-shuffle";
    }
    if ((low === "gemini-3.8-flash" || low === "gemini-3.8-pro") && (info.is_auth === true || dbg.is_auth === true)) {
      return "mode-shuffle";
    }
  }
  if (
    low === "tendon-local" ||
    low.startsWith("tendon") ||
    low.startsWith("local") ||
    low.includes("gemma") ||
    low.endsWith(".gguf")
  ) {
    return "mode-local";
  }
  if (resolved && typeof getModelConfigStatus === "function") {
    const status = getModelConfigStatus(resolved);
    if (status) {
      if (status.actionType === "auth" || status.category === "Shuffle AI") {
        return "mode-shuffle";
      }
      if (
        status.category === "Local Models" ||
        status.actionType === "download_model" ||
        status.actionType === "storage_settings" ||
        status.actionType === "hardware" ||
        status.actionType === "hardware_limit"
      ) {
        return "mode-local";
      }
    }
  }
  if (!low && ((typeof window !== "undefined" && window.activeExecutionMode === "shuffle") || activeExecutionMode === "shuffle")) {
    return "mode-shuffle";
  }
  return "mode-direct";
}

function getLastMessageModelFromConv(conv) {
  if (!conv || typeof conv !== "object") return "";
  if (Array.isArray(conv.turns)) {
    for (let i = conv.turns.length - 1; i >= 0; i--) {
      const m = extractModelFromTurn(conv.turns[i]);
      if (m) return m;
    }
  }
  const fallback = (typeof conv.model === "string" && conv.model.trim()) ||
    (typeof conv.ai_model === "string" && conv.ai_model.trim()) || "";
  if (fallback === "local_shell") return "";
  return fallback === "shuffle" ? "shuffle-ai" : fallback;
}

function getLastMessageModelFromAnyConv(convs, preferredConvId) {
  if (!Array.isArray(convs) || convs.length === 0) return "";
  if (preferredConvId) {
    const pref = convs.find(c => c && c.id === preferredConvId);
    if (pref) {
      const m = getLastMessageModelFromConv(pref);
      if (m) return m;
    }
  }
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i];
    if (!c || !Array.isArray(c.turns) || c.turns.length === 0) continue;
    const m = getLastMessageModelFromConv(c);
    if (m) return m;
  }
  for (let i = 0; i < convs.length; i++) {
    const m = getLastMessageModelFromConv(convs[i]);
    if (m) return m;
  }
  return "";
}

function applyModelSelectionFromHistory(model, projectPath) {
  if (!model || typeof model !== "string") return;
  const clean = model.trim() === "shuffle" ? "shuffle-ai" : model.trim();
  if (!clean || clean === "local_shell") return;
  activeAiModel = clean;
  if (typeof window !== "undefined") {
    window.activeAiModel = clean;
  }
  try {
    localStorage.setItem("orborus_ai_model", clean);
    localStorage.setItem("orborus_last_model", clean);
  } catch (e) {}
  if (typeof saveRememberedModelForType === "function") {
    saveRememberedModelForType(projectPath !== undefined ? projectPath : activeProjectPath, clean);
  }
  if (clean === "shuffle-ai") {
    activeExecutionMode = "shuffle";
    if (typeof window !== "undefined") window.activeExecutionMode = "shuffle";
    try {
      localStorage.setItem("orborus_active_execution_mode", "shuffle");
    } catch (e) {}
  }
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
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
  window.extractModelFromTurn = extractModelFromTurn;
  window.getSettingsTabForModel = getSettingsTabForModel;
  window.getLastMessageModelFromConv = getLastMessageModelFromConv;
  window.getLastMessageModelFromAnyConv = getLastMessageModelFromAnyConv;
  window.applyModelSelectionFromHistory = applyModelSelectionFromHistory;
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
  const userStoredModel = localStorage.getItem("orborus_ai_model");
  const preferred = (typeof window !== "undefined" && window.activeAiModel) || userStoredModel || rememberedModel || "tendon-local";
  activeAiModel = preferred;
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

  const storedModelsDir = localStorage.getItem("orborus_local_models_dir");
  if (storedModelsDir) {
    window.localModelsDir = storedModelsDir;
  }
  const storedModelPath = localStorage.getItem("orborus_local_model_path");
  if (storedModelPath) {
    window.localModelPath = storedModelPath;
  }

  // 2. Synchronously restore cached projects and conversations
  loadStoredProjects();

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

  // Sync in-memory conv pinned state and infer each conversation's last message model
  appConversations.forEach(c => {
    c.pinned = pinnedConversationIds.has(c.id);
    const inferredModel = getLastMessageModelFromConv(c);
    if (inferredModel) {
      c.model = inferredModel;
    }
  });

  const savedActiveConvId = localStorage.getItem("orborus_active_conv_id");
  const lastMsgModel = getLastMessageModelFromAnyConv(appConversations, savedActiveConvId);
  if (lastMsgModel) {
    applyModelSelectionFromHistory(lastMsgModel, activeProjectPath);
  }

  // Scan appConversations and activeProjectPath to merge any known project paths into allProjects
  const initialProjectsToMerge = [];
  if (activeProjectPath && activeProjectPath !== ".") {
    const pName = activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project";
    initialProjectsToMerge.push({ Name: pName, Path: activeProjectPath });
  }
  if (Array.isArray(appConversations)) {
    appConversations.forEach(c => {
      if (!c) return;
      const pPath = c.projectId || c.project_id;
      if (pPath && pPath !== ".") {
        const pName = c.projectName || c.project_name || pPath.split(/[/\\]/).filter(Boolean).pop() || "Project";
        initialProjectsToMerge.push({ Name: pName, Path: pPath });
      }
    });
  }
  if (initialProjectsToMerge.length > 0) {
    mergeProjects(initialProjectsToMerge);
  }

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
    const savedOAuth = typeof localStorage !== "undefined" && localStorage.getItem("orborus_oauth_logged_in") === "true";
    window.oauthLoggedIn = savedOAuth;
    updateAuthState({
      is_logged_in: savedOAuth,
      oauth_logged_in: savedOAuth,
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
  if (!window.getInitialState && typeof callGo !== "function") return;

  try {
    const raw = window.getInitialState ? await window.getInitialState() : await callGo("getInitialState", "{}");
    if (!raw) return;
    const state = typeof raw === "string" ? JSON.parse(raw) : raw;

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

    // Merge backend projects into allProjects non-destructively
    if (Array.isArray(state.projects) && state.projects.length > 0) {
      mergeProjects(state.projects);
      if (typeof renderProjectTree === "function") {
        renderProjectTree();
      }
    }

    // Backend vs Frontend Credential Validation:
    const isBackendLoggedOut = state.oauth_logged_in === false || state.is_logged_in === false;
    if (isBackendLoggedOut) {
      window.oauthLoggedIn = false;
      isLoggedIn = false;
      localStorage.removeItem("orborus_oauth_logged_in");
    }
    if (state.ai_api_key && (!isBackendLoggedOut || !state.ai_api_key.startsWith("shfl_"))) {
      currentAiKey = state.ai_api_key;
      localStorage.setItem("orborus_ai_key", state.ai_api_key);
    } else if (isBackendLoggedOut) {
      const storedKey = localStorage.getItem("orborus_ai_key") || currentAiKey || "";
      if (storedKey.startsWith("shfl_")) {
        currentAiKey = "";
        localStorage.removeItem("orborus_ai_key");
      }
    }
    if (state.ai_api_url && (!isBackendLoggedOut || (!state.ai_api_url.includes("shuffler.io") && !state.ai_api_url.includes("shuffle")))) {
      currentAiUrl = state.ai_api_url;
      localStorage.setItem("orborus_ai_url", state.ai_api_url);
    } else if (isBackendLoggedOut) {
      const storedUrl = localStorage.getItem("orborus_ai_url") || currentAiUrl || "";
      if (storedUrl.includes("shuffler.io") || storedUrl.includes("shuffle")) {
        currentAiUrl = "";
        localStorage.removeItem("orborus_ai_url");
      }
    }

    // Sync OAuth state before resolving active model
    updateAuthState(state);

    // Respect the model used by the last message first, then backend/stored model choice
    const candidateModel = getLastMessageModelFromAnyConv(appConversations, activeConversationId)
      || state.ai_model
      || activeAiModel
      || getRememberedModelForType(activeProjectPath)
      || localStorage.getItem("orborus_ai_model");
    if (candidateModel) {
      applyModelSelectionFromHistory(candidateModel, activeProjectPath);
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
      currentApprovalRules = typeof normalizeApprovalRule === "function"
        ? state.approval_rules.map(normalizeApprovalRule).filter(Boolean)
        : state.approval_rules;
      updateApprovalRulesCount();
    }

    if (Array.isArray(state.approval_queue)) {
      if (typeof normalizeApprovalRequestItem === "function") {
        globalApprovalQueue = state.approval_queue.map(normalizeApprovalRequestItem).filter(Boolean);
      } else {
        globalApprovalQueue = state.approval_queue;
      }
    } else if (state.pending_approval && typeof state.pending_approval === "object") {
      const single = typeof normalizeApprovalRequestItem === "function"
        ? normalizeApprovalRequestItem(state.pending_approval)
        : state.pending_approval;
      if (single) globalApprovalQueue = [single];
    }
    if (typeof syncGlobalApprovalQueueUI === "function") {
      syncGlobalApprovalQueueUI();
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

    if (state.system_ram_total_mb) {
      window.systemRamTotalMB = state.system_ram_total_mb;
    }
    if (state.system_ram_free_mb) {
      window.systemRamFreeMB = state.system_ram_free_mb;
    }

    if (state.local_models_dir) {
      window.localModelsDir = state.local_models_dir;
      localStorage.setItem("orborus_local_models_dir", state.local_models_dir);
    }
    if (state.local_model_path) {
      window.localModelPath = state.local_model_path;
      localStorage.setItem("orborus_local_model_path", state.local_model_path);
    }
    if (typeof updateLocalModelCatalogState === "function") {
      updateLocalModelCatalogState(
        state.local_models_catalog,
        state.local_disk_free_bytes,
        state.local_disk_free_gb,
        state.local_disk_free_display,
        state.local_download_state
      );
    }

    if (state.active_execution_mode) {
      const resolvedExecMode = activeAiModel === "shuffle-ai" ? "shuffle" : state.active_execution_mode;
      activeExecutionMode = resolvedExecMode;
      window.activeExecutionMode = resolvedExecMode;
      localStorage.setItem("orborus_active_execution_mode", resolvedExecMode);
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
          const dcModel = getLastMessageModelFromConv(dc);
          if (dcModel) {
            dc.model = dcModel;
          }
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
            const mergedModel = getLastMessageModelFromConv(local) || dcModel;
            if (mergedModel) {
              local.model = mergedModel;
            }
          }
        });

        const diskLastModel = getLastMessageModelFromAnyConv(appConversations, activeConversationId);
        if (diskLastModel) {
          applyModelSelectionFromHistory(diskLastModel, activeProjectPath);
        }

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
