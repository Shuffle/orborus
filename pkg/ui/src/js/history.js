// --- Conversation History Modal & Prompt Reuse ---
// ----------------- Conversation History -----------------
let currentHistoryItems = [];

function getCombinedHistory() {
  const items = [];
  const seen = new Set();

  // 1. Gather turns from active conversation first (most recent & directly relevant)
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c.id === activeConversationId);
    if (curConv) {
      const turns = curConv.turns || [];
      turns.forEach(t => {
        if (!t || !t.prompt) return;
        const key = (t.id || "") + ":" + t.prompt;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            id: t.id,
            convId: curConv.id,
            convTitle: curConv.title || "Current Conversation",
            isCurrentConv: true,
            isArchived: !!(curConv.archived || curConv.is_archived),
            prompt: t.prompt,
            output: t.output || t.error || (t.status === "running" ? "Running execution..." : ""),
            status: t.status || "success",
            timestamp: t.timestamp || curConv.created_at || "Active chat",
            duration: t.duration || ""
          });
        }
      });
      // Fallback for single-prompt legacy conversations
      if (turns.length === 0 && curConv.prompt) {
        items.push({
          convId: curConv.id,
          convTitle: curConv.title || "Current Conversation",
          isCurrentConv: true,
          isArchived: !!(curConv.archived || curConv.is_archived),
          prompt: curConv.prompt,
          output: curConv.output || "",
          status: "success",
          timestamp: curConv.created_at || "Active chat",
          duration: ""
        });
      }
    }
  }

  // 2. Gather turns from all other conversations in appConversations
  if (Array.isArray(appConversations)) {
    appConversations.forEach(conv => {
      if (!conv || conv.id === activeConversationId) return;
      const isArch = !!(conv.archived || conv.is_archived);
      const turns = conv.turns || [];
      turns.forEach(t => {
        if (!t || !t.prompt) return;
        const key = (t.id || "") + ":" + t.prompt;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            id: t.id,
            convId: conv.id,
            convTitle: conv.title || "Conversation",
            isCurrentConv: false,
            isArchived: isArch,
            prompt: t.prompt,
            output: t.output || t.error || "",
            status: t.status || "success",
            timestamp: t.timestamp || conv.created_at || "",
            duration: t.duration || ""
          });
        }
      });
      if (turns.length === 0 && conv.prompt) {
        const key = conv.id + ":" + conv.prompt;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            convId: conv.id,
            convTitle: conv.title || "Conversation",
            isCurrentConv: false,
            isArchived: isArch,
            prompt: conv.prompt,
            output: conv.output || "",
            status: "success",
            timestamp: conv.created_at || "",
            duration: ""
          });
        }
      }
    });
  }

  // 3. Gather standalone executionHistory entries (session & localStorage)
  const hist = (typeof window !== "undefined" && Array.isArray(window.executionHistory))
    ? window.executionHistory
    : (Array.isArray(executionHistory) ? executionHistory : []);

  hist.forEach(h => {
    if (!h || !h.prompt) return;
    const key = (h.prompt || "") + ":" + (h.timestamp || "");
    if (!seen.has(key)) {
      seen.add(key);
      items.push(h);
    }
  });

  return items;
}

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

  const allItems = getCombinedHistory();
  renderHistoryList(allItems);
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

function switchHistoryConversation(convId) {
  closeHistoryModal();
  if (typeof selectConversation === "function" && convId) {
    selectConversation(convId);
  }
}

function renderHistoryList(items) {
  currentHistoryItems = items || [];
  const list = document.getElementById("history-modal-list");
  const desc = document.getElementById("history-modal-desc");
  if (!list) return;
  list.innerHTML = "";

  if (!items || items.length === 0) {
    list.innerHTML = `
      <div style="text-align:center; padding:32px 16px; color:var(--text-muted); font-size:13px;">
        No conversations recorded yet. Send a prompt to start chatting!
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

    const title = item.convTitle || item.conversation_title || "";
    const convId = item.convId || item.conversation_id || "";
    const isArchived = !!item.isArchived;
    const convBadge = title ? `<span class="history-conv-badge" style="font-size:11px; color:var(--text-secondary); background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; margin-left:6px;">${escapeHtml(title)}</span>` : "";
    const archivedBadge = isArchived ? `<span class="history-conv-badge" style="font-size:11px; color:var(--text-muted); background:rgba(255,255,255,0.04); padding:2px 6px; border-radius:4px; margin-left:4px; border:1px solid rgba(255,255,255,0.08);">Archived</span>` : "";
    const openChatBtn = convId ? `<button class="btn-history-action" onclick="switchHistoryConversation('${convId}')">Open Chat</button>` : "";
    const archiveToggleBtn = convId ? (isArchived
      ? `<button class="btn-history-action" onclick="unarchiveFromHistory('${convId}', event)">Restore to Sidebar</button>`
      : `<button class="btn-history-action" onclick="archiveFromHistory('${convId}', event)">Archive</button>`
    ) : "";

    card.innerHTML = `
      <div class="history-entry-header">
        <div style="display:flex; align-items:center;">
          <span class="history-badge ${statusClass}">${escapeHtml(statusText)}</span>
          ${convBadge}
          ${archivedBadge}
        </div>
        <span>${escapeHtml(item.timestamp || "")} ${item.duration ? "(" + escapeHtml(item.duration) + ")" : ""}</span>
      </div>
      <div class="history-prompt-text">$ ${escapeHtml(item.prompt)}</div>
      <div class="history-output-preview">${escapeHtml(item.output || item.error || "No output")}</div>
      <div class="history-actions">
        ${openChatBtn}
        ${archiveToggleBtn}
        <button class="btn-history-action" onclick="useHistoryPrompt(${index})">Use Prompt</button>
        <button class="btn-history-action btn-run-again" onclick="runHistoryPrompt(${index})">Run Again</button>
      </div>
    `;
    list.appendChild(card);
  });
}

async function archiveFromHistory(convId, event) {
  if (event) event.stopPropagation();
  const fn = typeof archiveConversation === "function" ? archiveConversation : window.archiveConversation;
  if (fn) {
    await fn(convId, event);
    const allItems = getCombinedHistory();
    renderHistoryList(allItems);
  }
}

async function unarchiveFromHistory(convId, event) {
  if (event) event.stopPropagation();
  const fn = typeof unarchiveConversation === "function" ? unarchiveConversation : window.unarchiveConversation;
  if (fn) {
    await fn(convId, event);
    const allItems = getCombinedHistory();
    renderHistoryList(allItems);
  }
}

function filterHistory(query) {
  const allItems = getCombinedHistory();
  const q = (query || "").toLowerCase().trim();
  if (!q) {
    renderHistoryList(allItems);
    return;
  }
  const filtered = allItems.filter(item => {
    const title = (item.convTitle || item.conversation_title || "").toLowerCase();
    return (item.prompt || "").toLowerCase().includes(q) ||
           (item.output || "").toLowerCase().includes(q) ||
           title.includes(q);
  });
  renderHistoryList(filtered);
}

function useHistoryPrompt(index) {
  const item = currentHistoryItems[index];
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
  const item = currentHistoryItems[index];
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
  try {
    localStorage.removeItem("orborus_execution_history");
  } catch (e) {}

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
