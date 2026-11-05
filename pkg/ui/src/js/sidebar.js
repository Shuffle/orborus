function deduplicateConversationTurns(turns) {
  if (!Array.isArray(turns) || turns.length <= 1) return Array.isArray(turns) ? turns : [];
  const isIncomplete = (t) => {
    if (!t) return false;
    const out = String(t.output || "").trim();
    const err = String(t.error || "").trim();
    if (out !== "" || err !== "") return false;
    const st = String(t.status || "").toLowerCase().trim();
    return st === "" || st === "running" || st === "in_progress" || st === "interrupted" || st === "pending";
  };
  const cleaned = [];
  for (let i = 0; i < turns.length; i++) {
    const cur = turns[i];
    if (i + 1 < turns.length && isIncomplete(cur)) {
      const next = turns[i + 1];
      const curPrompt = String((cur && cur.prompt) || "").trim().toLowerCase();
      const nextPrompt = String((next && next.prompt) || "").trim().toLowerCase();
      if (curPrompt !== "" && curPrompt === nextPrompt) {
        continue;
      }
    }
    cleaned.push(cur);
  }
  return cleaned;
}

// --- Stored Conversations Storage ---
async function loadStoredConversations() {
  // 1. Try loading from disk via Go backend bridge
  try {
    if (window.listConversations) {
      const raw = await window.listConversations();
      const diskConvs = JSON.parse(raw);
      if (Array.isArray(diskConvs) && diskConvs.length > 0) {
        diskConvs.forEach(c => {
          if (c && Array.isArray(c.turns)) {
            c.turns = deduplicateConversationTurns(c.turns);
          }
        });
        appConversations = diskConvs;
      }
    }
  } catch (err) {
    console.warn("Backend listConversations failed, falling back to localStorage:", err);
  }

  // 2. Fall back / merge with localStorage
  try {
    const rawConvs = localStorage.getItem("orborus_conversations");
    if (rawConvs) {
      const parsed = JSON.parse(rawConvs);
      if (Array.isArray(parsed)) {
        const validLocal = parsed.filter(c => c && c.id && !c.id.startsWith("conv-demo-"));
        validLocal.forEach(c => {
          if (Array.isArray(c.turns)) {
            c.turns = deduplicateConversationTurns(c.turns);
          }
        });
        if (appConversations.length === 0) {
          appConversations = validLocal;
        } else {
          // Merge by ID if not in disk list, and preserve local archived state if already in disk list
          const existingMap = new Map(appConversations.map(c => [c.id, c]));
          validLocal.forEach(c => {
            if (!existingMap.has(c.id)) {
              appConversations.push(c);
            } else {
              const existing = existingMap.get(c.id);
              if (c.archived !== undefined || c.is_archived !== undefined) {
                const isArch = !!(c.archived || c.is_archived || existing.archived || existing.is_archived);
                existing.archived = isArch;
                existing.is_archived = isArch;
              }
            }
          });
        }
      }
    }
    const rawPinned = localStorage.getItem("orborus_pinned_conversations");
    if (rawPinned) {
      const parsed = JSON.parse(rawPinned);
      if (Array.isArray(parsed)) {
        pinnedConversationIds = new Set(parsed.filter(id => typeof id === "string" && !id.startsWith("conv-demo-")));
      }
    }
    if (Array.isArray(appConversations) && appConversations.length > 0) {
      if (typeof conversationOrderIds === "undefined" || !Array.isArray(conversationOrderIds)) {
        conversationOrderIds = [];
      }
      let orderChanged = false;
      appConversations.forEach(c => {
        if (c && c.id && !conversationOrderIds.includes(c.id)) {
          conversationOrderIds.push(c.id);
          orderChanged = true;
        }
      });
      if (orderChanged && typeof saveConversationOrder === "function") {
        saveConversationOrder(conversationOrderIds);
      }
      const orderMap = new Map();
      conversationOrderIds.forEach((id, idx) => orderMap.set(id, idx));
      appConversations.sort((a, b) => {
        const ia = (a && orderMap.has(a.id)) ? orderMap.get(a.id) : 999999;
        const ib = (b && orderMap.has(b.id)) ? orderMap.get(b.id) : 999999;
        return ia - ib;
      });
    }
  } catch (err) {
    console.warn("Failed to load stored conversations from localStorage:", err);
  }
}

let _saveConvsTimer = null;
function scheduleLocalConversationsSave() {
  if (_saveConvsTimer) clearTimeout(_saveConvsTimer);
  _saveConvsTimer = setTimeout(() => {
    _saveConvsTimer = null;
    try {
      localStorage.setItem("orborus_conversations", JSON.stringify(appConversations));
      localStorage.setItem("orborus_pinned_conversations", JSON.stringify(Array.from(pinnedConversationIds)));
    } catch (err) {
      console.warn("Failed to save conversations to storage:", err);
    }
  }, 120);
}

async function saveStoredConversations() {
  if (Array.isArray(appConversations)) {
    appConversations.forEach(c => {
      if (c && Array.isArray(c.turns)) {
        c.turns = deduplicateConversationTurns(c.turns);
      }
    });
  }
  scheduleLocalConversationsSave();

  // Also sync active conversation to disk via bridge if present
  if (activeConversationId && window.saveConversation) {
    const cur = appConversations.find(c => c.id === activeConversationId);
    if (cur) {
      try {
        await window.saveConversation(cur);
      } catch (e) {
        console.warn("Failed to save conversation to disk:", e);
      }
    }
  }
}


// --- Repository Scanner, Project Tree & Conversation Selection ---
async function scanRepositories() {
  const btn = document.getElementById("btn-scan-repos");
  if (btn) btn.classList.add("spinning");

  try {
    if (window.listProjects) {
      const raw = await window.listProjects();
      const projects = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(projects)) {
        if (typeof mergeProjects === "function") {
          mergeProjects(projects);
        } else {
          const existing = new Set(allProjects.map(p => (p.Path || p.path || "").toLowerCase()));
          projects.forEach(p => {
            const pPath = (p.Path || p.path || "").toLowerCase();
            if (pPath && !existing.has(pPath)) {
              allProjects.push(p);
              existing.add(pPath);
            }
          });
        }
      }
      renderProjectTree();
      renderSettingsProjectsList();
    } else {
      renderProjectTree();
      renderSettingsProjectsList();
    }
  } catch (err) {
    console.error("Scan error:", err);
    renderProjectTree();
  } finally {
    if (btn) btn.classList.remove("spinning");
    const scanLoading = document.getElementById("sidebar-scan-loading");
    if (scanLoading) scanLoading.remove();
  }
}

function toggleProjectsFilter() {
  const box = document.getElementById("project-filter-box");
  const input = document.getElementById("sidebar-project-filter");
  if (!box) return;
  isProjectsFilterOpen = !isProjectsFilterOpen;
  box.classList.toggle("visible", isProjectsFilterOpen);
  if (isProjectsFilterOpen && input) {
    input.focus();
    input.select();
  } else if (!isProjectsFilterOpen) {
    projectFilterQuery = "";
    if (input) input.value = "";
    renderProjectTree();
  }
}

function filterProjectTree(query) {
  projectFilterQuery = (query || "").toLowerCase().trim();
  renderProjectTree();
}

function toggleProjectCollapse(projectPath, event) {
  if (event) event.stopPropagation();
  collapsedProjects[projectPath] = !collapsedProjects[projectPath];
  try {
    localStorage.setItem("orborus_collapsed_projects", JSON.stringify(collapsedProjects));
  } catch (e) {}
  renderProjectTree();
}

async function togglePinConversation(convId, event) {
  if (event) event.stopPropagation();
  if (pinnedConversationIds.has(convId)) {
    pinnedConversationIds.delete(convId);
    showToast("Unpinned conversation");
  } else {
    pinnedConversationIds.add(convId);
    showToast("Pinned conversation to top");
  }

  // Update in-memory conv objects
  const conv = appConversations.find(c => c.id === convId);
  if (conv) conv.pinned = pinnedConversationIds.has(convId);

  // Optimistic UI update immediately
  renderProjectTree();
  saveStoredConversations();

  // Persist to backend in background
  if (window.setPinnedConversations) {
    try {
      window.setPinnedConversations(JSON.stringify(Array.from(pinnedConversationIds))).catch(() => {});
    } catch (e) {
      console.warn("setPinnedConversations error:", e);
    }
  }
}

async function selectConversation(convId) {
  if (!convId) return;
  if (activeConversationId && activeConversationId !== convId && typeof saveCurrentConversationScrollState === "function") {
    saveCurrentConversationScrollState(activeConversationId);
  }
  activeConversationId = convId;
  localStorage.setItem("orborus_active_conv_id", convId);
  if (typeof markConversationRead === "function") {
    markConversationRead(convId);
  }

  // 1. Optimistic instant switch (0ms latency)
  let cachedConv = (appConversations || []).find(c => c && c.id === convId);
  const cachedTurnCount = (cachedConv && Array.isArray(cachedConv.turns)) ? cachedConv.turns.length : -1;
  const cachedUpdatedAt = cachedConv ? (cachedConv.updated_at || "") : "";
  if (cachedConv) {
    const projPath = cachedConv.projectId !== undefined ? cachedConv.projectId : (cachedConv.project_id !== undefined ? cachedConv.project_id : "");
    const projName = cachedConv.projectName || cachedConv.project_name || (projPath === "" ? "No project" : undefined);
    if (projPath !== activeProjectPath && !(projPath === "." && activeProjectPath && activeProjectPath !== ".")) {
      setActiveProject(projPath, projName);
    }
    const lastTurnModel = typeof getLastMessageModelFromConv === "function" ? getLastMessageModelFromConv(cachedConv) : "";
    const convModel = lastTurnModel || cachedConv.model || cachedConv.ai_model || (typeof getRememberedModelForType === "function" ? getRememberedModelForType(projPath) : null);
    if (convModel) {
      cachedConv.model = convModel;
      if (typeof applyModelSelectionFromHistory === "function") {
        applyModelSelectionFromHistory(convModel, projPath);
      } else {
        activeAiModel = convModel;
        if (typeof window !== "undefined") window.activeAiModel = convModel;
        localStorage.setItem("orborus_ai_model", convModel);
      }
    }
    const convReasoning = cachedConv.reasoning || (typeof getRememberedReasoningForType === "function" ? getRememberedReasoningForType(projPath) : null);
    if (convReasoning) {
      activeReasoningEffort = convReasoning;
      if (typeof window !== "undefined") window.activeReasoningEffort = convReasoning;
      localStorage.setItem("orborus_ai_reasoning", convReasoning);
    }
    if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
    if (typeof updateActiveReasoningLabel === "function") updateActiveReasoningLabel();
  }
  renderProjectTree();
  renderActiveConversation();

  // 2. Fetch full conversation transcript from backend disk in background
  if (window.getConversation) {
    try {
      const raw = await window.getConversation(convId);
      const diskConv = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (diskConv && diskConv.id && !diskConv.error) {
        const inferredDiskModel = (typeof getLastMessageModelFromConv === "function" ? getLastMessageModelFromConv(diskConv) : "") || diskConv.model || diskConv.ai_model || (cachedConv && cachedConv.model);
        if (inferredDiskModel) {
          diskConv.model = inferredDiskModel;
        }
        // Preserve in-memory archived status if cachedConv already had an explicit archived state
        if (cachedConv && (cachedConv.archived !== undefined || cachedConv.is_archived !== undefined)) {
          const isArch = !!(cachedConv.archived || cachedConv.is_archived);
          diskConv.archived = isArch;
          diskConv.is_archived = isArch;
        } else if (diskConv.archived !== undefined || diskConv.is_archived !== undefined) {
          const isArch = !!(diskConv.archived || diskConv.is_archived);
          diskConv.archived = isArch;
          diskConv.is_archived = isArch;
        }
        if (!Array.isArray(appConversations)) appConversations = [];
        const idx = appConversations.findIndex(c => c && c.id === convId);
        if (idx !== -1) {
          if (typeof isPromptExecuting !== "undefined" && isPromptExecuting &&
              typeof runningConversationId !== "undefined" && runningConversationId === convId) {
            const currentConv = appConversations[idx];
            if (currentConv && Array.isArray(currentConv.turns) && currentConv.turns.length > 0) {
              const lastTurn = currentConv.turns[currentConv.turns.length - 1];
              if (lastTurn && (lastTurn.status === "running" || lastTurn.status === "in_progress")) {
                if (!Array.isArray(diskConv.turns)) diskConv.turns = [];
                const existingIdx = diskConv.turns.findIndex(t => t.id === lastTurn.id);
                if (existingIdx !== -1) {
                  diskConv.turns[existingIdx] = lastTurn;
                } else {
                  diskConv.turns.push(lastTurn);
                }
              }
            }
          }
          appConversations[idx] = diskConv;
        } else {
          appConversations.unshift(diskConv);
        }
        if (activeConversationId === convId) {
          const diskModel = (typeof getLastMessageModelFromConv === "function" ? getLastMessageModelFromConv(diskConv) : "") || diskConv.model || diskConv.ai_model;
          if (diskModel) {
            diskConv.model = diskModel;
            if (typeof applyModelSelectionFromHistory === "function") {
              applyModelSelectionFromHistory(diskModel, diskConv.projectId || diskConv.project_id || "");
            } else {
              activeAiModel = diskModel;
              if (typeof window !== "undefined") window.activeAiModel = diskModel;
              localStorage.setItem("orborus_ai_model", diskModel);
            }
          }
          if (diskConv.reasoning) {
            activeReasoningEffort = diskConv.reasoning;
            if (typeof window !== "undefined") window.activeReasoningEffort = diskConv.reasoning;
            localStorage.setItem("orborus_ai_reasoning", diskConv.reasoning);
          }
          if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
          if (typeof updateActiveReasoningLabel === "function") updateActiveReasoningLabel();
          const diskTurnCount = Array.isArray(diskConv.turns) ? diskConv.turns.length : 0;
          const diskUpdatedAt = diskConv.updated_at || "";
          if (cachedTurnCount !== diskTurnCount || cachedUpdatedAt !== diskUpdatedAt) {
            renderActiveConversation();
          }
          if (typeof renderTerminalLogs === "function") {
            renderTerminalLogs();
          }
        }
        scheduleLocalConversationsSave();
      }
    } catch (e) {
      console.warn("Failed to fetch fresh conversation from disk:", e);
    }
  }
  if (typeof renderTerminalLogs === "function") {
    renderTerminalLogs();
  }
}

async function archiveConversation(convId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (!convId) return;
  const conv = (appConversations || []).find(c => c && c.id === convId);
  if (!conv) return;

  // Mark archived immediately in memory
  conv.archived = true;
  conv.is_archived = true;
  conv.updated_at = new Date().toISOString();

  // If pinned, also remove from pinned
  if (pinnedConversationIds.has(convId)) {
    pinnedConversationIds.delete(convId);
    if (window.setPinnedConversations) {
      try {
        window.setPinnedConversations(JSON.stringify(Array.from(pinnedConversationIds))).catch(() => {});
      } catch (e) {}
    }
  }

  // If this was the active conversation, switch to another non-archived chat or start fresh session
  if (activeConversationId === convId) {
    const nextConv = (appConversations || []).find(c => c && c.id !== convId && !c.archived && !c.is_archived);
    if (nextConv) {
      activeConversationId = nextConv.id;
      localStorage.setItem("orborus_active_conv_id", nextConv.id);
      renderActiveConversation();
    } else {
      startNewSession();
    }
  }

  // Immediately re-render sidebar so it disappears from sidebar without delay
  renderProjectTree();

  // Save to storage
  saveStoredConversations();

  // Fast disk sync via dedicated backend endpoint if available, fallback to saveConversation
  if (window.archiveConversationBackend) {
    try {
      await window.archiveConversationBackend(convId);
    } catch (e) {
      console.warn("archiveConversationBackend error:", e);
    }
  } else if (window.saveConversation) {
    try {
      await window.saveConversation(conv);
    } catch (e) {
      console.warn("Failed to save archived conversation:", e);
    }
  }

  // Update history list if modal is open
  if (typeof refreshHistoryModalView === "function") {
    refreshHistoryModalView();
  } else if (typeof renderHistoryList === "function" && typeof getCombinedHistory === "function") {
    const allItems = getCombinedHistory();
    renderHistoryList(allItems);
  }

  showToast("Conversation archived");
}

async function unarchiveConversation(convId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (!convId) return;
  const conv = (appConversations || []).find(c => c && c.id === convId);
  if (!conv) return;

  conv.archived = false;
  conv.is_archived = false;
  conv.updated_at = new Date().toISOString();

  saveStoredConversations();

  if (window.unarchiveConversationBackend) {
    try {
      await window.unarchiveConversationBackend(convId);
    } catch (e) {
      console.warn("unarchiveConversationBackend error:", e);
    }
  } else if (window.saveConversation) {
    try {
      await window.saveConversation(conv);
    } catch (e) {
      console.warn("Failed to save unarchived conversation:", e);
    }
  }

  renderProjectTree();
  if (typeof renderActiveConversation === "function") {
    renderActiveConversation();
  }
  if (typeof refreshHistoryModalView === "function") {
    refreshHistoryModalView();
  } else if (typeof renderHistoryList === "function" && typeof getCombinedHistory === "function") {
    const allItems = getCombinedHistory();
    renderHistoryList(allItems);
  }
  showToast("Conversation unarchived and restored to sidebar");
}

async function unarchiveActiveConversation(event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (!activeConversationId) return;
  await unarchiveConversation(activeConversationId, event);
}

async function unarchiveAndOpenConversation(convId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (!convId) return;
  await unarchiveConversation(convId, event);
  if (typeof closeHistoryModal === "function") {
    closeHistoryModal();
  }
  if (typeof selectConversation === "function") {
    await selectConversation(convId);
  }
}

var _sidebarDragState = null;
var _lastSidebarDragEnd = 0;

function clearSidebarDragStyles() {
  const tree = document.getElementById("sidebar-project-tree");
  if (!tree) return;
  tree.querySelectorAll(".dragging, .drag-over-top, .drag-over-bottom, .drag-over-project").forEach(el => {
    el.classList.remove("dragging", "drag-over-top", "drag-over-bottom", "drag-over-project");
  });
}

function sortConvsStable(convList) {
  if (!Array.isArray(convList) || convList.length <= 1) return Array.isArray(convList) ? [...convList] : [];
  if (typeof conversationOrderIds === "undefined" || !Array.isArray(conversationOrderIds)) {
    conversationOrderIds = [];
  }
  let orderChanged = false;
  (appConversations || []).forEach(c => {
    if (c && c.id && !conversationOrderIds.includes(c.id)) {
      conversationOrderIds.push(c.id);
      orderChanged = true;
    }
  });
  convList.forEach(c => {
    if (c && c.id && !conversationOrderIds.includes(c.id)) {
      conversationOrderIds.push(c.id);
      orderChanged = true;
    }
  });
  if (orderChanged && typeof saveConversationOrder === "function") {
    saveConversationOrder(conversationOrderIds);
  }
  const orderMap = new Map();
  conversationOrderIds.forEach((id, idx) => orderMap.set(id, idx));

  return [...convList].sort((a, b) => {
    const aPinned = typeof pinnedConversationIds !== "undefined" && pinnedConversationIds.has(a.id);
    const bPinned = typeof pinnedConversationIds !== "undefined" && pinnedConversationIds.has(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    const ia = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
    const ib = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
    return ia - ib;
  });
}

function reorderSidebarProject(draggedPath, targetPath, insertAfter) {
  const getNorm = (typeof normPath === "function") ? normPath : (p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
  const draggedNorm = getNorm(draggedPath);
  const targetNorm = getNorm(targetPath);
  if (!draggedNorm || !targetNorm || draggedNorm === targetNorm) return;

  const currentPaths = [];
  const seen = new Set();
  if (typeof projectOrderPaths !== "undefined" && Array.isArray(projectOrderPaths)) {
    projectOrderPaths.forEach(p => {
      const k = getNorm(p);
      if (k && !seen.has(k)) {
        seen.add(k);
        currentPaths.push(k);
      }
    });
  }
  (allProjects || []).forEach(p => {
    const k = getNorm(p && (p.Path || p.path));
    if (k && !seen.has(k)) {
      seen.add(k);
      currentPaths.push(k);
    }
  });
  if (!seen.has(draggedNorm)) {
    seen.add(draggedNorm);
    currentPaths.push(draggedNorm);
  }
  if (!seen.has(targetNorm)) {
    seen.add(targetNorm);
    currentPaths.push(targetNorm);
  }

  const withoutDragged = currentPaths.filter(k => k !== draggedNorm);
  const targetIdx = withoutDragged.indexOf(targetNorm);
  if (targetIdx === -1) return;

  const insertIdx = insertAfter ? targetIdx + 1 : targetIdx;
  withoutDragged.splice(insertIdx, 0, draggedNorm);

  if (typeof saveProjectOrder === "function") {
    saveProjectOrder(withoutDragged);
  } else {
    projectOrderPaths = withoutDragged;
  }
  if (typeof sortProjectsByStoredOrder === "function") {
    allProjects = sortProjectsByStoredOrder(allProjects);
  }
  if (typeof saveStoredProjects === "function") {
    saveStoredProjects();
  }
  renderProjectTree();
  if (typeof renderSettingsProjectsList === "function") {
    renderSettingsProjectsList();
  }
}

function reorderSidebarConversation(draggedConvId, targetConvId, insertAfter, targetProjectPath, targetProjectName) {
  if (!draggedConvId || !targetConvId || draggedConvId === targetConvId) return;
  if (!Array.isArray(appConversations)) return;

  const draggedConv = appConversations.find(c => c && c.id === draggedConvId);
  const targetConv = appConversations.find(c => c && c.id === targetConvId);
  if (!draggedConv || !targetConv) return;

  const getNorm = (typeof normPath === "function") ? normPath : (p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
  const resolvedProjPath = targetProjectPath !== undefined ? targetProjectPath : (targetConv.projectId || targetConv.project_id || "");
  const resolvedProjName = targetProjectName !== undefined ? targetProjectName : (targetConv.projectName || targetConv.project_name || "");

  const oldProjNorm = getNorm(draggedConv.projectId || draggedConv.project_id || "");
  const newProjNorm = getNorm(resolvedProjPath);
  const projectChanged = oldProjNorm !== newProjNorm;

  if (projectChanged) {
    draggedConv.projectId = resolvedProjPath;
    draggedConv.project_id = resolvedProjPath;
    draggedConv.projectName = resolvedProjName;
    draggedConv.project_name = resolvedProjName;
    if (draggedConv.id === activeConversationId && typeof setActiveProject === "function") {
      setActiveProject(resolvedProjPath, resolvedProjName || (resolvedProjPath ? resolvedProjPath.split(/[/\\]/).filter(Boolean).pop() : "No project"));
    }
  }

  if (typeof conversationOrderIds === "undefined" || !Array.isArray(conversationOrderIds)) {
    conversationOrderIds = [];
  }
  appConversations.forEach(c => {
    if (c && c.id && !conversationOrderIds.includes(c.id)) {
      conversationOrderIds.push(c.id);
    }
  });

  const withoutDragged = conversationOrderIds.filter(id => id !== draggedConvId);
  const targetIdx = withoutDragged.indexOf(targetConvId);
  if (targetIdx === -1) {
    withoutDragged.unshift(draggedConvId);
  } else {
    const insertIdx = insertAfter ? targetIdx + 1 : targetIdx;
    withoutDragged.splice(insertIdx, 0, draggedConvId);
  }

  if (typeof saveConversationOrder === "function") {
    saveConversationOrder(withoutDragged);
  } else {
    conversationOrderIds = withoutDragged;
  }

  const orderMap = new Map();
  conversationOrderIds.forEach((id, idx) => orderMap.set(id, idx));
  appConversations.sort((a, b) => {
    const ia = (a && orderMap.has(a.id)) ? orderMap.get(a.id) : 999999;
    const ib = (b && orderMap.has(b.id)) ? orderMap.get(b.id) : 999999;
    return ia - ib;
  });

  saveStoredConversations(projectChanged ? draggedConv : undefined);
  renderProjectTree();
}

function moveConversationToProject(draggedConvId, targetProjectPath, targetProjectName) {
  if (!draggedConvId || !Array.isArray(appConversations)) return;
  const draggedConv = appConversations.find(c => c && c.id === draggedConvId);
  if (!draggedConv) return;

  const resolvedProjPath = targetProjectPath || "";
  const resolvedProjName = targetProjectName || (resolvedProjPath ? (resolvedProjPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "");

  draggedConv.projectId = resolvedProjPath;
  draggedConv.project_id = resolvedProjPath;
  draggedConv.projectName = resolvedProjName;
  draggedConv.project_name = resolvedProjName;

  const collapseKey = resolvedProjPath || "__unassigned__";
  if (typeof collapsedProjects !== "undefined" && collapsedProjects) {
    collapsedProjects[collapseKey] = false;
    try {
      localStorage.setItem("orborus_collapsed_projects", JSON.stringify(collapsedProjects));
    } catch (e) {}
  }

  if (typeof conversationOrderIds === "undefined" || !Array.isArray(conversationOrderIds)) {
    conversationOrderIds = [];
  }
  const withoutDragged = conversationOrderIds.filter(id => id !== draggedConvId);
  withoutDragged.unshift(draggedConvId);
  if (typeof saveConversationOrder === "function") {
    saveConversationOrder(withoutDragged);
  } else {
    conversationOrderIds = withoutDragged;
  }

  const orderMap = new Map();
  conversationOrderIds.forEach((id, idx) => orderMap.set(id, idx));
  appConversations.sort((a, b) => {
    const ia = (a && orderMap.has(a.id)) ? orderMap.get(a.id) : 999999;
    const ib = (b && orderMap.has(b.id)) ? orderMap.get(b.id) : 999999;
    return ia - ib;
  });

  if (draggedConv.id === activeConversationId && typeof setActiveProject === "function") {
    setActiveProject(resolvedProjPath, resolvedProjName || "No project");
  }

  saveStoredConversations(draggedConv);
  renderProjectTree();
}

function createConvRowElement(conv, groupProjectPath, groupProjectName) {
  const isCur = conv.id === activeConversationId;
  const isPinned = pinnedConversationIds.has(conv.id);
  const isRunning = !!(typeof isPromptExecuting !== "undefined" && isPromptExecuting &&
                       typeof runningConversationId !== "undefined" && runningConversationId === conv.id);
  const isWaitingApproval = Array.isArray(globalApprovalQueue) && globalApprovalQueue.some(q =>
    (q.conversation_id && q.conversation_id === conv.id) || (!q.conversation_id && isRunning)
  );
  const isUnread = !isCur && !isRunning && !isWaitingApproval &&
    ((typeof unreadConversationIds !== "undefined" && unreadConversationIds.has(conv.id)) || Boolean(conv.unread));

  const effectiveProjPath = groupProjectPath !== undefined ? groupProjectPath : (conv.projectId || conv.project_id || "");
  const effectiveProjName = groupProjectName !== undefined ? groupProjectName : (conv.projectName || conv.project_name || "");

  const convRow = document.createElement("div");
  convRow.className = "conversation-row" + (isCur ? " active" : "") + (isPinned ? " pinned" : "") + ((isRunning || isWaitingApproval) ? " running" : "") + (isWaitingApproval ? " waiting-approval" : "") + (isUnread ? " unread" : "");
  convRow.draggable = true;
  convRow.dataset.convId = conv.id;

  convRow.addEventListener("dragstart", (e) => {
    if (e.target && e.target.closest(".conversation-actions")) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    _sidebarDragState = {
      type: "conversation",
      convId: conv.id,
      projectPath: effectiveProjPath
    };
    convRow.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", conv.id);
      } catch (_) {}
    }
  });

  convRow.addEventListener("dragend", (e) => {
    e.stopPropagation();
    _lastSidebarDragEnd = Date.now();
    _sidebarDragState = null;
    clearSidebarDragStyles();
  });

  convRow.addEventListener("dragover", (e) => {
    if (!_sidebarDragState || _sidebarDragState.type !== "conversation") return;
    if (_sidebarDragState.convId === conv.id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = convRow.getBoundingClientRect();
    const isAfter = (e.clientY - rect.top) > (rect.height / 2);
    convRow.classList.remove("drag-over-top", "drag-over-bottom");
    convRow.classList.add(isAfter ? "drag-over-bottom" : "drag-over-top");
  });

  convRow.addEventListener("dragleave", (e) => {
    if (!convRow.contains(e.relatedTarget)) {
      convRow.classList.remove("drag-over-top", "drag-over-bottom");
    }
  });

  convRow.addEventListener("drop", (e) => {
    if (!_sidebarDragState || _sidebarDragState.type !== "conversation") return;
    e.preventDefault();
    e.stopPropagation();
    const draggedId = _sidebarDragState.convId;
    const rect = convRow.getBoundingClientRect();
    const isAfter = (e.clientY - rect.top) > (rect.height / 2);
    _sidebarDragState = null;
    clearSidebarDragStyles();
    if (draggedId && draggedId !== conv.id) {
      reorderSidebarConversation(draggedId, conv.id, isAfter, effectiveProjPath, effectiveProjName);
    }
  });

  convRow.onclick = (e) => {
    if (Date.now() - _lastSidebarDragEnd < 150) return;
    if (e.target && e.target.closest(".conversation-actions") && !e.target.closest(".conversation-unread-wrap")) return;
    selectConversation(conv.id);
  };

  convRow.innerHTML = `
    <div class="conversation-row-left">
      <span class="conversation-title" title="${escapeHtml(conv.title || "Conversation")}">${escapeHtml(conv.title || "Conversation")}</span>
    </div>
    <div class="conversation-actions">
      <button class="btn-pin-toggle ${isPinned ? "active" : ""}" title="${isPinned ? "Unpin conversation" : "Pin conversation to top"}" onclick="togglePinConversation('${escapeJsAttr(conv.id)}', event)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="${isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v8M5 10l7 2 7-2M7 10v6l5 4 5-4v-6"/>
        </svg>
      </button>
      <button class="btn-archive-toggle" title="Archive conversation (moves to Conversation History)" onclick="archiveConversation('${escapeJsAttr(conv.id)}', event)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
      </button>
      ${(isRunning || isWaitingApproval) ? `
        <div class="conversation-running-wrap ${isWaitingApproval ? "waiting-approval" : ""}" title="${isWaitingApproval ? "Waiting for approval... click to stop" : "Running... click to stop"}" onclick="event.stopPropagation(); stopExecution('${escapeJsAttr(conv.id)}');">
          ${isWaitingApproval
            ? `<span class="conversation-approval-badge">Approval</span>`
            : `<span class="conversation-spinner"></span>`}
          <button class="conversation-abort-btn" type="button" title="Stop execution" onclick="event.stopPropagation(); stopExecution('${escapeJsAttr(conv.id)}');">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2"/>
            </svg>
          </button>
        </div>
      ` : (isUnread ? `
        <div class="conversation-unread-wrap" title="Finished — click to view">
          <span class="conversation-unread-dot"></span>
        </div>
      ` : "")}
    </div>
  `;
  return convRow;
}

function renderProjectTree() {
  const treeContainer = document.getElementById("sidebar-project-tree");
  const dropdownContainer = document.getElementById("project-items");
  const repoCount = document.getElementById("repo-count");

  if (treeContainer) {
    treeContainer.innerHTML = "";
  }

  // Only non-archived conversations should ever show up in the sidebar
  const nonArchivedConvs = (appConversations || []).filter(c => c && !c.archived && !c.is_archived);

  // Helper for sorting conversations: pinned first, then stable custom order (never auto-reorders on click)
  const sortConvs = (convList) => sortConvsStable(convList);

  const normPath = p => (p || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const filterQuery = (projectFilterQuery || "").toLowerCase().trim();

  // Combine projects from allProjects, stored conversations, and activeProjectPath in stable order
  const projectMap = new Map();

  allProjects.forEach(p => {
    if (p && (p.Path || p.path)) {
      const pPath = p.Path || p.path;
      const key = normPath(pPath);
      if (key && !projectMap.has(key)) {
        projectMap.set(key, {
          Name: p.Name || p.name || (pPath === "." ? "Active Workspace" : (pPath.split(/[/\\]/).filter(Boolean).pop() || "Project")),
          Path: pPath
        });
      }
    }
  });

  // Extract and map any projects derived from conversations!
  (appConversations || []).forEach(c => {
    if (!c || c.archived || c.is_archived) return;
    const pId = c.projectId || c.project_id;
    const pName = c.projectName || c.project_name;
    if (pId) {
      const key = normPath(pId);
      if (key && !projectMap.has(key)) {
        projectMap.set(key, {
          Name: pName || (pId === "." ? "Active Workspace" : (pId.split(/[/\\]/).filter(Boolean).pop() || "Project")),
          Path: pId
        });
      }
    }
  });

  if (activeProjectPath && activeProjectPath !== "") {
    const activeKey = normPath(activeProjectPath);
    if (activeKey && !projectMap.has(activeKey)) {
      let activeName = (document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : "") || "";
      if (!activeName || activeName === "Orborus Agent Runner" || activeName === "Local Workspace") {
        activeName = activeProjectPath === "." ? "Active Workspace" : (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Active Workspace");
      }
      projectMap.set(activeKey, {
        Name: activeName,
        Path: activeProjectPath
      });
    }
  }

  let projectsList = Array.from(projectMap.values());
  if (typeof sortProjectsByStoredOrder === "function") {
    projectsList = sortProjectsByStoredOrder(projectsList);
  }
  if (repoCount) {
    repoCount.innerText = projectsList.length > 0 ? (projectsList.length + " found") : "";
  }

  // Keep dropdown updated
  if (dropdownContainer) {
    dropdownContainer.innerHTML = "";

    const noProjItem = document.createElement("div");
    const isNoProjCur = normPath(activeProjectPath) === "";
    noProjItem.className = "dropdown-item" + (isNoProjCur ? " active" : "");
    noProjItem.innerHTML = `
      <span class="dropdown-item-name" style="font-style: italic;">No project</span>
      <span class="dropdown-item-path">Independent conversation</span>
    `;
    noProjItem.onclick = () => {
      selectProject("", "No project");
      toggleProjectDropdown(null, false);
    };
    dropdownContainer.appendChild(noProjItem);

    projectsList.forEach(p => {
      const name = p.Name || p.Path.split(/[/\\]/).filter(Boolean).pop() || "Project";
      const isCur = normPath(p.Path) === normPath(activeProjectPath);
      const dropItem = document.createElement("div");
      dropItem.className = "dropdown-item" + (isCur ? " active" : "");
      dropItem.innerHTML = `
        <span class="dropdown-item-name">${escapeHtml(name)}</span>
        <span class="dropdown-item-path">${escapeHtml(p.Path)}${(typeof getProjectFoldersList === "function" && getProjectFoldersList(p.Path).length > 1) ? ` (+${getProjectFoldersList(p.Path).length - 1} attached)` : ""}</span>
      `;
      dropItem.onclick = () => {
        selectProject(p.Path, name);
        toggleProjectDropdown(null, false);
      };
      dropdownContainer.appendChild(dropItem);
    });
  }

  if (!treeContainer) return;

  // Case 1: No projects / repositories found at all
  if (projectsList.length === 0) {
    let convsToShow = [...nonArchivedConvs];
    if (filterQuery) {
      convsToShow = convsToShow.filter(c => 
        (c.title || "").toLowerCase().includes(filterQuery) || 
        (c.prompt || "").toLowerCase().includes(filterQuery)
      );
    }
    const sorted = sortConvs(convsToShow);

    if (sorted.length === 0) {
      treeContainer.innerHTML = `
        <div style="font-size:12px; color:var(--text-muted); padding:8px 10px;">
          ${filterQuery ? "No matching conversations found." : "No active conversations. Start a new chat above!"}
        </div>
      `;
      return;
    }

    const convsList = document.createElement("div");
    convsList.className = "project-conversations-list";
    convsList.style.display = "flex";
    convsList.style.flexDirection = "column";
    sorted.forEach(conv => {
      convsList.appendChild(createConvRowElement(conv, "", ""));
    });
    treeContainer.appendChild(convsList);
    return;
  }

  // Case 2: One or more projects exist
  const renderedConvIds = new Set();

  projectsList.forEach(proj => {
    const projName = proj.Name || proj.Path.split(/[/\\]/).filter(Boolean).pop() || "Project";
    const isCollapsed = !!collapsedProjects[proj.Path];
    const projNorm = normPath(proj.Path);
    const activeNorm = normPath(activeProjectPath);

    let convs = nonArchivedConvs.filter(c => {
      const cPath = normPath(c.projectId || c.project_id);
      return cPath && cPath === projNorm;
    });

    if (convs.length === 0 && (projNorm === activeNorm || projNorm === ".") && activeNorm !== "") {
      convs = nonArchivedConvs.filter(c => {
        const cPath = normPath(c.projectId || c.project_id);
        return cPath && (cPath === "." || cPath === activeNorm);
      });
    }

    // Apply search filter if active
    if (filterQuery) {
      const matchProj = projName.toLowerCase().includes(filterQuery) || proj.Path.toLowerCase().includes(filterQuery);
      const matchingConvs = convs.filter(c => 
        (c.title || "").toLowerCase().includes(filterQuery) || 
        (c.prompt || "").toLowerCase().includes(filterQuery)
      );
      if (!matchProj && matchingConvs.length === 0) {
        return; // filter out
      }
      if (!matchProj && matchingConvs.length > 0) {
        convs = matchingConvs;
      }
    }

    convs.forEach(c => renderedConvIds.add(c.id));
    const sortedConvs = sortConvs(convs);

    const projGroup = document.createElement("div");
    projGroup.className = "project-group" + (isCollapsed ? " collapsed" : "");
    projGroup.dataset.projectPath = proj.Path;

    const folderRow = document.createElement("div");
    folderRow.className = "project-folder-row" + (projNorm && projNorm === activeNorm ? " active" : "");
    folderRow.draggable = true;
    folderRow.dataset.projectPath = proj.Path;

    folderRow.addEventListener("dragstart", (e) => {
      if (e.target && e.target.closest(".project-folder-right")) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      _sidebarDragState = {
        type: "project",
        path: proj.Path,
        norm: projNorm
      };
      projGroup.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", proj.Path);
        } catch (_) {}
      }
    });

    folderRow.addEventListener("dragend", (e) => {
      e.stopPropagation();
      _lastSidebarDragEnd = Date.now();
      _sidebarDragState = null;
      clearSidebarDragStyles();
    });

    projGroup.addEventListener("dragover", (e) => {
      if (!_sidebarDragState) return;
      if (_sidebarDragState.type === "project") {
        if (_sidebarDragState.norm === projNorm) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = projGroup.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > (rect.height / 2);
        projGroup.classList.remove("drag-over-top", "drag-over-bottom");
        projGroup.classList.add(isAfter ? "drag-over-bottom" : "drag-over-top");
      } else if (_sidebarDragState.type === "conversation") {
        // Allow dropping a conversation onto the project header or empty project group
        if (e.target && e.target.closest(".conversation-row")) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        folderRow.classList.add("drag-over-project");
      }
    });

    projGroup.addEventListener("dragleave", (e) => {
      if (!projGroup.contains(e.relatedTarget)) {
        projGroup.classList.remove("drag-over-top", "drag-over-bottom");
        folderRow.classList.remove("drag-over-project");
      }
    });

    projGroup.addEventListener("drop", (e) => {
      if (!_sidebarDragState) return;
      if (_sidebarDragState.type === "project") {
        e.preventDefault();
        e.stopPropagation();
        const draggedPath = _sidebarDragState.path;
        const rect = projGroup.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > (rect.height / 2);
        _sidebarDragState = null;
        clearSidebarDragStyles();
        if (draggedPath && normPath(draggedPath) !== projNorm) {
          reorderSidebarProject(draggedPath, proj.Path, isAfter);
        }
      } else if (_sidebarDragState.type === "conversation") {
        if (e.target && e.target.closest(".conversation-row")) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedConvId = _sidebarDragState.convId;
        _sidebarDragState = null;
        clearSidebarDragStyles();
        if (draggedConvId) {
          moveConversationToProject(draggedConvId, proj.Path, projName);
        }
      }
    });

    folderRow.onclick = (e) => {
      if (Date.now() - _lastSidebarDragEnd < 150) return;
      if (e.target && e.target.closest(".btn-project-settings")) return;
      const targetConvId = sortedConvs.length > 0 ? sortedConvs[0].id : null;
      const isAlreadyInProjectConv = Boolean(projNorm && projNorm === activeNorm) &&
        (sortedConvs.length > 0 ? sortedConvs.some(c => c.id === activeConversationId) : !activeConversationId);
      if (!isAlreadyInProjectConv) {
        selectProject(proj.Path, projName, { switchConversation: true, targetConvId: targetConvId });
      } else {
        toggleProjectCollapse(proj.Path, e);
      }
    };

    const folderIconSvg = isCollapsed
      ? `<svg class="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
         </svg>`
      : `<svg class="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
         </svg>`;

    folderRow.innerHTML = `
      <div class="project-folder-left">
        ${folderIconSvg}
        <span class="project-folder-title" title="${escapeHtml((typeof getProjectFoldersList === "function" ? getProjectFoldersList(proj.Path) : [proj.Path]).join("\n"))}">${escapeHtml(projName)}</span>
        ${(typeof getProjectFoldersList === "function" && getProjectFoldersList(proj.Path).length > 1) ? `<span style="font-size:10px; color:var(--text-muted); background:rgba(255, 255, 255, 0.05); padding:0px 5px; border-radius:4px; flex-shrink:0;" title="${escapeHtml("Primary folders attached (" + getProjectFoldersList(proj.Path).length + "/5):\n" + getProjectFoldersList(proj.Path).join("\n"))}">${getProjectFoldersList(proj.Path).length}/5</span>` : ""}
      </div>
      <div class="project-folder-right">
        <button type="button" class="btn-project-settings" title="Project settings" onclick="openProjectSettings('${escapeJsAttr(proj.Path)}', '${escapeJsAttr(projName)}', event)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <span class="project-conv-count">${sortedConvs.length}</span>
      </div>
    `;

    const folderIconEl = folderRow.querySelector(".project-folder-icon");
    if (folderIconEl) {
      folderIconEl.onclick = (e) => {
        e.stopPropagation();
        toggleProjectCollapse(proj.Path, e);
      };
    }

    projGroup.appendChild(folderRow);

    const attachedFoldersForProj = (typeof getProjectFoldersList === "function") ? getProjectFoldersList(proj.Path) : [proj.Path];
    if (attachedFoldersForProj.length > 1 && !isCollapsed) {
      const attachedSubList = document.createElement("div");
      attachedSubList.style.cssText = "display:flex; flex-direction:column; gap:1px; padding:2px 8px 4px 24px; border-bottom:1px solid rgba(255, 255, 255, 0.04); margin-bottom:2px;";
      attachedFoldersForProj.slice(1).forEach((subPath) => {
        const subName = String(subPath).split(/[/\\]/).filter(Boolean).pop() || subPath;
        const subRow = document.createElement("div");
        subRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:11px; color:var(--text-muted); padding:2px 4px; cursor:pointer;";
        subRow.title = "Attached primary folder: " + subPath + " (click to manage project folders)";
        subRow.onclick = (ev) => {
          ev.stopPropagation();
          openProjectSettings(proj.Path, projName, ev);
        };
        subRow.innerHTML = `
          <div style="display:flex; align-items:center; gap:5px; min-width:0; overflow:hidden;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.65; flex-shrink:0;">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(subName)}</span>
          </div>
          <span style="font-size:10px; opacity:0.6; font-family:ui-monospace,Menlo,Monaco,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:95px;">${escapeHtml(subPath)}</span>
        `;
        attachedSubList.appendChild(subRow);
      });
      projGroup.appendChild(attachedSubList);
    }

    const convsList = document.createElement("div");
    convsList.className = "project-conversations-list";
    if (isCollapsed) {
      convsList.style.display = "none";
    }

    if (sortedConvs.length === 0) {
      const emptyRow = document.createElement("div");
      emptyRow.style.padding = "5px 8px";
      emptyRow.style.fontSize = "11.5px";
      emptyRow.style.color = "var(--text-muted)";
      emptyRow.innerText = "No conversations";
      convsList.appendChild(emptyRow);
    } else {
      sortedConvs.forEach(conv => {
        convsList.appendChild(createConvRowElement(conv, proj.Path, projName));
      });
    }

    projGroup.appendChild(convsList);
    treeContainer.appendChild(projGroup);
  });

  // Render any remaining non-archived conversations that didn't match known projects
  let unassignedConvs = nonArchivedConvs.filter(c => !renderedConvIds.has(c.id));
  if (filterQuery) {
    unassignedConvs = unassignedConvs.filter(c => 
      (c.title || "").toLowerCase().includes(filterQuery) || 
      (c.prompt || "").toLowerCase().includes(filterQuery)
    );
  }
  if (unassignedConvs.length > 0) {
    const sortedUnassigned = sortConvs(unassignedConvs);
    const isUnassignedCollapsed = !!collapsedProjects["__unassigned__"];
    const unassignedGroup = document.createElement("div");
    unassignedGroup.className = "project-group" + (isUnassignedCollapsed ? " collapsed" : "");
    
    const unassignedFolderIconSvg = isUnassignedCollapsed
      ? `<svg class="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
         </svg>`
      : `<svg class="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
         </svg>`;

    const unassignedHeader = document.createElement("div");
    unassignedHeader.className = "project-folder-row";
    unassignedHeader.style.cursor = "pointer";
    unassignedHeader.onclick = (e) => {
      if (Date.now() - _lastSidebarDragEnd < 150) return;
      toggleProjectCollapse("__unassigned__", e);
    };
    unassignedHeader.innerHTML = `
      <div class="project-folder-left">
        ${unassignedFolderIconSvg}
        <span class="project-folder-title" style="color:var(--text-secondary); font-size:11.5px; text-transform:uppercase; letter-spacing:0.05em;">Conversations</span>
      </div>
      <span class="project-conv-count">${sortedUnassigned.length}</span>
    `;
    unassignedGroup.appendChild(unassignedHeader);

    unassignedGroup.addEventListener("dragover", (e) => {
      if (!_sidebarDragState || _sidebarDragState.type !== "conversation") return;
      if (e.target && e.target.closest(".conversation-row")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      unassignedHeader.classList.add("drag-over-project");
    });

    unassignedGroup.addEventListener("dragleave", (e) => {
      if (!unassignedGroup.contains(e.relatedTarget)) {
        unassignedHeader.classList.remove("drag-over-project");
      }
    });

    unassignedGroup.addEventListener("drop", (e) => {
      if (!_sidebarDragState || _sidebarDragState.type !== "conversation") return;
      if (e.target && e.target.closest(".conversation-row")) return;
      e.preventDefault();
      e.stopPropagation();
      const draggedConvId = _sidebarDragState.convId;
      _sidebarDragState = null;
      clearSidebarDragStyles();
      if (draggedConvId) {
        moveConversationToProject(draggedConvId, "", "");
      }
    });

    const unassignedList = document.createElement("div");
    unassignedList.className = "project-conversations-list";
    if (isUnassignedCollapsed) {
      unassignedList.style.display = "none";
    }
    sortedUnassigned.forEach(conv => {
      unassignedList.appendChild(createConvRowElement(conv, "", ""));
    });
    unassignedGroup.appendChild(unassignedList);
    treeContainer.appendChild(unassignedGroup);
  }

  // Show a subtle link to view/restore archived conversations if any exist
  const archivedCount = (appConversations || []).filter(c => c && (c.archived || c.is_archived)).length;
  if (archivedCount > 0) {
    const archivedFooter = document.createElement("div");
    archivedFooter.className = "sidebar-archived-footer-row";
    archivedFooter.title = "View and restore archived conversations";
    archivedFooter.onclick = () => {
      if (typeof openArchivedHistoryModal === "function") {
        openArchivedHistoryModal();
      } else if (typeof openHistoryModal === "function") {
        openHistoryModal();
      }
    };
    archivedFooter.innerHTML = `
      <div class="sidebar-archived-footer-left">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
        <span>Archived conversations</span>
      </div>
      <span class="project-conv-count">${archivedCount}</span>
    `;
    treeContainer.appendChild(archivedFooter);
  }
}



function toggleAddProjectMenu(event, forceState) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("add-project-popover");
  if (!menu) return;
  const isCurrentlyOpen = menu.classList.contains("visible");
  const target = typeof forceState === "boolean" ? forceState : !isCurrentlyOpen;
  closeAllDropdowns(["add-project-popover"]);
  menu.classList.toggle("visible", target);
}

function handleNewProjectFromMenu(event) {
  if (event) event.stopPropagation();
  toggleAddProjectMenu(null, false);
  if (typeof chooseCustomDirectory === "function") {
    chooseCustomDirectory();
  }
}

async function handleQuickStartProject(event) {
  if (event) event.stopPropagation();
  toggleAddProjectMenu(null, false);
  try {
    let rawResp = null;
    if (typeof window.quickStartProject === "function") {
      rawResp = await window.quickStartProject("");
    } else if (typeof window.bridgeCall === "function") {
      rawResp = await window.bridgeCall("quickStartProject", "{}");
    } else if (typeof window.callGo === "function") {
      rawResp = await window.callGo("quickStartProject", "{}");
    }
    let parsed = null;
    if (rawResp) {
      parsed = typeof rawResp === "string" ? JSON.parse(rawResp) : rawResp;
    }
    if (parsed && parsed.status === "ok" && parsed.path) {
      const projName = parsed.project_name || String(parsed.path).split(/[\\/]/).filter(Boolean).pop() || parsed.path;
      if (Array.isArray(parsed.projects)) {
        mergeProjects(parsed.projects);
      }
      mergeProjects([{ Name: projName, Path: parsed.path }]);
      collapsedProjects[parsed.path] = false;
      try {
        localStorage.setItem("orborus_collapsed_projects", JSON.stringify(collapsedProjects));
      } catch (e) {}
      await selectProject(parsed.path, projName);
      if (typeof startNewSession === "function") {
        startNewSession();
      }
      renderProjectTree();
      if (typeof showToast === "function") {
        showToast("Quick Start project created: " + projName);
      }
      return;
    }
    const errMsg = (parsed && (parsed.error || parsed.message)) || "Failed to quick start project";
    if (typeof showToast === "function") {
      showToast(errMsg);
    }
  } catch (err) {
    console.error("[QuickStart] Failed:", err);
    if (typeof showToast === "function") {
      showToast("Failed to quick start project");
    }
  }
}

function toggleProjectDropdown(event, forceState) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("project-dropdown-menu");
  if (!menu) return;
  const isCurrentlyOpen = menu.classList.contains("visible");
  const target = typeof forceState === "boolean" ? forceState : !isCurrentlyOpen;
  closeAllDropdowns(["project-dropdown-menu"]);
  menu.classList.toggle("visible", target);
  if (menu.classList.contains("visible")) {
    const search = document.getElementById("project-search");
    if (search) {
      search.value = "";
      filterProjects("");
      search.focus();
    }
  }
}

function filterProjects(query) {
  const container = document.getElementById("project-items");
  if (!container) return;
  const q = (query || "").toLowerCase().trim();
  const items = container.querySelectorAll(".dropdown-item");
  let visibleCount = 0;
  items.forEach(item => {
    const text = item.innerText.toLowerCase();
    const matches = !q || text.includes(q);
    item.style.display = matches ? "" : "none";
    if (matches) visibleCount++;
  });
  const repoCount = document.getElementById("repo-count");
  if (repoCount && q) {
    repoCount.innerText = `${visibleCount} matching`;
  }
}

async function selectProject(path, displayName, options = {}) {
  if (path === undefined || path === null) return;
  let name = displayName;
  if (!name) {
    if (path === "") {
      name = "No project";
    } else {
      const parts = path.split(/[/\\]/).filter(Boolean);
      name = parts.length > 0 ? parts[parts.length - 1] : "Project";
    }
  }

  // Preserve previous active project and active conversation's project in allProjects
  // so switching to another project or "No project" never drops them from the sidebar
  if (!Array.isArray(allProjects)) allProjects = [];
  const toPreserve = [];
  if (activeProjectPath && activeProjectPath !== ".") {
    const prevParts = activeProjectPath.split(/[/\\]/).filter(Boolean);
    const prevName = prevParts.length > 0 ? prevParts[prevParts.length - 1] : "Project";
    toPreserve.push({ Name: prevName, Path: activeProjectPath });
  }
  if (activeConversationId && Array.isArray(appConversations)) {
    const existingConv = appConversations.find(c => c && c.id === activeConversationId);
    const prevConvProj = existingConv ? (existingConv.projectId || existingConv.project_id || "") : "";
    if (prevConvProj && prevConvProj !== ".") {
      const prevConvName = existingConv.projectName || existingConv.project_name || prevConvProj.split(/[/\\]/).filter(Boolean).pop() || "Project";
      toPreserve.push({ Name: prevConvName, Path: prevConvProj });
    }
  }
  if (path !== "" && path !== ".") {
    toPreserve.push({ Name: name, Path: path });
  }
  if (toPreserve.length > 0) {
    if (typeof mergeProjects === "function") {
      mergeProjects(toPreserve);
    } else {
      const getNorm = (typeof normPath === "function") ? normPath : (p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
      toPreserve.forEach(item => {
        const norm = getNorm(item.Path);
        if (!norm) return;
        const existingIdx = allProjects.findIndex(p => getNorm(p.Path || p.path) === norm);
        if (existingIdx !== -1) {
          if (item.Name && (!allProjects[existingIdx].Name || allProjects[existingIdx].Name === "Project" || allProjects[existingIdx].Name === "Local Workspace")) {
            allProjects[existingIdx].Name = item.Name;
          }
        } else {
          allProjects.push({ Name: item.Name, Path: item.Path });
        }
      });
      if (typeof saveStoredProjects === "function") {
        saveStoredProjects();
      }
    }
  }

  // 1. Optimistic UI update immediately (instant, no redundant renders)
  setActiveProject(path, name);
  localStorage.setItem("orborus_active_project", path);
  if (typeof collapsedProjects !== "undefined" && collapsedProjects) {
    collapsedProjects[path] = false;
    try {
      localStorage.setItem("orborus_collapsed_projects", JSON.stringify(collapsedProjects));
    } catch (e) {}
  }

  // 2. Only switch conversation context if explicitly requested (e.g. clicking a folder row in sidebar)
  // When choosing a project from the dropdown above the prompt input, retain the current view context!
  if (options && options.switchConversation) {
    let targetId = options.targetConvId !== undefined ? options.targetConvId : null;
    if (targetId === null && options.targetConvId === undefined) {
      const normTarget = (path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const projectConvs = sortConvsStable((appConversations || []).filter(c => {
        if (!c || c.archived || c.is_archived) return false;
        const pId = (c.projectId || c.project_id || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        return pId === normTarget;
      }));
      if (projectConvs.length > 0) {
        targetId = projectConvs[0].id;
      }
    }
    if (targetId && typeof selectConversation === "function") {
      await selectConversation(targetId);
    } else if (typeof startNewSession === "function") {
      startNewSession();
      renderProjectTree();
    } else {
      renderProjectTree();
    }
  } else {
    if (activeConversationId && !(options && options.preserveConversationProject)) {
      // If user is inside an existing chat, update the active chat's project tag before rendering the tree
      const curConv = (appConversations || []).find(c => c && c.id === activeConversationId);
      if (curConv) {
        curConv.projectId = path;
        curConv.project_id = path;
        curConv.projectName = name;
        curConv.project_name = name;
        const topbarProject = document.getElementById("topbar-project-name");
        if (topbarProject) {
          topbarProject.innerText = name || "No project";
        }
        if (typeof saveStoredConversations === "function") {
          saveStoredConversations();
        }
      }
    } else if (!activeConversationId) {
      const rememberedModel = typeof getRememberedModelForType === "function" ? getRememberedModelForType(path) : "";
      const lastConvModel = typeof getLastMessageModelFromAnyConv === "function" ? getLastMessageModelFromAnyConv(appConversations, activeConversationId) : "";
      const nextModel = rememberedModel || lastConvModel || activeAiModel || localStorage.getItem("orborus_ai_model") || "tendon-local";
      if (nextModel) {
        activeAiModel = nextModel;
        if (typeof window !== "undefined") window.activeAiModel = nextModel;
        localStorage.setItem("orborus_ai_model", nextModel);
      }
      if (typeof getRememberedReasoningForType === "function") {
        const rememberedReasoning = getRememberedReasoningForType(path) || "low";
        activeReasoningEffort = rememberedReasoning;
        if (typeof window !== "undefined") window.activeReasoningEffort = rememberedReasoning;
        localStorage.setItem("orborus_ai_reasoning", rememberedReasoning);
      }
      if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
      if (typeof updateActiveReasoningLabel === "function") updateActiveReasoningLabel();
    }
    renderProjectTree();
  }

  // 3. Refresh right sidebar overview & git status only if the right sidebar is currently visible
  const rightSidebar = document.getElementById("preview-sidebar");
  if (path !== "" && rightSidebar && rightSidebar.style.display !== "none" && typeof loadRightSidebarOverview === "function") {
    loadRightSidebarOverview();
  }

  // 4. If settings modal is open, immediately select this project in settings
  if (typeof selectSettingsProject === "function") {
    const modal = document.getElementById("settings-modal");
    if (modal && modal.classList.contains("visible")) {
      selectSettingsProject(path, name);
    }
  }

  // 5. Notify backend asynchronously in background without blocking UI
  // IMPORTANT: Do NOT call window.selectProject(path) here because global `async function selectProject`
  // overwrites `window.selectProject`, which would cause infinite synchronous recursion!
  const notifyBackend = (typeof window.selectProjectBackend === "function")
    ? window.selectProjectBackend(path)
    : (typeof window.bridgeCall === "function"
      ? window.bridgeCall("selectProject", path)
      : (typeof callGo === "function" ? callGo("selectProject", path) : null));
  if (notifyBackend && typeof notifyBackend.then === "function") {
    notifyBackend.then(raw => {
      if (raw) {
        try {
          const res = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (res && res.projects && Array.isArray(res.projects) && res.projects.length > 0) {
            const prevLen = Array.isArray(allProjects) ? allProjects.length : 0;
            if (typeof mergeProjects === "function") {
              mergeProjects(res.projects);
            } else {
              const existingSet = new Set(allProjects.map(p => (p.Path || p.path || "").toLowerCase()));
              res.projects.forEach(p => {
                const k = (p.Path || p.path || "").toLowerCase();
                if (k && !existingSet.has(k)) {
                  allProjects.push(p);
                  existingSet.add(k);
                }
              });
            }
            if (allProjects.length !== prevLen) {
              renderProjectTree();
            }
          }
        } catch (e) {}
      }
    }).catch(err => {
      console.warn("selectProject backend sync error:", err);
    });
  }
}

function setActiveProject(path, displayName) {
  activeProjectPath = path;
  localStorage.setItem("orborus_active_project", path);
  let name = displayName;
  if (!name) {
    if (path === "") {
      name = "No project";
    } else {
      const parts = path.split(/[/\\]/).filter(Boolean);
      name = parts.length > 0 ? parts[parts.length - 1] : "Orborus Agent Runner";
    }
  }
  const el = document.getElementById("active-project-name");
  if (el) el.innerText = name;
  const topbarProj = document.getElementById("topbar-project-name");
  if (topbarProj && !activeConversationId) topbarProj.innerText = name;
}

function renderProjects(projects) {
  if (Array.isArray(projects)) {
    if (typeof mergeProjects === "function") {
      mergeProjects(projects);
    } else {
      const existing = new Set(allProjects.map(p => (p.Path || p.path || "").toLowerCase()));
      projects.forEach(p => {
        const pPath = (p.Path || p.path || "").toLowerCase();
        if (pPath && !existing.has(pPath)) {
          allProjects.push(p);
          existing.add(pPath);
        }
      });
    }
  }
  renderProjectTree();
  if (typeof renderSettingsProjectsList === "function") {
    renderSettingsProjectsList();
  }
}

window.renderProjects = renderProjects;
window.archiveConversation = archiveConversation;
window.unarchiveConversation = unarchiveConversation;
window.selectConversation = selectConversation;
window.togglePinConversation = togglePinConversation;
window.reorderSidebarProject = reorderSidebarProject;
window.reorderSidebarConversation = reorderSidebarConversation;
window.moveConversationToProject = moveConversationToProject;
