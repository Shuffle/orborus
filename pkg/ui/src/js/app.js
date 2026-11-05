// --- App Bootstrap, Keyboard Shortcuts & Overlay Handlers ---
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message) {
  const toast = document.getElementById("app-toast");
  if (!toast) return;
  toast.innerText = message;
  toast.classList.add("visible");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("visible");
  }, 2800);
}

function handleOverlayClick(event, modalId) {
  if (event.target && (event.target.id === modalId || event.target.classList.contains("modal-overlay"))) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove("visible");
    if (typeof checkModalActive === "function") checkModalActive();
  }
}

function closeAllModals() {
  document.querySelectorAll(".modal-overlay").forEach(m => m.classList.remove("visible"));
  if (typeof checkModalActive === "function") checkModalActive();
}

function closeAllDropdowns(exceptIds = []) {
  const dropdowns = [
    "project-dropdown-menu",
    "add-project-popover",
    "shuffle-tenant-dropdown-menu",
    "shuffle-tenant-dropdown-menu",
    "shuffle-tools-dropdown-menu",
    "prompt-plus-menu"
  ];
  dropdowns.forEach(id => {
    if (!exceptIds.includes(id)) {
      const el = document.getElementById(id);
      if (el) el.classList.remove("visible");
    }
  });
  if (!exceptIds.includes("approval-queue-popover")) {
    const approvalPop = document.getElementById("approval-queue-popover");
    if (approvalPop) approvalPop.classList.remove("open");
  }
}

function handleClickOutside(e) {
  const projMenu = document.getElementById("project-dropdown-menu");
  const projBtn = document.getElementById("project-dropdown-btn");
  if (projMenu && projMenu.classList.contains("visible")) {
    if (!projMenu.contains(e.target) && (!projBtn || !projBtn.contains(e.target))) {
      projMenu.classList.remove("visible");
    }
  }
  const addProjPopover = document.getElementById("add-project-popover");
  const addProjBtn = document.getElementById("btn-add-project-menu");
  if (addProjPopover && addProjPopover.classList.contains("visible")) {
    if (!addProjPopover.contains(e.target) && (!addProjBtn || !addProjBtn.contains(e.target))) {
      addProjPopover.classList.remove("visible");
    }
  }
  const tenantMenu = document.getElementById("shuffle-tenant-dropdown-menu");
  const tenantBtn = document.getElementById("btn-shuffle-tenant-dropdown");
  if (tenantMenu && tenantMenu.classList.contains("visible")) {
    if (!tenantMenu.contains(e.target) && (!tenantBtn || !tenantBtn.contains(e.target))) {
      tenantMenu.classList.remove("visible");
    }
  }
  const promptPlusMenu = document.getElementById("prompt-plus-menu");
  const promptPlusBtn = document.getElementById("btn-prompt-plus");
  if (promptPlusMenu && promptPlusMenu.classList.contains("visible")) {
    if (!promptPlusMenu.contains(e.target) && (!promptPlusBtn || !promptPlusBtn.contains(e.target))) {
      promptPlusMenu.classList.remove("visible");
    }
  }
  const shuffleToolsMenu = document.getElementById("shuffle-tools-dropdown-menu");
  const shuffleToolsBtn = document.getElementById("btn-shuffle-tools-picker");
  if (shuffleToolsMenu && shuffleToolsMenu.classList.contains("visible")) {
    if (!shuffleToolsMenu.contains(e.target) && (!shuffleToolsBtn || !shuffleToolsBtn.contains(e.target))) {
      shuffleToolsMenu.classList.remove("visible");
    }
  }
  const approvalPopover = document.getElementById("approval-queue-popover");
  const approvalRow = document.getElementById("approval-queue-row");
  if (approvalPopover && approvalPopover.classList.contains("open")) {
    if (!approvalPopover.contains(e.target) && (!approvalRow || !approvalRow.contains(e.target))) {
      approvalPopover.classList.remove("open");
    }
  }
}

window.addEventListener("pointerdown", handleClickOutside, true);
window.addEventListener("click", handleClickOutside, true);

// Global keyboard shortcuts (1-5 for approvals, Cmd+Y for history, Cmd+N for new chat, Cmd+, for settings, Esc to close modals/popovers)
window.addEventListener("keydown", function(e) {
  const card = document.getElementById("approval-card");
  if (card && card.classList.contains("visible")) {
    const isTypingInAnswer = document.activeElement && document.activeElement.id === "approval-answer-input";
    if (!isTypingInAnswer) {
      if (e.key >= "1" && e.key <= "5") {
        const optIdx = parseInt(e.key, 10);
        const optEl = document.getElementById("opt-" + optIdx);
        if (!optEl || optEl.style.display !== "none") {
          e.preventDefault();
          selectApprovalOption(optIdx);
          return;
        }
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectApprovalOption(Math.min(5, selectedApprovalOption + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectApprovalOption(Math.max(1, selectedApprovalOption - 1));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submitApproval();
      return;
    }
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      skipApproval();
      return;
    }
  }

  if ((e.metaKey || e.ctrlKey) && (e.key === "," || e.code === "Comma")) {
    e.preventDefault();
    openSettingsModal();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    toggleHistoryModal();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    startNewSession();
    return;
  }
  if (e.key === "Escape" || e.key === "Esc" || e.keyCode === 27) {
    closeAllModals();
    closeAllDropdowns();
  }
}, true);

function bootApp() {
  try {
    const rightSidebar = document.getElementById("preview-sidebar");
    if (rightSidebar) {
      rightSidebar.style.display = "none";
      rightSidebar.classList.remove("expanded");
    }
    const btnRightSidebar = document.getElementById("btn-toggle-right-sidebar");
    if (btnRightSidebar) {
      btnRightSidebar.classList.remove("active");
    }
  } catch(e) {}

  try {
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
  } catch(e) {}

  try {
    setupWindowDragging();
  } catch(e) {}

  try {
    init();
  } catch(e) {
    console.error("init error:", e);
  }

  try {
    initFooterControls();
  } catch(e) {}

  try {
    const savedModel = localStorage.getItem("orborus_ai_model");
    if (savedModel) {
      activeAiModel = savedModel;
      const sel = document.getElementById("select-ai-model");
      if (sel) sel.value = savedModel;
    }
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
  } catch(e) {}

  try {
    if (typeof populateAiModelSelect === "function") {
      populateAiModelSelect();
    }
    if (typeof updateModesDisplay === "function") {
      updateModesDisplay();
    }
    if (typeof refreshShuffleSharedSkills === "function") {
      refreshShuffleSharedSkills();
    }
    if (typeof syncGlobalApprovalQueueUI === "function") {
      syncGlobalApprovalQueueUI();
    }
  } catch(e) {}
}

// Explicit global window bindings for all interactive handlers & safety aliases
function registerGlobalHandlers() {
  if (typeof window === "undefined") return;
  const handlers = {
    submitPrompt: typeof submitPrompt === "function" ? submitPrompt : async function() {},
    toggleModelDropdown: typeof toggleModelDropdown === "function" ? toggleModelDropdown : function() {},
    toggelModelDropdown: typeof toggleModelDropdown === "function" ? toggleModelDropdown : function() {}, // Typo safety alias
    toggleReasoningDropdown: typeof toggleReasoningDropdown === "function" ? toggleReasoningDropdown : function() {},
    toggleProjectDropdown: typeof toggleProjectDropdown === "function" ? toggleProjectDropdown : function() {},
    toggleRunningTasks: typeof toggleRunningTasks === "function" ? toggleRunningTasks : function() {},
    toggleActiveSteps: typeof toggleActiveSteps === "function" ? toggleActiveSteps : function() {},
    toggleSidebar: typeof toggleSidebar === "function" ? toggleSidebar : function() {},
    toggleRightSidebar: typeof toggleRightSidebar === "function" ? toggleRightSidebar : function() {},
    toggleHistoryModal: typeof toggleHistoryModal === "function" ? toggleHistoryModal : function() {},
    closeHistoryModal: typeof closeHistoryModal === "function" ? closeHistoryModal : function() {},
    startNewSession: typeof startNewSession === "function" ? startNewSession : function() {},
    selectAiModel: typeof selectAiModel === "function" ? selectAiModel : function() {},
    selectReasoningEffort: typeof selectReasoningEffort === "function" ? selectReasoningEffort : function() {},
    showLocalModelSubmenu: typeof showLocalModelSubmenu === "function" ? showLocalModelSubmenu : function() {},
    hideLocalModelSubmenu: typeof hideLocalModelSubmenu === "function" ? hideLocalModelSubmenu : function() {},
    openSettingsModal: typeof openSettingsModal === "function" ? openSettingsModal : function() {},
    openProjectSettings: typeof openProjectSettings === "function" ? openProjectSettings : function() {},
    selectSettingsProject: typeof selectSettingsProject === "function" ? selectSettingsProject : function() {},
    getProjectFoldersList: typeof getProjectFoldersList === "function" ? getProjectFoldersList : function() { return []; },
    renderProjectAttachedFolders: typeof renderProjectAttachedFolders === "function" ? renderProjectAttachedFolders : function() {},
    attachProjectFolder: typeof attachProjectFolder === "function" ? attachProjectFolder : async function() {},
    toggleAttachProjectFolderInput: typeof toggleAttachProjectFolderInput === "function" ? toggleAttachProjectFolderInput : function() {},
    cancelAttachProjectFolderInput: typeof cancelAttachProjectFolderInput === "function" ? cancelAttachProjectFolderInput : function() {},
    confirmAttachProjectFolderInput: typeof confirmAttachProjectFolderInput === "function" ? confirmAttachProjectFolderInput : function() {},
    addAttachedFolderToProject: typeof addAttachedFolderToProject === "function" ? addAttachedFolderToProject : function() { return false; },
    removeProjectFolder: typeof removeProjectFolder === "function" ? removeProjectFolder : function() {},
    closeSettingsModal: typeof closeSettingsModal === "function" ? closeSettingsModal : function() {},
    switchSettingsTab: typeof switchSettingsTab === "function" ? switchSettingsTab : function() {},
    saveSettings: typeof saveSettings === "function" ? saveSettings : function() {},
    saveDirectLlmSettings: typeof saveDirectLlmSettings === "function" ? saveDirectLlmSettings : function() {},
    addCurrentByokModel: typeof addCurrentByokModel === "function" ? addCurrentByokModel : function() {},
    handleRemoveByokModel: typeof handleRemoveByokModel === "function" ? handleRemoveByokModel : function() {},
    quickSelectByokModel: typeof quickSelectByokModel === "function" ? quickSelectByokModel : function() {},
    handleByokModelInput: typeof handleByokModelInput === "function" ? handleByokModelInput : function() {},
    applyDirectLlmPreset: typeof applyDirectLlmPreset === "function" ? applyDirectLlmPreset : function() {},
    loginWithOAuth: typeof loginWithOAuth === "function" ? loginWithOAuth : function() {},
    cancelOAuthLogin: typeof cancelOAuthLogin === "function" ? cancelOAuthLogin : function() {},
    testShuffleAiConfig: typeof testShuffleAiConfig === "function" ? testShuffleAiConfig : function() {},
    testDirectLlmConfig: typeof testDirectLlmConfig === "function" ? testDirectLlmConfig : function() {},
    logoutShuffle: typeof logoutShuffle === "function" ? logoutShuffle : function() {},
    toggleShuffleTenantDropdown: typeof toggleShuffleTenantDropdown === "function" ? toggleShuffleTenantDropdown : function() {},
    selectShuffleTenant: typeof selectShuffleTenant === "function" ? selectShuffleTenant : async function() {},
    refreshShuffleTenants: typeof refreshShuffleTenants === "function" ? refreshShuffleTenants : async function() {},
    renderShuffleTenantDropdown: typeof renderShuffleTenantDropdown === "function" ? renderShuffleTenantDropdown : function() {},
    submitOAuthToken: typeof submitOAuthToken === "function" ? submitOAuthToken : function() {},
    submitOrborusAuth: typeof submitOrborusAuth === "function" ? submitOrborusAuth : function() {},
    scanRepositories: typeof scanRepositories === "function" ? scanRepositories : function() {},
    chooseCustomDirectory: typeof chooseCustomDirectory === "function" ? chooseCustomDirectory : function() {},
    toggleAddProjectMenu: typeof toggleAddProjectMenu === "function" ? toggleAddProjectMenu : function() {},
    handleNewProjectFromMenu: typeof handleNewProjectFromMenu === "function" ? handleNewProjectFromMenu : function() {},
    handleQuickStartProject: typeof handleQuickStartProject === "function" ? handleQuickStartProject : async function() {},
    browseNativeDirectory: typeof browseNativeDirectory === "function" ? browseNativeDirectory : async function() {},
    handleAuthAction: typeof handleAuthAction === "function" ? handleAuthAction : function() {},
    handleReminderAction: typeof handleReminderAction === "function" ? handleReminderAction : function() {},
    handleReminderUseLocal: typeof handleReminderUseLocal === "function" ? handleReminderUseLocal : function() {},
    selectApprovalOption: typeof selectApprovalOption === "function" ? selectApprovalOption : function() {},
    skipApproval: typeof skipApproval === "function" ? skipApproval : function() {},
    submitApproval: typeof submitApproval === "function" ? submitApproval : function() {},
    toggleApprovalQueuePopover: typeof toggleApprovalQueuePopover === "function" ? toggleApprovalQueuePopover : function() {},
    closeApprovalQueuePopover: typeof closeApprovalQueuePopover === "function" ? closeApprovalQueuePopover : function() {},
    switchApprovalQueueTab: typeof switchApprovalQueueTab === "function" ? switchApprovalQueueTab : function() {},
    resolveQueueApprovalItem: typeof resolveQueueApprovalItem === "function" ? resolveQueueApprovalItem : async function() {},
    focusQuestionCardFromQueue: typeof focusQuestionCardFromQueue === "function" ? focusQuestionCardFromQueue : function() {},
    approveNextInQueue: typeof approveNextInQueue === "function" ? approveNextInQueue : function() {},
    denyNextInQueue: typeof denyNextInQueue === "function" ? denyNextInQueue : function() {},
    approveAllQueueItems: typeof approveAllQueueItems === "function" ? approveAllQueueItems : async function() {},
    denyAllQueueItems: typeof denyAllQueueItems === "function" ? denyAllQueueItems : async function() {},
    setQuickApprovalPolicy: typeof setQuickApprovalPolicy === "function" ? setQuickApprovalPolicy : async function() {},
    toggleQuickSandboxMode: typeof toggleQuickSandboxMode === "function" ? toggleQuickSandboxMode : async function() {},
    addQuickApprovalRuleFromQueue: typeof addQuickApprovalRuleFromQueue === "function" ? addQuickApprovalRuleFromQueue : async function() {},
    quickAllowPrefixFromHistory: typeof quickAllowPrefixFromHistory === "function" ? quickAllowPrefixFromHistory : async function() {},
    revokeRuleFromQueue: typeof revokeRuleFromQueue === "function" ? revokeRuleFromQueue : async function() {},
    openApprovalSettingsFromQueue: typeof openApprovalSettingsFromQueue === "function" ? openApprovalSettingsFromQueue : function() {},
    syncGlobalApprovalQueueUI: typeof syncGlobalApprovalQueueUI === "function" ? syncGlobalApprovalQueueUI : function() {},
    renderGlobalApprovalQueuePopover: typeof renderGlobalApprovalQueuePopover === "function" ? renderGlobalApprovalQueuePopover : function() {},
    refreshApprovalQueueFromBackend: typeof refreshApprovalQueueFromBackend === "function" ? refreshApprovalQueueFromBackend : async function() {},
    normalizeApprovalRequestItem: typeof normalizeApprovalRequestItem === "function" ? normalizeApprovalRequestItem : function(x) { return x; },
    scrollToBottomOfStream: typeof scrollToBottomOfStream === "function" ? scrollToBottomOfStream : function() {},
    stopExecution: typeof stopExecution === "function" ? stopExecution : function() {},
    addFileContext: typeof addFileContext === "function" ? addFileContext : function() {},
    handleFileInputChange: typeof handleFileInputChange === "function" ? handleFileInputChange : function() {},
    removePendingAttachment: typeof removePendingAttachment === "function" ? removePendingAttachment : function() {},
    clearPendingAttachments: typeof clearPendingAttachments === "function" ? clearPendingAttachments : function() {},
    handleInput: typeof handleInput === "function" ? handleInput : function() {},
    handleKeyDown: typeof handleKeyDown === "function" ? handleKeyDown : function() {},
    filterProjectTree: typeof filterProjectTree === "function" ? filterProjectTree : function() {},
    filterProjects: typeof filterProjects === "function" ? filterProjects : function() {},
    archiveConversation: typeof archiveConversation === "function" ? archiveConversation : function() {},
    unarchiveConversation: typeof unarchiveConversation === "function" ? unarchiveConversation : function() {},
    unarchiveActiveConversation: typeof unarchiveActiveConversation === "function" ? unarchiveActiveConversation : function() {},
    unarchiveAndOpenConversation: typeof unarchiveAndOpenConversation === "function" ? unarchiveAndOpenConversation : function() {},
    openHistoryModal: typeof openHistoryModal === "function" ? openHistoryModal : function() {},
    openArchivedHistoryModal: typeof openArchivedHistoryModal === "function" ? openArchivedHistoryModal : function() {},
    setHistoryFilter: typeof setHistoryFilter === "function" ? setHistoryFilter : function() {},
    refreshHistoryModalView: typeof refreshHistoryModalView === "function" ? refreshHistoryModalView : function() {},
    switchHistoryConversation: typeof switchHistoryConversation === "function" ? switchHistoryConversation : function() {},
    archiveFromHistory: typeof archiveFromHistory === "function" ? archiveFromHistory : function() {},
    unarchiveFromHistory: typeof unarchiveFromHistory === "function" ? unarchiveFromHistory : function() {},
    filterHistory: typeof filterHistory === "function" ? filterHistory : function() {},
    clearAllHistory: typeof clearAllHistory === "function" ? clearAllHistory : function() {},
    setQueuedMessageMode: typeof setQueuedMessageMode === "function" ? setQueuedMessageMode : function() {},
    renderPromptQueueShelf: typeof renderPromptQueueShelf === "function" ? renderPromptQueueShelf : function() {},
    enqueuePrompt: typeof enqueuePrompt === "function" ? enqueuePrompt : function() {},
    startEditQueuedPrompt: typeof startEditQueuedPrompt === "function" ? startEditQueuedPrompt : function() {},
    saveEditQueuedPrompt: typeof saveEditQueuedPrompt === "function" ? saveEditQueuedPrompt : function() {},
    cancelEditQueuedPrompt: typeof cancelEditQueuedPrompt === "function" ? cancelEditQueuedPrompt : function() {},
    handleQueueInputKey: typeof handleQueueInputKey === "function" ? handleQueueInputKey : function() {},
    popQueuedPromptToInput: typeof popQueuedPromptToInput === "function" ? popQueuedPromptToInput : function() {},
    cancelQueuedPrompt: typeof cancelQueuedPrompt === "function" ? cancelQueuedPrompt : function() {},
    processNextInQueue: typeof processNextInQueue === "function" ? processNextInQueue : function() {},
    handleGlobalPresetChange: typeof handleGlobalPresetChange === "function" ? handleGlobalPresetChange : function() {},
    rescanLocalModels: typeof rescanLocalModels === "function" ? rescanLocalModels : function() {},
    toggleCustomSkillForm: typeof toggleCustomSkillForm === "function" ? toggleCustomSkillForm : function() {},
    browseAndInjectSkillFile: typeof browseAndInjectSkillFile === "function" ? browseAndInjectSkillFile : function() {},
    saveCustomSkill: typeof saveCustomSkill === "function" ? saveCustomSkill : function() {},
    windowControl: typeof windowControl === "function" ? windowControl : function() {},
    handleFooterModelChange: typeof handleFooterModelChange === "function" ? handleFooterModelChange : function() {},
    handleFooterReasoningChange: typeof handleFooterReasoningChange === "function" ? handleFooterReasoningChange : function() {},
    openTerminalLogsTab: typeof openTerminalLogsTab === "function" ? openTerminalLogsTab : function() {},
    copyTerminalLogs: typeof copyTerminalLogs === "function" ? copyTerminalLogs : function() {},
    toggleTerminalAutoScroll: typeof toggleTerminalAutoScroll === "function" ? toggleTerminalAutoScroll : function() {},
    clearTerminalView: typeof clearTerminalView === "function" ? clearTerminalView : function() {},
    loadBackendLogs: typeof loadBackendLogs === "function" ? loadBackendLogs : function() {},
    startLocalModelDownload: typeof startLocalModelDownload === "function" ? startLocalModelDownload : async function() {},
    cancelLocalModelDownload: typeof cancelLocalModelDownload === "function" ? cancelLocalModelDownload : async function() {},
    refreshLocalModelCatalog: typeof refreshLocalModelCatalog === "function" ? refreshLocalModelCatalog : async function() {},
    onLocalModelDownloadProgress: typeof window.onLocalModelDownloadProgress === "function" ? window.onLocalModelDownloadProgress : function() {},
    openTurnRawOutput: typeof openTurnRawOutput === "function" ? openTurnRawOutput : function() {},
    renderRightSidebarRawOutputList: typeof renderRightSidebarRawOutputList === "function" ? renderRightSidebarRawOutputList : function() {},
    toggleEditorFold: typeof toggleEditorFold === "function" ? toggleEditorFold : function() {},
    expandAllEditorFolds: typeof expandAllEditorFolds === "function" ? expandAllEditorFolds : function() {},
    collapseAllEditorFolds: typeof collapseAllEditorFolds === "function" ? collapseAllEditorFolds : function() {},
    toggleEditorWordWrap: typeof toggleEditorWordWrap === "function" ? toggleEditorWordWrap : function() {},
    toggleEditorDeepParse: typeof toggleEditorDeepParse === "function" ? toggleEditorDeepParse : function() {},
    toggleEditorMultilineString: typeof toggleEditorMultilineString === "function" ? toggleEditorMultilineString : function() {},
    switchRawOutputViewMode: typeof switchRawOutputViewMode === "function" ? switchRawOutputViewMode : function() {},
    openPermissionsDetail: typeof openPermissionsDetail === "function" ? openPermissionsDetail : function() {},
    closePermissionsDetail: typeof closePermissionsDetail === "function" ? closePermissionsDetail : function() {},
    setPermissionsDetailScope: typeof setPermissionsDetailScope === "function" ? setPermissionsDetailScope : function() {},
    switchPermissionsDetailCategory: typeof switchPermissionsDetailCategory === "function" ? switchPermissionsDetailCategory : function() {},
    renderPermissionsSummaries: typeof renderPermissionsSummaries === "function" ? renderPermissionsSummaries : function() {},
    renderPermissionsDetail: typeof renderPermissionsDetail === "function" ? renderPermissionsDetail : function() {},
    showAddPermissionRuleRow: typeof showAddPermissionRuleRow === "function" ? showAddPermissionRuleRow : function() {},
    cancelNewPermissionRule: typeof cancelNewPermissionRule === "function" ? cancelNewPermissionRule : function() {},
    saveNewPermissionRule: typeof saveNewPermissionRule === "function" ? saveNewPermissionRule : function() {},
    changePermissionRuleAction: typeof changePermissionRuleAction === "function" ? changePermissionRuleAction : function() {},
    startEditPermissionRule: typeof startEditPermissionRule === "function" ? startEditPermissionRule : function() {},
    cancelEditPermissionRule: typeof cancelEditPermissionRule === "function" ? cancelEditPermissionRule : function() {},
    saveEditPermissionRule: typeof saveEditPermissionRule === "function" ? saveEditPermissionRule : function() {},
    deletePermissionRule: typeof deletePermissionRule === "function" ? deletePermissionRule : function() {},
    filterTerminalLogsByArea: typeof filterTerminalLogsByArea === "function" ? filterTerminalLogsByArea : function() {},
    toggleTerminalLogScope: typeof toggleTerminalLogScope === "function" ? toggleTerminalLogScope : function() {},
    toggleTerminalDebugLogs: typeof toggleTerminalDebugLogs === "function" ? toggleTerminalDebugLogs : function() {},
    renderTerminalLogs: typeof renderTerminalLogs === "function" ? renderTerminalLogs : function() {},
    toggleTurnChangesList: typeof toggleTurnChangesList === "function" ? toggleTurnChangesList : function() {},
    toggleTurnFileInlineDiff: typeof toggleTurnFileInlineDiff === "function" ? toggleTurnFileInlineDiff : function() {},
    openReviewSidebar: typeof openReviewSidebar === "function" ? openReviewSidebar : function() {},
    previewFileInSidebar: typeof previewFileInSidebar === "function" ? previewFileInSidebar : function() {},
    setRightSidebarFullscreen: typeof setRightSidebarFullscreen === "function" ? setRightSidebarFullscreen : function() {},
    toggleShuffleToolsDropdown: typeof toggleShuffleToolsDropdown === "function" ? toggleShuffleToolsDropdown : function() {},
    refreshShuffleAuthenticatedApps: typeof refreshShuffleAuthenticatedApps === "function" ? refreshShuffleAuthenticatedApps : function() {},
    filterShuffleToolsList: typeof filterShuffleToolsList === "function" ? filterShuffleToolsList : function() {},
    toggleAttachShuffleTool: typeof toggleAttachShuffleTool === "function" ? toggleAttachShuffleTool : function() {},
    removeAttachedShuffleTool: typeof removeAttachedShuffleTool === "function" ? removeAttachedShuffleTool : function() {},
    clearAllAttachedShuffleTools: typeof clearAllAttachedShuffleTools === "function" ? clearAllAttachedShuffleTools : function() {},
    toggleAttachShuffleSkill: typeof toggleAttachShuffleSkill === "function" ? toggleAttachShuffleSkill : async function() {},
    removeAttachedShuffleSkill: typeof removeAttachedShuffleSkill === "function" ? removeAttachedShuffleSkill : async function() {},
    refreshShuffleSharedSkills: typeof refreshShuffleSharedSkills === "function" ? refreshShuffleSharedSkills : async function() {},
    syncAttachedShuffleSkillsToBackend: typeof syncAttachedShuffleSkillsToBackend === "function" ? syncAttachedShuffleSkillsToBackend : async function() {},
    togglePromptPlusMenu: typeof togglePromptPlusMenu === "function" ? togglePromptPlusMenu : function() {},
    togglePromptPlusSkillsSubmenu: typeof togglePromptPlusSkillsSubmenu === "function" ? togglePromptPlusSkillsSubmenu : function() {},
    renderPromptPlusMenu: typeof renderPromptPlusMenu === "function" ? renderPromptPlusMenu : function() {},
    triggerAddFileFromPlusMenu: typeof triggerAddFileFromPlusMenu === "function" ? triggerAddFileFromPlusMenu : function() {},
    clearAttachedShuffleSkills: typeof clearAttachedShuffleSkills === "function" ? clearAttachedShuffleSkills : async function() {},
    updateShuffleToolsButtonVisibility: typeof updateShuffleToolsButtonVisibility === "function" ? updateShuffleToolsButtonVisibility : function() {}
  };
  for (const [k, fn] of Object.entries(handlers)) {
    window[k] = fn;
  }
}

registerGlobalHandlers();

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", bootApp);
} else {
  bootApp();
}