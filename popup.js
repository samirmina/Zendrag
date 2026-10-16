let subdomain = '';
let allViews = [];
let lastHistoryWrite = 0;
let settings = {};
const DEFAULT_SETTINGS = {
  pollInterval: 60,
  idlePause: 'enabled',
  maxPages: 3,
  interPageDelay: 250,
  soundAlert: 'disabled',
  notificationBehavior: 'per-ticket',
  notificationPersistence: 'auto-close',
  historyCapacity: 100
};

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  return settings;
}

async function saveSettings(updated) {
  settings = { ...settings, ...updated };
  await chrome.storage.local.set({ settings });
}

function applySettingsToUI() {
  const pollIntervalEl = document.getElementById('poll-interval');
  const idlePauseEl = document.getElementById('idle-pause');
  const maxPagesEl = document.getElementById('max-pages');
  const interPageDelayEl = document.getElementById('inter-page-delay');
  const soundAlertEl = document.getElementById('sound-alert');
  const notificationBehaviorEl = document.getElementById('notification-behavior');
  const notificationPersistenceEl = document.getElementById('notification-persistence');
  const historyCapacityEl = document.getElementById('history-capacity');

  if (pollIntervalEl) pollIntervalEl.value = String(settings.pollInterval ?? DEFAULT_SETTINGS.pollInterval);
  if (idlePauseEl) idlePauseEl.value = String(settings.idlePause ?? DEFAULT_SETTINGS.idlePause);
  if (maxPagesEl) maxPagesEl.value = String(settings.maxPages ?? DEFAULT_SETTINGS.maxPages);
  if (interPageDelayEl) interPageDelayEl.value = String(settings.interPageDelay ?? DEFAULT_SETTINGS.interPageDelay);
  if (soundAlertEl) soundAlertEl.value = String(settings.soundAlert ?? DEFAULT_SETTINGS.soundAlert);
  if (notificationBehaviorEl) notificationBehaviorEl.value = String(settings.notificationBehavior ?? DEFAULT_SETTINGS.notificationBehavior);
  if (notificationPersistenceEl) notificationPersistenceEl.value = String(settings.notificationPersistence ?? DEFAULT_SETTINGS.notificationPersistence);
  if (historyCapacityEl) historyCapacityEl.value = String(settings.historyCapacity ?? DEFAULT_SETTINGS.historyCapacity);
}

function formatTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderHistory(entries) {
  const container = document.getElementById('ticket-history');
  if (!entries.length) {
    container.innerHTML = '<div class="history-empty">No tickets yet</div>';
    return;
  }
  container.innerHTML = entries.slice(0, 100).map(entry => `
    <div class="history-item">
      <span class="history-ticket">#${entry.ticketNumber || '???'}</span>
      <span class="history-view">${entry.viewTitle}</span>
      <span class="history-time">${formatTime(entry.receivedAt)}</span>
    </div>
  `).join('');
}

function updateButtonState(monitoring, paused, selectedViews, viewsLoaded) {
  const btn = document.getElementById('toggle-btn');
  if (monitoring && !paused) {
    btn.textContent = 'Stop Monitoring';
    btn.disabled = false;
  } else if (monitoring && paused) {
    btn.textContent = 'Resume Monitoring';
    btn.disabled = false;
  } else {
    btn.textContent = 'Start Monitoring';
    btn.disabled = !viewsLoaded || !(selectedViews || []).length;
  }
}

function getViewRules(selectedViews, viewId) {
  const view = selectedViews.find(v => v.id === viewId);
  return view?.rules || [];
}

async function getAvailableValuesForColumn(columnKey) {
  const { dynamicFieldValues = {}, combinedLookupMap = {} } = await chrome.storage.local.get(['dynamicFieldValues', 'combinedLookupMap']);

  if (dynamicFieldValues[columnKey] && dynamicFieldValues[columnKey].length > 0) {
    return dynamicFieldValues[columnKey];
  }

  if (['group_id', 'assignee_id', 'organization_id', 'group'].includes(columnKey)) {
    return Object.entries(combinedLookupMap).map(([id, name]) => ({
      value: name,
      label: `${name} (ID: ${id})`
    }));
  }

  return [];
}

function renderRuleRow(rule, viewId, availableColumns = [], valuesMap = {}) {
  const selectedColumn = rule.column || '';
  const columnOptions = availableColumns.map(col => 
    `<option value="${col.key}" ${selectedColumn === col.key ? 'selected' : ''}>${col.title}</option>`
  ).join('');
  
  const orphanOption = (selectedColumn && !availableColumns.some(col => col.key === selectedColumn)) 
    ? `<option value="${selectedColumn}" disabled>${selectedColumn} (no longer available)</option>`
    : '';
  
  const selectedValues = rule.values || [];
  const currentValues = valuesMap[selectedColumn] || [];
  const valuesOptions = currentValues.map(val => 
    `<option value="${val}" ${selectedValues.includes(val) ? 'selected' : ''}>${val}</option>`
  ).join('');
  
  return `
    <div class="rule-row" data-view-id="${viewId}">
      <select class="rule-column">
        <option value="">Select column...</option>
        ${orphanOption}
        ${columnOptions}
      </select>
      <select class="rule-values" multiple ${!selectedColumn ? 'disabled' : ''}>
        <option value="">Select values...</option>
        ${valuesOptions}
      </select>
      <button type="button" class="rule-delete-btn text-btn">Delete</button>
    </div>
  `;
}

function renderRuleEditor(viewId, rules, availableColumns = [], valuesMap = {}) {
  const rulesHtml = (rules || []).map(rule => renderRuleRow(rule, viewId, availableColumns, valuesMap)).join('');
  return `
    <div class="rule-editor" data-view-id="${viewId}">
      <div class="rule-editor-header">
        <span>Rules for this view:</span>
      </div>
      <div class="rule-list">
        ${rulesHtml || '<div class="history-empty">No rules yet. All tickets will be candidates.</div>'}
      </div>
      <button type="button" class="add-rule-btn">Add Rule</button>
      <div class="rule-actions">
        <button type="button" class="save-rules-btn text-btn">Save</button>
        <button type="button" class="cancel-rules-btn text-btn">Cancel</button>
      </div>
    </div>
  `;
}

async function loadViews(statusEl, viewsList, toggleBtn) {
  statusEl.textContent = 'Loading views...';
  statusEl.style.color = 'gray';
  viewsList.innerHTML = '';
  toggleBtn.disabled = true;

  const stored = await chrome.storage.local.get('subdomain');
  if (stored.subdomain) {
    subdomain = stored.subdomain;
  } else {
    const findResult = await chrome.runtime.sendMessage({ type: 'FIND_SUBDOMAIN' });
    if (findResult.error) {
      statusEl.textContent = 'Open any Zendesk page to load views';
      statusEl.style.color = 'red';
      viewsList.innerHTML = '<div class="history-empty">Open any Zendesk page to load views</div>';
      return false;
    }
    subdomain = findResult.subdomain;
    await chrome.storage.local.set({ subdomain });
  }

  statusEl.textContent = 'Loading views...';
  const response = await chrome.runtime.sendMessage({ type: 'GET_VIEWS', subdomain });

  if (response.error) {
    statusEl.textContent = 'Open any Zendesk page to load views';
    statusEl.style.color = 'red';
    viewsList.innerHTML = '<div class="history-empty">Open any Zendesk page to load views</div>';
    return false;
  }

  allViews = response.views || [];
  if (allViews.length === 0) {
    statusEl.textContent = 'No views found';
    statusEl.style.color = 'red';
    return false;
  }

  statusEl.textContent = `${allViews.length} views loaded`;
  statusEl.style.color = 'green';

  const state = await chrome.storage.local.get(['selectedViews', 'monitoring', 'paused']);
  const selectedViews = state.selectedViews || [];

  viewsList.innerHTML = allViews.map(view => {
    const isSelected = selectedViews.some(v => v.id === view.id);
    const rules = getViewRules(selectedViews, view.id);
    return `
      <div class="view-row" data-view-id="${view.id}">
        <label class="view-item">
          <input type="checkbox" class="view-checkbox" value="${view.id}" ${isSelected ? 'checked' : ''}>
          <span class="view-title">${view.title}</span>
        </label>
        <button type="button" class="edit-rules-btn text-btn">Edit Rules</button>
        <div class="rule-editor-container"></div>
      </div>
    `;
  }).join('');

  updateButtonState(state.monitoring, state.paused, selectedViews, true);
  return true;
}

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const toggleBtn = document.getElementById('toggle-btn');
  const viewsList = document.getElementById('views-list');
  const clearHistoryBtn = document.getElementById('clear-history-btn');

  const viewsLoaded = await loadViews(statusEl, viewsList, toggleBtn);

  const historyResult = await chrome.storage.local.get('ticketHistory');
  const storedSettings = await chrome.storage.local.get('settings');
  const capacity = storedSettings.settings?.historyCapacity ?? DEFAULT_SETTINGS.historyCapacity;
  let historyEntries = historyResult.ticketHistory || [];
  if (historyEntries.length > capacity) {
    historyEntries = historyEntries.slice(0, capacity);
    await chrome.storage.local.set({ ticketHistory: historyEntries });
  }
  renderHistory(historyEntries);

  const state = await chrome.storage.local.get(['monitoring', 'paused', 'selectedViews']);
  if (state.monitoring && state.paused) {
    statusEl.textContent = 'Monitoring Paused — waiting for Zendesk tab';
    statusEl.style.color = 'red';
  }

  const settingsPanel = document.getElementById('settings-panel');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsClose = document.getElementById('settings-close');

  settingsToggle?.addEventListener('click', async () => {
    await loadSettings();
    applySettingsToUI();
    settingsPanel.classList.remove('hidden');
  });

  settingsClose?.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  const settingControls = [
    { id: 'poll-interval', key: 'pollInterval', parser: Number },
    { id: 'idle-pause', key: 'idlePause' },
    { id: 'max-pages', key: 'maxPages', parser: Number },
    { id: 'inter-page-delay', key: 'interPageDelay', parser: Number },
    { id: 'sound-alert', key: 'soundAlert' },
    { id: 'notification-behavior', key: 'notificationBehavior' },
    { id: 'notification-persistence', key: 'notificationPersistence' },
    { id: 'history-capacity', key: 'historyCapacity', parser: Number }
  ];

  for (const control of settingControls) {
    const el = document.getElementById(control.id);
    if (!el) continue;
    el.addEventListener('change', async () => {
      const value = control.parser ? control.parser(el.value) : el.value;
      await saveSettings({ [control.key]: value });
    });
  }

  document.getElementById('clear-cache-btn')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_METADATA_CACHE' });
    alert('Metadata cache cleared.');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ticketHistory) {
      const now = Date.now();
      if (now - lastHistoryWrite < 500) return;
      const newHistory = changes.ticketHistory.newValue || [];
      const currentCapacity = settings.historyCapacity ?? DEFAULT_SETTINGS.historyCapacity;
      const trimmed = newHistory.slice(0, currentCapacity);
      renderHistory(trimmed);
    }
    if (changes.monitoring || changes.paused || changes.selectedViews) {
      const monitoring = changes.monitoring?.newValue ?? state.monitoring;
      const paused = changes.paused?.newValue ?? state.paused;
      const selectedViews = changes.selectedViews?.newValue ?? state.selectedViews;
      updateButtonState(monitoring, paused, selectedViews, allViews.length > 0);
      if (monitoring && paused) {
        statusEl.textContent = 'Monitoring Paused — waiting for Zendesk tab';
        statusEl.style.color = 'red';
      }
    }
  });

  viewsList.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.edit-rules-btn');
    if (!editBtn) return;
    const viewRow = editBtn.closest('.view-row');
    const viewId = viewRow.dataset.viewId;
    const container = viewRow.querySelector('.rule-editor-container');
    const isOpen = container.innerHTML.trim() !== '';

    if (isOpen) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = '<div class="history-empty">Loading columns...</div>';

    try {
      const subdomain = await chrome.storage.local.get('subdomain');
      const result = await chrome.runtime.sendMessage({ 
        type: 'GET_VIEW_COLUMNS', 
        subdomain: subdomain.subdomain,
        viewId 
      });
      
      if (result.error) {
        container.innerHTML = '<div class="history-empty">Failed to load columns. Please try again.</div>';
        return;
      }

      if (!result.columns.length) {
        container.innerHTML = '<div class="history-empty">No columns available in this view.</div>';
        return;
      }

      const currentState = await chrome.storage.local.get('selectedViews');
      const rules = getViewRules(currentState.selectedViews || [], viewId);
      container.innerHTML = renderRuleEditor(viewId, rules, result.columns, result.valuesMap);
      
      const ruleEditor = container.querySelector('.rule-editor');
      if (ruleEditor) {
        ruleEditor.dataset.columns = JSON.stringify(result.columns);
        ruleEditor.dataset.valuesMap = JSON.stringify(result.valuesMap);
      }
    } catch (err) {
      container.innerHTML = '<div class="history-empty">Failed to load columns. Please try again.</div>';
    }
  });

  viewsList.addEventListener('click', async (e) => {
    const target = e.target;
    const ruleEditor = target.closest('.rule-editor');
    if (!ruleEditor) return;
    const viewId = ruleEditor.dataset.viewId;

    if (target.classList.contains('add-rule-btn')) {
      const ruleList = ruleEditor.querySelector('.rule-list');
      const emptyMsg = ruleList.querySelector('.history-empty');
      if (emptyMsg) ruleList.innerHTML = '';
      const tempDiv = document.createElement('div');
      
      let availableColumns = [];
      let valuesMap = {};
      try {
        availableColumns = JSON.parse(ruleEditor.dataset.columns || '[]');
        valuesMap = JSON.parse(ruleEditor.dataset.valuesMap || '{}');
      } catch (e) {
        availableColumns = [];
        valuesMap = {};
      }
      
      tempDiv.innerHTML = renderRuleRow({ column: '', values: [] }, viewId, availableColumns, valuesMap);
      ruleList.appendChild(tempDiv.firstElementChild);
      return;
    }

    if (target.classList.contains('rule-delete-btn')) {
      const ruleRow = target.closest('.rule-row');
      ruleRow.remove();
      const ruleList = ruleEditor.querySelector('.rule-list');
      if (!ruleList.querySelector('.rule-row')) {
        ruleList.innerHTML = '<div class="history-empty">No rules yet. All tickets will be candidates.</div>';
      }
      return;
    }

    if (target.classList.contains('save-rules-btn')) {
      const ruleRows = ruleEditor.querySelectorAll('.rule-row');
      const rules = Array.from(ruleRows).map(row => {
        const column = row.querySelector('.rule-column').value.trim();
        const valuesSelect = row.querySelector('.rule-values');
        const values = valuesSelect ? Array.from(valuesSelect.selectedOptions).map(o => o.value).filter(Boolean) : [];
        return { column, values };
      }).filter(r => r.column);

      const currentState = await chrome.storage.local.get('selectedViews');
      const selectedViews = (currentState.selectedViews || []).map(v => {
        if (v.id !== viewId) return v;
        return { ...v, rules };
      });
      await chrome.storage.local.set({ selectedViews });
      ruleEditor.closest('.rule-editor-container').innerHTML = '';
      return;
    }

    if (target.classList.contains('cancel-rules-btn')) {
      ruleEditor.closest('.rule-editor-container').innerHTML = '';
      return;
    }
  });

  viewsList.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('rule-column')) return;
    const ruleRow = e.target.closest('.rule-row');
    if (!ruleRow) return;
    const ruleEditor = ruleRow.closest('.rule-editor');
    const viewId = ruleEditor.dataset.viewId;

    let valuesMap = {};
    try {
      valuesMap = JSON.parse(ruleEditor.dataset.valuesMap || '{}');
    } catch (e) {
      valuesMap = {};
    }

    const selectedColumn = e.target.value;
    const valuesSelect = ruleRow.querySelector('.rule-values');

    valuesSelect.innerHTML = '<option value="">Select values...</option>';

    let newValues = valuesMap[selectedColumn] || [];
    if (!newValues.length && (selectedColumn === 'channel' || selectedColumn === 'via.channel')) {
      newValues = valuesMap['via.channel'] || valuesMap['channel'] || [];
    }

    if (!newValues.length) {
      const fetchedValues = await getAvailableValuesForColumn(selectedColumn);
      newValues = fetchedValues.map(v => typeof v === 'object' ? v.value : v);
    }

    const valuesOptions = newValues.map(val => {
      const displayLabel = typeof val === 'object' ? (val.label || val.value) : val;
      const actualVal = typeof val === 'object' ? val.value : val;
      return `<option value="${actualVal}">${displayLabel}</option>`;
    }).join('');

    valuesSelect.innerHTML += valuesOptions;
    valuesSelect.disabled = !selectedColumn;
  });

  viewsList.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('view-checkbox')) return;
    const checked = Array.from(viewsList.querySelectorAll('.view-checkbox:checked'));
    const currentState = await chrome.storage.local.get('selectedViews');
    const selectedViews = checked.map(cb => {
      const viewRow = cb.closest('.view-row');
      const viewId = viewRow.dataset.viewId;
      const view = allViews.find(v => v.id === viewId);
      const currentStateEl = document.querySelector('.rule-editor[data-view-id="' + viewId + '"]');
      let rules = [];
      if (currentStateEl) {
        const ruleRows = currentStateEl.querySelectorAll('.rule-row');
        rules = Array.from(ruleRows).map(row => {
          const column = row.querySelector('.rule-column').value.trim();
          const valuesSelect = row.querySelector('.rule-values');
          const values = valuesSelect ? Array.from(valuesSelect.selectedOptions).map(o => o.value).filter(Boolean) : [];
          return { column, values };
        }).filter(r => r.column);
      } else {
        const storedView = (currentState.selectedViews || []).find(v => v.id === viewId);
        rules = storedView?.rules || [];
      }
      return {
        id: viewId,
        title: view ? view.title : cb.parentElement.textContent.trim(),
        rules
      };
    });

    const state = await chrome.storage.local.get(['selectedViews', 'monitoring']);
    await chrome.storage.local.set({ selectedViews });
    if (state.monitoring && selectedViews.length === 0) {
      await chrome.storage.local.set({ monitoring: false });
      await chrome.runtime.sendMessage({ type: 'STOP_MONITORING' });
    }
  });

  toggleBtn.addEventListener('click', async () => {
    const monitoringState = await chrome.storage.local.get(['monitoring', 'paused']);
    const monitoring = monitoringState.monitoring;
    const paused = monitoringState.paused;

    if (monitoring && !paused) {
      await chrome.runtime.sendMessage({ type: 'STOP_MONITORING' });
      toggleBtn.textContent = 'Start Monitoring';
      statusEl.textContent = `${allViews.length} views loaded`;
      statusEl.style.color = 'green';
      const current = await chrome.storage.local.get('selectedViews');
      updateButtonState(false, false, current.selectedViews, allViews.length > 0);
      return;
    }

    if (monitoring && paused) {
      toggleBtn.disabled = true;
      toggleBtn.textContent = 'Resuming...';
      const res = await chrome.runtime.sendMessage({ type: 'RESUME_MONITORING' });
      if (res.success) {
        toggleBtn.textContent = 'Stop Monitoring';
        statusEl.textContent = `${allViews.length} views loaded`;
        statusEl.style.color = 'green';
      } else {
        toggleBtn.textContent = 'Resume Monitoring';
        statusEl.textContent = res.error === 'no_zendesk_tab' ? 'Open any Zendesk page to resume' : 'Something went wrong. Please try again.';
        statusEl.style.color = 'red';
      }
      toggleBtn.disabled = false;
      const current = await chrome.storage.local.get('selectedViews');
      updateButtonState(monitoring, !res.success, current.selectedViews, allViews.length > 0);
      return;
    }

    const checked = viewsList.querySelectorAll('.view-checkbox:checked');
    const selectedViews = Array.from(checked).map(cb => {
      const viewRow = cb.closest('.view-row');
      const viewId = viewRow.dataset.viewId;
      const view = allViews.find(v => v.id === viewId);
      const ruleEditor = document.querySelector(`.rule-editor[data-view-id="${viewId}"]`);
      let rules = [];
      if (ruleEditor) {
        const ruleRows = ruleEditor.querySelectorAll('.rule-row');
        rules = Array.from(ruleRows).map(row => {
          const column = row.querySelector('.rule-column').value.trim();
          const valuesSelect = row.querySelector('.rule-values');
          const values = valuesSelect ? Array.from(valuesSelect.selectedOptions).map(o => o.value).filter(Boolean) : [];
          return { column, values };
        }).filter(r => r.column);
      }
      return {
        id: viewId,
        title: view ? view.title : cb.parentElement.textContent.trim(),
        rules
      };
    });

    if (selectedViews.length === 0) {
      alert('Please select at least one view');
      return;
    }

    toggleBtn.disabled = true;
    toggleBtn.textContent = 'Starting...';

    const res = await chrome.runtime.sendMessage({
      type: 'START_MONITORING',
      subdomain,
      views: selectedViews
    });

    if (res.success) {
      toggleBtn.textContent = 'Stop Monitoring';
      statusEl.textContent = `${allViews.length} views loaded`;
      statusEl.style.color = 'green';
    } else {
      toggleBtn.textContent = 'Start Monitoring';
      statusEl.textContent = res.error === 'no_zendesk_tab' ? 'Open any Zendesk page to start' : 'Something went wrong. Please try again.';
      statusEl.style.color = 'red';
    }
    toggleBtn.disabled = false;
    updateButtonState(res.success, false, selectedViews, allViews.length > 0);
  });

  clearHistoryBtn.addEventListener('click', async () => {
    lastHistoryWrite = Date.now();
    await chrome.storage.local.set({ ticketHistory: [] });
    renderHistory([]);
  });
});
