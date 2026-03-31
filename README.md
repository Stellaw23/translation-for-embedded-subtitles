# Vlog 字幕翻译 · Translation for Embedded Subtitles

A Chrome extension that captures, OCR-reads, and translates Korean/Japanese vlog subtitles in real time — with a local OCR pipeline and a data collection loop for improving accuracy.

## Features

- **Floating overlay** — shows original subtitle + translation in a draggable window
- **Dual OCR backend** — tries a local macOS Vision bridge first (higher accuracy), falls back to in-extension Tesseract
- **Confidence indicator** — displays OCR confidence %; turns red for low-confidence reads
- **Font color control** — white/black toggle adjusts image preprocessing for better OCR on different subtitle styles
- **Data collection loop** — opt-in sample capture, JSONL/ZIP export, label import to correct OCR errors persistently
- **Annotator tool** — standalone HTML app (`tests/annotator.html`) for reviewing and labeling exported samples

## Installation

1. Clone this repo
2. Open Chrome → `chrome://extensions` → Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` folder

## Local OCR Bridge (optional, macOS only)

The local bridge uses the macOS Vision framework for higher-accuracy OCR:

```bash
cd local-ocr-bridge
npm install

# Set the path to the Vision CLI binary (download separately)
export VISION_OCR_PATH=/path/to/macos-vision-ocr-arm64

# Optionally set a shared secret for security
export OCR_SECRET=your-secret-here

node ocr_server.js
```

The extension will automatically use the bridge when it's running on `http://127.0.0.1:3000`, and fall back to the built-in Tesseract OCR otherwise.

## Running Tests

```bash
npm install
npm test
```

31 unit tests covering OCR utility functions (time bucketing, label map lookups, JSONL parsing, CRC32).

## Supported Sites

- YouTube (`youtube.com`, `youtu.be`)
- Bilibili (`bilibili.com`)
- All other pages (via `*://*/*` fallback)
