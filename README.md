# Zenduck

A browser extension that monitors new Zendesk tickets and alerts you with sound notifications.

## Features

- Watches Zendesk for new tickets
- Plays configurable sounds on new ticket events
- Popup UI to view and manage settings
- Background service worker for persistent monitoring

## Project structure

```
manifest.json          # Chrome Extension manifest (v3)
background.js          # Service worker that monitors tickets
popup.html             # Popup UI
popup.js               # Popup logic
popup.css              # Popup styles
offscreen.html         # Offscreen document
offscreen.js           # Offscreen script
icon.png               # Extension icon
sounds/                # Notification sound files
ZENDUCK_CORE_RULES.md  # Core rules
architecture.md        # Architecture overview
future_architecture.md # Future architecture notes
structure.md           # Project structure notes
```

## Installation

1. Clone the repository.
2. Open Chrome/Edge and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.

## License

MIT
