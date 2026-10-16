# Zenduck - Core Rules & Architecture Decisions

## 1. Core Objective:
The extension must work for both Zendesk Admins and Agents.
The user typically monitors a small number of views (usually 1 to 4 views maximum).
The core value of the extension is a powerful Rules system that precisely controls which tickets trigger notifications.

## 2. Authentication Strategy:
All API calls are executed from within an active Zendesk tab using `chrome.scripting.executeScript`.
The extension relies on the user's existing browser session (cookies) for authentication.
No API tokens or OAuth will be used in the initial version.

## 3. Monitoring Scope:
Monitoring runs only on the views explicitly selected by the user.
The extension will never automatically scan all available views.
Maximum recommended views per user is 4.

## 4. Seen Tickets Logic:
Each view must maintain its own independent `seenTickets` list.
A ticket is considered "new" only relative to the specific view it appeared in.
The notification must indicate which view the ticket came from.

## 5. Ticket History:
- New tickets appear in the Popup in a "Ticket History" section.
- History capacity is bounded by a user setting; when the limit is reached, oldest entries are dropped.
- History can be cleared manually from the popup.
- Retention behavior is configurable through Settings.

## 6. Settings:
- Settings are persisted in `chrome.storage.local` under a `settings` key.
- Available settings:
  - `pollInterval`: polling interval in seconds; valid values are 15, 30, 40, 60; default is 60.
  - `idlePause`: whether monitoring should pause when no Zendesk tab is available; values are `enabled` or `disabled`; default is `enabled`.
  - `maxPages`: maximum execute.json pages to fetch per poll; values are 1, 3, 5; default is 3.
  - `interPageDelay`: delay in milliseconds between page requests; values are 100, 250, 500; default is 250.
  - `soundAlert`: whether to play a sound on new tickets; values are `enabled` or `disabled`; default is `disabled`.
  - `notificationBehavior`: `per-ticket` or `summary`; default is `per-ticket`.
  - `notificationPersistence`: `auto-close` or `sticky`; default is `auto-close`.
  - `historyCapacity`: maximum number of history entries to retain; values are 50, 100, 200; default is 100.
- A "Clear Metadata Cache" action resets the in-memory/system metadata cache so it is re-fetched from Zendesk on next use.
- The popup exposes Settings through a collapsible Settings section in the Single View layout.

## 7. Popup Design:
- The Popup is a single interface (Single View layout).
- Contains:
  - Start / Stop Monitoring control bar
  - List of selected views with inline rule editing
  - Ticket History log with manual clear control
  - Collapsible Settings section (retention policy, polling options)

## 8. Rules Engine:
- Each view has its own set of rules (view-specific rules).
- Each rule consists of:
  - Column selected from a dropdown list of available columns discovered from the view's `execute.json` response `columns` array
  - Values selected from a multi-select dropdown of unique values present in the current view data for that column
- The column dropdown shows the Zendesk UI display title, while the stored rule value uses the internal column key.
- A ticket is a candidate only if it meets ALL rules in the view (AND logic between rules).
- Within the same rule, if there is more than one value, any value is sufficient (OR logic within values).
- If a view has no rules, all tickets from that view are candidates.
- Rules are applied client-side after fetching tickets from the view execute endpoint.
- Rules are edited inline within the Views list in the popup.
- When "Edit Rules" is clicked, the extension fetches the view and discovers available columns and their current values dynamically.
- Selecting a column automatically updates the values dropdown to show only values present in the current view data.
- Object-type fields such as assignee or group are resolved to their display names rather than raw JSON.
- The rules engine uses a generic lookup resolver: foreign-key IDs are resolved to display names using dictionaries embedded in the API response (`users`, `groups`, `organizations`, `custom_statuses`) merged with system metadata fetched from `/groups.json`, `/custom_statuses.json`, `/users.json`, and `/ticket_fields.json`. No field names or IDs are hardcoded.
- Rule values in the popup are populated from Zendesk system metadata endpoints (`ticket_fields`, `custom_statuses`, `groups`, `users`), cached for the session with re-hydration on Service Worker wakeup, rather than derived from paginating through every ticket row.
- `getAvailableValuesForColumn(columnKey)` reads from `chrome.storage.local.dynamicFieldValues` first, then falls back to `combinedLookupMap` for ID-based columns (`group_id`, `assignee_id`, `organization_id`). For these ID-based columns, the dropdown returns `{ value: name, label: '${name} (ID: ${id})' }` so users select by translated name while the rule filter matches by both resolved name and raw ID.
- Rule matching in `applyRules` is case-insensitive and supports matching by resolved display name, raw ticket value, or partial inclusion. This prevents failures from case differences, trimming, or ID/name mismatches.
- The `GET_VIEW_COLUMNS` handler builds columns and values directly from fetched ticket data. It adds default columns (`via.channel`, `channel`, `status`, `priority`, `group_id`, `assignee_id`, `type`) and extracts actual values from each ticket, including nested `via.channel` and custom fields from `ticket.fields` or `ticket.custom_fields`. This ensures dropdowns contain real values present in the view rather than only metadata-derived entries.
- Bounded pagination is handled automatically: up to 3 pages are fetched using `links.next` / `Link` header before rules are applied during monitoring.
- The execute endpoint is called with `per_page=30&page=1` query parameters.
- A 250ms delay is inserted between paginated page requests to reduce request burst intensity.
- HTTP `429` responses are detected from the injected fetch result; when encountered, the fetch loop breaks early and returns partial data plus a rate-limit error instead of hammering the API.
- Background monitoring uses `maxPages = 3` rather than `10` to limit API load while still covering up to 90 tickets per view per poll.
- UI column/value discovery continues to use `maxPages = 1` for fast popup responses.

## 9. Seen Tickets Logic:

### 9.1 Per-View Tracking

Each view maintains an independent list of seen ticket IDs. This ensures that:
- A ticket appearing in multiple views is not suppressed globally.
- A ticket is only considered "new" within the context of the view it was fetched from.

### 9.2 Initialization

When monitoring starts:
- For each selected view, the extension executes the view and collects all current ticket IDs.
- These IDs are stored in `viewSeenTickets[viewId]`.
- The alarm does not fire notifications for these initial tickets.

### 9.3 Subsequent Polls

On each alarm tick:
- Execute each selected view.
- Compare returned tickets against `viewSeenTickets[viewId]`.
- Tickets not present in the view's seen list are considered new.

### 9.4 Notification Attribution

Every notification must indicate the source view so the user understands which view triggered it.

## 10. Ticket History

### 10.1 Behavior

- Every newly detected ticket is appended to `ticketHistory` in storage.
- The popup renders this history in its dedicated section.
- History is bounded by `settings.historyCapacity`; older entries are dropped when the limit is exceeded.
- Manual clear is available from the popup.

### 10.2 Retention Policies

History retention is configurable via Settings. Current behavior:
- `manual` — User clears history explicitly via a button.
- Capacity-backed trimming — When the history exceeds `historyCapacity`, oldest entries are removed automatically.

### 10.3 Storage

`ticketHistory` is stored in `chrome.storage.local`. Given the expected low volume (1-4 views, modest ticket throughput), size constraints are not a concern for the initial version.

## 11. Notification Strategy

### 11.1 Notification Behavior

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

### 11.2 Per-Ticket Notification

- Title: `#<ticket number> - <subject>`
- Message: `Channel: <CHANNEL> • Group: <GROUP>\nAssignee: <ASSIGNEE>\nView: <view title>`
- Context message: `Zenduck Monitor`
- Includes an `Open Ticket` action button.
- `chrome.notifications.onButtonClicked` opens the ticket URL in a new tab when the button is clicked.
- Group and Assignee names are resolved from `group_id` and `assignee_id` through the metadata lookup map built from side-loaded `users`, `groups`, and `organizations` in the execute response, merged with system metadata endpoints.
- Channel is resolved from `via.channel` through the dynamic resolver; if absent, the field is omitted from the notification rather than displaying a hardcoded placeholder.
- Persistence and sound are controlled by `maybeNotify()`: it reads `settings.notificationPersistence` to set `requireInteraction`, and if `settings.soundAlert === 'enabled'`, it sends a `playSound` message to an offscreen document that plays `alert.mp3`.

### 11.3 Summary Notification

- Type: `list`
- Title: `Zenduck: <count> New Tickets Detected`
- Message: `View: <view title>` or `Summary of recent incoming tickets`
- Items: up to 4 tickets shown as `#<number>: <subject>`, plus `...` with remaining count when there are more than 4.
- Includes an `Open Zendesk` action button.
- `chrome.notifications.onButtonClicked` opens the Zendesk dashboard in a new tab when the button is clicked.
- Persistence and sound behavior are the same as per-ticket notifications.

### 11.4 Badge Counter

- The extension icon badge displays the total count of unseen tickets across all monitored views.
- Badge text is updated after each poll cycle.

### 11.5 Offscreen Audio Playback

- Because Manifest V3 service workers cannot reliably play audio, the extension uses `chrome.offscreen.createDocument()` to host `offscreen.html` and `offscreen.js`.
- `offscreen.html` contains an `<audio id="alert" preload="auto" src="alert.mp3">` element.
- `offscreen.js` listens for `chrome.runtime.onMessage` with `type: 'playSound'`, resets `audio.currentTime`, and calls `audio.play()`.
- `background.js` ensures the offscreen document exists before sending the play message, and catches playback errors to avoid uncaught promise rejections.

## 12. API Integration

### 12.1 Execution Context

All Zendesk API calls are executed from within an active Zendesk tab using `chrome.scripting.executeScript`. The extension relies on the user's existing browser session (cookies) for authentication. No API tokens or OAuth are used.

### 12.2 Primary Endpoint

```
GET https://{subdomain}.zendesk.com/api/v2/views/{viewId}/execute.json?per_page=30&page=1
```

### 12.3 Response Shape

The execute endpoint returns a normalized response:

- `response.view.columns`: ordered array of column IDs active in the current view.
- `response.columns`: dictionary of column metadata keyed by column ID, containing `title`, `type`, and `sortable`.
- `response.rows` or `response.tickets`: ticket data objects. Foreign-key fields (`requester_id`, `assignee_id`, `group_id`, `organization_id`) are stored as numeric IDs.
- Side-loaded lookup arrays: `users`, `groups`, `organizations`, `custom_statuses`.

**Column Normalization:** In `fetchAllPages`, each column object from `response.columns[id]` is normalized before being added to `allColumns`. The stored shape is always:

```javascript
{
  id: col.id || id,
  title: col.title || id,
  type: col.type || 'text',
  sortable: col.sortable || false
}
```

**Per-View Column Isolation:** To avoid cross-view column mixing when multiple views are fetched in one alarm cycle, `fetchAllPages` stores normalized columns in `globalThis.viewColumnsMap[viewId]`. The `GET_VIEW_COLUMNS` handler reads from this map using `message.viewId`, ensuring the popup always receives the correct column set for the requested view.

Example response structure:

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

### 12.4 Pagination

The response may include `links.next` for the next page URL, or the `Link` HTTP header may contain the next page URL. The extension fetches all pages and accumulates tickets before applying rules. A short delay is inserted between page requests to reduce request burst intensity. If an HTTP `429` response is received, the fetch loop stops and returns partial data with a rate-limit error instead of retrying immediately.

### 12.5 Rate Limiting & Backoff

Zendesk enforces account-level rate limits. To avoid exhausting quota:
- UI value discovery uses `maxPages = 1`.
- Background monitoring uses `maxPages = 3` rather than larger values.
- `fetchAllPages` inserts a delay between successful page fetches.
- On HTTP `429`, `fetchAllPages` breaks early and returns `lastError = 'HTTP 429: Rate limited...'`. Monitoring code should surface this as a pause/notification rather than continuing failing requests.

### 12.6 Metadata Endpoints (Rule Editor & Monitoring)

For popup rule value discovery and for background monitoring lookup resolution, the extension fetches system metadata from:
- `/api/v2/ticket_fields.json` — custom field definitions and dropdown options
- `/api/v2/custom_statuses.json` — all custom statuses
- `/api/v2/groups.json` — all groups
- `/api/v2/users.json` — all users/agents
- `/api/v2/organizations.json` — all organizations

This metadata is cached in the Service Worker context and re-fetched as needed when the worker wakes, since Manifest V3 service workers are ephemeral. It is merged with first-page ticket values to populate rule dropdowns without paginating through all tickets. The same metadata is merged into the lookup map used by `applyRules` during background monitoring so that numeric foreign keys (e.g., `group_id`, `custom_status_id`, `organization_id`) are resolved to display names.

### 12.7 Lookup Dictionaries

The response may include top-level arrays (`users`, `groups`, `organizations`, `custom_statuses`) used by the generic resolver to convert foreign-key IDs to display names. These dictionaries are merged across all pages into a single lookup map, which is then further augmented with system metadata before rule evaluation.

### 12.8 Nested Path Resolution

Column keys may use dot-notation to access nested ticket properties, such as `via.channel` or `organization.name`. The resolver traverses the ticket object dynamically by splitting on `.` and walking each segment; if any segment is missing, the value is treated as absent and the resolver falls back to direct property access or returns an empty string. This supports arbitrary nesting depth and avoids hardcoded one-level splits.

### 12.9 Dynamic Metadata Persistence

After applying rules during background monitoring, the extension persists dynamic field metadata to `chrome.storage.local` so the popup rules editor can populate dropdowns without re-fetching:

- `combinedLookupMap`: the merged lookup map containing side-loaded entities and system metadata, keyed by string IDs.
- `dynamicFieldValues`: a map of column keys to arrays of `{ value, label }` objects derived from the current ticket set. Built for:
  - `via.channel` — lowercase channel strings observed in tickets.
  - `group_id` — raw numeric group IDs from tickets.
  - `assignee_id` — raw numeric assignee IDs from tickets.
- `lastMetadataUpdate`: timestamp of the last persistence operation.

This avoids the prior issue where the rules editor dropdowns were grayed out because lookup data existed only in the ephemeral Service Worker context and was lost between sessions.

### 12.10 Smart Notification Routing

The `Open Ticket` button on per-ticket notifications uses SPA-aware routing instead of opening a new tab:

- If a Zendesk tab is already open, `chrome.tabs.update()` navigates that tab directly to `https://{subdomain}.zendesk.com/agent/tickets/{ticketId}` and focuses its window.
- If no Zendesk tab exists, `chrome.tabs.create()` opens the ticket URL in a new tab.
- For summary notifications without a ticket ID, the button navigates to `https://{subdomain}.zendesk.com/agent/dashboard`.
- Notification IDs follow the pattern `ticket-{ticketId}` or `summary-{timestamp}` so the handler can distinguish ticket links from summary links.

## 13. Message Passing Contract

### 13.1 Popup → Background

| Message | Payload | Response |
|---------|---------|----------|
| `GET_VIEWS` | `{ subdomain: string }` | `{ views: Array<{ id: string; title: string }> }` |
| `GET_VIEW_COLUMNS` | `{ subdomain, viewId }` | `{ columns, valuesMap }` |
| `START_MONITORING` | `{ subdomain, views }` | `{ success: boolean }` |
| `STOP_MONITORING` | `{}` | `{ success: boolean }` |
| `RESUME_MONITORING` | `{}` | `{ success: boolean }` |
| `FIND_SUBDOMAIN` | `{}` | `{ subdomain: string }` |
| `CLEAR_METADATA_CACHE` | `{}` | `{ success: boolean }` |

### 13.2 Background → Popup (Future)

- Event-driven updates (e.g., `TICKETS_FOUND`, `MONITORING_STOPPED`) are not in the current core rules but may be added to keep the popup in sync without polling.

## 14. Polling & Alarm Lifecycle

### 14.1 Alarm Configuration

- Default poll interval: 1 minute.
- User-configurable via `settings.pollInterval`.
- `maxPages` for monitoring is user-configurable via `settings.maxPages`; default is 3.
- Inter-page delay is user-configurable via `settings.interPageDelay`; default is 250ms.

### 14.2 Lifecycle

1. `START_MONITORING` initializes state, loads settings, and creates a repeating alarm.
2. Alarm fires → background iterates selected views → compares against `viewSeenTickets` → updates state and fires notifications.
3. `STOP_MONITORING` clears the alarm and sets `monitoring = false`.
4. State (`viewSeenTickets`, `ticketHistory`, `selectedViews`, `settings`) is preserved across stop/start cycles so the user does not lose context.

## 15. Security & Privacy Model

- **No credentials handled**: The extension never prompts for, stores, or transmits API tokens or passwords.
- **Cookie-based only**: Authentication is entirely dependent on the user's existing Zendesk browser session.
- **Scoped host permissions**: Only `https://*.zendesk.com/*` is declared.
- **Local-only storage**: `chrome.storage.local` is not synced to Chrome cloud storage.
- **No external calls**: All network requests are to Zendesk domains only.

## 16. Current Gaps (Roadmap Items)

| Feature | Target State | Notes |
|---------|-------------|-------|
| Per-view `viewSeenTickets` | Implemented | Replaced flat `seenTickets` array |
| Ticket History UI | Implemented | Section in popup with manual clear and capacity trim |
| Settings UI | Implemented | Poll interval, max pages, delay, sound, notifications, history capacity, metadata cache clear |
| Idle pause | Implemented | Pause when Zendesk tab is missing, toggleable via Settings |
| Rules Engine | Implemented | Client-side AND/OR filtering with generic lookup resolver, metadata-backed values, metadata-merged lookup map for monitoring, bounded pagination |
| Popup state restoration | Partial | Restores views and history; settings restore is implemented |
| Badge counter | ✅ Implemented | Global count |
| Error handling | ⚠️ Basic try/catch | Retry logic, user feedback |
| Subdomain parsing | ⚠️ Fragile (`split('.')[0][1]`) | URL parsing with edge cases |
| Generic lookup resolver | ✅ Implemented | Resolve foreign keys to display names without hardcoded field names; merged with system metadata for monitoring |
| Metadata-backed rule values | ✅ Implemented | System metadata fetched once per Service Worker session and re-hydrated on wakeup; merged into monitoring lookup map |
| Pagination | ✅ Implemented | `maxPages=1` for UI, `maxPages=3` for monitoring via `links.next` / `Link` header |
| Execute endpoint parameters | ✅ Implemented | Called with `per_page=30&page=1` |
| Rate limiting & backoff | ✅ Implemented | Delay between pages; HTTP `429` stops fetch loop and returns `lastError` |

## 17. Design Principles

1. **Session Leverage**: Use existing browser state; never ask for credentials.
2. **Minimal API Surface**: Only fetch what the user explicitly selects.
3. **View-Scoped State**: Tickets are new or old relative to a specific view, not globally.
4. **Client-Side Filtering**: Rules are applied after fetching to keep the implementation simple and avoid query-formatting risks.
5. **User Control**: History, polling, and rules are user-configurable with safe defaults.
6. **Zero Hardcoded Field Names**: All field resolution is dynamic via schema parsing and generic lookup maps.
7. **Bounded Pagination**: Monitoring fetches up to `maxPages` pages before rule application to balance coverage and rate-limit safety.
8. **Metadata Caching**: System metadata is fetched once per Service Worker session and cached in the worker context. Because Manifest V3 service workers are ephemeral, the cache may be rehydrated on worker wakeup to keep the UI instant and avoid rate limits.
