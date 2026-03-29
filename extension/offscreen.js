// extension/offscreen.js
// Runs in extension context — NOT subject to page CSP.
// Tesseract blob: workers are allowed here.

let tesseractWorker = null;

async function initTesseract() {
  if (tesseractWorker) return;
  tesseractWorker = await Tesseract.createWorker('kor+jpn', 1, {
    // Use local extension worker file to avoid CDN/CSP issues
    workerPath: chrome.runtime.getURL('libs/worker.min.js'),
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4/tesseract-core.wasm.js',
    logger: () => {}
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OCR') {
    initTesseract()
      .then(() => tesseractWorker.recognize(msg.dataUrl))
      .then(({ data }) => {
        const text = data.text.trim().replace(/\s+/g, ' ');
        sendResponse({ ok: true, text });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
});
