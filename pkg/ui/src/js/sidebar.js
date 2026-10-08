// --- Stored Conversations Storage ---
async function loadStoredConversations() {
  // 1. Try loading from disk via Go backend bridge
  try {
    if (window.listConversations) {
      const raw = await window.listConversations();
      const diskConvs = JSON.parse(raw);
      if (Array.isArray(diskConvs) && diskConvs.length > 0) {
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
        if (appConversations.length === 0) {
          appConversations = validLocal;
        } else {
          // Merge by ID if not in disk list
          const existingIds = new Set(appConversations.map(c => c.id));
          validLocal.forEach(c => {
            if (!existingIds.has(c.id)) {
              appConversations.push(c);
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
  } catch (err) {
    console.warn("Failed to load stored conversations from localStorage:", err);
  }
}

async function saveStoredConversations() {
  try {
    localStorage.setItem("orborus_conversations", JSON.stringify(appConversations));
    localStorage.setItem("orborus_pinned_conversations", JSON.stringify(Array.from(pinnedConversationIds)));
  } catch (err) {
    console.warn("Failed to save conversations to storage:", err);
  }

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
        const existing = new Set(allProjects.map(p => (p.Path || p.path || "").toLowerCase()));
        projects.forEach(p => {
          const pPath = (p.Path || p.path || "").toLowerCase();
          if (pPath && !existing.has(pPath)) {
            allProjects.push(p);
            existing.add(pPath);
          }
        });
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
  activeConversationId = convId;
  localStorage.setItem("orborus_active_conv_id", convId);

  // 1. Optimistic instant switch (0ms latency)
  let cachedConv = (appConversations || []).find(c => c && c.id === convId);
  if (cachedConv) {
    const projPath = cachedConv.projectId !== undefined ? cachedConv.projectId : (cachedConv.project_id !== undefined ? cachedConv.project_id : "");
    const projName = cachedConv.projectName || cachedConv.project_name || (projPath === "" ? "No project" : undefined);
    if (projPath !== activeProjectPath) {
      setActiveProject(projPath, projName);
    }
  }
  renderProjectTree();
  renderActiveConversation();

  // 2. Fetch full conversation transcript from backend disk in background
  if (window.getConversation) {
    try {
      const raw = await window.getConversation(convId);
      const diskConv = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (diskConv && diskConv.id && !diskConv.error) {
        if (!Array.isArray(appConversations)) appConversations = [];
        const idx = appConversations.findIndex(c => c && c.id === convId);
        if (idx !== -1) {
          appConversations[idx] = diskConv;
        } else {
          appConversations.unshift(diskConv);
        }
        if (activeConversationId === convId) {
          renderActiveConversation();
        }
        try {
          localStorage.setItem("orborus_conversations", JSON.stringify(appConversations));
        } catch (e) {}
      }
    } catch (e) {
      console.warn("Failed to fetch fresh conversation from disk:", e);
    }
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
  if (typeof renderHistoryList === "function" && typeof getCombinedHistory === "function") {
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
  if (activeConversationId === convId && typeof renderActiveConversation === "function") {
    renderActiveConversation();
  }
  if (typeof renderHistoryList === "function" && typeof getCombinedHistory === "function") {
    const allItems = getCombinedHistory();
    renderHistoryList(allItems);
  }
  showToast("Conversation restored to sidebar");
}

function createConvRowElement(conv) {
  const isCur = conv.id === activeConversationId;
  const isPinned = pinnedConversationIds.has(conv.id);
  const isRunning = (typeof isPromptExecuting !== "undefined" && isPromptExecuting && (conv.id === activeConversationId || conv.id === runningConversationId)) ||
                    (typeof runningConversationId !== "undefined" && runningConversationId === conv.id);

  const convRow = document.createElement("div");
  convRow.className = "conversation-row" + (isCur ? " active" : "") + (isPinned ? " pinned" : "") + (isRunning ? " running" : "");
  convRow.onclick = (e) => {
    if (e.target && e.target.closest(".conversation-actions")) return;
    selectConversation(conv.id);
  };

  convRow.innerHTML = `
    <div class="conversation-row-left">
      <span class="conversation-dot"></span>
      <span class="conversation-title" title="${escapeHtml(conv.title || "Conversation")}">${escapeHtml(conv.title || "Conversation")}</span>
    </div>
    <div class="conversation-actions">
      ${isRunning ? `
        <div class="conversation-running-wrap" title="Running... click to stop" onclick="event.stopPropagation(); stopExecution();">
          <span class="conversation-spinner"></span>
          <button class="conversation-abort-btn" type="button" title="Stop execution" onclick="event.stopPropagation(); stopExecution();">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2"/>
            </svg>
          </button>
        </div>
      ` : ""}
      <button class="btn-pin-toggle ${isPinned ? "active" : ""}" title="${isPinned ? "Unpin conversation" : "Pin conversation to top"}" onclick="togglePinConversation('${conv.id}', event)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="${isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v8M5 10l7 2 7-2M7 10v6l5 4 5-4v-6"/>
        </svg>
      </button>
      <button class="btn-archive-toggle" title="Archive conversation (moves to Conversation History)" onclick="archiveConversation('${conv.id}', event)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
      </button>
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

  // Helper for sorting conversations: pinned first, then updated_at / created_at desc
  const sortConvs = (convList) => {
    return [...convList].sort((a, b) => {
      const aPinned = pinnedConversationIds.has(a.id);
      const bPinned = pinnedConversationIds.has(b.id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      const bTime = b.updated_at || b.created_at || "";
      const aTime = a.updated_at || a.created_at || "";
      return bTime.localeCompare(aTime);
    });
  };

  const normPath = p => (p || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const filterQuery = (projectFilterQuery || "").toLowerCase().trim();

  // Combine projects from activeProjectPath, allProjects, and stored conversations
  const projectMap = new Map();

  if (activeProjectPath && activeProjectPath !== "") {
    let activeName = (document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : "") || "";
    if (!activeName || activeName === "Orborus Agent Runner" || activeName === "Local Workspace") {
      activeName = activeProjectPath === "." ? "Active Workspace" : (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Active Workspace");
    }
    projectMap.set(normPath(activeProjectPath), {
      Name: activeName,
      Path: activeProjectPath
    });
  }

  allProjects.forEach(p => {
    if (p && p.Path) {
      const key = normPath(p.Path);
      if (!projectMap.has(key)) {
        projectMap.set(key, p);
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
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          Name: pName || (pId === "." ? "Active Workspace" : (pId.split(/[/\\]/).filter(Boolean).pop() || "Project")),
          Path: pId
        });
      }
    }
  });

  const projectsList = Array.from(projectMap.values());
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
        <span class="dropdown-item-path">${escapeHtml(p.Path)}</span>
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
      convsList.appendChild(createConvRowElement(conv));
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

    const folderRow = document.createElement("div");
    folderRow.className = "project-folder-row";
    folderRow.onclick = async (e) => {
      if (proj.Path !== activeProjectPath) {
        await selectProject(proj.Path, projName, { switchConversation: true });
        collapsedProjects[proj.Path] = false;
        renderProjectTree();
      } else {
        toggleProjectCollapse(proj.Path, e);
      }
    };

    folderRow.innerHTML = `
      <div class="project-folder-left">
        <svg class="project-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <svg class="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="project-folder-title">${escapeHtml(projName)}</span>
      </div>
      <span class="project-conv-count">${sortedConvs.length}</span>
    `;
    projGroup.appendChild(folderRow);

    const convsList = document.createElement("div");
    convsList.className = "project-conversations-list";
    if (isCollapsed) {
      convsList.style.display = "none";
    }

    if (sortedConvs.length === 0) {
      const emptyRow = document.createElement("div");
      emptyRow.style.padding = "6px 20px 6px 34px";
      emptyRow.style.fontSize = "11.5px";
      emptyRow.style.color = "var(--text-muted)";
      emptyRow.innerText = "No conversations";
      convsList.appendChild(emptyRow);
    } else {
      sortedConvs.forEach(conv => {
        convsList.appendChild(createConvRowElement(conv));
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
    const unassignedGroup = document.createElement("div");
    unassignedGroup.className = "project-group";
    
    const unassignedHeader = document.createElement("div");
    unassignedHeader.className = "sidebar-section-divider";
    unassignedHeader.innerHTML = `<span>Conversations</span><span>${sortedUnassigned.length}</span>`;
    unassignedGroup.appendChild(unassignedHeader);

    const unassignedList = document.createElement("div");
    unassignedList.className = "project-conversations-list";
    sortedUnassigned.forEach(conv => {
      unassignedList.appendChild(createConvRowElement(conv));
    });
    unassignedGroup.appendChild(unassignedList);
    treeContainer.appendChild(unassignedGroup);
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
  if (path !== "") {
    if (!Array.isArray(allProjects)) allProjects = [];
    const norm = path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const existingIdx = allProjects.findIndex(p => {
      const pNorm = (p.Path || p.path || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      return pNorm === norm;
    });
    if (existingIdx !== -1) {
      allProjects[existingIdx].Name = name;
      const item = allProjects.splice(existingIdx, 1)[0];
      allProjects.unshift(item);
    } else {
      allProjects.unshift({ Name: name, Path: path });
    }
  }

  // 1. Optimistic UI update immediately (instant, no redundant renders)
  setActiveProject(path, name);
  localStorage.setItem("orborus_active_project", path);
  renderProjectTree();

  // 2. Only switch conversation context if explicitly requested (e.g. clicking a folder row in sidebar)
  // When choosing a project from the dropdown above the prompt input, retain the current view context!
  if (options && options.switchConversation) {
    const normTarget = (path || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const projectConvs = (appConversations || []).filter(c => {
      if (!c || c.archived || c.is_archived) return false;
      const pId = (c.projectId || c.project_id || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      return pId === normTarget;
    });
    if (projectConvs.length > 0) {
      if (typeof selectConversation === "function") {
        selectConversation(projectConvs[0].id);
      }
    } else {
      if (typeof startNewSession === "function") {
        startNewSession();
      }
    }
  } else if (activeConversationId) {
    // If user is inside an existing chat, update the active chat's project tag
    const curConv = (appConversations || []).find(c => c && c.id === activeConversationId);
    if (curConv) {
      curConv.projectId = path;
      curConv.project_id = path;
      curConv.projectName = name;
      curConv.project_name = name;
      if (typeof saveStoredConversations === "function") {
        saveStoredConversations();
      }
    }
  }

  // 3. Refresh right sidebar overview & git status only if a project workspace exists
  if (path !== "" && typeof loadRightSidebarOverview === "function") {
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
  const notifyBackend = window.selectProject ? window.selectProject(path) : (typeof callGo === "function" ? callGo("selectProject", path) : null);
  if (notifyBackend && typeof notifyBackend.then === "function") {
    notifyBackend.then(raw => {
      if (raw) {
        try {
          const res = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (res && res.projects && Array.isArray(res.projects) && res.projects.length > 0) {
            allProjects = res.projects;
            renderProjectTree();
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
    allProjects = projects;
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
