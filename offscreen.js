chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'playSound') {
    const audio = document.getElementById('alert');
    if (audio) {
      audio.currentTime = 0;
      audio.play()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.warn('Audio playback suppressed by Chrome policy:', e);
          sendResponse({ ok: false, error: e.message });
        });
    }
  }
  return true;
});
