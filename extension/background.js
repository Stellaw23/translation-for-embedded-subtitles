// extension/background.js
importScripts("llm-client.js");

// ── LLM client ─────────────────────────────────────────────────────────────
let client = null;

function getClient() {
  return new Promise((resolve) => {
    if (client) {
      resolve(client);
      return;
    }
    chrome.storage.local.get(
      ["backend", "ollamaUrl", "ollamaModel", "claudeApiKey"],
      (cfg) => {
        client = new LLMClient({
          backend: cfg.backend || "ollama",
          ollamaUrl: cfg.ollamaUrl || "http://localhost:11434",
          ollamaModel: cfg.ollamaModel || "qwen2.5:7b",
          claudeApiKey: cfg.claudeApiKey || "",
        });
        resolve(client);
      },
    );
  });
}

// Invalidate cached client whenever the user saves new config in the popup
chrome.storage.onChanged.addListener(() => {
  client = null;
});

// ── Offscreen document concurrency lock ────────────────────────────────────
// offscreenReady: a Promise that resolves once offscreen.js fires OFFSCREEN_READY.
// creatingOffscreenPromise: guards against concurrent createDocument() calls —
//   if two OCR frames arrive back-to-back before the document is alive, the
//   second awaits the first instead of racing to create a duplicate.

let offscreenReady = null;
let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  // Fast path: document already exists
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  // Slow path: another call already started creation — join it
  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;
  }

  // We are the first caller — acquire the lock
  creatingOffscreenPromise = (async () => {
    try {
      // Set up the ready-signal promise before createDocument so we cannot
      // miss the OFFSCREEN_READY message that fires immediately on load.
      let readyResolve;
      offscreenReady = new Promise((r) => {
        readyResolve = r;
      });
      offscreenReady.resolve = readyResolve;

      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Run Tesseract OCR for burned-in subtitle recognition",
      });

      // Wait for offscreen.js to confirm it has booted (5 s hard timeout)
      await Promise.race([
        offscreenReady,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Offscreen document boot timeout")),
            5000,
          ),
        ),
      ]);
    } finally {
      // Always release the lock so future calls can retry on failure
      offscreenReady = null;
      creatingOffscreenPromise = null;
    }
  })();

  return creatingOffscreenPromise;
}

// ── Single unified message listener ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ── Offscreen boot handshake ──────────────────────────────────────────
  if (msg.type === "OFFSCREEN_READY") {
    if (offscreenReady && offscreenReady.resolve) {
      offscreenReady.resolve();
    }
    return; // no sendResponse needed
  }

  // ── LLM: translate subtitle text ─────────────────────────────────────
  if (msg.type === "TRANSLATE") {
    getClient()
      .then((c) => c.translate(msg.text, msg.lang))
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  // ── LLM: word breakdown ───────────────────────────────────────────────
  if (msg.type === "BREAKDOWN") {
    getClient()
      .then((c) => c.breakdown(msg.word, msg.lang))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── OCR relay: content.js → background → offscreen ───────────────────
  // content.js sends { type: "OCR", dataUrl }.
  // background ensures the offscreen document is alive, then forwards the
  // frame as { type: "OFFSCREEN_OCR_TASK", dataUrl } so offscreen.js can
  // distinguish between messages that come from content scripts (type "OCR")
  // and tasks dispatched by background (type "OFFSCREEN_OCR_TASK").
  if (msg.type === "OCR") {
    ensureOffscreenDocument()
      .then(() =>
        chrome.runtime.sendMessage({
          type: "OFFSCREEN_OCR_TASK",
          dataUrl: msg.dataUrl,
        }),
      )
      .then((result) =>
        sendResponse(
          result ?? { ok: false, error: "No response from offscreen" },
        ),
      )
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
