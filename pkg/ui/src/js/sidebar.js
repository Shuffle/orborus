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
        allProjects = projects;
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
  activeConversationId = convId;
  localStorage.setItem("orborus_active_conv_id", convId);

  // 1. Optimistic instant switch (0ms latency)
  const cachedConv = appConversations.find(c => c.id === convId);
  if (cachedConv) {
    const projPath = cachedConv.projectId || cachedConv.project_id;
    const projName = cachedConv.projectName || cachedConv.project_name;
    if (projPath && projPath !== activeProjectPath) {
      setActiveProject(projPath, projName);
    }
  }
  renderProjectTree();
  renderActiveConversation();

  // 2. Fetch full conversation transcript from backend disk in background
  if (window.getConversation) {
    try {
      const raw = await window.getConversation(convId);
      const diskConv = JSON.parse(raw);
      if (diskConv && diskConv.id && !diskConv.error) {
        if (!Array.isArray(appConversations)) appConversations = [];
        const idx = appConversations.findIndex(c => c.id === convId);
        if (idx !== -1) {
          appConversations[idx] = diskConv;
        } else {
          appConversations.unshift(diskConv);
        }
        if (activeConversationId === convId) {
          renderActiveConversation();
        }
        saveStoredConversations();
      }
    } catch (e) {
      console.warn("Failed to fetch fresh conversation from disk:", e);
    }
  }
}

function renderProjectTree() {
  const treeContainer = document.getElementById("sidebar-project-tree");
  const dropdownContainer = document.getElementById("project-items");
  const repoCount = document.getElementById("repo-count");

  // Keep dropdown updated
  if (dropdownContainer) {
    dropdownContainer.innerHTML = "";
    allProjects.forEach(p => {
      const name = p.Name || p.Path.split("/").filter(Boolean).pop() || "Project";
      const isCur = p.Path === activeProjectPath;
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
  treeContainer.innerHTML = "";

  // Combine projects from allProjects and known projects from appConversations
  const projectMap = new Map();

  // If an active project is set, ensure it is included
  if (activeProjectPath && activeProjectPath !== ".") {
    const activeName = (document.getElementById("active-project-name") ? document.getElementById("active-project-name").innerText : "") ||
      activeProjectPath.split("/").filter(Boolean).pop() || "Active Workspace";
    projectMap.set(activeProjectPath, {
      Name: activeName,
      Path: activeProjectPath
    });
  }

  allProjects.forEach(p => {
    projectMap.set(p.Path, p);
  });

  appConversations.forEach(c => {
    if (c.projectId && !projectMap.has(c.projectId)) {
      projectMap.set(c.projectId, {
        Name: c.projectName || c.projectId.split("/").filter(Boolean).pop(),
        Path: c.projectId
      });
    }
  });

  const projectsList = Array.from(projectMap.values());
  if (repoCount) {
    repoCount.innerText = projectsList.length + " found";
  }

  if (projectsList.length === 0) {
    treeContainer.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:6px 10px;">No repositories found.</div>`;
    return;
  }

  projectsList.forEach(proj => {
    const projName = proj.Name || proj.Path.split("/").filter(Boolean).pop() || "Project";
    const isCollapsed = !!collapsedProjects[proj.Path];

    // Find conversations for this project
    let convs = appConversations.filter(c => c.projectId === proj.Path);
    if (convs.length === 0 && (proj.Path === activeProjectPath || proj.Path === ".")) {
      convs = appConversations.filter(c => !c.projectId || c.projectId === "." || c.projectId === activeProjectPath);
    }

    // Apply search filter if active
    if (projectFilterQuery) {
      const matchProj = projName.toLowerCase().includes(projectFilterQuery) || proj.Path.toLowerCase().includes(projectFilterQuery);
      const matchingConvs = convs.filter(c => (c.title || "").toLowerCase().includes(projectFilterQuery) || (c.prompt || "").toLowerCase().includes(projectFilterQuery));
      if (!matchProj && matchingConvs.length === 0) {
        return; // filter out
      }
      if (!matchProj && matchingConvs.length > 0) {
        convs = matchingConvs;
      }
    }

    // Sort conversations: pinned first, then by title or id
    const sortedConvs = [...convs].sort((a, b) => {
      const aPinned = pinnedConversationIds.has(a.id);
      const bPinned = pinnedConversationIds.has(b.id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return 0;
    });

    // Project container element
    const projGroup = document.createElement("div");
    projGroup.className = "project-group" + (isCollapsed ? " collapsed" : "");

    // Folder header row
    folderRow.onclick = async (e) => {
      if (proj.Path !== activeProjectPath) {
        await selectProject(proj.Path, projName);
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

    // Conversations sub-list
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
        const isCur = conv.id === activeConversationId;
        const isPinned = pinnedConversationIds.has(conv.id);

        const convRow = document.createElement("div");
        convRow.className = "conversation-row" + (isCur ? " active" : "") + (isPinned ? " pinned" : "");
        convRow.onclick = () => selectConversation(conv.id);

        convRow.innerHTML = `
          <div class="conversation-row-left">
            <span class="conversation-dot"></span>
            <span class="conversation-title" title="${escapeHtml(conv.title)}">${escapeHtml(conv.title)}</span>
          </div>
          <button class="btn-pin-toggle ${isPinned ? "active" : ""}" title="${isPinned ? "Unpin conversation" : "Pin conversation to top"}" onclick="togglePinConversation('${conv.id}', event)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="${isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v8M5 10l7 2 7-2M7 10v6l5 4 5-4v-6"/>
            </svg>
          </button>
        `;
        convsList.appendChild(convRow);
      });
    }

    projGroup.appendChild(convsList);
    treeContainer.appendChild(projGroup);
  });
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

async function selectProject(path, displayName) {
  if (!path) return;
  let name = displayName;
  if (!name) {
    const parts = path.split("/").filter(Boolean);
    name = parts.length > 0 ? parts[parts.length - 1] : "Project";
  }
  if (!Array.isArray(allProjects)) allProjects = [];
  const existing = allProjects.find(p => p.Path === path);
  if (!existing) {
    allProjects.unshift({ Name: name, Path: path });
  }

  // 1. Optimistic UI update immediately
  setActiveProject(path, name);
  renderProjects(allProjects);
  renderProjectTree();
  localStorage.setItem("orborus_active_project", path);

  // 2. Notify backend in background
  if (window.selectProject) {
    try {
      window.selectProject(path).catch(() => {});
    } catch (err) {
      console.warn("window.selectProject error:", err);
    }
  }
}

function setActiveProject(path, displayName) {
  activeProjectPath = path;
  localStorage.setItem("orborus_active_project", path);
  let name = displayName;
  if (!name) {
    const parts = path.split("/").filter(Boolean);
    name = parts.length > 0 ? parts[parts.length - 1] : "Orborus Agent Runner";
  }
  const el = document.getElementById("active-project-name");
  if (el) el.innerText = name;
}
