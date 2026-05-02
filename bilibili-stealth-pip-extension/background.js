'use strict';

const BRIDGE_BASE_URL = 'http://127.0.0.1:39877';

async function postToNativeBridge(path, payload) {
  const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `native bridge returned HTTP ${response.status}`);
  }
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'OPEN_NATIVE_STEALTH_PIP') {
    return false;
  }

  postToNativeBridge('/open', {
    url: message.url,
    title: message.title || sender.tab?.title || ''
  })
    .then((data) => {
      sendResponse({
        ok: true,
        data
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || String(error)
      });
    });

  return true;
});
