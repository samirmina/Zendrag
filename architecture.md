# Zenduck - Architecture Documentation

## 1. System Overview

Zenduck is a Chrome Manifest V3 extension that monitors Zendesk views for new tickets and notifies the user in real-time. The extension is designed for Zendesk Admins and Agents who need to track a small number of high-priority views (typically 1-4) without manually refreshing Zendesk.

**Key Characteristics:**
- Authentication via existing browser session (cookies), no OAuth or API tokens
- Monitoring is scoped strictly to user-selected views
- Per-view `seenTickets` tracking to determine ticket newness
- Rules engine with per-view inline rule editor
- Ticket history in popup with user-controlled retention
- Chrome Alarms API for periodic polling (1-minute intervals)

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Chrome Browser                       │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐ │
│  │ Zendesk Tab │    │  Popup (UI)  │    │  Service Worker │ │
│  │             │    │              │    │  (background)   │ │
│  │ Session     │    │ - Views List │    │                 │ │
│  │ Cookies     │    │ - History    │    │ - Alarm Manager │ │
│  └─────────────┘    │ - Settings   │    │ - Message Handler │ │
│         ▲           └──────▲───────┘    │ - Fetch Wrapper │ │
│         │                  │            └────────┬────────┘ │
│         │    messaging     │                     │          │
│         │                  │              fetch │          │
│         │                  │              ┌─────▼──────┐   │
│         │                  │              │  Zendesk  │   │
│         │                  │              │   API     │   │
│         │                  │              └───────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | Type | Responsibility |
|-----------|------|----------------|
| `popup.html/js/css` | Extension Popup | User interface for view selection, monitoring control, ticket history, and settings |
| `background.js` | Service Worker | Alarm scheduling, API calls, seen tickets tracking, notifications, badge updates |
| `manifest.json` | Config | Extension metadata, permissions, background service worker declaration |
| `ZENDUCK_CORE_RULES.md` | Documentation | Architecture decisions, business rules, product requirements |

---

## 3. Data Model

### 3.1 Storage Schema (`chrome.storage.local`)

```typescript
interface StorageData {
  // Monitoring State
  monitoring: boolean;
  selectedViews: Array<{ id: string; title: string; rules: Array<{ column: string; values: string[] }> }>;
  subdomain: string;
  viewSeenTickets: Record<string, string[]>; // viewId -> ticketIds
  ticketHistory: Array<{
    ticketId: string;
    ticketNumber: string;
    viewId: string;
    viewTitle: string;
    receivedAt: string; // ISO 8601
  }>;
  settings: {
    pollInterval: number; // seconds, default 60
    idlePause: 'enabled' | 'disabled'; // default enabled
    maxPages: 1 | 3 | 5; // default 3
    interPageDelay: 100 | 250 | 500; // ms, default 250
    soundAlert: 'enabled' | 'disabled'; // default disabled
    notificationBehavior: 'per-ticket' | 'summary'; // default per-ticket
    notificationPersistence: 'auto-close' | 'sticky'; // default auto-close
    historyCapacity: 50 | 100 | 200; // default 100
  };
}
```

### 3.2 Message Passing Contract

| Message Type | Direction | Payload | Response |
|--------------|-----------|---------|----------|
| `GET_VIEWS` | Popup → Background | `{ subdomain }` | `{ views: View[] }` |
| `GET_VIEW_COLUMNS` | Popup → Background | `{ subdomain, viewId }` | `{ columns: Array<{ key: string, title: string }>, valuesMap: Record<string, string[]> }` |
| `START_MONITORING` | Popup → Background | `{ subdomain, views }` | `{ success: boolean }` |
| `STOP_MONITORING` | Popup → Background | `{}` | `{ success: boolean }` |
| `RESUME_MONITORING` | Popup → Background | `{}` | `{ success: boolean }` |
| `FIND_SUBDOMAIN` | Popup → Background | `{}` | `{ subdomain: string }` |
| `CLEAR_METADATA_CACHE` | Popup → Background | `{}` | `{ success: boolean }` |

---

## 4. Data Flow

### 4.1 Monitoring Lifecycle

```
1. User opens popup
   └─> Popup queries active tab for Zendesk URL
   └─> Extracts subdomain or loads from storage
   └─> Requests views list via GET_VIEWS message
   └─> Renders checkboxes with stored selection

2. User clicks "Start Monitoring"
   └─> Popup validates selection (at least 1 view)
   └─> Sends START_MONITORING with selected views
   └─> Background fetches all tickets from each view
   └─> Initializes seenTickets with current ticket IDs
   └─> Creates 1-minute alarm
   └─> Updates badge text

3. Alarm fires (every 1 minute)
   └─> Background reads monitoring state from storage
   └─> For each selected view:
       └─> Fetches view via /views/{id}/execute.json
       └─> Extracts tickets from response
       └─> Compares against seenTickets (per-view target)
   └─> Deduplicates new tickets across views
   └─> Appends to ticketHistory
   └─> Updates seenTickets
   └─> Fires Chrome notification
   └─> Updates badge count

4. User clicks "Stop Monitoring"
   └─> Popup sends STOP_MONITORING
   └─> Background clears alarm
   └─> Clears monitoring flag (preserves seenTickets)
```

### 4.2 API Integration

**Endpoint:** `https://{subdomain}.zendesk.com/api/v2/views/{viewId}/execute.json?per_page=30&page=1`

**Authentication:** Relies on browser cookies from active Zendesk tab session. No Authorization header is sent.

**Response Shape:**
```json
{
  "view": {
    "columns": ["id", "subject", "requester_id", "assignee_id", "updated_at_with_time"]
  },
  "columns": {
    "id": { "title": "ID", "type": "text", "sortable": true },
    "subject": { "title": "Subject", "type": "text", "sortable": true },
    "requester_id": { "title": "Requester", "type": "user", "sortable": false },
    "assignee_id": { "title": "Assignee", "type": "user", "sortable": false },
    "updated_at_with_time": { "title": "Updated", "type": "date", "sortable": true }
  },
  "rows": [
    {
      "id": "12345",
      "subject": "Server down",
      "requester_id": 111,
      "assignee_id": 222,
      "updated_at_with_time": "2024-03-22T08:31:37Z"
    }
  ],
  "users": [
    { "id": 111, "name": "Alice" },
    { "id": 222, "name": "Bob" }
  ],
  "groups": [...],
  "organizations": [...],
  "custom_statuses": [...]
}
```

**Column Mapping:** The extension reads `response.view.columns` to determine the ordered column IDs for the current view, then looks up each ID in `response.columns` to get the display title, type, and sortability. This preserves the exact column order defined by the view instead of iterating `response.columns` as an array.

**Column Normalization:** In `fetchAllPages`, each column object from `response.columns[id]` is normalized before being added to `allColumns`. The stored shape is always:

```javascript
{
  id: col.id || id,
  title: col.title || id,
  type: col.type || 'text',
  sortable: col.sortable || false
}
```

**Per-View Column Isolation:** `fetchAllPages` stores normalized columns in `globalThis.viewColumnsMap[viewId]`. The `GET_VIEW_COLUMNS` handler reads from this map using `message.viewId`, ensuring the popup always receives the correct column set for the requested view. This prevents cross-view column mixing when multiple views are fetched in one alarm cycle.

**Row Value Resolution:** Row fields are keyed by column IDs. Foreign-key fields (`requester_id`, `assignee_id`, `group_id`, `organization_id`) contain numeric IDs. The extension resolves them through lookup maps built from side-loaded `users`, `groups`, `organizations`, and `custom_statuses`, merged with system metadata. Date fields are returned as ISO-8601 strings and can be formatted to local time in the UI.

**Pagination:** The response may include `links.next` for the next page URL. The extension fetches all pages and accumulates tickets before applying rules. A short delay is inserted between page requests to reduce request burst intensity. If an HTTP `429` response is received, the fetch loop stops and returns partial data with a rate-limit error instead of retrying immediately.

**Rate Limiting:** To avoid exhausting Zendesk quota:
- UI value discovery uses `maxPages = 1`.
- Background monitoring uses `maxPages = 3`.
- `fetchAllPages` inserts a delay between successful page fetches.
- On HTTP `429`, `fetchAllPages` breaks early and returns `lastError = 'HTTP 429: Rate limited...'`. Monitoring code surfaces this as a pause/notification rather than continuing failing requests.

**Lookup Dictionaries:** The response may include top-level arrays (`users`, `groups`, `organizations`, `custom_statuses`) used by the generic resolver to convert foreign-key IDs to display names. These dictionaries are merged across all pages into a single lookup map, which is then further augmented with system metadata before rule evaluation during monitoring.

**Metadata Endpoints (UI/Rule Editor & Monitoring):** For popup rule value discovery and for background monitoring lookup resolution, the extension fetches system metadata from:
- `/api/v2/ticket_fields.json` — custom field definitions and dropdown options
- `/api/v2/custom_statuses.json` — all custom statuses
- `/api/v2/groups.json` — all groups
- `/api/v2/users.json` — all users/agents
- `/api/v2/organizations.json` — all organizations

This metadata is cached in the Service Worker context and re-fetched as needed when the worker wakes, since Manifest V3 service workers are ephemeral. It is merged with first-page ticket values to populate rule dropdowns without paginating through all tickets. The same metadata is merged into the lookup map used by `applyRules` during background monitoring so that numeric foreign keys (e.g., `group_id`, `custom_status_id`, `organization_id`) are resolved to display names.

**Nested Path Resolution:** Column keys may use dot-notation to access nested ticket properties, such as `via.channel` or `organization.name`. The resolver traverses the ticket object dynamically by splitting on `.` and walking each segment; if any segment is missing, the value is treated as absent and the resolver falls back to direct property access or returns an empty string. This supports arbitrary nesting depth and avoids hardcoded one-level splits.

**Dynamic Metadata Persistence:** After applying rules during background monitoring, the extension persists `combinedLookupMap`, `dynamicFieldValues`, and `lastMetadataUpdate` to `chrome.storage.local`. This makes rule dropdown values available to the popup even after the Service Worker context is lost, preventing grayed-out selectors. `dynamicFieldValues` is built from observed ticket fields (`via.channel`, `group_id`, `assignee_id`) and stored as `{ value, label }` arrays keyed by column key.

**Smart Notification Routing:** The `Open Ticket` button on per-ticket notifications parses the notification ID as `ticket-{ticketId}` and routes to `https://{subdomain}.zendesk.com/agent/tickets/{ticketId}`. If a Zendesk tab is already open, it navigates that tab in place and focuses its window instead of opening a new tab. Summary notifications fall back to `https://{subdomain}.zendesk.com/agent/dashboard`.

---

## 5. State Management

### 5.1 Current Implementation

- **Per-view `viewSeenTickets`**: `Record<viewId, ticketId[]>` — each view tracks its own seen tickets
- **In-memory state in popup.js**: `subdomain`, `allViews`
- **Ticket History**: New tickets are appended to `ticketHistory` in storage and rendered in the popup
- **Rules Engine**: Client-side `applyRules()` filters tickets after fetch; AND between rules, OR within values

### 5.2 Remaining Gaps

- **History retention settings**: No UI or storage field yet; history is append-only with manual clear only
- **Settings object**: Poll interval, history retention policy, and notification preferences not yet implemented
- **Popup state restoration**: Partially implemented; needs full settings restore when settings UI is added

---

## 6. Security & Privacy

- **No credentials stored**: The extension never handles API tokens or passwords
- **Cookie-based auth**: Leverages the user's existing authenticated Zendesk session
- **Host permissions scoped**: Only `https://*.zendesk.com/*`
- **Storage is local**: `chrome.storage.local` is not synced to cloud
- **No external network calls**: All API calls are to Zendesk domains only

---

## 7. Extension Points & Future Work

### 7.1 Rules Engine
- Rules are applied client-side after fetching tickets from the view execute endpoint
- Rule format: `{ column: string, values: string[] }`
- Column is selected from a dropdown populated by executing the view and extracting all unique ticket field names from the `columns` array
- Column display title comes from the `columns` array in the `execute.json` response; the stored rule value uses the internal column key
- Values are exact string matches selected from a multi-select dropdown of values present in the current view data for the selected column
- Values are sourced from Zendesk system metadata (`ticket_fields`, `custom_statuses`, `groups`, `users`) cached in memory for the session, merged with first-page ticket values as fallback
- `getAvailableValuesForColumn(columnKey)` in `popup.js` reads from `chrome.storage.local.dynamicFieldValues` first, then falls back to `combinedLookupMap` for ID-based columns (`group_id`, `assignee_id`, `organization_id`). For these ID-based columns, the dropdown returns `{ value: name, label: '${name} (ID: ${id})' }` so users select by translated name while the rule filter matches by both resolved name and raw ID.
- Rule matching in `applyRules` is case-insensitive and supports matching by resolved display name, raw ticket value, or partial inclusion. This prevents failures from case differences, trimming, or ID/name mismatches.
- The `GET_VIEW_COLUMNS` handler builds columns and values directly from fetched ticket data. It adds default columns (`via.channel`, `channel`, `status`, `priority`, `group_id`, `assignee_id`, `type`) and extracts actual values from each ticket, including nested `via.channel` and custom fields from `ticket.fields` or `ticket.custom_fields`. This ensures dropdowns contain real values present in the view rather than only metadata-derived entries.
- Logic: AND between rules, OR within values
- Example: Only notify on tickets where `Channel` is `"Email"` or `"Chat"` AND `Priority` is `"High"` or `"Urgent"`
- Implementation: `applyRules()` in `background.js` filters tickets after `extractTickets()`, using `resolveCellValue()` with a generic lookup map
- Popup: Inline per-view rule editor with dynamic column and value dropdowns in the views list
- Object-type fields such as assignee or group are resolved to display names via the generic lookup resolver using response dictionaries (`users`, `groups`, `organizations`, `custom_statuses`) merged with system metadata endpoints
- The execute endpoint is called with `per_page=30&page=1` query parameters
- The `lookupMap` used during monitoring is merged with system metadata via `mergeMetadataIntoLookupMap()` to ensure numeric foreign keys are resolved even when view responses lack embedded dictionaries
- UI values are populated from metadata with `maxPages = 1`; monitoring uses `fetchAllPages(..., 3)` with bounded pagination and a 250ms inter-page delay to prevent HTTP 429 quota exhaustion.

### 7.2 Ticket History
- UI section in popup below views list showing ticket number, view name, and time
- Manual clear button is implemented
- Auto-clear timer and retention settings are not yet implemented

### 7.3 Notifications

- `per-ticket` mode uses `type: 'basic'` with title `#<number> - <subject>`, message showing channel, group, assignee, and view, and an `Open Ticket` button.
- `summary` mode uses `type: 'list'` with up to 4 ticket items and an `Open Zendesk` button.
- `chrome.notifications.onButtonClicked` reads `subdomain` from storage and opens the ticket or dashboard URL.
- Group and Assignee names are resolved through the metadata lookup map built from the execute response side-loaded `users`, `groups`, and `organizations`, merged with system metadata.
- Channel is resolved from `via.channel` through the dynamic resolver; if absent, the field is omitted from the notification rather than displaying a hardcoded placeholder.
- `maybeNotify()` reads `settings.notificationPersistence` to set `requireInteraction` on the notification. `auto-close` uses the default behavior; `sticky` keeps the notification visible until the user dismisses it.
- `maybeNotify()` reads `settings.soundAlert`. When `enabled`, it ensures an offscreen document exists via `chrome.offscreen.createDocument()` and sends a `playSound` message to `offscreen.js`, which plays `alert.mp3` in an `<audio>` element. Playback errors are caught and logged as warnings to avoid uncaught promise rejections from Chrome's Autoplay Policy.
---

## 8. Current Gaps vs Target Architecture

| Feature | Current Status | Target State |
|---------|---------------|--------------|
| Per-view seen tickets | ✅ Implemented | `viewSeenTickets` map |
| Ticket History | ✅ Implemented | Append-only log in popup |
| History retention | ✅ Implemented | `settings.historyCapacity` bounds history; manual clear also available |
| Rules Engine | ✅ Implemented | Client-side AND/OR filtering with generic lookup resolver, metadata-backed values, metadata-merged monitoring lookup, bounded pagination |
| Popup state restore | ✅ Implemented | Restores views, history, and settings |
| Badge counter | ✅ Implemented | Global count |
| Error handling | ⚠️ Basic try/catch | Retry logic, user feedback |
| Subdomain parsing | ⚠️ Fragile (`split('.')[0][1]`) | URL parsing with edge cases |
| Generic lookup resolver | ✅ Implemented | Resolve foreign keys to display names without hardcoded field names; merged with system metadata for monitoring |
| Metadata-backed rule values | ✅ Implemented | System metadata fetched once per Service Worker session and re-hydrated on wakeup; merged into monitoring lookup map |
| Pagination | ✅ Implemented | `maxPages=1` for UI, `maxPages=3` for monitoring via `links.next` / `Link` header |
| Execute endpoint parameters | ✅ Implemented | Called with `per_page=30&page=1` |
| Rate limiting & backoff | ✅ Implemented | Delay between pages; HTTP `429` stops fetch loop and returns `lastError` |
| Settings UI | ✅ Implemented | Poll interval, max pages, inter-page delay, sound, notifications, history capacity, idle pause, metadata cache clear |

---

## 9. File Inventory

| File | Purpose | Status |
|------|---------|--------|
| `manifest.json` | Extension config | ✅ Complete |
| `background.js` | Service worker, alarms, API | ✅ Complete (generic resolver, metadata caching, pagination, metadata-merged monitoring lookup, rate-limit handling) |
| `popup.html` | Popup structure | ✅ Complete (includes Settings panel) |
| `popup.js` | Popup logic | ⚠️ Partial — subdomain parsing covers common `*.zendesk.com` URLs; edge-case hardening remains a tracked gap; Settings wiring implemented |
| `popup.css` | Popup styling | ✅ Complete |
| `ZENDUCK_CORE_RULES.md` | Product & architecture decisions | ✅ Complete |
| `architecture.md` | This file — technical architecture | ✅ Complete |

---

## 10. Design Principles

1. **Session Leverage**: Use existing browser state; never ask for credentials
2. **Minimal API Surface**: Only fetch what the user explicitly selects
3. **View-Scoped State**: Tickets are new or old relative to a specific view, not globally
4. **User Control**: History, polling, and rules are user-configurable
5. **Fail-Safe Defaults**: If rules or history fail, core monitoring continues
6. **Zero Hardcoded Field Names**: All field resolution is dynamic via schema parsing and generic lookup maps
7. **Full Pagination Coverage**: All pages are fetched before rule application to ensure complete coverage
8. **Metadata Caching**: System metadata is fetched once per Service Worker session and cached in the worker context. Because Manifest V3 service workers are ephemeral, the cache may be rehydrated on worker wakeup to keep the UI instant and avoid rate limits.



