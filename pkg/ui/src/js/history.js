// --- Conversation History Modal & Prompt Reuse ---
// ----------------- Conversation History -----------------
function toggleHistoryModal() {
  const modal = document.getElementById("history-modal");
  if (!modal) return;
  if (modal.classList.contains("visible")) {
    closeHistoryModal();
  } else {
    openHistoryModal();
  }
}

function openHistoryModal() {
  const modal = document.getElementById("history-modal");
  if (!modal) return;
  modal.classList.add("visible");
  if (typeof checkModalActive === "function") checkModalActive();
  if (typeof window !== "undefined" && Array.isArray(window.executionHistory)) {
    executionHistory = window.executionHistory;
  } else if (!Array.isArray(executionHistory)) {
    executionHistory = [];
  }
  renderHistoryList(executionHistory);
  const searchInput = document.getElementById("history-search-input");
  if (searchInput) {
    searchInput.value = "";
    searchInput.focus();
  }
}

function closeHistoryModal() {
  const modal = document.getElementById("history-modal");
  if (modal) modal.classList.remove("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

function renderHistoryList(items) {
  const list = document.getElementById("history-modal-list");
  const desc = document.getElementById("history-modal-desc");
  if (!list) return;
  list.innerHTML = "";

  if (!items || items.length === 0) {
    list.innerHTML = `
      <div style="text-align:center; padding:32px 16px; color:var(--text-muted); font-size:13px;">
        No conversations recorded in this session yet.
      </div>
    `;
    if (desc) desc.innerText = "0 recorded executions";
    return;
  }

  if (desc) desc.innerText = `${items.length} recorded execution${items.length === 1 ? "" : "s"}`;

  items.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "history-entry-card";
    const statusClass = item.status === "error" ? "error" : (item.status === "denied" ? "denied" : "success");
    const statusText = item.status || "success";

    card.innerHTML = `
      <div class="history-entry-header">
        <span class="history-badge ${statusClass}">${escapeHtml(statusText)}</span>
        <span>${escapeHtml(item.timestamp || "")} ${item.duration ? "(" + escapeHtml(item.duration) + ")" : ""}</span>
      </div>
      <div class="history-prompt-text">$ ${escapeHtml(item.prompt)}</div>
      <div class="history-output-preview">${escapeHtml(item.output || item.error || "No output")}</div>
      <div class="history-actions">
        <button class="btn-history-action" onclick="useHistoryPrompt(${index})">Use Prompt</button>
        <button class="btn-history-action btn-run-again" onclick="runHistoryPrompt(${index})">Run Again</button>
      </div>
    `;
    list.appendChild(card);
  });
}

function filterHistory(query) {
  if (typeof window !== "undefined" && Array.isArray(window.executionHistory)) {
    executionHistory = window.executionHistory;
  } else if (!Array.isArray(executionHistory)) {
    executionHistory = [];
  }
  const q = query.toLowerCase().trim();
  if (!q) {
    renderHistoryList(executionHistory);
    return;
  }
  const filtered = executionHistory.filter(item => {
    return (item.prompt || "").toLowerCase().includes(q) || (item.output || "").toLowerCase().includes(q);
  });
  renderHistoryList(filtered);
}

function useHistoryPrompt(index) {
  if (typeof window !== "undefined" && Array.isArray(window.executionHistory)) {
    executionHistory = window.executionHistory;
  } else if (!Array.isArray(executionHistory)) {
    executionHistory = [];
  }
  const item = executionHistory[index];
  if (!item) return;
  const textarea = document.getElementById("prompt-input");
  if (textarea) {
    textarea.value = item.prompt;
    handleInput(textarea);
    textarea.focus();
  }
  closeHistoryModal();
  showToast("Loaded prompt into editor");
}

function runHistoryPrompt(index) {
  if (typeof window !== "undefined" && Array.isArray(window.executionHistory)) {
    executionHistory = window.executionHistory;
  } else if (!Array.isArray(executionHistory)) {
    executionHistory = [];
  }
  const item = executionHistory[index];
  if (!item) return;
  closeHistoryModal();
  const textarea = document.getElementById("prompt-input");
  if (textarea) {
    textarea.value = item.prompt;
    handleInput(textarea);
  }
  submitPrompt();
}

async function clearAllHistory() {
  if (typeof window !== "undefined") {
    window.executionHistory = [];
    executionHistory = window.executionHistory;
  } else {
    executionHistory = [];
  }
  appConversations = [];
  pinnedConversationIds.clear();
  saveStoredConversations();
  renderProjectTree();
  startNewSession();
  renderHistoryList([]);
  const container = document.getElementById("execution-cards-container");
  if (container) container.innerHTML = "";
  if (window.clearHistory) {
    try {
      await window.clearHistory();
    } catch (e) {
      console.warn("clearHistory error:", e);
    }
  }
  showToast("Conversation history cleared");
}
