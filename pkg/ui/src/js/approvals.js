// --- Approvals Card, Radio Options & Permissions Management ---
var activePermissionsDetailCategory = "file";
var activePermissionsDetailScope = "global";
var activePermissionsDetailReturnTab = "general";
var activeAddingSubCategory = null;
var activeEditingRuleId = null;

function inferPermissionCategory(target) {
  const clean = String(target || "").trim();
  const lower = clean.toLowerCase();
  if (lower.startsWith("mcp_") || lower.startsWith("mcp:")) return "mcp";
  if (lower.startsWith("http://") || lower.startsWith("https://")) return "network";
  if (lower.startsWith("bypass:") || lower.startsWith("unsandboxed:")) return "sandbox_bypass";
  if (lower.startsWith("write:")) return "file_write";
  if (
    lower.startsWith("read:") ||
    clean.startsWith("/") ||
    clean.startsWith("~/") ||
    clean.startsWith("./") ||
    clean.startsWith("../") ||
    /^[a-zA-Z]:[\\/]/.test(clean)
  ) {
    return "file_read";
  }
  return "terminal";
}

function normalizeApprovalRule(r) {
  if (!r || typeof r !== "object") return null;
  const id = String(r.ID || r.id || ("rule-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)));
  const command = String(r.Command !== undefined ? r.Command : (r.command || "")).trim();
  if (!command) return null;
  const category = String(r.Category || r.category || inferPermissionCategory(command));
  const rawAction = String(r.Action || r.action || "allow").toLowerCase();
  const action = rawAction === "deny" ? "deny" : "allow";
  const scope = String(r.Scope || r.scope || "global").toLowerCase();
  const scopeId = String(r.ScopeID !== undefined ? r.ScopeID : (r.scope_id || ""));
  const createdAt = String(r.CreatedAt || r.created_at || new Date().toISOString());

  return {
    ID: id,
    id: id,
    Command: command,
    command: command,
    Category: category,
    category: category,
    Action: action,
    action: action,
    Scope: scope,
    scope: scope,
    ScopeID: scopeId,
    scope_id: scopeId,
    CreatedAt: createdAt,
    created_at: createdAt
  };
}

function saveLocalApprovalRulesBackup() {
  try {
    if (typeof localStorage !== "undefined" && Array.isArray(currentApprovalRules)) {
      localStorage.setItem("orborus_approval_rules", JSON.stringify(currentApprovalRules));
    }
  } catch (e) {}
}

function loadLocalApprovalRulesBackup() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("orborus_approval_rules");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map(normalizeApprovalRule).filter(Boolean);
        }
      }
    }
  } catch (e) {}
  return [];
}

function normalizeApprovalRequestItem(data) {
  if (!data || typeof data !== "object") return null;
  const id = String(data.id || data.ID || ("appr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)));
  const execId = String(data.exec_id || data.ExecID || "");
  const convId = String(data.conversation_id || data.ConversationID || activeConversationId || "");
  const action = String(data.action || data.Action || data.cmd || data.Command || "").trim();
  const cmdPrefix = String(
    data.command_prefix ||
    data.CommandPrefix ||
    data.prefix ||
    (action ? action.split(/\s+/).slice(0, 2).join(" ") : "action")
  ).trim();
  const category = String(data.category || data.Category || inferPermissionCategory(cmdPrefix || action));
  const rawKind = String(data.kind || data.Kind || (category.toLowerCase() === "question" ? "question" : "approval")).toLowerCase();
  const kind = rawKind === "question" ? "question" : "approval";
  const questions = Array.isArray(data.questions || data.Questions)
    ? (data.questions || data.Questions).map(q => String(q || "").trim()).filter(Boolean)
    : [];
  const options = Array.isArray(data.options || data.Options)
    ? (data.options || data.Options).map(o => String(o || "").trim()).filter(Boolean)
    : [];
  const source = String(data.source || data.Source || (kind === "question" ? "agent" : "terminal"));
  const description = String(data.description || data.Description || data.desc || (kind === "question" ? "Agent Question" : "Allow action?"));
  const warning = String(data.warning || data.Warning || "");
  const timestamp = String(data.timestamp || data.Timestamp || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const project = String(data.project || data.Project || activeProjectPath || ".");

  return {
    id: id,
    ID: id,
    exec_id: execId,
    conversation_id: convId,
    action: action,
    command_prefix: cmdPrefix,
    category: category,
    kind: kind,
    questions: questions,
    options: options,
    source: source,
    description: description,
    warning: warning,
    timestamp: timestamp,
    project: project
  };
}

function loadApprovalDecisionHistoryBackup() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("orborus_approval_decision_history");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter(item => item && typeof item === "object");
        }
      }
    }
  } catch (e) {}
  return [];
}

function saveApprovalDecisionHistoryBackup() {
  try {
    if (typeof localStorage !== "undefined" && Array.isArray(approvalDecisionHistory)) {
      localStorage.setItem("orborus_approval_decision_history", JSON.stringify(approvalDecisionHistory));
    }
  } catch (e) {}
}

function ensureApprovalDecisionHistoryLoaded() {
  if (!Array.isArray(approvalDecisionHistory) || approvalDecisionHistory.length === 0) {
    const stored = loadApprovalDecisionHistoryBackup();
    if (stored.length > 0) {
      approvalDecisionHistory = stored;
    } else if (!Array.isArray(approvalDecisionHistory)) {
      approvalDecisionHistory = [];
    }
  }
  return approvalDecisionHistory;
}

function recordApprovalDecisionHistory(entry) {
  if (!entry) return;
  ensureApprovalDecisionHistoryLoaded();
  const cleanAction = String(entry.action || "").trim();
  const cleanPrefix = String(entry.command_prefix || "").trim();
  const optNum = Number(entry.option) >= 1 && Number(entry.option) <= 5 ? Number(entry.option) : 1;
  approvalDecisionHistory.unshift({
    id: entry.id || ("hist-" + Date.now()),
    action: cleanAction,
    command_prefix: cleanPrefix,
    kind: entry.kind === "question" ? "question" : "approval",
    option: optNum,
    skipped: Boolean(entry.skipped),
    decision: entry.decision || "approved",
    answer: String(entry.answer || "").trim(),
    scope: entry.scope || "",
    project: entry.project || activeProjectPath || ".",
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  });
  if (approvalDecisionHistory.length > 60) {
    approvalDecisionHistory = approvalDecisionHistory.slice(0, 60);
  }
  saveApprovalDecisionHistoryBackup();
}

function findPreviousApprovalChoice(action, commandPrefix, kind) {
  const history = ensureApprovalDecisionHistoryLoaded();
  if (!Array.isArray(history) || history.length === 0) return null;
  const targetKind = kind === "question" ? "question" : "approval";
  const normAction = String(action || "").trim();
  const normPrefix = String(commandPrefix || "").trim();

  if (normAction) {
    const exactMatch = history.find(h => {
      const hKind = h.kind === "question" ? "question" : "approval";
      return hKind === targetKind && String(h.action || "").trim() === normAction;
    });
    if (exactMatch) {
      return Object.assign({}, exactMatch, { match_type: "exact" });
    }
  }

  if (targetKind === "approval" && normPrefix && normPrefix !== "action" && normPrefix !== "this action") {
    const prefixMatch = history.find(h => {
      const hKind = h.kind === "question" ? "question" : "approval";
      return hKind === "approval" && String(h.command_prefix || "").trim() === normPrefix;
    });
    if (prefixMatch) {
      return Object.assign({}, prefixMatch, { match_type: "prefix" });
    }
  }

  return null;
}

window.onApprovalRequest = function(req) {
  try {
    const data = typeof req === "string" ? JSON.parse(req) : req;
    if (data && data.sync_queue && Array.isArray(data.pending_approvals)) {
      globalApprovalQueue = data.pending_approvals.map(normalizeApprovalRequestItem).filter(Boolean);
      syncGlobalApprovalQueueUI();
      return;
    }
    const item = normalizeApprovalRequestItem(data);
    if (!item) return;

    if (!Array.isArray(globalApprovalQueue)) globalApprovalQueue = [];
    const existingIdx = globalApprovalQueue.findIndex(q => q.id === item.id);
    if (existingIdx >= 0) {
      globalApprovalQueue[existingIdx] = item;
    } else {
      globalApprovalQueue.push(item);
    }

    syncGlobalApprovalQueueUI();
  } catch (err) {
    console.error("onApprovalRequest parse error:", err);
  }
};

function formatPolicyShortLabel(policy) {
  const p = String(policy || currentPermissionPolicy || "safe_auto").toLowerCase();
  if (p === "ask_all" || p === "prompt") return "Ask All";
  if (p === "full_auto") return "Full Auto";
  return "Safe Auto";
}

function getEffectiveProjectPermissions(projPath) {
  const target = projPath || (typeof activeProjectPath !== "undefined" ? activeProjectPath : ".");
  let p = (typeof currentProjectPermissions !== "undefined" && currentProjectPermissions && currentProjectPermissions[target])
    ? currentProjectPermissions[target]
    : null;
  if (!p && typeof currentProjectPermissions !== "undefined" && currentProjectPermissions) {
    const normTarget = typeof normPath === "function" ? normPath(target) : String(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    for (const k of Object.keys(currentProjectPermissions)) {
      const nk = typeof normPath === "function" ? normPath(k) : String(k).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (nk === normTarget) {
        p = currentProjectPermissions[k];
        break;
      }
    }
  }
  return {
    permissionPolicy: (p && (p.permission_policy || p.permissionPolicy)) || currentPermissionPolicy || "safe_auto",
    sandboxMode: (p && p.sandbox_mode !== undefined) ? !!p.sandbox_mode : (typeof currentSandboxMode !== "undefined" ? !!currentSandboxMode : false)
  };
}

function syncGlobalApprovalQueueUI() {
  if (!Array.isArray(globalApprovalQueue)) globalApprovalQueue = [];
  const pendingCount = globalApprovalQueue.length;

  const wrapperEl = document.getElementById("approval-queue-wrapper");
  const popEl = document.getElementById("approval-queue-popover");
  const rowEl = document.getElementById("approval-queue-row");
  const dotEl = document.getElementById("approval-queue-dot");
  const labelEl = document.getElementById("approval-queue-status-label");
  const badgeEl = document.getElementById("approval-queue-count-badge");
  const inlineActionsEl = document.getElementById("approval-queue-inline-actions");

  const effPerms = getEffectiveProjectPermissions(activeProjectPath);
  const effectivePolicy = effPerms.permissionPolicy || currentPermissionPolicy || "safe_auto";
  const effectiveSandbox = !!effPerms.sandboxMode;

  if (wrapperEl) {
    wrapperEl.style.display = pendingCount > 0 ? "block" : "none";
  }

  if (pendingCount === 0 && popEl) {
    popEl.classList.remove("open");
  }

  if (rowEl) {
    rowEl.style.display = pendingCount > 0 ? "flex" : "none";
    if (pendingCount > 0) {
      rowEl.classList.add("has-pending");
    } else {
      rowEl.classList.remove("has-pending");
    }
  }

  if (dotEl) {
    dotEl.className = "status-dot " + (pendingCount > 0 ? "pending-approval" : (effectivePolicy === "full_auto" ? "standalone" : "connected"));
  }

  if (labelEl) {
    if (pendingCount > 0) {
      const firstItem = globalApprovalQueue[0];
      const isQ = firstItem && (firstItem.kind === "question" || firstItem.category === "question");
      const shortPrefix = firstItem.command_prefix || firstItem.action || (isQ ? "Question" : "Action");
      const displayPrefix = shortPrefix.length > 16 ? shortPrefix.slice(0, 15) + "…" : shortPrefix;
      labelEl.innerText = pendingCount === 1
        ? (isQ ? `Question: ${displayPrefix}` : `Approve: ${displayPrefix}`)
        : `Pending (${pendingCount})`;
    } else {
      const modeText = formatPolicyShortLabel(effectivePolicy);
      const rulesCount = Array.isArray(currentApprovalRules) ? currentApprovalRules.length : 0;
      labelEl.innerText = rulesCount > 0
        ? `Approvals: ${modeText} (${rulesCount})`
        : `Approvals: ${modeText}`;
    }
  }

  if (inlineActionsEl) {
    inlineActionsEl.style.display = pendingCount > 0 ? "inline-flex" : "none";
  }

  if (badgeEl) {
    badgeEl.innerText = String(pendingCount);
    badgeEl.style.display = pendingCount > 1 ? "inline-flex" : "none";
  }

  // Sync quick mode buttons inside popover
  ["ask_all", "safe_auto", "full_auto"].forEach(mode => {
    const btn = document.getElementById("aq-mode-" + mode);
    if (btn) {
      if (effectivePolicy === mode) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    }
  });
  const sbBtn = document.getElementById("aq-sandbox-toggle");
  if (sbBtn) {
    if (effectiveSandbox) {
      sbBtn.classList.add("active");
    } else {
      sbBtn.classList.remove("active");
    }
  }

  // Sync main chat approval card with head of queue
  if (pendingCount > 0) {
    showApprovalCard(globalApprovalQueue[0]);
  } else {
    const card = document.getElementById("approval-card");
    if (card) {
      card.classList.remove("visible");
      card.classList.remove("question-mode");
    }
    const dock = document.getElementById("chat-dock-container");
    if (dock) dock.classList.remove("has-approval-card");
    currentApprovalId = null;
  }

  renderGlobalApprovalQueuePopover();
  if (typeof renderProjectTree === "function") {
    renderProjectTree();
  }
}

function renderGlobalApprovalQueuePopover() {
  if (!Array.isArray(globalApprovalQueue)) globalApprovalQueue = [];
  if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
  ensureApprovalDecisionHistoryLoaded();

  const pendingCount = globalApprovalQueue.length;
  const rulesCount = currentApprovalRules.length;
  const historyCount = approvalDecisionHistory.length;

  const popCountEl = document.getElementById("approval-popover-count");
  if (popCountEl) popCountEl.innerText = String(pendingCount);

  const tabPendingCount = document.getElementById("aq-tab-pending-count");
  if (tabPendingCount) tabPendingCount.innerText = String(pendingCount);

  const tabRulesCount = document.getElementById("aq-tab-rules-count");
  if (tabRulesCount) tabRulesCount.innerText = String(rulesCount);

  const tabHistoryCount = document.getElementById("aq-tab-history-count");
  if (tabHistoryCount) tabHistoryCount.innerText = String(historyCount);

  const btnApproveAll = document.getElementById("btn-approval-queue-approve-all");
  const btnDenyAll = document.getElementById("btn-approval-queue-deny-all");
  if (btnApproveAll) btnApproveAll.style.display = pendingCount > 0 ? "inline-flex" : "none";
  if (btnDenyAll) btnDenyAll.style.display = pendingCount > 0 ? "inline-flex" : "none";

  // 1. Render Pending List
  const pendingListEl = document.getElementById("approval-queue-list");
  if (pendingListEl) {
    if (pendingCount === 0) {
      pendingListEl.innerHTML = `<div class="approval-queue-empty">No actions waiting for approval.</div>`;
    } else {
      pendingListEl.innerHTML = globalApprovalQueue.map(item => {
        const safeId = escapeJsAttr(item.id);
        const isQ = item.kind === "question" || item.category === "question";
        const projBase = item.project && item.project !== "."
          ? item.project.split(/[/\\]/).filter(Boolean).pop() || item.project
          : "Workspace";
        const catLabel = escapeHtml(item.category || (isQ ? "question" : "terminal"));
        const desc = escapeHtml(item.description || (isQ ? "Agent Question" : "Allow action?"));
        const cmd = escapeHtml(item.action || item.command_prefix || "");
        const warn = item.warning ? `<div class="approval-queue-item-warning">${escapeHtml(item.warning)}</div>` : "";
        let actionsHtml = "";
        if (isQ) {
          const qTextRaw = (Array.isArray(item.questions) && item.questions.length > 0)
            ? item.questions.join("\n")
            : (item.action || item.command_prefix || "");
          const quickOpts = deriveContextualQuestionOptions(item, qTextRaw).slice(0, 3);
          const quickBtns = quickOpts.map(opt => {
            const safeOptAttr = escapeJsAttr(opt);
            return `<button class="aq-action-btn" onclick="resolveQueueApprovalItem('${safeId}', 1, event, '${safeOptAttr}')">${escapeHtml(opt)}</button>`;
          }).join("");
          actionsHtml = `<div class="approval-queue-item-actions">
               ${quickBtns}
               <button class="aq-action-btn primary" onclick="focusQuestionCardFromQueue('${safeId}', event)">Custom...</button>
             </div>`;
        } else {
          actionsHtml = `<div class="approval-queue-item-actions">
               <button class="aq-action-btn primary" onclick="resolveQueueApprovalItem('${safeId}', 1, event)">Approve Once</button>
               <button class="aq-action-btn" onclick="resolveQueueApprovalItem('${safeId}', 2, event)" title="Always allow in this conversation">Always (Chat)</button>
               <button class="aq-action-btn" onclick="resolveQueueApprovalItem('${safeId}', 3, event)" title="Always allow in this project">Always (Project)</button>
               <button class="aq-action-btn" onclick="resolveQueueApprovalItem('${safeId}', 4, event)" title="Always allow globally">Always (Global)</button>
               <button class="aq-action-btn" onclick="resolveQueueApprovalItem('${safeId}', 5, event)">Deny</button>
             </div>`;
        }
        return `
          <div class="approval-queue-item" data-approval-id="${escapeHtml(item.id)}">
            <div class="approval-queue-item-top">
              <span class="approval-queue-item-title">${desc}</span>
              <div class="approval-queue-item-meta">
                <span class="approval-queue-pill">${catLabel}</span>
                <span>${escapeHtml(projBase)}</span>
              </div>
            </div>
            <div class="approval-queue-item-cmd">${cmd}</div>
            ${warn}
            ${actionsHtml}
          </div>
        `;
      }).join("");
    }
  }

  // 2. Render Remembered Rules List
  const rulesListEl = document.getElementById("approval-queue-rules-list");
  if (rulesListEl) {
    if (rulesCount === 0) {
      rulesListEl.innerHTML = `<div class="approval-queue-empty">No saved approval rules yet. Add a rule above or choose "Always" when approving.</div>`;
    } else {
      rulesListEl.innerHTML = currentApprovalRules.map(rule => {
        const r = normalizeApprovalRule(rule) || rule;
        const safeRuleId = escapeJsAttr(r.id || r.ID);
        const actLabel = (r.action || r.Action) === "deny" ? "block" : "allow";
        const scopeLabel = r.scope || r.Scope || "global";
        return `
          <div class="approval-queue-item">
            <div class="approval-queue-item-top">
              <span class="approval-queue-item-cmd">${escapeHtml(r.command || r.Command)}</span>
              <div class="approval-queue-item-meta">
                <span class="approval-queue-pill">${escapeHtml(actLabel)}</span>
                <span class="approval-queue-pill">${escapeHtml(scopeLabel)}</span>
                <button class="aq-action-btn" onclick="revokeRuleFromQueue('${safeRuleId}', event)">Revoke</button>
              </div>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // 3. Render Recent Decisions History
  ensureApprovalDecisionHistoryLoaded();
  const historyListEl = document.getElementById("approval-queue-history-list");
  if (historyListEl) {
    if (approvalDecisionHistory.length === 0) {
      historyListEl.innerHTML = `<div class="approval-queue-empty">No approval decisions recorded yet.</div>`;
    } else {
      historyListEl.innerHTML = approvalDecisionHistory.map(h => {
        const cmdText = h.action || h.command_prefix || "";
        const safePrefix = escapeJsAttr(h.command_prefix || h.action || "");
        const ansNote = h.answer ? `<div style="font-size:11px; color:var(--text-muted); margin-top:3px;">Reason/Answer: ${escapeHtml(h.answer)}</div>` : "";
        return `
          <div class="approval-queue-item">
            <div class="approval-queue-item-top">
              <span class="approval-queue-item-cmd">${escapeHtml(cmdText)}</span>
              <div class="approval-queue-item-meta">
                <span class="approval-queue-pill">${escapeHtml(h.decision)}</span>
                <span>${escapeHtml(h.timestamp || "")}</span>
                ${safePrefix && h.kind !== "question" ? `<button class="aq-action-btn" onclick="quickAllowPrefixFromHistory('${safePrefix}', event)" title="Save as project allow rule">+ Rule</button>` : ""}
              </div>
            </div>
            ${ansNote}
          </div>
        `;
      }).join("");
    }
  }
}

function toggleApprovalQueuePopover(event) {
  if (event) event.stopPropagation();
  const pop = document.getElementById("approval-queue-popover");
  if (!pop) return;
  const isOpen = pop.classList.contains("open");
  if (isOpen) {
    pop.classList.remove("open");
  } else {
    if (typeof closeAllDropdowns === "function") closeAllDropdowns();
    refreshApprovalQueueFromBackend();
    syncGlobalApprovalQueueUI();
    pop.classList.add("open");
  }
}

function closeApprovalQueuePopover(event) {
  if (event) event.stopPropagation();
  const pop = document.getElementById("approval-queue-popover");
  if (pop) pop.classList.remove("open");
}

function switchApprovalQueueTab(tab, event) {
  if (event) event.stopPropagation();
  activeApprovalQueueTab = tab || "pending";
  ["pending", "rules", "history"].forEach(t => {
    const tabBtn = document.getElementById("aq-tab-" + t);
    const panelEl = document.getElementById("aq-panel-" + t);
    if (tabBtn) {
      if (t === activeApprovalQueueTab) tabBtn.classList.add("active");
      else tabBtn.classList.remove("active");
    }
    if (panelEl) {
      if (t === activeApprovalQueueTab) panelEl.classList.add("active");
      else panelEl.classList.remove("active");
    }
  });
  renderGlobalApprovalQueuePopover();
}

async function refreshApprovalQueueFromBackend() {
  try {
    let raw = null;
    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("getApprovalQueue", "");
    } else if (typeof callGo === "function") {
      raw = await callGo("getApprovalQueue", "");
    }
    if (raw) {
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (res && Array.isArray(res.approval_queue)) {
        globalApprovalQueue = res.approval_queue.map(normalizeApprovalRequestItem).filter(Boolean);
      }
      if (res && Array.isArray(res.approval_rules)) {
        currentApprovalRules = res.approval_rules.map(normalizeApprovalRule).filter(Boolean);
        saveLocalApprovalRulesBackup();
      }
      syncGlobalApprovalQueueUI();
    }
  } catch (e) {}
}

async function resolveQueueApprovalItem(approvalId, option, event, customAnswer, isSkipped) {
  if (event) event.stopPropagation();
  if (!Array.isArray(globalApprovalQueue)) globalApprovalQueue = [];

  const targetItem = globalApprovalQueue.find(q => q.id === approvalId) || globalApprovalQueue[0];
  const isQuestion = Boolean(targetItem && (targetItem.kind === "question" || targetItem.category === "question")) || window.currentApprovalKind === "question";
  const resolvedId = targetItem ? targetItem.id : (approvalId || currentApprovalId || "step-4");
  const fullCmd = targetItem
    ? ((isQuestion && Array.isArray(targetItem.questions) && targetItem.questions.length > 0) ? targetItem.questions.join("\n\n") : (targetItem.action || ""))
    : (currentApprovalCmd || "");
  const prefix = targetItem
    ? (targetItem.command_prefix || fullCmd || "action")
    : (currentApprovalCmdPrefix || fullCmd || "action");
  const itemConvId = (targetItem && targetItem.conversation_id) || activeConversationId || "active";
  const itemExecId = (targetItem && targetItem.exec_id) || "";
  const itemProj = (targetItem && targetItem.project) || activeProjectPath || ".";
  const answerStr = String(customAnswer !== undefined ? customAnswer : "").trim();

  let scope = "global";
  let scopeId = "";
  if (option === 1 || option === 2) {
    scope = "conversation";
    scopeId = itemConvId;
  } else if (option === 3) {
    scope = "project";
    scopeId = itemProj;
  } else if (option === 4) {
    scope = "global";
    scopeId = "";
  } else if (option === 5) {
    scope = itemConvId ? "conversation" : (itemProj ? "project" : "global");
    scopeId = itemConvId || itemProj || "";
  }

  // Optimistically remove from local queue (including any duplicate queued entry for the exact same action in this execution)
  const normFullCmd = String(fullCmd || "").trim();
  globalApprovalQueue = globalApprovalQueue.filter(q => {
    if (q.id === resolvedId || q.id === currentApprovalId) return false;
    if (normFullCmd && String(q.action || "").trim() === normFullCmd && ((itemExecId && q.exec_id === itemExecId) || (itemConvId && q.conversation_id === itemConvId))) {
      return false;
    }
    return true;
  });
  if (currentApprovalId === resolvedId) {
    currentApprovalId = null;
  }
  syncGlobalApprovalQueueUI();
  recordApprovalDecisionHistory({
    id: resolvedId,
    action: fullCmd || prefix,
    command_prefix: prefix,
    kind: isQuestion ? "question" : "approval",
    option: option,
    skipped: Boolean(isSkipped),
    decision: isQuestion
      ? ((option === 5 && !answerStr) || isSkipped ? "skipped" : "answered")
      : (isSkipped ? "skipped" : (option === 5 ? "denied" : (option > 1 ? `allowed (${scope})` : "approved"))),
    answer: answerStr,
    scope: scope,
    project: itemProj
  });

  let updatedFromBackend = false;
  let isInFlight = false;
  try {
    let raw = null;
    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("respondApprovalWithOptions", JSON.stringify({
        id: resolvedId,
        option: option,
        command_prefix: prefix,
        scope: scope,
        scope_id: scopeId,
        answer: answerStr
      }));
    } else if (typeof window.respondApprovalWithOptions === "function") {
      raw = await window.respondApprovalWithOptions(
        resolvedId,
        option,
        prefix,
        scope,
        scopeId,
        answerStr
      );
    }
    if (raw) {
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (res && res.in_flight === true) {
        isInFlight = true;
      }
      const backendRules = (res && Array.isArray(res.approval_rules)) ? res.approval_rules : (res && Array.isArray(res.rules) ? res.rules : null);
      if (backendRules) {
        currentApprovalRules = backendRules.map(normalizeApprovalRule).filter(Boolean);
        saveLocalApprovalRulesBackup();
        updatedFromBackend = true;
      }
      if (res && Array.isArray(res.approval_queue)) {
        globalApprovalQueue = res.approval_queue.map(normalizeApprovalRequestItem).filter(Boolean);
      } else if (res && Array.isArray(res.pending_approvals)) {
        globalApprovalQueue = res.pending_approvals.map(normalizeApprovalRequestItem).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn("resolveQueueApprovalItem error:", err);
  }

  if (!isQuestion && !updatedFromBackend && option > 1 && option < 5) {
    const recordedRule = normalizeApprovalRule({
      ID: "rule-" + Date.now(),
      Command: prefix,
      Category: inferPermissionCategory(prefix),
      Action: "allow",
      Scope: scope,
      ScopeID: scopeId,
      CreatedAt: new Date().toISOString()
    });
    if (recordedRule) {
      if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
      currentApprovalRules.unshift(recordedRule);
      saveLocalApprovalRulesBackup();
    }
  }

  syncGlobalApprovalQueueUI();
  updateApprovalRulesCount();
  renderPermissionsSummaries();

  if (isQuestion) {
    if (option === 5 && !answerStr) {
      showToast("Question skipped");
    } else {
      showToast("Answer sent to agent");
    }
  } else if (option === 5) {
    showToast(answerStr ? "Instruction sent to agent" : "Execution denied");
  } else if (option > 1) {
    showToast(`Allowed '${prefix}' and saved rule (${scope})`);
  } else {
    showToast(`Approved: ${prefix}`);
  }

  if (!isInFlight) {
    const conv = appConversations.find(c => c.id === activeConversationId);
    if (conv && conv.steps) {
      const pendingIdx = conv.steps.findIndex(s => s.id === resolvedId);
      if (pendingIdx !== -1) {
        conv.steps[pendingIdx] = {
          id: "step-" + Date.now(),
          type: "cmd",
          title: (option === 5 ? "Denied: " : "Approved: ") + (fullCmd || prefix),
          output: option === 5 ? "Execution was denied by user." : "Command approved by user.",
          collapsed: false
        };
        renderActiveConversation();
      }
    }
  }

  loadApprovalRules();
}

function focusQuestionCardFromQueue(approvalId, event) {
  if (event) event.stopPropagation();
  closeApprovalQueuePopover();
  const card = document.getElementById("approval-card");
  if (card && card.classList.contains("visible")) {
    try {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {}
  }
  const qOpts = Array.isArray(window.currentQuestionOptions) ? window.currentQuestionOptions : [];
  if (qOpts.length > 0) {
    selectApprovalOption(qOpts.length);
  }
  const inputEl = document.getElementById("approval-answer-input");
  if (inputEl) {
    inputEl.focus();
  }
}

function approveNextInQueue(event) {
  if (event) event.stopPropagation();
  const next = Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 0 ? globalApprovalQueue[0] : null;
  const id = next ? next.id : (currentApprovalId || "");
  if (!id) return;
  if (next && (next.kind === "question" || next.category === "question")) {
    focusQuestionCardFromQueue(id, event);
    return;
  }
  resolveQueueApprovalItem(id, 1, event);
}

function denyNextInQueue(event) {
  if (event) event.stopPropagation();
  const next = Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 0 ? globalApprovalQueue[0] : null;
  const id = next ? next.id : (currentApprovalId || "");
  if (!id) return;
  resolveQueueApprovalItem(id, 5, event);
}

async function approveAllQueueItems(event) {
  if (event) event.stopPropagation();
  if (!Array.isArray(globalApprovalQueue) || globalApprovalQueue.length === 0) return;
  const count = globalApprovalQueue.length;
  globalApprovalQueue.forEach(item => {
    recordApprovalDecisionHistory({
      id: item.id,
      action: item.action || item.command_prefix,
      command_prefix: item.command_prefix,
      decision: "approved (batch)",
      project: item.project
    });
  });
  globalApprovalQueue = [];
  syncGlobalApprovalQueueUI();

  try {
    if (typeof window.bridgeCall === "function") {
      await window.bridgeCall("respondAllApprovals", JSON.stringify({ approved: true }));
    } else if (typeof callGo === "function") {
      await callGo("respondAllApprovals", JSON.stringify({ approved: true }));
    }
  } catch (e) {}
  showToast(`Approved all ${count} pending request(s)`);
}

async function denyAllQueueItems(event) {
  if (event) event.stopPropagation();
  if (!Array.isArray(globalApprovalQueue) || globalApprovalQueue.length === 0) return;
  const count = globalApprovalQueue.length;
  globalApprovalQueue.forEach(item => {
    recordApprovalDecisionHistory({
      id: item.id,
      action: item.action || item.command_prefix,
      command_prefix: item.command_prefix,
      decision: "denied (batch)",
      project: item.project
    });
  });
  globalApprovalQueue = [];
  syncGlobalApprovalQueueUI();

  try {
    if (typeof window.bridgeCall === "function") {
      await window.bridgeCall("respondAllApprovals", JSON.stringify({ approved: false }));
    } else if (typeof callGo === "function") {
      await callGo("respondAllApprovals", JSON.stringify({ approved: false }));
    }
  } catch (e) {}
  showToast(`Denied all ${count} pending request(s)`);
}

async function setQuickApprovalPolicy(policy, event) {
  if (event) event.stopPropagation();
  if (!policy) return;
  currentPermissionPolicy = policy;
  if (policy === "ask_all") {
    currentTerminalExecutionPolicy = "sandbox";
    currentFileAccessPolicy = "ask";
  } else if (policy === "safe_auto") {
    currentTerminalExecutionPolicy = "safe_auto";
    currentFileAccessPolicy = "read_only";
  } else if (policy === "full_auto") {
    currentTerminalExecutionPolicy = "full_auto";
    currentFileAccessPolicy = "allow_all";
  }
  const presetEl = document.getElementById("select-global-preset") || document.getElementById("select-permission-policy");
  if (presetEl) presetEl.value = policy;

  if (typeof handleGlobalPresetChange === "function" && document.getElementById("select-global-preset")) {
    handleGlobalPresetChange();
  } else if (typeof autoSaveGeneralSettings === "function") {
    autoSaveGeneralSettings();
  }
  syncGlobalApprovalQueueUI();
  showToast(`Approval mode: ${formatPolicyShortLabel(policy)}`);
}

async function toggleQuickSandboxMode(event) {
  if (event) event.stopPropagation();
  currentSandboxMode = !currentSandboxMode;
  const sbCheckbox = document.getElementById("toggle-global-sandbox") || document.getElementById("toggle-sandbox-mode");
  if (sbCheckbox) sbCheckbox.checked = currentSandboxMode;
  if (typeof autoSaveGeneralSettings === "function") {
    autoSaveGeneralSettings();
  }
  syncGlobalApprovalQueueUI();
  showToast(currentSandboxMode ? "Sandbox Mode enabled" : "Sandbox Mode disabled");
}

async function addQuickApprovalRuleFromQueue(event) {
  if (event) event.stopPropagation();
  const inputEl = document.getElementById("aq-quick-rule-input");
  const actionEl = document.getElementById("aq-quick-rule-action");
  const scopeEl = document.getElementById("aq-quick-rule-scope");
  if (!inputEl) return;

  const cmd = String(inputEl.value || "").trim();
  if (!cmd) return;
  const action = actionEl ? actionEl.value : "allow";
  const scope = scopeEl ? scopeEl.value : "project";
  const scopeId = scope === "project" ? (activeProjectPath || ".") : "";

  const rulePayload = {
    command: cmd,
    category: inferPermissionCategory(cmd),
    action: action,
    scope: scope,
    scope_id: scopeId
  };

  inputEl.value = "";
  try {
    let raw = null;
    if (typeof window.addApprovalRule === "function") {
      raw = await window.addApprovalRule(JSON.stringify(rulePayload));
    } else if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("addApprovalRule", JSON.stringify(rulePayload));
    }
    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        currentApprovalRules = parsed.map(normalizeApprovalRule).filter(Boolean);
        saveLocalApprovalRulesBackup();
      }
    } else {
      const localRule = normalizeApprovalRule(rulePayload);
      if (localRule) {
        currentApprovalRules.unshift(localRule);
        saveLocalApprovalRulesBackup();
      }
    }
  } catch (e) {}

  syncGlobalApprovalQueueUI();
  updateApprovalRulesCount();
  renderPermissionsSummaries();
  showToast(`Rule saved: ${action} '${cmd}' (${scope})`);
}

async function quickAllowPrefixFromHistory(prefix, event) {
  if (event) event.stopPropagation();
  if (!prefix) return;
  const rulePayload = {
    command: prefix,
    category: inferPermissionCategory(prefix),
    action: "allow",
    scope: "project",
    scope_id: activeProjectPath || "."
  };
  try {
    if (typeof window.addApprovalRule === "function") {
      const raw = await window.addApprovalRule(JSON.stringify(rulePayload));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        currentApprovalRules = parsed.map(normalizeApprovalRule).filter(Boolean);
        saveLocalApprovalRulesBackup();
      }
    } else if (typeof window.bridgeCall === "function") {
      const raw = await window.bridgeCall("addApprovalRule", JSON.stringify(rulePayload));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        currentApprovalRules = parsed.map(normalizeApprovalRule).filter(Boolean);
        saveLocalApprovalRulesBackup();
      }
    }
  } catch (e) {}
  syncGlobalApprovalQueueUI();
  updateApprovalRulesCount();
  renderPermissionsSummaries();
  showToast(`Added project rule for '${prefix}'`);
}

async function revokeRuleFromQueue(ruleId, event) {
  if (event) event.stopPropagation();
  if (!ruleId) return;
  await revokeApprovalRule(ruleId);
  syncGlobalApprovalQueueUI();
}

function openApprovalSettingsFromQueue(event) {
  if (event) event.stopPropagation();
  closeApprovalQueuePopover();
  if (typeof openSettingsModal === "function") {
    openSettingsModal();
  }
  if (typeof openPermissionsDetail === "function") {
    openPermissionsDetail("terminal", "global");
  }
}

function isGenericQuestionPlaceholderOption(opt) {
  const lower = String(opt || "").trim().toLowerCase().replace(/\.$/, "");
  return (
    !lower ||
    lower === "<nil>" ||
    lower === "null" ||
    lower === "yes, proceed" ||
    lower === "use recommended defaults" ||
    lower === "no, skip this" ||
    lower === "type custom answer below" ||
    lower === "custom" ||
    lower === "custom..." ||
    lower === "other" ||
    lower === "skip"
  );
}

function deriveContextualQuestionOptions(item, qText) {
  const cleaned = [];
  const seen = new Set();
  const addCandidate = (raw) => {
    if (cleaned.length >= 3) return;
    let s = String(raw || "").trim();
    s = s.replace(/^[-*•–]\s+/, "").replace(/^[1-9a-dA-D][.)]\s+/, "").replace(/^[`"']|[`"']$/g, "").replace(/[?;]+$/, "").trim();
    if (!s || s.length > 90 || isGenericQuestionPlaceholderOption(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cleaned.push(s);
  };

  if (item && Array.isArray(item.options)) {
    item.options.forEach(opt => addCandidate(opt));
  }
  if (cleaned.length > 0) {
    return cleaned.slice(0, 3);
  }

  const text = String(qText || "").trim();
  if (text) {
    const lines = text.split(/\r?\n/);
    const listItems = [];
    lines.forEach(line => {
      const t = line.trim();
      if (/^([-*•]|[1-9a-dA-D][.)])\s+/.test(t) && !t.endsWith(":")) {
        listItems.push(t);
      }
    });
    if (listItems.length >= 2) {
      listItems.forEach(li => addCandidate(li));
      if (cleaned.length > 0) return cleaned.slice(0, 3);
    }

    const egMatch = text.match(/\((?:e\.g\.?|for example|such as|like)[:\s,]+([^)?\n]+)\)/i);
    if (egMatch && egMatch[1]) {
      egMatch[1]
        .replace(/,\s*or\s+/gi, "|")
        .replace(/\s+or\s+/gi, "|")
        .split(/[|,]/)
        .forEach(p => addCandidate(p));
      if (cleaned.length > 0) return cleaned.slice(0, 3);
    }

    const lastLine = (lines[lines.length - 1] || "").trim().replace(/\?+$/, "");
    if (/\s+or\s+/i.test(lastLine) && lastLine.length <= 130) {
      const stripped = lastLine.replace(/^(?:would you like(?: to use)?|should i(?: use)?|do you (?:prefer|want(?: to use)?)|would you prefer|are you using|is this for|shall we use|choose between)\s+/i, "");
      const parts = stripped.replace(/,\s*or\s+/gi, "|").replace(/\s+or\s+/gi, "|").replace(/,\s+/g, "|").split("|");
      if (parts.length >= 2 && parts.length <= 4) {
        parts.forEach(p => addCandidate(p));
        if (cleaned.length >= 2) return cleaned.slice(0, 3);
      }
    }
  }

  const lower = text.toLowerCase();
  if (/database|storage|persistence/.test(lower)) {
    return ["SQLite (local file)", "PostgreSQL", "In-memory storage"];
  }
  if (/environment|deploy|target env/.test(lower)) {
    return ["Local development", "Staging", "Production"];
  }
  if (/auth|token|api key|credential/.test(lower)) {
    return ["Use environment variables (.env)", "Use existing config / session"];
  }
  if (/test|verify|validation/.test(lower)) {
    return ["Run targeted tests only", "Run full test suite", "Skip tests for now"];
  }
  if (/directory|folder|path|where should/.test(lower)) {
    return ["Current workspace root", "Use existing project structure"];
  }
  if (/format|output|report/.test(lower)) {
    return ["Concise summary", "Detailed step-by-step output", "JSON / structured format"];
  }
  if (/overwrite|replace|existing file/.test(lower)) {
    return ["Update existing file in-place", "Create a new file alongside it", "Keep existing file unchanged"];
  }
  if (/^(should|would you like|do you want|can i|shall)\b/.test(lower)) {
    return ["Yes, go ahead with this", "Use a minimal, non-breaking approach", "No, hold off on this step"];
  }
  return ["Use recommended defaults for this workspace", "Take the simplest minimal approach"];
}

function showApprovalCard(data) {
  const card = document.getElementById("approval-card");
  if (!card) return;

  const item = normalizeApprovalRequestItem(data) || data;
  const isQuestion = item.kind === "question" || item.category === "question";
  window.currentApprovalKind = isQuestion ? "question" : "approval";

  currentApprovalId = item.id || item.ID || ("approval-" + Date.now());
  currentApprovalCmd = item.action || item.cmd || item.Command || "";
  const prefix = item.command_prefix || item.prefix || item.CommandPrefix || (currentApprovalCmd ? currentApprovalCmd.trim().split(/\s+/).slice(0, 2).join(" ") : "this action");
  currentApprovalCmdPrefix = prefix;
  currentApprovalProject = item.project || activeProjectPath || ".";

  const titleEl = document.getElementById("approval-title-text");
  const warnBanner = document.getElementById("approval-warning-banner");
  const warnText = document.getElementById("approval-warning-text");
  const cmdEl = document.getElementById("approval-cmd");
  const prevChoiceBanner = document.getElementById("approval-prev-choice-banner");
  const prevChoiceText = document.getElementById("approval-prev-choice-text");
  const answerWrap = document.getElementById("approval-answer-wrap");
  const answerInput = document.getElementById("approval-answer-input");
  const submitLabel = document.getElementById("approval-submit-label");
  const skipBtn = card.querySelector(".btn-approval-skip");

  if (prevChoiceBanner) prevChoiceBanner.style.display = "none";
  if (prevChoiceText) prevChoiceText.innerText = "";

  const queueSuffix = Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 1
    ? ` (1 of ${globalApprovalQueue.length} in queue)`
    : "";

  if (isQuestion) {
    card.classList.add("question-mode");
    if (skipBtn) skipBtn.style.display = "none";
    const baseDesc = item.description || item.desc || item.Description || "Answer Required";
    if (titleEl) {
      titleEl.innerText = baseDesc + queueSuffix;
    }
    const warn = String(item.warning || item.Warning || "").trim();
    if (warnBanner) {
      if (warn) {
        warnBanner.style.display = "flex";
        if (warnText) warnText.innerText = warn;
      } else {
        warnBanner.style.display = "none";
      }
    }
    const qText = (Array.isArray(item.questions) && item.questions.length > 0)
      ? item.questions.join("\n\n")
      : currentApprovalCmd;
    if (cmdEl) cmdEl.innerText = qText;

    const generatedOpts = deriveContextualQuestionOptions(item, qText).slice(0, 3);
    const displayOpts = generatedOpts.concat(["Custom..."]);
    window.currentQuestionOptions = displayOpts;

    const prevChoice = findPreviousApprovalChoice(qText, prefix, "question");
    let defaultOpt = 1;
    let prefillAnswer = "";
    if (prevChoice) {
      const prevAns = String(prevChoice.answer || "").trim();
      if (prevAns) {
        const matchedIdx = displayOpts.findIndex((o, idx) => idx < displayOpts.length - 1 && o.toLowerCase() === prevAns.toLowerCase());
        if (matchedIdx >= 0) {
          defaultOpt = matchedIdx + 1;
        } else {
          defaultOpt = displayOpts.length;
          prefillAnswer = prevAns;
        }
      } else if (prevChoice.option >= 1 && prevChoice.option <= displayOpts.length) {
        defaultOpt = prevChoice.option;
      }
      if (prevChoiceBanner && prevChoiceText) {
        const timeNote = prevChoice.timestamp ? ` (${prevChoice.timestamp})` : "";
        prevChoiceText.innerText = prevAns
          ? `Previous answer${timeNote}: "${prevAns}" — pre-selected as default`
          : `Previously ${prevChoice.decision || "answered"}${timeNote}`;
        prevChoiceBanner.style.display = "flex";
      }
    }

    for (let i = 1; i <= 5; i++) {
      const optEl = document.getElementById("opt-" + i);
      const lblEl = document.getElementById("lbl-opt-" + i);
      if (i <= displayOpts.length) {
        if (optEl) optEl.style.display = "flex";
        if (lblEl) {
          lblEl.innerText = displayOpts[i - 1];
          if (prevChoice && i === defaultOpt) {
            const badge = document.createElement("span");
            badge.className = "approval-prev-badge";
            badge.innerText = "Previous choice";
            lblEl.appendChild(badge);
          }
        }
      } else {
        if (optEl) optEl.style.display = "none";
      }
    }

    if (answerWrap) answerWrap.style.display = "flex";
    if (answerInput) {
      answerInput.value = prefillAnswer;
      answerInput.placeholder = "Type a custom answer (or choose an option above)...";
      answerInput.oninput = () => {
        if (window.currentApprovalKind === "question" && String(answerInput.value || "").trim().length > 0) {
          const customIdx = Array.isArray(window.currentQuestionOptions) ? window.currentQuestionOptions.length : 0;
          if (customIdx >= 1 && selectedApprovalOption !== customIdx) {
            selectApprovalOption(customIdx);
          }
        }
      };
      answerInput.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          submitApproval();
        }
      };
    }
    if (submitLabel) submitLabel.innerText = "Send Answer";
    selectApprovalOption(defaultOpt);
  } else {
    card.classList.remove("question-mode");
    if (skipBtn) skipBtn.style.display = "";
    window.currentQuestionOptions = [];

    const baseDesc = item.description || item.desc || item.Description || "Allow action?";
    const warn = item.warning || item.Warning || "";
    if (titleEl) {
      titleEl.innerText = (warn ? `${baseDesc} — ${warn}` : baseDesc) + queueSuffix;
    }
    if (warnBanner) {
      warnBanner.style.display = "flex";
      if (warnText) {
        warnText.innerText = warn || "Confirm the command is safe to run outside of the sandbox with full network and disk access.";
      }
    }
    if (cmdEl) cmdEl.innerText = currentApprovalCmd;

    for (let i = 1; i <= 5; i++) {
      const optEl = document.getElementById("opt-" + i);
      if (optEl) optEl.style.display = "flex";
    }
    const lblOpt1 = document.getElementById("lbl-opt-1");
    if (lblOpt1) lblOpt1.innerText = "Yes, allow this time";
    const lblOpt2 = document.getElementById("lbl-opt-2");
    if (lblOpt2) lblOpt2.innerText = `Yes, and always allow '${prefix}' in this conversation`;
    const lblOpt3 = document.getElementById("lbl-opt-3");
    if (lblOpt3) lblOpt3.innerText = `Yes, and always allow '${prefix}' in this project`;
    const lblOpt4 = document.getElementById("lbl-opt-4");
    if (lblOpt4) lblOpt4.innerText = `Yes, and always allow '${prefix}'`;
    const lblOpt5 = document.getElementById("lbl-opt-5");
    if (lblOpt5) lblOpt5.innerText = "No (tell the agent what to do instead)";

    const prevChoice = findPreviousApprovalChoice(currentApprovalCmd, prefix, "approval");
    let defaultOpt = 1;
    let prefillReason = "";
    if (prevChoice) {
      if (prevChoice.option >= 1 && prevChoice.option <= 5) {
        defaultOpt = prevChoice.option;
      } else if (prevChoice.decision === "denied" || prevChoice.decision === "skipped" || prevChoice.skipped) {
        defaultOpt = 5;
      }
      if (defaultOpt === 5 && prevChoice.answer) {
        prefillReason = String(prevChoice.answer).trim();
      }
      const targetLbl = document.getElementById("lbl-opt-" + defaultOpt);
      if (targetLbl) {
        const badge = document.createElement("span");
        badge.className = "approval-prev-badge";
        badge.innerText = prevChoice.skipped ? "Previously skipped" : "Previous choice";
        targetLbl.appendChild(badge);
      }
      if (prevChoiceBanner && prevChoiceText) {
        const timeNote = prevChoice.timestamp ? ` at ${prevChoice.timestamp}` : "";
        let choiceDesc = "Option " + defaultOpt;
        if (prevChoice.skipped || prevChoice.decision === "skipped") {
          choiceDesc = "Skipped (did not run)";
        } else if (defaultOpt === 5) {
          choiceDesc = "Option 5 — Denied (did not run)";
        } else if (defaultOpt === 1) {
          choiceDesc = "Option 1 — Allowed once";
        } else if (defaultOpt === 2) {
          choiceDesc = "Option 2 — Allowed in conversation";
        } else if (defaultOpt === 3) {
          choiceDesc = "Option 3 — Allowed in project";
        } else if (defaultOpt === 4) {
          choiceDesc = "Option 4 — Allowed globally";
        }
        const whySuffix = prevChoice.answer ? ` — Reason: "${prevChoice.answer}"` : "";
        const matchNote = prevChoice.match_type === "prefix" ? ` (for '${prefix}')` : "";
        prevChoiceText.innerText = `Previous choice${matchNote}${timeNote}: ${choiceDesc}${whySuffix}`;
        prevChoiceBanner.style.display = "flex";
      }
    }

    if (answerWrap) answerWrap.style.display = defaultOpt === 5 ? "flex" : "none";
    if (answerInput) {
      answerInput.value = prefillReason;
      answerInput.placeholder = "Tell the agent what to do instead (optional)...";
      answerInput.oninput = null;
      answerInput.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          submitApproval();
        }
      };
    }
    if (submitLabel) submitLabel.innerText = "Submit";
    selectApprovalOption(defaultOpt);
  }

  card.classList.add("visible");
  const dock = document.getElementById("chat-dock-container");
  if (dock) dock.classList.add("has-approval-card");
}

function selectApprovalOption(num) {
  if (num < 1 || num > 5) return;
  selectedApprovalOption = num;
  for (let i = 1; i <= 5; i++) {
    const opt = document.getElementById("opt-" + i);
    if (opt) {
      if (i === num) {
        opt.classList.add("selected");
      } else {
        opt.classList.remove("selected");
      }
    }
  }

  const answerWrap = document.getElementById("approval-answer-wrap");
  const answerInput = document.getElementById("approval-answer-input");
  if (window.currentApprovalKind === "question") {
    if (answerWrap) answerWrap.style.display = "flex";
    const qOpts = Array.isArray(window.currentQuestionOptions) ? window.currentQuestionOptions : [];
    if (num === qOpts.length && answerInput) {
      answerInput.focus();
    }
  } else {
    if (answerWrap) {
      answerWrap.style.display = num === 5 ? "flex" : "none";
    }
    if (num === 5 && answerInput) {
      answerInput.focus();
    }
  }
}

async function submitApproval() {
  const card = document.getElementById("approval-card");
  if (!card || !card.classList.contains("visible")) return;
  const approvalId = currentApprovalId || (Array.isArray(globalApprovalQueue) && globalApprovalQueue[0] ? globalApprovalQueue[0].id : "step-4");
  const answerInput = document.getElementById("approval-answer-input");
  const mainPromptInput = document.getElementById("prompt-input");
  let typedAnswer = answerInput ? String(answerInput.value || "").trim() : "";
  let usedMainPrompt = false;
  if (!typedAnswer && mainPromptInput && (window.currentApprovalKind === "question" || selectedApprovalOption === 5)) {
    const mainVal = String(mainPromptInput.value || "").trim();
    if (mainVal) {
      typedAnswer = mainVal;
      usedMainPrompt = true;
    }
  }

  if (window.currentApprovalKind === "question") {
    const qOpts = Array.isArray(window.currentQuestionOptions) ? window.currentQuestionOptions : [];
    const selectedLabel = (selectedApprovalOption >= 1 && selectedApprovalOption <= qOpts.length)
      ? qOpts[selectedApprovalOption - 1]
      : "";
    const isCustomOption = selectedLabel === "Custom..." || selectedLabel === "Type custom answer below" || selectedApprovalOption === qOpts.length;
    if (typedAnswer) {
      if (usedMainPrompt && mainPromptInput) {
        mainPromptInput.value = "";
        mainPromptInput.style.height = "auto";
      }
      await resolveQueueApprovalItem(approvalId, 1, null, typedAnswer);
      return;
    }
    if (isCustomOption || !selectedLabel) {
      if (answerInput) answerInput.focus();
      showToast("Please type your custom answer or select an option above");
      return;
    }
    await resolveQueueApprovalItem(approvalId, 1, null, selectedLabel);
    return;
  }

  if (usedMainPrompt && mainPromptInput && selectedApprovalOption === 5) {
    mainPromptInput.value = "";
    mainPromptInput.style.height = "auto";
  }
  await resolveQueueApprovalItem(approvalId, selectedApprovalOption, null, selectedApprovalOption === 5 ? typedAnswer : "");
}

async function skipApproval() {
  const approvalId = currentApprovalId || (Array.isArray(globalApprovalQueue) && globalApprovalQueue[0] ? globalApprovalQueue[0].id : "");
  const answerInput = document.getElementById("approval-answer-input");
  const typedNote = answerInput ? String(answerInput.value || "").trim() : "";
  if (approvalId) {
    await resolveQueueApprovalItem(approvalId, 5, null, typedNote, true);
  } else {
    const card = document.getElementById("approval-card");
    if (card) {
      card.classList.remove("visible");
      card.classList.remove("question-mode");
    }
    const dock = document.getElementById("chat-dock-container");
    if (dock) dock.classList.remove("has-approval-card");
    showToast("Execution denied (skipped)");
  }
}

async function respondApproval(approved) {
  const approvalId = currentApprovalId || (Array.isArray(globalApprovalQueue) && globalApprovalQueue[0] ? globalApprovalQueue[0].id : "");
  if (!approvalId) return;
  await resolveQueueApprovalItem(approvalId, approved ? 1 : 5);
}

// ----------------- Remembered Approvals Modal & Backend Sync -----------------
async function openRememberedApprovalsModal() {
  await loadApprovalRules();
  const modal = document.getElementById("remembered-approvals-modal");
  if (modal) modal.classList.add("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

function closeRememberedApprovalsModal() {
  const modal = document.getElementById("remembered-approvals-modal");
  if (modal) modal.classList.remove("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

async function loadApprovalRules() {
  let loaded = null;
  if (typeof window.getApprovalRules === "function") {
    try {
      const raw = await window.getApprovalRules();
      const rules = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(rules)) {
        loaded = rules.map(normalizeApprovalRule).filter(Boolean);
      }
    } catch (err) {
      console.warn("getApprovalRules error:", err);
    }
  } else if (typeof window.bridgeCall === "function") {
    try {
      const raw = await window.bridgeCall("getApprovalRules", "");
      const rules = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(rules)) {
        loaded = rules.map(normalizeApprovalRule).filter(Boolean);
      }
    } catch (err) {}
  }

  if (Array.isArray(loaded)) {
    if (loaded.length === 0 && (!currentApprovalRules || currentApprovalRules.length === 0)) {
      const backup = loadLocalApprovalRulesBackup();
      if (backup.length > 0) {
        currentApprovalRules = backup;
      } else {
        currentApprovalRules = [];
      }
    } else {
      currentApprovalRules = loaded;
      saveLocalApprovalRulesBackup();
    }
  } else if (!Array.isArray(currentApprovalRules) || currentApprovalRules.length === 0) {
    currentApprovalRules = loadLocalApprovalRulesBackup();
  } else {
    currentApprovalRules = currentApprovalRules.map(normalizeApprovalRule).filter(Boolean);
  }

  updateApprovalRulesCount();
  renderRememberedRulesTable();
  renderPermissionsSummaries();
  syncGlobalApprovalQueueUI();
  const detailPanel = document.getElementById("settings-panel-permissions-detail");
  if (detailPanel && detailPanel.classList.contains("active")) {
    renderPermissionsDetail();
  }
}

function updateApprovalRulesCount() {
  const countEl = document.getElementById("remembered-rules-count");
  if (countEl) {
    countEl.innerText = currentApprovalRules ? currentApprovalRules.length : 0;
  }
}

function renderRememberedRulesTable() {
  const tbody = document.getElementById("remembered-rules-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!currentApprovalRules || currentApprovalRules.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:16px;">No remembered approval rules yet.</td></tr>`;
    return;
  }

  currentApprovalRules.forEach(rawRule => {
    const rule = normalizeApprovalRule(rawRule);
    if (!rule) return;
    const tr = document.createElement("tr");
    const scopeClass = rule.Scope || "global";
    const scopeLabel = rule.Scope === "project" ? `Project (${(rule.ScopeID || "").split(/[/\\]/).pop() || "active"})` : (rule.Scope === "conversation" ? "Conversation" : "Global");
    const dateStr = rule.CreatedAt ? new Date(rule.CreatedAt).toLocaleTimeString() : "Just now";
    const actionLabel = rule.Action === "deny" ? " [Deny]" : "";

    tr.innerHTML = `
      <td style="font-family:'SF Mono',Menlo,monospace; font-weight:600; color:#f8fafc;">${escapeHtml(rule.Command)}${escapeHtml(actionLabel)}</td>
      <td><span class="rule-scope-badge ${escapeHtml(scopeClass)}">${escapeHtml(scopeLabel)}</span></td>
      <td style="color:var(--text-muted); font-size:11.5px;">${escapeHtml(dateStr)}</td>
      <td>
        <button class="btn-rule-revoke" onclick="revokeApprovalRule('${escapeJsAttr(rule.ID)}')">Revoke</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function persistApprovalRuleToBackend(rule, isUpdate) {
  const actionName = isUpdate ? "updateApprovalRule" : "addApprovalRule";
  const payload = JSON.stringify(rule);
  try {
    if (!isUpdate && typeof window.addApprovalRule === "function") {
      await window.addApprovalRule(payload);
    } else if (typeof window.bridgeCall === "function") {
      await window.bridgeCall(actionName, payload);
    } else if (typeof callGo === "function") {
      await callGo(actionName, payload);
    }
  } catch (err) {
    console.warn(actionName + " error:", err);
  }
}

async function revokeApprovalRule(ruleId) {
  try {
    if (typeof window.revokeApprovalRuleBackend === "function") {
      await window.revokeApprovalRuleBackend(ruleId);
    } else if (typeof window.bridgeCall === "function") {
      await window.bridgeCall("revokeApprovalRule", ruleId);
    } else if (typeof callGo === "function") {
      await callGo("revokeApprovalRule", ruleId);
    }
  } catch (err) {
    console.warn("revokeApprovalRule error:", err);
  }
  currentApprovalRules = (currentApprovalRules || [])
    .map(normalizeApprovalRule)
    .filter(r => r && r.ID !== ruleId);
  saveLocalApprovalRulesBackup();
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  renderPermissionsSummaries();
  renderPermissionsDetail();
  syncGlobalApprovalQueueUI();
  showToast("Permission rule removed");
}

async function clearAllApprovalRules() {
  if (window.clearApprovalRules) {
    try {
      await window.clearApprovalRules();
    } catch (err) {
      console.warn("clearApprovalRules error:", err);
    }
  }
  currentApprovalRules = [];
  saveLocalApprovalRulesBackup();
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  renderPermissionsSummaries();
  renderPermissionsDetail();
  syncGlobalApprovalQueueUI();
  showToast("All approval rules revoked");
}

async function addManualApprovalRule() {
  const cmdInput = document.getElementById("input-new-rule-cmd");
  const scopeSelect = document.getElementById("select-new-rule-scope");
  const cmd = cmdInput ? cmdInput.value.trim() : "";
  if (!cmd) return;

  const scope = scopeSelect ? scopeSelect.value : "global";
  let scopeId = "";
  if (scope === "project") scopeId = activeSettingsProject || activeProjectPath || ".";
  if (scope === "conversation") scopeId = activeConversationId || "active";

  const rule = normalizeApprovalRule({
    ID: "rule-" + Date.now(),
    Command: cmd,
    Category: inferPermissionCategory(cmd),
    Action: "allow",
    Scope: scope,
    ScopeID: scopeId,
    CreatedAt: new Date().toISOString()
  });

  await persistApprovalRuleToBackend(rule, false);

  if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
  currentApprovalRules.unshift(rule);
  saveLocalApprovalRulesBackup();
  if (cmdInput) cmdInput.value = "";
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  renderPermissionsSummaries();
  renderPermissionsDetail();
  syncGlobalApprovalQueueUI();
  showToast(`Added rule: '${cmd}'`);
}

// ----------------- Permissions Summary & Drill-Down Detail View -----------------
const PERMISSION_CATEGORY_CONFIG = {
  file: {
    title: "File Permissions",
    subcategories: [
      {
        key: "file_read",
        title: "File Reads",
        desc: "Allow/deny agent read access to specific files or directories.",
        placeholder: "e.g. ~/Desktop/* or /path/to/folder/*"
      },
      {
        key: "file_write",
        title: "File Writes",
        desc: "Allow/deny agent write access to specific files or directories.",
        placeholder: "e.g. ~/Desktop/* or ./src/*"
      }
    ]
  },
  network: {
    title: "Network Access Rules",
    subcategories: [
      {
        key: "network",
        title: "Network Access Rules",
        desc: "Allow/deny agent read access to specific URLs or domains.",
        placeholder: "e.g. https://api.github.com/* or https://docs.example.com/*"
      }
    ]
  },
  terminal: {
    title: "Terminal Commands",
    subcategories: [
      {
        key: "terminal",
        title: "Terminal Commands",
        desc: "Allow/deny agent execution of specific terminal commands.",
        placeholder: "e.g. git status, go test ./..., npm run build"
      }
    ]
  },
  sandbox_bypass: {
    title: "Commands Outside Sandbox",
    subcategories: [
      {
        key: "sandbox_bypass",
        title: "Commands Outside Sandbox",
        desc: "Allow/deny agent execution of commands outside the sandbox.",
        placeholder: "e.g. pnpm install, docker compose up"
      }
    ]
  },
  mcp: {
    title: "MCP Tools",
    subcategories: [
      {
        key: "mcp",
        title: "MCP Tools",
        desc: "Allow/deny external tools via Model Context Protocol.",
        placeholder: "e.g. mcp_github_create_issue or server:tool_name"
      }
    ]
  }
};

function matchesCategoryGroup(ruleCategory, categoryGroup) {
  const cat = String(ruleCategory || "terminal").toLowerCase();
  if (categoryGroup === "file") {
    return cat === "file" || cat === "file_read" || cat === "file_write";
  }
  return cat === categoryGroup;
}

function getRulesForScope(scope, targetProjectPath, targetConvId) {
  const rules = (Array.isArray(currentApprovalRules) ? currentApprovalRules : [])
    .map(normalizeApprovalRule)
    .filter(Boolean);

  const projPath = targetProjectPath || activeSettingsProject || activeProjectPath || ".";
  const normProj = typeof normPath === "function" ? normPath(projPath) : String(projPath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const convId = targetConvId || activeConversationId || "";

  if (scope === "global") {
    return rules.filter(r => !r.Scope || r.Scope === "global");
  }

  if (scope === "project") {
    const matched = rules.filter(r => {
      if (r.Scope !== "project") return false;
      if (!r.ScopeID) return true;
      const normRuleProj = typeof normPath === "function" ? normPath(r.ScopeID) : String(r.ScopeID).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      return normRuleProj === normProj || r.ScopeID === projPath;
    });

    // Also include project's allowed_commands prefixes if configured in currentProjectPermissions
    let perms = (currentProjectPermissions && currentProjectPermissions[projPath]) ? currentProjectPermissions[projPath] : null;
    if (!perms && currentProjectPermissions) {
      for (const k of Object.keys(currentProjectPermissions)) {
        const nk = typeof normPath === "function" ? normPath(k) : k.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        if (nk === normProj) {
          perms = currentProjectPermissions[k];
          break;
        }
      }
    }
    if (perms && perms.allowed_commands) {
      const prefixes = String(perms.allowed_commands).split(",").map(s => s.trim()).filter(Boolean);
      prefixes.forEach(pref => {
        const exists = matched.some(m => m.Command.toLowerCase() === pref.toLowerCase());
        if (!exists) {
          matched.push(normalizeApprovalRule({
            ID: "proj-prefix-" + pref,
            Command: pref,
            Category: inferPermissionCategory(pref),
            Action: "allow",
            Scope: "project",
            ScopeID: projPath
          }));
        }
      });
    }
    return matched;
  }

  if (scope === "conversation") {
    const matched = rules.filter(r => {
      if (r.Scope !== "conversation") return false;
      if (!convId || !r.ScopeID || r.ScopeID === "active") return true;
      return r.ScopeID === convId;
    });

    // Also inspect active conversation steps for any approved/denied executions not yet in matched
    if (Array.isArray(appConversations)) {
      const conv = convId ? appConversations.find(c => c.id === convId) : appConversations[0];
      if (conv && Array.isArray(conv.steps)) {
        conv.steps.forEach((s, idx) => {
          const title = String(s.title || "");
          if (title.startsWith("Approved: ") || title.startsWith("Denied: ")) {
            const isDeny = title.startsWith("Denied: ");
            const cmdText = title.replace(/^(Approved|Denied):\s*/, "").trim();
            if (cmdText && !matched.some(m => m.Command === cmdText && m.Action === (isDeny ? "deny" : "allow"))) {
              matched.push(normalizeApprovalRule({
                ID: s.id || ("conv-step-" + idx),
                Command: cmdText,
                Category: inferPermissionCategory(cmdText),
                Action: isDeny ? "deny" : "allow",
                Scope: "conversation",
                ScopeID: conv.id || convId || "active"
              }));
            }
          }
        });
      }
    }
    return matched;
  }

  return rules;
}

function renderPermissionsSummaries() {
  const categories = ["file", "network", "terminal", "sandbox_bypass", "mcp"];

  // 1. Global counts
  const globalRules = getRulesForScope("global");
  categories.forEach(cat => {
    const badge = document.getElementById("perm-count-global-" + cat);
    if (!badge) return;
    const count = globalRules.filter(r => matchesCategoryGroup(r.Category, cat)).length;
    badge.innerText = String(count);
    badge.style.display = count > 0 ? "inline-flex" : "none";
  });

  // 2. Project counts
  const projPath = activeSettingsProject || activeProjectPath || ".";
  const projectRules = getRulesForScope("project", projPath);
  categories.forEach(cat => {
    const badge = document.getElementById("perm-count-project-" + cat);
    if (!badge) return;
    const count = projectRules.filter(r => matchesCategoryGroup(r.Category, cat)).length;
    badge.innerText = String(count);
    badge.style.display = count > 0 ? "inline-flex" : "none";
  });
}

function openPermissionsDetail(categoryGroup, scope) {
  const detailPanel = document.getElementById("settings-panel-permissions-detail");
  if (!detailPanel) return;

  if (activeSettingsTab && activeSettingsTab !== "permissions-detail") {
    activePermissionsDetailReturnTab = activeSettingsTab;
  } else if (activeSettingsProject) {
    activePermissionsDetailReturnTab = "project:" + activeSettingsProject;
  } else {
    activePermissionsDetailReturnTab = "general";
  }

  activePermissionsDetailCategory = PERMISSION_CATEGORY_CONFIG[categoryGroup] ? categoryGroup : "file";
  activePermissionsDetailScope = scope || (activeSettingsProject ? "project" : "global");
  activeAddingSubCategory = null;
  activeEditingRuleId = null;

  document.querySelectorAll(".settings-panel").forEach(el => el.classList.remove("active"));
  detailPanel.classList.add("active");

  const backBtn = document.getElementById("btn-permissions-detail-back");
  if (backBtn) backBtn.style.display = "inline-flex";

  renderPermissionsDetail();
}

function closePermissionsDetail() {
  const backBtn = document.getElementById("btn-permissions-detail-back");
  if (backBtn) backBtn.style.display = "none";

  activeAddingSubCategory = null;
  activeEditingRuleId = null;

  const target = activePermissionsDetailReturnTab || "general";
  if (target.startsWith("project:")) {
    const projPath = target.replace("project:", "");
    if (typeof selectSettingsProject === "function") {
      selectSettingsProject(projPath);
      return;
    }
  }
  if (typeof switchSettingsTab === "function") {
    switchSettingsTab(target);
  }
}

function setPermissionsDetailScope(scope) {
  if (!scope) return;
  activePermissionsDetailScope = scope;
  activeAddingSubCategory = null;
  activeEditingRuleId = null;
  renderPermissionsDetail();
}

function switchPermissionsDetailCategory(categoryGroup) {
  if (!PERMISSION_CATEGORY_CONFIG[categoryGroup]) return;
  activePermissionsDetailCategory = categoryGroup;
  activeAddingSubCategory = null;
  activeEditingRuleId = null;
  renderPermissionsDetail();
}

function renderPermissionsDetail() {
  const catConfig = PERMISSION_CATEGORY_CONFIG[activePermissionsDetailCategory] || PERMISSION_CATEGORY_CONFIG.file;
  const titleEl = document.getElementById("settings-view-title");
  const descEl = document.getElementById("settings-view-desc");

  if (titleEl) titleEl.innerText = catConfig.title;

  const projPath = activeSettingsProject || activeProjectPath || ".";
  const projName = projPath === "." ? "Active Workspace" : (projPath.split(/[/\\]/).filter(Boolean).pop() || projPath);
  const activeConv = Array.isArray(appConversations) ? appConversations.find(c => c.id === activeConversationId) : null;
  const convLabel = activeConv && activeConv.title ? activeConv.title : (activeConversationId ? "Conversation " + activeConversationId.slice(0, 8) : "Current Conversation");

  let scopeDesc = "Rules applied globally across all projects and conversations.";
  let contextBadge = "Global (All Workspaces)";
  if (activePermissionsDetailScope === "project") {
    scopeDesc = `Rules approved or denied for project '${projName}'. Also inherits Global Permissions.`;
    contextBadge = `Project: ${projName}`;
  } else if (activePermissionsDetailScope === "conversation") {
    scopeDesc = `Rules approved or denied in '${convLabel}'. Also inherits Project & Global Permissions.`;
    contextBadge = `Conversation: ${convLabel}`;
  }
  if (descEl) descEl.innerText = scopeDesc;

  const contextEl = document.getElementById("perm-detail-context-label");
  if (contextEl) contextEl.innerText = contextBadge;

  // Scope buttons active state
  ["global", "project", "conversation"].forEach(sc => {
    const btn = document.getElementById("btn-perm-scope-" + sc);
    if (btn) {
      if (sc === activePermissionsDetailScope) btn.classList.add("active");
      else btn.classList.remove("active");
    }
  });

  // Category tab buttons active state
  Object.keys(PERMISSION_CATEGORY_CONFIG).forEach(catKey => {
    const btn = document.getElementById("btn-perm-cat-" + catKey);
    if (btn) {
      if (catKey === activePermissionsDetailCategory) btn.classList.add("active");
      else btn.classList.remove("active");
    }
  });

  const container = document.getElementById("permissions-detail-sections");
  if (!container) return;
  container.innerHTML = "";

  const scopedRules = getRulesForScope(activePermissionsDetailScope, projPath, activeConversationId);

  catConfig.subcategories.forEach(sub => {
    const subRules = scopedRules.filter(r => {
      const rCat = String(r.Category || "terminal").toLowerCase();
      if (sub.key === "file_read") {
        return rCat === "file_read" || rCat === "file";
      }
      return rCat === sub.key;
    });

    const section = document.createElement("div");
    section.className = "perm-subsection";

    let html = `
      <div class="perm-subsection-header">
        <div>
          <div class="perm-subsection-title">${escapeHtml(sub.title)}</div>
          <div class="perm-subsection-desc">${escapeHtml(sub.desc)}</div>
        </div>
        <button type="button" class="btn-perm-open" onclick="showAddPermissionRuleRow('${escapeJsAttr(sub.key)}')">Add</button>
      </div>
      <div class="perm-rules-list" id="perm-rules-list-${escapeHtml(sub.key)}">
    `;

    if (activeAddingSubCategory === sub.key) {
      html += `
        <div class="perm-rule-row">
          <select id="new-perm-action-${escapeHtml(sub.key)}" class="perm-action-select">
            <option value="allow" selected>Allow</option>
            <option value="deny">Deny</option>
          </select>
          <input id="new-perm-target-${escapeHtml(sub.key)}" type="text" class="perm-target-input" placeholder="${escapeHtml(sub.placeholder || "")}" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewPermissionRule('${escapeJsAttr(sub.key)}');}else if(event.key==='Escape'){event.preventDefault();cancelNewPermissionRule();}">
          <button type="button" class="btn-perm-open" onclick="saveNewPermissionRule('${escapeJsAttr(sub.key)}')">Save</button>
          <button type="button" class="perm-icon-btn" title="Cancel" onclick="cancelNewPermissionRule()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;
    }

    if (subRules.length === 0 && activeAddingSubCategory !== sub.key) {
      html += `<div class="perm-empty-state">No rules configured in this scope yet. Click <strong>Add</strong> to create an Allow or Deny rule.</div>`;
    } else {
      subRules.forEach(rule => {
        const isEditing = activeEditingRuleId === rule.ID;
        const isAllow = rule.Action !== "deny";
        if (isEditing) {
          html += `
            <div class="perm-rule-row">
              <select id="edit-perm-action-${escapeHtml(rule.ID)}" class="perm-action-select">
                <option value="allow" ${isAllow ? "selected" : ""}>Allow</option>
                <option value="deny" ${!isAllow ? "selected" : ""}>Deny</option>
              </select>
              <input id="edit-perm-target-${escapeHtml(rule.ID)}" type="text" class="perm-target-input" value="${escapeHtml(rule.Command)}" onkeydown="if(event.key==='Enter'){event.preventDefault();saveEditPermissionRule('${escapeJsAttr(rule.ID)}');}else if(event.key==='Escape'){event.preventDefault();cancelEditPermissionRule();}">
              <button type="button" class="btn-perm-open" onclick="saveEditPermissionRule('${escapeJsAttr(rule.ID)}')">Save</button>
              <button type="button" class="perm-icon-btn" title="Cancel" onclick="cancelEditPermissionRule()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          `;
        } else {
          html += `
            <div class="perm-rule-row">
              <select class="perm-action-select" onchange="changePermissionRuleAction('${escapeJsAttr(rule.ID)}', this.value)">
                <option value="allow" ${isAllow ? "selected" : ""}>Allow</option>
                <option value="deny" ${!isAllow ? "selected" : ""}>Deny</option>
              </select>
              <div class="perm-target-box">
                <span class="perm-target-text" title="${escapeHtml(rule.Command)}">${escapeHtml(rule.Command)}</span>
                <div class="perm-target-actions">
                  <button type="button" class="perm-icon-btn" title="Edit rule" onclick="startEditPermissionRule('${escapeJsAttr(rule.ID)}')">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </button>
                  <button type="button" class="perm-icon-btn" title="Delete rule" onclick="deletePermissionRule('${escapeJsAttr(rule.ID)}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          `;
        }
      });
    }

    html += `</div>`;
    section.innerHTML = html;
    container.appendChild(section);
  });

  if (activeAddingSubCategory) {
    const input = document.getElementById("new-perm-target-" + activeAddingSubCategory);
    if (input) setTimeout(() => input.focus(), 20);
  } else if (activeEditingRuleId) {
    const input = document.getElementById("edit-perm-target-" + activeEditingRuleId);
    if (input) setTimeout(() => { input.focus(); input.select(); }, 20);
  }
}

function showAddPermissionRuleRow(subCategoryKey) {
  activeAddingSubCategory = subCategoryKey;
  activeEditingRuleId = null;
  renderPermissionsDetail();
}

function cancelNewPermissionRule() {
  activeAddingSubCategory = null;
  renderPermissionsDetail();
}

async function saveNewPermissionRule(subCategoryKey) {
  const actionEl = document.getElementById("new-perm-action-" + subCategoryKey);
  const targetEl = document.getElementById("new-perm-target-" + subCategoryKey);
  const target = targetEl ? targetEl.value.trim() : "";
  if (!target) {
    showToast("Please enter a path, command, or rule pattern");
    if (targetEl) targetEl.focus();
    return;
  }
  const action = actionEl && actionEl.value === "deny" ? "deny" : "allow";
  const scope = activePermissionsDetailScope || "global";
  let scopeId = "";
  if (scope === "project") {
    scopeId = activeSettingsProject || activeProjectPath || ".";
  } else if (scope === "conversation") {
    scopeId = activeConversationId || "active";
  }

  const newRule = normalizeApprovalRule({
    ID: "rule-" + Date.now(),
    Command: target,
    Category: subCategoryKey || inferPermissionCategory(target),
    Action: action,
    Scope: scope,
    ScopeID: scopeId,
    CreatedAt: new Date().toISOString()
  });

  if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
  currentApprovalRules.unshift(newRule);
  saveLocalApprovalRulesBackup();
  activeAddingSubCategory = null;

  await persistApprovalRuleToBackend(newRule, false);
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  renderPermissionsSummaries();
  renderPermissionsDetail();
  syncGlobalApprovalQueueUI();
  showToast(`${action === "deny" ? "Denied" : "Allowed"} '${target}' (${scope})`);
}

async function changePermissionRuleAction(ruleId, newAction) {
  if (!ruleId) return;
  const cleanAction = newAction === "deny" ? "deny" : "allow";
  if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
  currentApprovalRules = currentApprovalRules.map(normalizeApprovalRule).filter(Boolean);

  let targetRule = currentApprovalRules.find(r => r.ID === ruleId);
  if (!targetRule) {
    // Materialize virtual project/conversation rule into currentApprovalRules
    const scoped = getRulesForScope(activePermissionsDetailScope);
    const found = scoped.find(r => r.ID === ruleId);
    if (found) {
      targetRule = normalizeApprovalRule({
        ...found,
        ID: "rule-" + Date.now(),
        Action: cleanAction
      });
      currentApprovalRules.unshift(targetRule);
    }
  } else {
    targetRule.Action = cleanAction;
    targetRule.action = cleanAction;
  }

  if (targetRule) {
    saveLocalApprovalRulesBackup();
    await persistApprovalRuleToBackend(targetRule, true);
    renderRememberedRulesTable();
    renderPermissionsSummaries();
    renderPermissionsDetail();
    syncGlobalApprovalQueueUI();
    showToast(`Updated rule to ${cleanAction === "deny" ? "Deny" : "Allow"}`);
  }
}

function startEditPermissionRule(ruleId) {
  activeEditingRuleId = ruleId;
  activeAddingSubCategory = null;
  renderPermissionsDetail();
}

function cancelEditPermissionRule() {
  activeEditingRuleId = null;
  renderPermissionsDetail();
}

async function saveEditPermissionRule(ruleId) {
  const actionEl = document.getElementById("edit-perm-action-" + ruleId);
  const targetEl = document.getElementById("edit-perm-target-" + ruleId);
  const newTarget = targetEl ? targetEl.value.trim() : "";
  if (!newTarget) {
    showToast("Rule target cannot be empty");
    if (targetEl) targetEl.focus();
    return;
  }
  const newAction = actionEl && actionEl.value === "deny" ? "deny" : "allow";

  if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
  currentApprovalRules = currentApprovalRules.map(normalizeApprovalRule).filter(Boolean);

  let targetRule = currentApprovalRules.find(r => r.ID === ruleId);
  if (targetRule) {
    targetRule.Command = newTarget;
    targetRule.command = newTarget;
    targetRule.Action = newAction;
    targetRule.action = newAction;
  } else {
    const scoped = getRulesForScope(activePermissionsDetailScope);
    const found = scoped.find(r => r.ID === ruleId);
    targetRule = normalizeApprovalRule({
      ...(found || {}),
      ID: "rule-" + Date.now(),
      Command: newTarget,
      Action: newAction,
      Scope: activePermissionsDetailScope || "global",
      ScopeID: activePermissionsDetailScope === "project" ? (activeSettingsProject || activeProjectPath || ".") : (activePermissionsDetailScope === "conversation" ? (activeConversationId || "active") : "")
    });
    currentApprovalRules.unshift(targetRule);
  }

  activeEditingRuleId = null;
  saveLocalApprovalRulesBackup();
  await persistApprovalRuleToBackend(targetRule, true);
  renderRememberedRulesTable();
  renderPermissionsSummaries();
  renderPermissionsDetail();
  syncGlobalApprovalQueueUI();
  showToast("Permission rule updated");
}

async function deletePermissionRule(ruleId) {
  if (!ruleId) return;
  if (String(ruleId).startsWith("proj-prefix-")) {
    const pref = String(ruleId).replace("proj-prefix-", "");
    const projPath = activeSettingsProject || activeProjectPath || ".";
    if (currentProjectPermissions && currentProjectPermissions[projPath] && currentProjectPermissions[projPath].allowed_commands) {
      const updated = String(currentProjectPermissions[projPath].allowed_commands)
        .split(",")
        .map(s => s.trim())
        .filter(s => s && s.toLowerCase() !== pref.toLowerCase())
        .join(", ");
      currentProjectPermissions[projPath].allowed_commands = updated;
      const inputCmds = document.getElementById("input-project-allowed-commands");
      if (inputCmds) inputCmds.value = updated;
      if (typeof persistProjectPermissions === "function") {
        persistProjectPermissions(projPath);
      }
    }
  }
  await revokeApprovalRule(ruleId);
}
