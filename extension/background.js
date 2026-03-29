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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRANSLATE') {
    getClient()
      .then((c) => c.translate(msg.text, msg.lang))
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep sendResponse channel open for async
  }
  if (msg.type === 'BREAKDOWN') {
    getClient()
      .then((c) => c.breakdown(msg.word, msg.lang))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
