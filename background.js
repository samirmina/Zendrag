const ALARM_NAME = 'check-tickets';
let resumeDebounce = 0;
let notificationPermission = 'granted';
let cachedMetadata = null;

async function init() {
  try {
    notificationPermission = await chrome.notifications.getPermissionLevel();
  } catch (e) {
    console.error('Failed to get notification permission:', e);
  }
}

init();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['audio_playback'],
      justification: 'Play notification sound for new Zendesk tickets'
    });
  }
}

async function playNotificationSound() {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: 'playSound' });
  } catch (e) {
    console.error('Sound playback failed:', e);
  }
}

async function maybeNotify(options, fixedId) {
  if (notificationPermission !== 'granted') return;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const isSticky = settings?.notificationPersistence === 'sticky';

    const notificationOptions = {
      ...options,
      requireInteraction: isSticky
    };

    if (fixedId) {
      await chrome.notifications.clear(fixedId).catch(() => {});
    }
    await chrome.notifications.create(fixedId || options.id || '', notificationOptions);

    if (settings?.soundAlert === 'enabled') {
      await playNotificationSound();
    }
  } catch (e) {
    console.error('Notification failed:', e);
  }
}

async function injectFetch(tabId, url) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targetUrl) => {
      try {
        const r = await fetch(targetUrl, { credentials: 'include' });
        const headersObj = {};
        r.headers.forEach((value, key) => { headersObj[key] = value; });
        return {
          ok: r.ok,
          status: r.status,
          statusText: r.statusText,
          headers: headersObj,
          data: r.ok ? await r.json() : null,
          error: r.ok ? null : `HTTP ${r.status}: ${r.statusText}`
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    args: [url]
  });
  const injected = result?.[0]?.result;
  if (!injected) return { ok: false, error: 'injection_failed' };
  return injected;
}

function getNextPageUrl(response) {
  if (!response || !response.ok || !response.data) return null;
  const bodyNext = response.data.links?.next || response.data.next_page || response.data.next;
  if (bodyNext) return bodyNext;
  const linkHeader = response.headers?.link || '';
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function buildLookupMap(responseData, accumulator) {
  if (!accumulator) accumulator = {};
  if (!responseData) return accumulator;
  const entityTypes = ['users', 'groups', 'organizations', 'custom_statuses'];
  entityTypes.forEach(type => {
    if (Array.isArray(responseData[type])) {
      responseData[type].forEach(item => {
        if (item && item.id != null) {
          accumulator[String(item.id)] = item.name || item.title || item.value || String(item.id);
        }
      });
    }
  });
  return accumulator;
}

async function getOrFetchMetadata(tabId, subdomain) {
  if (!cachedMetadata) {
    cachedMetadata = await fetchMetadata(tabId, subdomain);
  }
  return cachedMetadata;
}

async function fetchMetadata(tabId, subdomain) {
  const endpoints = [
    `/api/v2/ticket_fields.json`,
    `/api/v2/custom_statuses.json`,
    `/api/v2/groups.json`,
    `/api/v2/users.json`,
    `/api/v2/organizations.json`
  ];
  const results = await Promise.all(
    endpoints.map(url => injectFetch(tabId, `https://${subdomain}.zendesk.com${url}`))
  );
  const metadata = {};
  results.forEach((res, idx) => {
    if (!res || !res.ok) return;
    const key = endpoints[idx].split('/').pop().replace('.json', '');
    metadata[key] = res.data[key] || res.data;
  });
  return metadata;
}

function buildMetadataMaps(metadata) {
  const maps = {};
  if (!metadata) return maps;
  if (Array.isArray(metadata.custom_statuses)) {
    maps.customStatuses = {};
    metadata.custom_statuses.forEach(item => {
      if (item && item.id != null) maps.customStatuses[String(item.id)] = item.name || item.title || String(item.id);
    });
  }
  if (Array.isArray(metadata.groups)) {
    maps.groups = {};
    metadata.groups.forEach(item => {
      if (item && item.id != null) maps.groups[String(item.id)] = item.name || String(item.id);
    });
  }
  if (Array.isArray(metadata.users)) {
    maps.users = {};
    metadata.users.forEach(item => {
      if (item && item.id != null) maps.users[String(item.id)] = item.name || String(item.id);
    });
  }
  if (Array.isArray(metadata.organizations)) {
    maps.organizations = {};
    metadata.organizations.forEach(item => {
      if (item && item.id != null) maps.organizations[String(item.id)] = item.name || String(item.id);
    });
  }
  if (Array.isArray(metadata.ticket_fields)) {
    maps.ticketFields = {};
    metadata.ticket_fields.forEach(field => {
      if (!field || field.id == null) return;
      const options = [];
      if (Array.isArray(field.custom_field_options)) {
        field.custom_field_options.forEach(opt => {
          if (opt && opt.value != null) options.push({ value: String(opt.value), label: opt.name || String(opt.value) });
        });
      }
      if (options.length) maps.ticketFields[String(field.id)] = options;
    });
  }
  return maps;
}

function mergeMetadataIntoLookupMap(lookupMap, metadataMaps) {
  if (!lookupMap || !metadataMaps) return lookupMap;
  if (metadataMaps.customStatuses) {
    Object.entries(metadataMaps.customStatuses).forEach(([id, name]) => {
      lookupMap[id] = name;
    });
  }
  if (metadataMaps.groups) {
    Object.entries(metadataMaps.groups).forEach(([id, name]) => {
      lookupMap[id] = name;
    });
  }
  if (metadataMaps.users) {
    Object.entries(metadataMaps.users).forEach(([id, name]) => {
      lookupMap[id] = name;
    });
  }
  if (metadataMaps.organizations) {
    Object.entries(metadataMaps.organizations).forEach(([id, name]) => {
      lookupMap[id] = name;
    });
  }
  if (metadataMaps.ticketFields) {
    Object.entries(metadataMaps.ticketFields).forEach(([fieldId, options]) => {
      options.forEach(opt => {
        lookupMap[opt.value] = opt.label;
      });
    });
  }
  return lookupMap;
}

function buildAndSaveDynamicMetadata(tickets, combinedLookupMap) {
  const dynamicFieldValues = {};

  tickets.forEach(ticket => {
    const channel = ticket.via?.channel || ticket.channel;
    if (channel) {
      if (!dynamicFieldValues['via.channel']) dynamicFieldValues['via.channel'] = new Set();
      dynamicFieldValues['via.channel'].add(String(channel).toLowerCase());
    }
    if (ticket.group_id != null) {
      if (!dynamicFieldValues['group_id']) dynamicFieldValues['group_id'] = new Set();
      dynamicFieldValues['group_id'].add(String(ticket.group_id));
    }
    if (ticket.assignee_id != null) {
      if (!dynamicFieldValues['assignee_id']) dynamicFieldValues['assignee_id'] = new Set();
      dynamicFieldValues['assignee_id'].add(String(ticket.assignee_id));
    }
  });

  const formattedFieldValues = {};
  for (const [key, set] of Object.entries(dynamicFieldValues)) {
    formattedFieldValues[key] = Array.from(set).map(val => ({
      value: val,
      label: combinedLookupMap[val] || val.toUpperCase()
    }));
  }

  chrome.storage.local.set({
    combinedLookupMap: combinedLookupMap,
    dynamicFieldValues: formattedFieldValues,
    lastMetadataUpdate: Date.now()
  });
}

function resolveCellValue(ticket, columnKey, lookupMap = {}) {
  if (!ticket || !columnKey) return '';

  // 1. Support dynamically nested paths (e.g., via.channel or organization.name)
  let rawValue = columnKey.split('.').reduce((obj, key) => obj?.[key], ticket);

  // 2. If the value is not nested, try reading directly from the ticket
  if (rawValue === undefined) {
    rawValue = ticket[columnKey];
  }

  // Custom fields fallback
  if (rawValue === undefined && ticket.fields && Array.isArray(ticket.fields)) {
    const customField = ticket.fields.find(f => String(f.id) === String(columnKey));
    if (customField) rawValue = customField.value;
  }

  if (rawValue === undefined || rawValue === null) return '';

  // Handle arrays
  if (Array.isArray(rawValue)) {
    return rawValue.map(item => {
      if (typeof item === 'object' && item !== null) {
        const name = item.name || item.title || item.value;
        if (name) return name;
        const idStr = String(item.id || '');
        return lookupMap[idStr] || idStr;
      }
      const str = String(item);
      return lookupMap[str] || str;
    }).filter(Boolean).join(', ');
  }

  // Handle objects
  if (typeof rawValue === 'object') {
    const name = rawValue.name || rawValue.title || rawValue.value;
    if (name) return name;
    const idStr = String(rawValue.id || '');
    return lookupMap[idStr] || idStr;
  }

  // 3. If the value is a numeric ID, look it up in the lookup map
  const stringId = String(rawValue);
  if (lookupMap[stringId]) {
    return lookupMap[stringId]; // Return the actual translated name dynamically
  }

  // 4. Return the raw value actually present in the JSON without imposing fixed assumptions
  return String(rawValue);
}

async function fetchAllPages(tabId, subdomain, viewId, maxPages = 1, interPageDelay = 250) {
  const allTickets = [];
  const allColumns = new Set();
  const lookupMap = {};
  let url = `https://${subdomain}.zendesk.com/api/v2/views/${viewId}/execute.json?per_page=30&page=1`;
  let pageCount = 0;
  let lastError = null;
  while (url && pageCount < maxPages) {
    const response = await injectFetch(tabId, url);
    if (!response || !response.ok) {
      if (response && response.status === 429) {
        const retryAfter = parseInt(response.headers?.['retry-after'] || response.headers?.['Retry-After'] || '10', 10);
        console.warn(`[Zenduck] Rate limited (429). Backing off for ${retryAfter}s.`);
        lastError = `HTTP 429: Rate limited. Retrying in ${retryAfter}s`;
        break;
      }
      lastError = response?.error || 'injection_failed';
      console.warn(`[Zenduck] Page fetch stopped at page ${pageCount + 1}. Status: ${lastError}`);
      break;
    }
    const tickets = extractTickets(response.data);
    allTickets.push(...tickets);
    const columnIds = response.data.view?.columns || [];
    const columnsDict = response.data.columns || {};
    columnIds.forEach(id => {
      const col = columnsDict[id];
      if (col) {
        allColumns.add(JSON.stringify({
          id: col.id || id,
          title: col.title || id,
          type: col.type || 'text',
          sortable: col.sortable || false
        }));
      }
    });
    buildLookupMap(response.data, lookupMap);
    url = getNextPageUrl(response);
    pageCount++;
    if (url && pageCount < maxPages) {
      await delay(interPageDelay);
    }
  }
  if (pageCount >= maxPages) {
    console.warn(`[Zenduck] fetchAllPages hit ${maxPages}-page limit for view ${viewId}`);
  }
  const deduped = [];
  const seen = new Set();
  for (const t of allTickets) {
    if (t && t.id && !seen.has(t.id)) { seen.add(t.id); deduped.push(t); }
  }
  const uniqueColumns = [];
  for (const s of allColumns) {
    try { uniqueColumns.push(JSON.parse(s)); } catch { /* ignore malformed column */ }
  }
  if (viewId) {
    globalThis.viewColumnsMap = globalThis.viewColumnsMap || {};
    globalThis.viewColumnsMap[viewId] = uniqueColumns;
  }
  const partial = pageCount > 0 && url != null;
  return { tickets: deduped, columns: uniqueColumns, lookupMap, partial, lastError };
}

async function findZendeskTab(subdomain) {
  const tabs = await chrome.tabs.query({ url: 'https://*.zendesk.com/*' });
  if (!tabs.length) return null;
  if (tabs.length === 1) return tabs[0];
  const match = tabs.find(t => {
    try {
      const hostname = new URL(t.url).hostname;
      if (hostname === 'zendesk.com') return false;
      if (!subdomain) return true;
      return hostname === `${subdomain}.zendesk.com` || hostname.endsWith(`.${subdomain}.zendesk.com`);
    } catch {
      return false;
    }
  });
  return match || tabs[0];
}

function extractTickets(responseData) {
  if (!responseData || typeof responseData !== 'object') return [];
  if (Array.isArray(responseData)) {
    return responseData.filter(t => t && (t.id || t.ticket_id));
  }
  const rows = responseData.rows;
  if (!Array.isArray(rows)) {
    console.warn('[Zenduck] Unexpected response shape:', JSON.stringify(responseData).slice(0, 600));
    return [];
  }
  const first = rows[0];
  if (!first) return [];
  if (first.ticket && typeof first.ticket === 'object') {
    return rows.map(r => r.ticket).filter(Boolean);
  }
  return rows.filter(t => t && (t.id || t.ticket_id));
}

function applyRules(tickets, rules, lookupMap) {
  if (!tickets.length || !rules || !rules.length) return tickets;
  return tickets.filter(ticket => {
    return rules.every(rule => {
      if (!rule.column || !rule.values || !rule.values.length) return true;

      const resolvedValue = resolveCellValue(ticket, rule.column, lookupMap).trim().toLowerCase();
      const rawValue = String(ticket[rule.column] ?? '').trim().toLowerCase();

      return rule.values.some(val => {
        const targetVal = String(val).trim().toLowerCase();
        return resolvedValue === targetVal || rawValue === targetVal || resolvedValue.includes(targetVal);
      });
    });
  });
}

async function pauseMonitoring(reason) {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.local.set({ paused: true });
  await chrome.action.setBadgeText({ text: 'PAUSED' });
  await maybeNotify({
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'Zenduck',
    message: `Zenduck paused — ${reason}`
  }, 'zenduck-paused');
}

async function resumeMonitoring() {
  const data = await chrome.storage.local.get(['subdomain']);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  await chrome.storage.local.set({ paused: false });
  await chrome.action.setBadgeText({ text: '0' });
  await maybeNotify({
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'Zenduck',
    message: 'Zenduck resumed — monitoring active'
  }, 'zenduck-resumed');
}

function showPerTicketNotification(ticket, viewTitle, subdomain, lookupMap) {
  const ticketId = ticket.id || ticket.ticket_id || '???';
  const ticketNumber = ticket.number ?? ticketId;
  const subject = ticket.subject || 'No Subject';
  const channel = resolveCellValue(ticket, 'via.channel', lookupMap) || resolveCellValue(ticket, 'channel', lookupMap);
  const group = resolveCellValue(ticket, 'group_id', lookupMap);
  const assignee = resolveCellValue(ticket, 'assignee_id', lookupMap);
  const topParts = [];
  if (channel) topParts.push(`Channel: ${String(channel).toUpperCase()}`);
  if (group) topParts.push(`Group: ${group}`);
  const messageLines = [
    topParts.join(' • ') || '',
    assignee ? `Assignee: ${assignee}` : '',
    `View: ${viewTitle}`
  ].filter(Boolean).join('\n');
  const contextMessage = 'Zenduck Monitor';

  maybeNotify({
    type: 'basic',
    iconUrl: 'icon.png',
    title: `#${ticketNumber} - ${subject}`,
    message: messageLines,
    contextMessage: contextMessage,
    priority: 2,
    buttons: [{ title: 'Open Ticket' }]
  }, `ticket-${ticketId}`);
}

function showSummaryNotification(tickets, viewTitle, subdomain) {
  const totalCount = tickets.length;
  const displayCount = Math.min(totalCount, 4);
  const items = [];
  for (let i = 0; i < displayCount; i++) {
    const ticket = tickets[i];
    const ticketId = ticket.id || ticket.ticket_id || '???';
    const ticketNumber = ticket.number ?? ticketId;
    const subject = ticket.subject || 'No subject';
    items.push({ title: `#${ticketNumber}`, message: subject });
  }
  if (totalCount > 4) {
    items.push({ title: '...', message: `And ${totalCount - 4} more new tickets` });
  }

  maybeNotify({
    type: 'list',
    iconUrl: 'icon.png',
    title: `Zenduck: ${totalCount} New Tickets Detected`,
    message: viewTitle ? `View: ${viewTitle}` : 'Summary of recent incoming tickets',
    items: items,
    priority: 2,
    buttons: [{ title: 'Open Zendesk' }]
  }, `summary-${Date.now()}`);
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (buttonIndex !== 0) return;
  const { subdomain } = await chrome.storage.local.get('subdomain');
  if (!subdomain) return;

  const ticketMatch = notificationId.match(/^ticket-(\d+)$/);
  const targetUrl = ticketMatch
    ? `https://${subdomain}.zendesk.com/agent/tickets/${ticketMatch[1]}`
    : `https://${subdomain}.zendesk.com/agent/dashboard`;

  const zendeskTabs = await chrome.tabs.query({ url: `https://${subdomain}.zendesk.com/*` });
  if (zendeskTabs.length > 0) {
    const activeTab = zendeskTabs[0];
    await chrome.tabs.update(activeTab.id, { url: targetUrl, active: true });
    if (activeTab.windowId) {
      await chrome.windows.update(activeTab.windowId, { focused: true });
    }
  } else {
    chrome.tabs.create({ url: targetUrl });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  try {
    const hostname = new URL(tab.url).hostname;
    if (!hostname.endsWith('.zendesk.com') && hostname !== 'zendesk.com') return;
  } catch {
    return;
  }
  const data = await chrome.storage.local.get(['monitoring', 'paused']);
  if (!data.monitoring || data.paused) return;
  const remaining = await chrome.tabs.query({ url: 'https://*.zendesk.com/*' });
  if (!remaining.length) {
    await pauseMonitoring('no Zendesk tab found');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  try {
    const hostname = new URL(tab.url).hostname;
    if (!hostname.endsWith('.zendesk.com') && hostname !== 'zendesk.com') return;
  } catch {
    return;
  }
  if (Date.now() - resumeDebounce < 1000) return;
  const data = await chrome.storage.local.get(['monitoring', 'paused']);
  if (data.monitoring && data.paused) {
    resumeDebounce = Date.now();
    await resumeMonitoring();
  }
});

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  try {
    if (message.type === 'GET_VIEWS') {
      const data = await chrome.storage.local.get(['subdomain']);
      const tab = await findZendeskTab(data.subdomain);
      if (!tab) return sendResponse({ error: 'no_zendesk_tab' });
      const response = await injectFetch(tab.id, `https://${data.subdomain}.zendesk.com/api/v2/views.json`);
      if (!response.ok) return sendResponse({ error: response.error || 'unexpected' });
      return sendResponse({ views: response.data.views || [] });
    }

    if (message.type === 'GET_VIEW_COLUMNS') {
      const data = await chrome.storage.local.get(['subdomain']);
      const tab = await findZendeskTab(data.subdomain);
      if (!tab) return sendResponse({ error: 'no_zendesk_tab' });
      const { tickets, lookupMap, lastError } = await fetchAllPages(tab.id, data.subdomain, message.viewId, 1);
      if (lastError) return sendResponse({ error: lastError || 'unexpected' });
      const metadata = await getOrFetchMetadata(tab.id, data.subdomain);
      const metadataMaps = buildMetadataMaps(metadata);
      const combinedLookup = mergeMetadataIntoLookupMap({ ...lookupMap }, metadataMaps);

      const columnsMap = new Map();
      const defaultCols = [
        { key: 'via.channel', title: 'CHANNEL' },
        { key: 'channel', title: 'CHANNEL' },
        { key: 'status', title: 'STATUS' },
        { key: 'priority', title: 'PRIORITY' },
        { key: 'group_id', title: 'GROUP' },
        { key: 'assignee_id', title: 'ASSIGNEE' },
        { key: 'type', title: 'TYPE' }
      ];
      defaultCols.forEach(c => columnsMap.set(c.key, c.title));

      const valuesMap = {};
      const addValue = (key, val) => {
        if (val === undefined || val === null || val === '') return;
        if (!valuesMap[key]) valuesMap[key] = new Set();
        valuesMap[key].add(String(val));
      };

      tickets.forEach(ticket => {
        const channelVal = ticket.via?.channel || ticket.channel;
        if (channelVal) {
          addValue('via.channel', channelVal);
          addValue('channel', channelVal);
        }

        Object.keys(ticket).forEach(key => {
          if (['custom_fields', 'fields', 'description', 'via', 'satisfaction_rating'].includes(key)) return;
          const resolved = resolveCellValue(ticket, key, combinedLookup);
          addValue(key, resolved || ticket[key]);
          if (!columnsMap.has(key)) {
            columnsMap.set(key, key.replace(/_/g, ' ').toUpperCase());
          }
        });

        const fieldsArray = ticket.fields || ticket.custom_fields;
        if (Array.isArray(fieldsArray)) {
          fieldsArray.forEach(f => {
            if (f.id != null && f.value != null) {
              const fieldKey = String(f.id);
              addValue(fieldKey, f.value);
              addValue(`custom_field_${f.id}`, f.value);
              if (!columnsMap.has(fieldKey)) {
                columnsMap.set(fieldKey, `Custom Field (${f.id})`);
              }
            }
          });
        }
      });

      Object.entries(metadataMaps).forEach(([type, map]) => {
        if (type === 'ticketFields') {
          Object.entries(map).forEach(([fieldId, options]) => {
            if (!valuesMap[fieldId]) valuesMap[fieldId] = new Set();
            options.forEach(opt => valuesMap[fieldId].add(opt.label));
          });
        } else {
          Object.entries(map).forEach(([id, name]) => {
            const columnKey = type === 'customStatuses' ? 'custom_status_id' :
                              type === 'groups' ? 'group_id' :
                              type === 'users' ? 'requester_id' : id;
            if (!valuesMap[columnKey]) valuesMap[columnKey] = new Set();
            valuesMap[columnKey].add(name);
          });
        }
      });

      const mappedColumns = Array.from(columnsMap.entries()).map(([key, title]) => ({ key, title }));
      const valuesMapSerializable = {};
      for (const key of Object.keys(valuesMap)) {
        valuesMapSerializable[key] = [...valuesMap[key]].sort();
      }
      return sendResponse({ columns: mappedColumns, valuesMap: valuesMapSerializable });
    }

    if (message.type === 'FIND_SUBDOMAIN') {
      const stored = await chrome.storage.local.get('subdomain');
      const tab = await findZendeskTab(stored.subdomain);
      if (!tab) return sendResponse({ error: 'no_zendesk_tab' });
      const hostname = new URL(tab.url).hostname;
      const subdomain = hostname.replace(/\.zendesk\.com$/, '');
      await chrome.storage.local.set({ subdomain });
      return sendResponse({ subdomain });
    }

    if (message.type === 'START_MONITORING') {
      const data = await chrome.storage.local.get(['subdomain']);
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.storage.local.set({ paused: false, monitoring: true });

      const tab = await findZendeskTab(data.subdomain);
      if (!tab) {
        await chrome.storage.local.set({ monitoring: false });
        return sendResponse({ success: false, error: 'no_zendesk_tab' });
      }

      const settingsResult = await chrome.storage.local.get('settings');
      const settings = { ...{ pollInterval: 60, maxPages: 3, interPageDelay: 250 }, ...(settingsResult.settings || {}) };
      const maxPages = settings.maxPages;
      const pollInterval = settings.pollInterval;

      const viewSeenTickets = {};
      for (const view of message.views) {
        try {
          const { tickets, lookupMap, lastError } = await fetchAllPages(tab.id, data.subdomain, view.id, maxPages, settings.interPageDelay);
          if (lastError) {
            if (lastError.includes('429')) {
              await chrome.storage.local.set({ monitoring: false });
              await maybeNotify({
                type: 'basic',
                iconUrl: 'icon.png',
                title: 'Zenduck',
                message: 'Zenduck paused — Zendesk rate limit hit during startup. Please wait and try again.'
              }, 'zenduck-rate-limited');
              return sendResponse({ success: false, error: lastError });
            }
            console.error(`Failed to fetch view ${view.id}:`, lastError);
            continue;
          }
          const metadata = await getOrFetchMetadata(tab.id, data.subdomain);
          const metadataMaps = buildMetadataMaps(metadata);
          const combinedLookupMap = mergeMetadataIntoLookupMap({ ...lookupMap }, metadataMaps);
          const filtered = applyRules(tickets, view.rules, combinedLookupMap);
          viewSeenTickets[view.id] = filtered.map(t => t.id);
        } catch (e) {
          console.error(`Failed to snapshot view ${view.id}:`, e);
        }
      }

      await chrome.storage.local.set({
        selectedViews: message.views,
        viewSeenTickets,
        subdomain: data.subdomain
      });
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(1, Math.floor(pollInterval / 60)) });
      await chrome.action.setBadgeText({ text: '0' });
      return sendResponse({ success: true });
    }

    if (message.type === 'STOP_MONITORING') {
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.action.setBadgeText({ text: '' });
      await chrome.storage.local.set({ monitoring: false, paused: false });
      return sendResponse({ success: true });
    }

    if (message.type === 'RESUME_MONITORING') {
      const data = await chrome.storage.local.get(['monitoring', 'subdomain']);
      if (!data.monitoring) {
        return sendResponse({ success: false, error: 'not_monitoring' });
      }
      const tab = await findZendeskTab(data.subdomain);
      if (!tab) {
        return sendResponse({ success: false, error: 'no_zendesk_tab' });
      }
      await resumeMonitoring();
      return sendResponse({ success: true });
    }

    if (message.type === 'CLEAR_METADATA_CACHE') {
      cachedMetadata = null;
      return sendResponse({ success: true });
    }
  } catch (e) {
    console.error('Background message handler error:', e);
    return sendResponse({ error: 'unexpected' });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    const data = await chrome.storage.local.get(['monitoring', 'paused', 'selectedViews', 'viewSeenTickets', 'ticketHistory', 'subdomain']);
    if (!data.monitoring || data.paused || !data.subdomain) return;
    if (!(data.selectedViews || []).length) {
      await chrome.storage.local.set({ monitoring: false });
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.action.setBadgeText({ text: '' });
      await maybeNotify({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Zenduck',
        message: 'Monitoring stopped — no views selected'
      }, 'zenduck-empty-views');
      return;
    }

    const settingsResult = await chrome.storage.local.get('settings');
    const settings = { ...{ maxPages: 3, interPageDelay: 250, historyCapacity: 100, idlePause: 'enabled', notificationBehavior: 'per-ticket' }, ...(settingsResult.settings || {}) };

    const stateCheck = await chrome.storage.local.get('monitoring');
    if (!stateCheck.monitoring) return;

    const tab = await findZendeskTab(data.subdomain);
    if (!tab) {
      if (settings.idlePause !== 'disabled') {
        await pauseMonitoring('no Zendesk tab available');
      }
      return;
    }

    let allNewTickets = [];
    let allMatchedTickets = [];
    let combinedLookupMap = {};

    for (const view of data.selectedViews) {
      const freshTab = await findZendeskTab(data.subdomain);
      if (!freshTab) {
        if (settings.idlePause !== 'disabled') {
          await pauseMonitoring('Zendesk tab lost during poll');
        }
        return;
      }
      try {
        const hostname = new URL(freshTab.url).hostname;
        if (!hostname.endsWith('.zendesk.com') && hostname !== 'zendesk.com') {
          if (settings.idlePause !== 'disabled') {
            await pauseMonitoring('Zendesk tab navigated away during poll');
          }
          return;
        }
      } catch {
        if (settings.idlePause !== 'disabled') {
          await pauseMonitoring('Zendesk tab URL invalid during poll');
        }
        return;
      }

      if (!data.viewSeenTickets[view.id]) {
        try {
          const { tickets, lookupMap, lastError } = await fetchAllPages(freshTab.id, data.subdomain, view.id, settings.maxPages, settings.interPageDelay);
          if (lastError) {
            if (lastError.includes('429')) {
              await pauseMonitoring('Rate limited by Zendesk during snapshot');
              await maybeNotify({
                type: 'basic',
                iconUrl: 'icon.png',
                title: 'Zenduck',
                message: 'Zenduck paused — Zendesk rate limit hit. Please wait a moment and resume.'
              }, 'zenduck-rate-limited');
              return;
            }
            console.error(`Failed to snapshot view ${view.id}:`, lastError);
            continue;
          }
          const metadata = await getOrFetchMetadata(freshTab.id, data.subdomain);
          const metadataMaps = buildMetadataMaps(metadata);
          combinedLookupMap = mergeMetadataIntoLookupMap({ ...lookupMap }, metadataMaps);
          const snapshotTickets = applyRules(tickets, view.rules, combinedLookupMap);
          buildAndSaveDynamicMetadata(snapshotTickets, combinedLookupMap);
          const updatedSeen = { ...data.viewSeenTickets };
          updatedSeen[view.id] = snapshotTickets.map(t => t.id);
          await chrome.storage.local.set({ viewSeenTickets: updatedSeen });
        } catch (e) {
          console.error(`Failed to snapshot view ${view.id}:`, e);
        }
        continue;
      }

      let result;
      try {
        result = await fetchAllPages(freshTab.id, data.subdomain, view.id, settings.maxPages, settings.interPageDelay);
      } catch (e) {
        console.error(`Failed to inject fetch for view ${view.id}:`, e);
        continue;
      }

      if (result && result.lastError) {
        if (result.lastError.includes('401') || result.lastError.includes('403')) {
          await pauseMonitoring('Zendesk session expired');
          await maybeNotify({
            type: 'basic',
            iconUrl: 'icon.png',
            title: 'Zenduck',
            message: 'Zenduck paused — please refresh your Zendesk session.'
          }, 'zendesk-auth-error');
          return;
        }
        if (result.lastError.includes('429')) {
          await pauseMonitoring('Rate limited by Zendesk');
          await maybeNotify({
            type: 'basic',
            iconUrl: 'icon.png',
            title: 'Zenduck',
            message: 'Zenduck paused — Zendesk rate limit hit. Please wait a moment and resume.'
          }, 'zenduck-rate-limited');
          return;
        }
        continue;
      }

      const metadata = await getOrFetchMetadata(freshTab.id, data.subdomain);
      const metadataMaps = buildMetadataMaps(metadata);
      combinedLookupMap = mergeMetadataIntoLookupMap({ ...result.lookupMap }, metadataMaps);
      const tickets = applyRules(result.tickets, view.rules, combinedLookupMap);
      if (tickets.length > 0) {
        console.log('[Zenduck] Ticket sample:', JSON.stringify(tickets[0]).slice(0, 500));
      }
      const seenIds = data.viewSeenTickets[view.id] || [];
      const newTickets = tickets.filter(t => !seenIds.includes(t.id));
      allNewTickets.push(...newTickets.map(t => ({ ...t, viewId: view.id, viewTitle: view.title })));
      allMatchedTickets.push(...tickets.map(t => ({ ...t, viewId: view.id, viewTitle: view.title })));
    }

    if (allMatchedTickets.length > 0) {
      buildAndSaveDynamicMetadata(allMatchedTickets, combinedLookupMap);
    }

    if (allNewTickets.length > 0) {
      const seen = new Set();
      const unique = allNewTickets.filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });

      const updatedSeen = { ...data.viewSeenTickets };
      for (const view of data.selectedViews) {
        updatedSeen[view.id] = [...new Set([
          ...(updatedSeen[view.id] || []),
          ...unique.filter(t => t.viewId === view.id).map(t => t.id)
        ])];
      }
      await chrome.storage.local.set({ viewSeenTickets: updatedSeen });

      const history = data.ticketHistory || [];
      const capacity = settings.historyCapacity;
      const newEntries = unique.map(t => ({
        ticketNumber: t.number ?? t.id ?? t.ticket_id ?? '???',
        ticketId: t.id,
        viewId: t.viewId,
        viewTitle: t.viewTitle,
        receivedAt: new Date().toISOString()
      }));
      const merged = [...newEntries, ...history];
      const trimmed = merged.slice(0, capacity);
      await chrome.storage.local.set({ ticketHistory: trimmed });

      if (settings.notificationBehavior === 'summary') {
        showSummaryNotification(unique, unique[0]?.viewTitle || '', data.subdomain);
      } else {
        for (const ticket of unique) {
          showPerTicketNotification(ticket, ticket.viewTitle || '', data.subdomain, combinedLookupMap);
        }
      }

      const current = await chrome.action.getBadgeText({});
      const count = Math.min((parseInt(current) || 0) + unique.length, 9999);
      await chrome.action.setBadgeText({ text: count.toString() });
    }
  } catch (e) {
    console.error('Alarm listener error:', e);
  }
});
