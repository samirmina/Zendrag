# Zenduck - Future Architecture

> **Purpose**: This document describes the target architecture for Zenduck, derived entirely from the core rules and product decisions defined in `ZENDUCK_CORE_RULES.md`. It describes how the system *should* be built, independent of the current implementation.

---

## 1. System Overview

Zenduck is a Chrome Manifest V3 extension that provides intelligent monitoring of Zendesk views. It is designed for Zendesk Admins and Agents who need to track a small number of high-priority views (typically 1-4) and receive notifications only for tickets that match user-defined rules.

**Guiding Principles (from Core Rules):**
- Work within the user's existing Zendesk session — no credential management
- Monitor only what the user explicitly selects — no automatic full-scan
- Treat ticket newness as view-scoped, not global
- Give the user full control over history retention

---

## 2. Authentication Strategy

All API calls are executed from within an active Zendesk tab using `chrome.scripting.executeScript`. The extension injects a content script or uses programmatic script execution into the Zendesk tab to leverage the user's existing authenticated session (cookies).

- **No OAuth flows** are implemented in the initial version.
- **No API tokens** are stored or transmitted by the extension.
- **No `Authorization` headers** are sent; requests rely on the browser's cookie-based session.

---

## 3. Monitoring Scope

- Monitoring is strictly limited to views explicitly selected by the user in the popup.
- The extension never automatically scans all available views.
- The recommended maximum is 4 selected views per user.
- The alarm/polling loop only iterates over the user's selected views.

---

## 4. Data Model

### 4.1 Storage Schema

```typescript
interface ZenduckStorage {
  subdomain: string;
  monitoring: boolean;
  selectedViews: Array<{
    id: string;
    title: string;
    rules: Array<{ column: string; values: string[] }>;
  }>;
  viewSeenTickets: Record<string, string[]>; // key: viewId, value: ticketId[]
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

### 4.2 Key Invariants

- `viewSeenTickets` is **per-view**. A ticket ID may appear in multiple view lists but is only "new" relative to the view it was fetched from.
- `selectedViews` is the single source of truth for which views are polled.
- `ticketHistory` is append-only with capacity trimming based on `settings.historyCapacity`.
- `settings` is the source of truth for user preferences and is persisted in `chrome.storage.local`.

---

## 5. Popup Architecture

The popup is a **single-tab interface** with the following sections:

### 5.1 Sections

1. **Header** — Extension name, connection status, and Settings toggle
2. **Monitoring Controls** — Start / Stop button with visual state feedback
3. **Views List** — Checkbox list of all available views; selected views are persisted and restored on popup open
4. **Ticket History** — Scrollable list of recently detected tickets, bounded by `settings.historyCapacity`
5. **Settings** — Collapsible panel for polling interval, max pages, inter-page delay, notifications, sound, history capacity, idle pause, and metadata cache management

### 5.2 Popup State Restoration

On `DOMContentLoaded`:
- Read `monitoring`, `selectedViews`, and `ticketHistory` from storage.
- Restore checkbox states for previously selected views.
- If monitoring is active, show "Stop Monitoring" button state.
- Render `ticketHistory` entries (subject to retention policy).

---

## 6. Rules Engine

### 6.1 Purpose

Rules exist to filter tickets by user-defined criteria. They are applied **client-side after fetching** tickets from the view execute endpoint.

### 6.2 Rule Model

- Each selected view can have zero or more rules.
- Rule structure: `{ column: string, values: string[] }`
- Column is selected from a dropdown populated by executing the view and extracting all unique ticket field names from the `columns` array.
- Column name is case-sensitive and must match the Zendesk ticket field exactly as shown in the view.
- Values are exact string matches selected from a multi-select dropdown of values present in the current view data.
- Values are sourced from Zendesk system metadata endpoints (`ticket_fields`, `custom_statuses`, `groups`, `users`), cached in memory for the extension session, and merged with first-page ticket values as fallback.
- `getAvailableValuesForColumn(columnKey)` in `popup.js` reads from `chrome.storage.local.dynamicFieldValues` first, then falls back to `combinedLookupMap` for ID-based columns (`group_id`, `assignee_id`, `organization_id`). For these ID-based columns, the dropdown returns `{ value: name, label: '${name} (ID: ${id})' }` so users select by translated name while the rule filter matches by both resolved name and raw ID.
- Values are resolved dynamically using a generic lookup resolver: foreign-key IDs are converted to display names using dictionaries embedded in the API response (`users`, `groups`, `organizations`, `custom_statuses`) merged with system metadata from dedicated endpoints. No field names or IDs are hardcoded.
- The combined lookup map ensures that numeric foreign keys (e.g., `group_id`, `custom_status_id`, `requester_id`) are resolved to display names during background monitoring, even when the view execute response does not include embedded dictionaries.
- Rule matching in `applyRules` is case-insensitive and supports matching by resolved display name, raw ticket value, or partial inclusion. This prevents failures from case differences, trimming, or ID/name mismatches.
- The `GET_VIEW_COLUMNS` handler builds columns and values directly from fetched ticket data. It adds default columns (`via.channel`, `channel`, `status`, `priority`, `group_id`, `assignee_id`, `type`) and extracts actual values from each ticket, including nested `via.channel` and custom fields from `ticket.fields` or `ticket.custom_fields`. This ensures dropdowns contain real values present in the view rather than only metadata-derived entries.
- Rule value dropdowns are populated from metadata, not from paginating through all tickets.
- Page fetches are throttled with a short delay between requests to avoid Zendesk rate limits.
- HTTP `429` responses are surfaced as `lastError` from `fetchAllPages`; monitoring treats them as soft failures and pauses rather than retrying immediately.

### 6.3 Rule Logic

- **Between rules:** AND logic. A ticket must satisfy ALL rules to be a candidate.
- **Within a rule:** OR logic. If a rule has multiple values, satisfying ANY one value is enough.

### 6.4 Example

View: "Support Tickets"
Rules:
  - Column: `Channel` → Values: `["Email", "Chat"]`
  - Column: `Priority` → Values: `["High", "Urgent"]`

A ticket is a candidate only if:
- `ticket.Channel` is `"Email"` OR `"Chat"`  
AND  
- `ticket.Priority` is `"High"` OR `"Urgent"`

### 6.5 Popup Rule Editor

Rules are edited inline within the Views list:
- Each view row has an "Edit Rules" button.
- Clicking it expands an inline rule editor below that view.
- The extension fetches the view data to discover available columns, then populates a dropdown.
- The editor shows existing rules, each with:
  - Column dropdown (select) populated from view data
  - Values multi-select dropdown populated from values present in the current view data for the selected column
  - Delete button
- "Add Rule" button adds a new empty rule row.
- "Save" saves rules to `selectedViews` in storage.
- "Cancel" discards changes and collapses the editor.
- If column discovery fails, shows an error message instead of rendering the rule editor.
- Selecting a column automatically updates the values dropdown to show only values present in the current view data.
- Object-type fields such as assignee or group are resolved to display names in the values dropdown.

### 6.6 Storage

```typescript
interface ViewConfig {
  id: string;
  title: string;
  rules: Array<{ column: string; values: string[] }>;
}
```

### 6.7 Edge Cases

- Empty `values` array: treat as "match nothing" (ticket fails this rule).
- Empty `rules` array: all tickets are candidates.
- Column does not exist on ticket: treat as empty string.
- Object-valued columns are resolved to display strings during value discovery.
- Foreign-key columns are resolved via generic lookup map merged with system metadata; if ID not found in either map, raw ID is used as fallback.
- Custom fields are resolved via `ticket.fields` fallback when column key is not a top-level ticket property.
- Pagination: all pages are fetched automatically before rule application; `links.next` or `Link` header is followed until exhausted.
- Metadata cache is in-memory only; rule values are populated from system metadata endpoints, not from paginating through all tickets.
- During background monitoring, the lookup map is augmented with system metadata via `mergeMetadataIntoLookupMap()` before `applyRules()` is called, ensuring foreign-key resolution even when view responses lack embedded dictionaries.

---

## 7. Seen Tickets Logic

### 7.1 Per-View Tracking

Each view maintains an independent list of seen ticket IDs. This ensures that:

- A ticket appearing in multiple views is not suppressed globally.
- A ticket is only considered "new" within the context of the view it was fetched from.

### 7.2 Initialization

When monitoring starts:
- For each selected view, the extension executes the view and collects all current ticket IDs.
- These IDs are stored in `viewSeenTickets[viewId]`.
- The alarm does not fire notifications for these initial tickets.

### 7.3 Subsequent Polls

On each alarm tick:
- Execute each selected view.
- Compare returned tickets against `viewSeenTickets[viewId]`.
- Tickets not present in the view's seen list are considered new.

### 7.4 Notification Attribution

Every notification must indicate the source view so the user understands which view triggered it.

---

## 8. Ticket History

### 8.1 Behavior

- Every newly detected ticket is appended to `ticketHistory` in storage.
- The popup renders this history in its dedicated section.
- History is **not** automatically cleared on a fixed timer by default.

### 8.2 Retention Policies

History retention is not yet configurable. Current behavior:
- `manual` — User clears history explicitly via a button (implemented).
- `10min` / `1hour` — Not yet implemented.

### 8.3 Storage

`ticketHistory` is stored in `chrome.storage.local`. Given the expected low volume (1-4 views, modest ticket throughput), size constraints are not a concern for the initial version.

---

## 9. Notification Strategy

### 9.1 Notification Behavior

- `notificationBehavior` is persisted in `settings.notificationBehavior`.
- Supported modes:
  - `per-ticket`: one notification per new ticket.
  - `summary`: one list notification per poll for all new tickets.
- `notificationPersistence` is persisted in `settings.notificationPersistence`.
  - `auto-close`: notification closes automatically after a few seconds.
  - `sticky`: notification stays until the user dismisses it.
- `soundAlert` is persisted in `settings.soundAlert`.
  - `enabled`: plays `alert.mp3` through an offscreen document when a notification is shown.
  - `disabled`: no sound is played.

### 9.2 Per-Ticket Notification

- Title: `#<ticket number> - <subject>`
- Message: `Channel: <CHANNEL> • Group: <GROUP>\nAssignee: <ASSIGNEE>\nView: <view title>`
- Context message: `Zenduck Monitor`
- Includes an `Open Ticket` action button.
- `chrome.notifications.onButtonClicked` opens the ticket URL in a new tab when the button is clicked.
- Group and Assignee names are resolved from `group_id` and `assignee_id` through the metadata lookup map built from side-loaded `users`, `groups`, and `organizations` in the execute response, merged with system metadata endpoints.
- Channel is resolved from `via.channel` through the dynamic resolver; if absent, the field is omitted from the notification rather than displaying a hardcoded placeholder.
- Persistence and sound are controlled by `maybeNotify()`: it reads `settings.notificationPersistence` to set `requireInteraction`, and if `settings.soundAlert === 'enabled'`, it sends a `playSound` message to an offscreen document that plays `alert.mp3`.

### 9.3 Summary Notification

- Type: `list`
- Title: `Zenduck: <count> New Tickets Detected`
- Message: `View: <view title>` or `Summary of recent incoming tickets`
- Items: up to 4 tickets shown as `#<number>: <subject>`, plus `...` with remaining count when there are more than 4.
- Includes an `Open Zendesk` action button.
- `chrome.notifications.onButtonClicked` opens the Zendesk dashboard in a new tab when the button is clicked.
- Persistence and sound behavior are the same as per-ticket notifications.

### 9.4 Badge Counter

- The extension icon badge displays the total count of unseen tickets across all monitored views.
- Badge text is updated after each poll cycle.

### 9.5 Offscreen Audio Playback

- Because Manifest V3 service workers cannot reliably play audio, the extension uses `chrome.offscreen.createDocument()` to host `offscreen.html` and `offscreen.js`.
- `offscreen.html` contains an `<audio id="alert" preload="auto" src="alert.mp3">` element.
- `offscreen.js` listens for `chrome.runtime.onMessage` with `type: 'playSound'`, resets `audio.currentTime`, and calls `audio.play()`.
- `background.js` ensures the offscreen document exists before sending the play message, and catches playback errors to avoid uncaught promise rejections from Chrome's Autoplay Policy.

---

## 10. API Integration

### 10.1 Execution Context

All Zendesk API calls are executed from within an active Zendesk tab using `chrome.scripting.executeScript`. The extension relies on the user's existing browser session (cookies) for authentication. No API tokens or OAuth are used.

### 10.2 Primary Endpoint

```
GET https://{subdomain}.zendesk.com/api/v2/views/{viewId}/execute.json?per_page=30&page=1
```

### 10.3 Response Shape

The execute endpoint returns a normalized response:

- `response.view.columns`: ordered array of column IDs active in the current view.
- `response.columns`: dictionary of column metadata keyed by column ID, containing `title`, `type`, and `sortable`.
- `response.rows` or `response.tickets`: ticket data objects. Foreign-key fields (`requester_id`, `assignee_id`, `group_id`, `organization_id`) are stored as numeric IDs.
- Side-loaded lookup arrays: `users`, `groups`, `organizations`, `custom_statuses`.

Example structure:
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

### 10.4 Pagination

The response may include `links.next` for the next page URL, or the `Link` HTTP header may contain the next page URL. The extension fetches all pages and accumulates tickets before applying rules. A short delay is inserted between page requests to reduce request burst intensity. If an HTTP `429` response is received, the fetch loop stops and returns partial data with a rate-limit error instead of retrying immediately.

### 10.5 Rate Limiting & Backoff

Zendesk enforces account-level rate limits. To avoid exhausting quota:
- UI value discovery uses `maxPages = 1`.
- Background monitoring uses `maxPages = 3` rather than larger values.
- `fetchAllPages` inserts a delay between successful page fetches.
- On HTTP `429`, `fetchAllPages` breaks early and returns `lastError = 'HTTP 429: Rate limited...'`. Monitoring code should surface this as a pause/notification rather than continuing failing requests.

### 10.6 Metadata Endpoints (Rule Editor & Monitoring)

For popup rule value discovery and for background monitoring lookup resolution, the extension fetches system metadata from:
- `/api/v2/ticket_fields.json` — custom field definitions and dropdown options
- `/api/v2/custom_statuses.json` — all custom statuses
- `/api/v2/groups.json` — all groups
- `/api/v2/users.json` — all users/agents
- `/api/v2/organizations.json` — all organizations

This metadata is cached in memory for the extension session and merged with first-page ticket values to populate rule dropdowns without paginating through all tickets. The same metadata is merged into the lookup map used by `applyRules` during background monitoring so that numeric foreign keys (e.g., `group_id`, `custom_status_id`, `organization_id`) are resolved to display names.

### 10.7 Lookup Dictionaries

The response may include top-level arrays (`users`, `groups`, `organizations`, `custom_statuses`) used by the generic resolver to convert foreign-key IDs to display names. These dictionaries are merged across all pages into a single lookup map, which is then further augmented with system metadata before rule evaluation.

### 10.8 Nested Path Resolution

Column keys may use dot-notation to access nested ticket properties, such as `via.channel` or `organization.name`. The resolver traverses the ticket object dynamically by splitting on `.` and walking each segment; if any segment is missing, the value is treated as absent and the resolver falls back to direct property access or returns an empty string. This supports arbitrary nesting depth and avoids hardcoded one-level splits.

### 10.9 Dynamic Metadata Persistence

After applying rules during background monitoring, the extension persists dynamic field metadata to `chrome.storage.local` so the popup rules editor can populate dropdowns without re-fetching:

- `combinedLookupMap`: the merged lookup map containing side-loaded entities and system metadata, keyed by string IDs.
- `dynamicFieldValues`: a map of column keys to arrays of `{ value, label }` objects derived from the current ticket set. Built for:
  - `via.channel` — lowercase channel strings observed in tickets.
  - `group_id` — raw numeric group IDs from tickets.
  - `assignee_id` — raw numeric assignee IDs from tickets.
- `lastMetadataUpdate`: timestamp of the last persistence operation.

This avoids the prior issue where the rules editor dropdowns were grayed out because lookup data existed only in the ephemeral Service Worker context and was lost between sessions.

### 10.10 Smart Notification Routing

The `Open Ticket` button on per-ticket notifications uses SPA-aware routing instead of opening a new tab:

- If a Zendesk tab is already open, `chrome.tabs.update()` navigates that tab directly to `https://{subdomain}.zendesk.com/agent/tickets/{ticketId}` and focuses its window.
- If no Zendesk tab exists, `chrome.tabs.create()` opens the ticket URL in a new tab.
- For summary notifications without a ticket ID, the button navigates to `https://{subdomain}.zendesk.com/agent/dashboard`.
- Notification IDs follow the pattern `ticket-{ticketId}` or `summary-{timestamp}` so the handler can distinguish ticket links from summary links.

---

## 11. Message Passing Contract

### 11.1 Popup → Background

| Message | Payload | Response |
|---------|---------|----------|
| `GET_VIEWS` | `{ subdomain: string }` | `{ views: Array<{ id: string; title: string }> }` |
| `GET_VIEW_COLUMNS` | `{ subdomain: string; viewId: string }` | `{ columns: Array<{ key: string, title: string }>, valuesMap: Record<string, string[]> }` |
| `FIND_SUBDOMAIN` | `{}` | `{ subdomain: string }` |
| `START_MONITORING` | `{ subdomain: string; views: Array<{ id: string; title: string; rules: Array<{ column: string; values: string[] }> }> }` | `{ success: boolean }` |
| `STOP_MONITORING` | `{}` | `{ success: boolean }` |
| `RESUME_MONITORING` | `{}` | `{ success: boolean }` |

### 11.2 Background → Popup (Future)

- Event-driven updates (e.g., `TICKETS_FOUND`, `MONITORING_STOPPED`) are not in the current core rules but may be added to keep the popup in sync without polling.

---

## 12. Polling & Alarm Lifecycle

### 12.1 Alarm Configuration

- Default poll interval: 1 minute.
- User-configurable via `settings.pollInterval`.
- `maxPages` for monitoring is user-configurable via `settings.maxPages`; default is 3.
- Inter-page delay is user-configurable via `settings.interPageDelay`; default is 250ms.

### 12.2 Lifecycle

1. `START_MONITORING` initializes state, loads settings, and creates a repeating alarm.
2. Alarm fires → background iterates selected views → compares against `viewSeenTickets` → updates state and fires notifications.
3. `STOP_MONITORING` clears the alarm and sets `monitoring = false`.
4. State (`viewSeenTickets`, `ticketHistory`, `selectedViews`, `settings`) is preserved across stop/start cycles so the user does not lose context.

---

## 13. Security & Privacy Model

- **No credentials handled**: The extension never prompts for, stores, or transmits API tokens or passwords.
- **Cookie-based only**: Authentication is entirely dependent on the user's existing Zendesk browser session.
- **Scoped host permissions**: Only `https://*.zendesk.com/*` is declared.
- **Local-only storage**: `chrome.storage.local` is not synced to Chrome cloud storage.
- **No external calls**: All network requests are to Zendesk domains only.

---

## 14. Current Gaps (Roadmap Items)

| Feature | Target State | Notes |
|---------|-------------|-------|
| Per-view `viewSeenTickets` | Implemented | Replaced flat `seenTickets` array |
| Ticket History UI | Implemented | Section in popup with manual clear and capacity trimming |
| History retention settings | Implemented | `settings.historyCapacity` controls max retained entries |
| Settings UI | Implemented | Poll interval, max pages, inter-page delay, sound, notification behavior/persistence, history capacity, idle pause, metadata cache clear |
| Rules Engine | Implemented | Client-side AND/OR filtering with generic lookup resolver, metadata-backed values, metadata-merged lookup map for monitoring, bounded pagination |
| Popup state restoration | Partial | Restores views, history, and settings; settings UI is implemented |
| Subdomain parsing robustness | Required | Replace fragile `split('.')[0][1]` logic |
| Error handling & retry | Required | Graceful degradation on API failures |
| Generic lookup resolver | Implemented | Resolve foreign keys to display names without hardcoded field names; merged with system metadata for monitoring |
| Metadata-backed rule values | Implemented | System metadata fetched once per Service Worker session and re-hydrated on wakeup; merged into monitoring lookup map |
| Pagination | Implemented | `maxPages=1` for UI, `maxPages=3` for monitoring via `links.next` / `Link` header |
| Execute endpoint parameters | Implemented | Called with `per_page=30&page=1` |
| Rate limiting & backoff | Implemented | Delay between pages; HTTP `429` stops fetch loop and returns `lastError` |

---

## 15. Design Principles

1. **Session Leverage**: Use existing browser state; never ask for credentials.
2. **Minimal API Surface**: Only fetch what the user explicitly selects.
3. **View-Scoped State**: Tickets are new or old relative to a specific view, not globally.
4. **Client-Side Filtering**: Rules are applied after fetching to keep the implementation simple and avoid query-formatting risks.
5. **User Control**: History, polling, and rules are user-configurable with safe defaults.
6. **Zero Hardcoded Field Names**: All field resolution is dynamic via schema parsing and generic lookup maps.
7. **Full Pagination Coverage**: All pages are fetched before rule application to ensure complete coverage.
8. **Metadata Caching**: System metadata is fetched once per session and cached in memory to keep the UI instant and avoid rate limits.
