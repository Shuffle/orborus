// --- Conversation History Modal & Prompt Reuse ---
// ----------------- Conversation History -----------------
let currentHistoryItems = [];
let activeHistoryFilter = "all"; // "all" | "archived" | "active"

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
            projectName: curConv.projectName || curConv.project_name || "",
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
          projectName: curConv.projectName || curConv.project_name || "",
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
            projectName: conv.projectName || conv.project_name || "",
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
            projectName: conv.projectName || conv.project_name || "",
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

function getArchivedConversationsList(query) {
  if (!Array.isArray(appConversations)) return [];
  const q = (query || "").toLowerCase().trim();
  const archived = appConversations.filter(c => c && (c.archived || c.is_archived));
  const sorted = [...archived].sort((a, b) => {
    const bTime = b.updated_at || b.created_at || "";
    const aTime = a.updated_at || a.created_at || "";
    return bTime.localeCompare(aTime);
  });
  if (!q) return sorted;
  return sorted.filter(c => {
    const title = (c.title || "").toLowerCase();
    const proj = (c.projectName || c.project_name || "").toLowerCase();
    const promptMatch = (c.prompt || "").toLowerCase().includes(q) ||
      (Array.isArray(c.turns) && c.turns.some(t => (t && ((t.prompt || "").toLowerCase().includes(q) || (t.output || "").toLowerCase().includes(q)))));
    return title.includes(q) || proj.includes(q) || promptMatch;
  });
}

function updateHistoryFilterCounts(allItems) {
  const items = Array.isArray(allItems) ? allItems : getCombinedHistory();
  const archivedConvs = Array.isArray(appConversations)
    ? appConversations.filter(c => c && (c.archived || c.is_archived))
    : [];
  const activeItems = items.filter(it => !it.isArchived);

  const countAllEl = document.getElementById("history-count-all");
  const countArchEl = document.getElementById("history-count-archived");
  const countActEl = document.getElementById("history-count-active");

  if (countAllEl) countAllEl.innerText = String(items.length || archivedConvs.length);
  if (countArchEl) countArchEl.innerText = String(archivedConvs.length);
  if (countActEl) countActEl.innerText = String(activeItems.length);

  ["all", "archived", "active"].forEach(tab => {
    const btn = document.getElementById("history-tab-" + tab);
    if (btn) btn.classList.toggle("active", activeHistoryFilter === tab);
  });
}

function setHistoryFilter(filter) {
  activeHistoryFilter = (filter === "archived" || filter === "active") ? filter : "all";
  refreshHistoryModalView();
}

function refreshHistoryModalView() {
  const searchInput = document.getElementById("history-search-input");
  const query = searchInput ? searchInput.value : "";
  filterHistory(query);
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

function openHistoryModal(initialFilter) {
  const modal = document.getElementById("history-modal");
  if (!modal) return;
  if (initialFilter === "archived" || initialFilter === "active" || initialFilter === "all") {
    activeHistoryFilter = initialFilter;
  }
  modal.classList.add("visible");
  if (typeof checkModalActive === "function") checkModalActive();

  const searchInput = document.getElementById("history-search-input");
  if (searchInput) {
    searchInput.value = "";
  }
  refreshHistoryModalView();
  if (searchInput) {
    searchInput.focus();
  }
}

function openArchivedHistoryModal() {
  openHistoryModal("archived");
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

function createArchivedConvCardElement(conv) {
  const card = document.createElement("div");
  card.className = "history-entry-card history-archived-conv-card";
  const convId = conv.id || "";
  const title = conv.title || "Archived Conversation";
  const projName = conv.projectName || conv.project_name || (conv.projectId || conv.project_id ? (conv.projectId || conv.project_id).split(/[/\\]/).filter(Boolean).pop() : "No project");
  const turns = Array.isArray(conv.turns) ? conv.turns : [];
  const turnCount = turns.length || (conv.prompt ? 1 : 0);
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const previewPrompt = (lastTurn && lastTurn.prompt) || conv.prompt || "";
  const previewOutput = (lastTurn && (lastTurn.output || lastTurn.error)) || conv.output || "";
  const timestamp = (lastTurn && lastTurn.timestamp) || conv.updated_at || conv.created_at || "";

  card.innerHTML = `
    <div class="history-entry-header">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <span class="history-badge" style="background:rgba(255,255,255,0.06); color:var(--text-secondary);">Archived</span>
        <span style="font-size:12.5px; font-weight:600; color:var(--text-primary);">${escapeHtml(title)}</span>
        <span class="history-conv-badge" style="font-size:11px; color:var(--text-muted); background:rgba(255,255,255,0.04); padding:1px 6px; border-radius:4px;">${escapeHtml(projName)}</span>
        <span style="font-size:11px; color:var(--text-muted);">${turnCount} turn${turnCount === 1 ? "" : "s"}</span>
      </div>
      <span>${escapeHtml(timestamp)}</span>
    </div>
    ${previewPrompt ? `<div class="history-prompt-text">$ ${escapeHtml(previewPrompt)}</div>` : ""}
    ${previewOutput ? `<div class="history-output-preview">${escapeHtml(previewOutput)}</div>` : ""}
    <div class="history-actions">
      <button type="button" class="btn-history-action" title="Open in read-only mode to read conversation" onclick="switchHistoryConversation('${escapeJsAttr(convId)}')">Open Chat</button>
      <button type="button" class="btn-history-action btn-run-again" title="Unarchive and restore to left sidebar" onclick="unarchiveFromHistory('${escapeJsAttr(convId)}', event)">Unarchive</button>
      <button type="button" class="btn-history-action" title="Unarchive and open conversation immediately" onclick="unarchiveAndOpenConversation('${escapeJsAttr(convId)}', event)">Unarchive &amp; Open</button>
    </div>
  `;
  return card;
}

function renderHistoryList(items, query) {
  const allItems = getCombinedHistory();
  updateHistoryFilterCounts(allItems);

  const list = document.getElementById("history-modal-list");
  const desc = document.getElementById("history-modal-desc");
  if (!list) return;
  list.innerHTML = "";

  const q = (query || "").toLowerCase().trim();
  const archivedConvs = getArchivedConversationsList(q);

  // If filter is strictly "archived", show conversation-level archived list for fast restoration & reading
  if (activeHistoryFilter === "archived") {
    currentHistoryItems = (items || []).filter(it => it.isArchived);
    if (archivedConvs.length === 0) {
      list.innerHTML = `
        <div style="text-align:center; padding:32px 16px; color:var(--text-muted); font-size:13px;">
          ${q ? "No matching archived conversations." : "No archived conversations."}
        </div>
      `;
      if (desc) desc.innerText = "0 archived conversations";
      return;
    }
    if (desc) desc.innerText = `${archivedConvs.length} archived conversation${archivedConvs.length === 1 ? "" : "s"} — Open Chat to read (read-only) or Unarchive to restore to sidebar`;
    archivedConvs.forEach(conv => {
      list.appendChild(createArchivedConvCardElement(conv));
    });
    return;
  }

  let filteredItems = items || [];
  if (activeHistoryFilter === "active") {
    filteredItems = filteredItems.filter(it => !it.isArchived);
  }
  currentHistoryItems = filteredItems;

  // In "all" view, if there are archived conversations, show a clean Archived Conversations section at top so they are easy to restore
  if (activeHistoryFilter === "all" && archivedConvs.length > 0) {
    const archSection = document.createElement("div");
    archSection.className = "history-archived-section";
    const archHeader = document.createElement("div");
    archHeader.className = "history-section-label-row";
    archHeader.innerHTML = `
      <span>Archived Conversations (${archivedConvs.length})</span>
      <span style="font-size:11px; color:var(--text-muted); font-weight:400;">Open Chat reads in read-only mode · Unarchive restores to sidebar</span>
    `;
    archSection.appendChild(archHeader);
    archivedConvs.forEach(conv => {
      archSection.appendChild(createArchivedConvCardElement(conv));
    });
    list.appendChild(archSection);

    if (filteredItems.length > 0) {
      const promptHeader = document.createElement("div");
      promptHeader.className = "history-section-label-row";
      promptHeader.style.marginTop = "10px";
      promptHeader.innerHTML = `<span>Prompt Executions (${filteredItems.length})</span>`;
      list.appendChild(promptHeader);
    }
  }

  if (filteredItems.length === 0 && (activeHistoryFilter !== "all" || archivedConvs.length === 0)) {
    list.innerHTML = `
      <div style="text-align:center; padding:32px 16px; color:var(--text-muted); font-size:13px;">
        No conversations recorded yet. Send a prompt to start chatting!
      </div>
    `;
    if (desc) desc.innerText = "0 recorded executions";
    return;
  }

  if (desc) {
    if (activeHistoryFilter === "all" && archivedConvs.length > 0) {
      desc.innerText = `${filteredItems.length} execution${filteredItems.length === 1 ? "" : "s"} · ${archivedConvs.length} archived`;
    } else {
      desc.innerText = `${filteredItems.length} recorded execution${filteredItems.length === 1 ? "" : "s"}`;
    }
  }

  filteredItems.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "history-entry-card";
    const statusClass = item.status === "error" ? "error" : (item.status === "denied" ? "denied" : "success");
    const statusText = item.status || "success";

    const title = item.convTitle || item.conversation_title || "";
    const convId = item.convId || item.conversation_id || "";
    const isArchived = !!item.isArchived;
    const convBadge = title ? `<span class="history-conv-badge" style="font-size:11px; color:var(--text-secondary); background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; margin-left:6px;">${escapeHtml(title)}</span>` : "";
    const archivedBadge = isArchived ? `<span class="history-conv-badge" style="font-size:11px; color:var(--text-muted); background:rgba(255,255,255,0.04); padding:2px 6px; border-radius:4px; margin-left:4px; border:1px solid rgba(255,255,255,0.08);">Archived</span>` : "";
    const openChatBtn = convId ? `<button class="btn-history-action" title="${isArchived ? "Open in read-only mode" : "Open conversation"}" onclick="switchHistoryConversation('${escapeJsAttr(convId)}')">Open Chat</button>` : "";
    const archiveToggleBtn = convId ? (isArchived
      ? `<button class="btn-history-action btn-run-again" onclick="unarchiveFromHistory('${escapeJsAttr(convId)}', event)">Unarchive</button>`
      : `<button class="btn-history-action" onclick="archiveFromHistory('${escapeJsAttr(convId)}', event)">Archive</button>`
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
    refreshHistoryModalView();
  }
}

async function unarchiveFromHistory(convId, event) {
  if (event) event.stopPropagation();
  const fn = typeof unarchiveConversation === "function" ? unarchiveConversation : window.unarchiveConversation;
  if (fn) {
    await fn(convId, event);
    refreshHistoryModalView();
  }
}

function filterHistory(query) {
  const allItems = getCombinedHistory();
  const q = (query || "").toLowerCase().trim();
  if (!q) {
    renderHistoryList(allItems, "");
    return;
  }
  const filtered = allItems.filter(item => {
    const title = (item.convTitle || item.conversation_title || "").toLowerCase();
    return (item.prompt || "").toLowerCase().includes(q) ||
           (item.output || "").toLowerCase().includes(q) ||
           title.includes(q);
  });
  renderHistoryList(filtered, q);
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
