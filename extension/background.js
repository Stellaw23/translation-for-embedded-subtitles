// extension/background.js
importScripts('llm-client.js');

let client = null;

function getClient() {
  return new Promise((resolve) => {
    if (client) { resolve(client); return; }
    chrome.storage.local.get(
      ['backend', 'ollamaUrl', 'ollamaModel', 'claudeApiKey'],
      (cfg) => {
        client = new LLMClient({
          backend: cfg.backend || 'ollama',
          ollamaUrl: cfg.ollamaUrl || 'http://localhost:11434',
          ollamaModel: cfg.ollamaModel || 'qwen2.5:7b',
          claudeApiKey: cfg.claudeApiKey || ''
        });
        resolve(client);
      }
    );
  });
}

// Reset client when config changes (Popup saves new settings)
chrome.storage.onChanged.addListener(() => { client = null; });

// ── Offscreen document for Tesseract OCR ─────────────────────────────
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Run Tesseract OCR for burned-in subtitle recognition'
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRANSLATE') {
    getClient()
      .then((c) => c.translate(msg.text, msg.lang))
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep sendResponse channel open for async
  }
  if (msg.type === 'OCR') {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: 'OCR', dataUrl: msg.dataUrl }))
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'BREAKDOWN') {
    getClient()
      .then((c) => c.breakdown(msg.word, msg.lang))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
