// translation/extension/offscreen.js
// Offscreen OCR runtime for Chrome MV3.
// Goal: fully avoid worker CDN fallback by using options-style createWorker()
// with explicit local worker/core paths, and initialize only Japanese ("jpn").

let tesseractWorker = null;
let initPromise = null;
let ocrQueue = Promise.resolve();

const OCR_LANG = "jpn";
const LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";

async function initTesseract() {
  if (tesseractWorker) return tesseractWorker;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // options-style createWorker to avoid legacy signature quirks/fallbacks
      const worker = await Tesseract.createWorker({
        workerPath: chrome.runtime.getURL("libs/worker.min.js"),
        corePath: chrome.runtime.getURL("libs/tesseract-core.wasm.js"),
        langPath: LANG_PATH,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: "none",
        logger: (m) => {
          const status = (m && m.status) || "";
          if (
            status.includes("loading tesseract core") ||
            status.includes("loading language traineddata") ||
            status.includes("initializing api")
          ) {
            const pct = Math.round(((m && m.progress) || 0) * 100);
            console.log("[Vlog OCR]", status, `${pct}%`);
          }
        },
      });

      // Explicit language lifecycle (single language: Japanese)
      await worker.loadLanguage(OCR_LANG);
      await worker.initialize(OCR_LANG);

      tesseractWorker = worker;
      console.log("[Vlog OCR] Tesseract ready");
      return worker;
    } catch (e) {
      console.error("[Vlog OCR] Tesseract init failed:", e);
      throw e;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

async function recognizeDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("Invalid or empty dataUrl provided to OCR.");
  }

  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch OCR frame: HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error("OCR frame blob is empty.");
  }

  const worker = await initTesseract();
  const { data } = await worker.recognize(blob, {}, { lang: OCR_LANG });
  const text = ((data && data.text) || "").trim().replace(/\s+/g, " ");
  const confidence = Number.isFinite(data && data.confidence)
    ? Math.max(0, Math.min(100, Number(data.confidence)))
    : null;
  return { text, confidence };
}

async function resetWorkerAfterCrash() {
  if (!tesseractWorker) return;
  try {
    await tesseractWorker.terminate();
    console.log("[Vlog OCR] Crashed worker terminated.");
  } catch (e) {
    console.error("[Vlog OCR] Failed to terminate worker:", e);
  } finally {
    tesseractWorker = null;
  }
}

// Handshake to background
chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "OFFSCREEN_OCR_TASK") return;

  // Serialize OCR requests; one recognize() at a time.
  ocrQueue = ocrQueue
    .catch(() => {})
    .then(async () => {
      try {
        const result = await recognizeDataUrl(msg.dataUrl);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error("[Vlog OCR] recognize error:", e);
        await resetWorkerAfterCrash();
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    });

  return true; // async sendResponse
});
