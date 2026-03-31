# TODOS

## Extension / OCR Pipeline

### P2 — Async init race
The `ocrDataCollectionEnabled` and `ocrLabelMap` variables load from chrome.storage asynchronously at startup. If OCR polling fires before the callback resolves (rare on first page load), the first few frames may be dropped or not corrected. Consider awaiting the initial storage read before starting OCR polling.

### P2 — Adjacent-bucket label correction
`resolveCorrectedText` looks up `timeBucket-1` through `timeBucket+1`. Adjacent buckets may contain different subtitle text, so a wrong correction could silently apply. Consider requiring an exact bucket match, or adding a text similarity check.

### P3 — OCR_SECRET for local bridge
The `ocr_server.js` now supports `OCR_SECRET` env var for shared secret auth. Add setup instructions (e.g., in README or a `.env.example`) so the secret can be configured easily.

### P3 — Stale video element after SPA navigation
After YouTube SPA navigation, the captured video element may be detached. OCR continues on a frozen frame. Consider adding a visibility/connection check before each OCR capture.

## Testing

### P3 — E2E tests for extension popup
The popup's export/import flows (JSONL export, ZIP export, labels import) are tested manually. Consider adding Playwright E2E tests for the popup once the extension stabilizes.

## Completed
