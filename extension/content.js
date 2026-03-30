// extension/content.js

// ── Language detection ─────────────────────────────────────────────────
function detectLang(text) {
  if (/[\uAC00-\uD7A3]/.test(text)) return "ko";
  if (/[\u3040-\u30FF\u4E00-\u9FAF]/.test(text)) return "ja";
  return null;
}

// ── DOM subtitle selectors ─────────────────────────────────────────────
const SUBTITLE_SELECTORS = [
  ".bilibili-player-video-subtitle span",
  ".ytp-caption-segment",
];

function findSubtitleElement() {
  for (const sel of SUBTITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el;
  }
  // Generic fallback: find short elements containing Korean/Japanese
  const candidates = document.querySelectorAll("span, p");
  for (const el of candidates) {
    const text = el.textContent.trim();
    if (text.length > 1 && text.length < 200 && detectLang(text)) return el;
  }
  return null;
}

// ── Throttle ───────────────────────────────────────────────────────────
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

// ── MutationObserver subtitle detector ────────────────────────────────
let lastSubtitleText = "";
let domIdleTimer = null;
let onSubtitleFound = null; // callback(text, lang)

const handleMutation = throttle(() => {
  const el = findSubtitleElement();
  if (!el) return;
  const text = el.textContent.trim();
  const lang = detectLang(text);
  if (!lang || text === lastSubtitleText) return;
  lastSubtitleText = text;
  resetDomIdleTimer();
  if (onSubtitleFound) onSubtitleFound(text, lang);
}, 1000);

const subtitleObserver = new MutationObserver(handleMutation);

function startDomDetection(callback) {
  onSubtitleFound = callback;
  subtitleObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  resetDomIdleTimer();
}

function resetDomIdleTimer() {
  clearTimeout(domIdleTimer);
  domIdleTimer = setTimeout(switchToOcrMode, 5000);
}

// ── Clickable token renderer (floating window + breakdown panel) ───────
function renderClickableTokens(el, text, lang) {
  const pattern =
    lang === "ko" ? /([\uAC00-\uD7A3]+)/g : /([\u3040-\u30FF\u4E00-\u9FAF]+)/g;
  const parts = text.split(pattern);

  el.innerHTML = "";
  parts.forEach((part) => {
    const span = document.createElement("span");
    span.textContent = part;
    if (detectLang(part)) {
      span.className = "vlog-token";
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        showBreakdownPanel(part, lang, e.clientX, e.clientY);
      });
    }
    el.appendChild(span);
  });
}

// ── Draggable floating subtitle window ────────────────────────────────
let floatingWindow = null;
let floatingOriginal = null;
let floatingTranslated = null;

function createFloatingWindow() {
  if (floatingWindow) return;

  floatingWindow = document.createElement("div");
  floatingWindow.className = "vlog-floating-window";
  floatingWindow.innerHTML = `
    <div class="vlog-drag-handle">::</div>
    <div class="vlog-float-content">
      <div class="vlog-float-original">等待识别…</div>
      <div class="vlog-float-translated"></div>
    </div>
  `;
  document.body.appendChild(floatingWindow);

  floatingOriginal = floatingWindow.querySelector(".vlog-float-original");
  floatingTranslated = floatingWindow.querySelector(".vlog-float-translated");

  // ── Drag logic ───────────────────────────────────────────────────────
  const handle = floatingWindow.querySelector(".vlog-drag-handle");
  let dragging = false;
  let startX, startY, initLeft, initTop;

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = floatingWindow.getBoundingClientRect();
    initLeft = rect.left;
    initTop = rect.top;
    // Detach from CSS bottom/transform anchor so absolute left/top takes over
    floatingWindow.style.bottom = "auto";
    floatingWindow.style.transform = "none";
    floatingWindow.style.left = `${initLeft}px`;
    floatingWindow.style.top = `${initTop}px`;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    floatingWindow.style.left = `${initLeft + (e.clientX - startX)}px`;
    floatingWindow.style.top = `${initTop + (e.clientY - startY)}px`;
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

// Single entry point for BOTH DOM subtitles and OCR results
function updateFloatingSubtitle(text, lang) {
  createFloatingWindow();
  floatingWindow.style.display = "flex";

  renderClickableTokens(floatingOriginal, text, lang);
  floatingTranslated.textContent = "翻译中…";
  floatingTranslated.classList.remove("vlog-error");

  chrome.runtime.sendMessage({ type: "TRANSLATE", text, lang }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      floatingTranslated.textContent = (res && res.error) || "翻译失败，请检查后端";
      floatingTranslated.classList.add("vlog-error");
      return;
    }
    floatingTranslated.textContent = res.translation;
  });
}

function hideFloatingWindow() {
  if (floatingWindow) floatingWindow.style.display = "none";
}

// ── Breakdown panel ────────────────────────────────────────────────────
let breakdownPanel = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showBreakdownPanel(word, lang, clientX, clientY) {
  closeBreakdownPanel();

  const panel = document.createElement("div");
  panel.className = "vlog-breakdown-panel";
  panel.innerHTML = `
    <div class="vlog-panel-header">
      <span class="vlog-panel-word">${escapeHtml(word)}</span>
      <button class="vlog-panel-close" title="关闭">×</button>
    </div>
    <div class="vlog-panel-body">
      <div class="vlog-panel-loading">分析中…</div>
    </div>
  `;

  const panelW = 220,
    panelH = 130;
  panel.style.cssText = `
    position: fixed;
    left: ${Math.min(clientX, window.innerWidth - panelW - 8)}px;
    top:  ${Math.min(clientY + 8, window.innerHeight - panelH - 8)}px;
    z-index: 2147483647;
  `;
  document.body.appendChild(panel);
  breakdownPanel = panel;

  panel
    .querySelector(".vlog-panel-close")
    .addEventListener("click", closeBreakdownPanel);

  chrome.runtime.sendMessage({ type: "BREAKDOWN", word, lang }, (res) => {
    if (!panel.isConnected) return;
    const body = panel.querySelector(".vlog-panel-body");
    if (chrome.runtime.lastError || !res || !res.ok) {
      body.innerHTML = `<div class="vlog-panel-error">${escapeHtml((res && res.error) || '分析失败')}</div>`;
      return;
    }
    const d = res.data;
    body.innerHTML = `
      <div class="vlog-panel-row"><span class="vlog-label">读音</span><span>${escapeHtml(d.reading)}</span></div>
      <div class="vlog-panel-row"><span class="vlog-label">释义</span><span>${escapeHtml(d.meaning)}</span></div>
      <div class="vlog-panel-row"><span class="vlog-label">词性</span><span>${escapeHtml(d.pos)}</span></div>
      <div class="vlog-panel-footer">
        <button class="vlog-save-btn">★ 收藏</button>
      </div>
    `;
    panel.querySelector(".vlog-save-btn").addEventListener("click", () => {
      saveToVocabulary({ ...d, lang });
    });
  });

  setTimeout(() => {
    document.addEventListener("click", outsideClickHandler);
  }, 0);
}

function outsideClickHandler(e) {
  if (breakdownPanel && !breakdownPanel.contains(e.target)) {
    closeBreakdownPanel();
  }
}

function closeBreakdownPanel() {
  if (breakdownPanel) {
    breakdownPanel.remove();
    breakdownPanel = null;
  }
  document.removeEventListener("click", outsideClickHandler);
}

function saveToVocabulary(entry) {
  chrome.storage.local.get(["vocabulary"], (data) => {
    const vocab = data.vocabulary || [];
    if (vocab.some((v) => v.word === entry.word && v.lang === entry.lang)) {
      const btn =
        breakdownPanel && breakdownPanel.querySelector(".vlog-save-btn");
      if (btn) {
        btn.textContent = "✓ 已收藏";
        btn.disabled = true;
      }
      return;
    }
    vocab.push({ ...entry, savedAt: Date.now() });
    chrome.storage.local.set({ vocabulary: vocab }, () => {
      const btn =
        breakdownPanel && breakdownPanel.querySelector(".vlog-save-btn");
      if (btn) {
        btn.textContent = "✓ 已收藏";
        btn.disabled = true;
      }
    });
  });
}

// ── OCR: frame capture → dataUrl → background → offscreen ─────────────

// region: { x, y, w, h } as 0–1 proportions of video dimensions
function captureVideoFrameDataUrl(video, region) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sx = Math.floor(vw * region.x);
  const sy = Math.floor(vh * region.y);
  const sw = Math.floor(vw * region.w);
  const sh = Math.floor(vh * region.h);
  if (sw <= 0 || sh <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

  try {
    return canvas.toDataURL("image/png");
  } catch (e) {
    // Canvas tainted by cross-origin video — nothing we can do here
    console.warn("[Vlog OCR] Canvas tainted (cross-origin video):", e.message);
    return null;
  }
}

let ocrInterval = null;
let ocrInFlight = false; // prevent overlapping OCR requests
let lastOcrText = "";
let ocrRegion = { x: 0, y: 0.75, w: 1, h: 0.25 }; // default: bottom 25%

function startOcrPolling(video) {
  if (ocrInterval) return;

  ocrInterval = setInterval(() => {
    if (ocrInFlight) return; // serialize polling requests
    const dataUrl = captureVideoFrameDataUrl(video, ocrRegion);
    if (!dataUrl) return;

    ocrInFlight = true;

    // Tesseract lives in offscreen.js — content.js just ferries the frame
    chrome.runtime.sendMessage({ type: "OCR", dataUrl }, (res) => {
      ocrInFlight = false;

      if (chrome.runtime.lastError) {
        if (
          chrome.runtime.lastError.message.includes(
            "Extension context invalidated",
          )
        ) {
          stopOcrPolling(); // extension was reloaded mid-session
        }
        return;
      }
      if (!res || !res.ok || !res.text) return;

      const text = res.text;

      // Skip walls of text — real subtitles are short phrases
      if (text.length > 60) return;

      // Skip garbled output — at least 40% of chars must be Korean/Japanese
      const cjkCount = (text.match(/[\uAC00-\uD7A3\u3040-\u30FF\u4E00-\u9FAF]/g) || []).length;
      if (cjkCount / text.length < 0.4) return;

      const lang = detectLang(text);
      if (!lang || text === lastOcrText) return;
      lastOcrText = text;

      // Same entry point as DOM subtitles — unified floating window
      updateFloatingSubtitle(text, lang);
    });
  }, 2000);
}

function stopOcrPolling() {
  clearInterval(ocrInterval);
  ocrInterval = null;
  ocrInFlight = false;
  lastOcrText = "";
}

// ── OCR region persistence (per hostname) ──────────────────────────────

function ocrRegionKey() {
  return `ocrRegion:${location.hostname}`;
}

function loadOcrRegion() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ocrRegionKey()], (data) => {
      resolve(data[ocrRegionKey()] || null);
    });
  });
}

function saveOcrRegion(region) {
  ocrRegion = region;
  chrome.storage.local.set({ [ocrRegionKey()]: region });
}

// ── OCR region selector UI ─────────────────────────────────────────────

function showRegionSelector(video, onConfirm) {
  const rect = video.getBoundingClientRect();

  const overlay = document.createElement("div");
  overlay.className = "vlog-region-overlay";
  overlay.style.cssText = `
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
  `;

  const hint = document.createElement("div");
  hint.className = "vlog-region-hint";
  hint.textContent = "拖拽选择字幕区域";

  const btnRow = document.createElement("div");
  btnRow.className = "vlog-region-btn-row";

  const defaultBtn = document.createElement("button");
  defaultBtn.className = "vlog-region-btn";
  defaultBtn.textContent = "默认底部 25%";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "vlog-region-btn vlog-region-confirm";
  confirmBtn.textContent = "确认选区";
  confirmBtn.disabled = true;

  btnRow.append(defaultBtn, confirmBtn);

  const selection = document.createElement("div");
  selection.className = "vlog-region-selection";

  overlay.append(hint, btnRow, selection);
  document.body.appendChild(overlay);

  let dragging = false;
  let startX = 0,
    startY = 0;
  let pendingRegion = null;

  overlay.addEventListener("mousedown", (e) => {
    if (e.target !== overlay && e.target !== hint) return;
    dragging = true;
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    selection.style.display = "block";
    e.preventDefault();
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const cx = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const cy = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const x = Math.min(startX, cx);
    const y = Math.min(startY, cy);
    const w = Math.abs(cx - startX);
    const h = Math.abs(cy - startY);
    selection.style.left = x + "px";
    selection.style.top = y + "px";
    selection.style.width = w + "px";
    selection.style.height = h + "px";
    if (w > 20 && h > 10) {
      pendingRegion = {
        x: x / rect.width,
        y: y / rect.height,
        w: w / rect.width,
        h: h / rect.height,
      };
      confirmBtn.disabled = false;
    }
  });

  overlay.addEventListener("mouseup", () => {
    dragging = false;
  });

  defaultBtn.addEventListener("click", () => {
    overlay.remove();
    onConfirm({ x: 0, y: 0.75, w: 1, h: 0.25 });
  });

  confirmBtn.addEventListener("click", () => {
    if (!pendingRegion) return;
    overlay.remove();
    onConfirm(pendingRegion);
  });
}

// ── Main orchestration ─────────────────────────────────────────────────

let currentMode = "dom";

function switchToOcrMode() {
  if (currentMode === "ocr") return;
  currentMode = "ocr";

  const video = document.querySelector("video");
  if (!video) return; // no video on page, skip OCR

  loadOcrRegion().then((saved) => {
    if (saved) {
      ocrRegion = saved;
      startOcrPolling(video);
    } else {
      showRegionSelector(video, (region) => {
        saveOcrRegion(region);
        startOcrPolling(video);
      });
    }
  });
}

function switchToDomMode() {
  if (currentMode === "dom") return;
  currentMode = "dom";
  stopOcrPolling();
  hideFloatingWindow(); // hide until next DOM subtitle fires
}

// ── Enable / disable ───────────────────────────────────────────────────

let enabled = false;

function enable() {
  if (enabled) return;
  enabled = true;
  // Both DOM subtitles and OCR results feed into the same floating window
  startDomDetection((text, lang) => {
    if (currentMode === "ocr") switchToDomMode();
    updateFloatingSubtitle(text, lang);
  });
}

function disable() {
  if (!enabled) return;
  enabled = false;
  subtitleObserver.disconnect();
  clearTimeout(domIdleTimer);
  stopOcrPolling();
  hideFloatingWindow();
  currentMode = "dom";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ENABLE") {
    enable();
    sendResponse({ enabled: true });
  } else if (msg.type === "DISABLE") {
    disable();
    sendResponse({ enabled: false });
  } else if (msg.type === "GET_STATUS") {
    sendResponse({ enabled });
  }
});
