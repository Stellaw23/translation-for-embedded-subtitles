// extension/content.js

// ── Language detection ────────────────────────────────────────────────
function detectLang(text) {
  if (/[\uAC00-\uD7A3]/.test(text)) return 'ko';
  if (/[\u3040-\u30FF\u4E00-\u9FAF]/.test(text)) return 'ja';
  return null;
}

// ── DOM subtitle selectors ────────────────────────────────────────────
const SUBTITLE_SELECTORS = [
  '.bilibili-player-video-subtitle span',
  '.ytp-caption-segment',
];

function findSubtitleElement() {
  for (const sel of SUBTITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el;
  }
  // Generic fallback: find short elements containing Korean/Japanese
  const candidates = document.querySelectorAll('span, p');
  for (const el of candidates) {
    const text = el.textContent.trim();
    if (text.length > 1 && text.length < 200 && detectLang(text)) return el;
  }
  return null;
}

// ── Throttle ──────────────────────────────────────────────────────────
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

// ── MutationObserver subtitle detector ───────────────────────────────
let lastSubtitleText = '';
let domIdleTimer = null;
let onSubtitleFound = null; // callback(text, lang, element)

const handleMutation = throttle(() => {
  const el = findSubtitleElement();
  if (!el) return;
  const text = el.textContent.trim();
  const lang = detectLang(text);
  if (!lang || text === lastSubtitleText) return;
  lastSubtitleText = text;
  resetDomIdleTimer();
  if (onSubtitleFound) onSubtitleFound(text, lang, el);
}, 1000);

const subtitleObserver = new MutationObserver(handleMutation);

function startDomDetection(callback) {
  onSubtitleFound = callback;
  subtitleObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  resetDomIdleTimer();
}

function resetDomIdleTimer() {
  clearTimeout(domIdleTimer);
  domIdleTimer = setTimeout(switchToOcrMode, 5000);
}

// ── Inline translation UI (DOM subtitle mode) ─────────────────────────
const TRANSLATION_CLASS = 'vlog-inline-translation';

function renderClickableTokens(el, text, lang) {
  const pattern = lang === 'ko'
    ? /([\uAC00-\uD7A3]+)/g
    : /([\u3040-\u30FF\u4E00-\u9FAF]+)/g;
  const parts = text.split(pattern);

  el.innerHTML = '';
  parts.forEach((part) => {
    const span = document.createElement('span');
    span.textContent = part;
    if (detectLang(part)) {
      span.className = 'vlog-token';
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        showBreakdownPanel(part, lang, e.clientX, e.clientY);
      });
    }
    el.appendChild(span);
  });
}

function showInlineTranslation(subtitleEl, text, lang) {
  // Remove old translation if present
  const old = subtitleEl.parentElement &&
    subtitleEl.parentElement.querySelector('.' + TRANSLATION_CLASS);
  if (old) old.remove();

  // Render original text as clickable tokens
  renderClickableTokens(subtitleEl, text, lang);

  // Insert loading placeholder
  const div = document.createElement('div');
  div.className = TRANSLATION_CLASS;
  div.textContent = '翻译中…';
  subtitleEl.insertAdjacentElement('afterend', div);

  chrome.runtime.sendMessage({ type: 'TRANSLATE', text, lang }, (res) => {
    if (!div.isConnected) return;
    if (chrome.runtime.lastError || !res || !res.ok) {
      const errMsg = res && res.error && res.error.includes('Ollama')
        ? 'Ollama 未运行，请检查本地服务'
        : '翻译失败，点击重试';
      div.textContent = errMsg;
      div.classList.add('vlog-error');
      div.addEventListener('click', () => showInlineTranslation(subtitleEl, text, lang), { once: true });
      return;
    }
    div.textContent = res.translation;
    div.classList.remove('vlog-error');
  });
}

// ── Breakdown panel ────────────────────────────────────────────────────
let breakdownPanel = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showBreakdownPanel(word, lang, clientX, clientY) {
  closeBreakdownPanel();

  const panel = document.createElement('div');
  panel.className = 'vlog-breakdown-panel';
  panel.innerHTML = `
    <div class="vlog-panel-header">
      <span class="vlog-panel-word">${escapeHtml(word)}</span>
      <button class="vlog-panel-close" title="关闭">×</button>
    </div>
    <div class="vlog-panel-body">
      <div class="vlog-panel-loading">分析中…</div>
    </div>
  `;

  const panelW = 220, panelH = 130;
  panel.style.cssText = `
    position: fixed;
    left: ${Math.min(clientX, window.innerWidth - panelW - 8)}px;
    top: ${Math.min(clientY + 8, window.innerHeight - panelH - 8)}px;
    z-index: 2147483647;
  `;
  document.body.appendChild(panel);
  breakdownPanel = panel;

  panel.querySelector('.vlog-panel-close').addEventListener('click', closeBreakdownPanel);

  chrome.runtime.sendMessage({ type: 'BREAKDOWN', word, lang }, (res) => {
    if (!panel.isConnected) return;
    const body = panel.querySelector('.vlog-panel-body');
    if (chrome.runtime.lastError || !res || !res.ok) {
      body.innerHTML = `<div class="vlog-panel-error">分析失败</div>`;
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
    panel.querySelector('.vlog-save-btn').addEventListener('click', () => {
      saveToVocabulary({ ...d, lang });
    });
  });

  setTimeout(() => {
    document.addEventListener('click', outsideClickHandler);
  }, 0);
}

function outsideClickHandler(e) {
  if (breakdownPanel && !breakdownPanel.contains(e.target)) {
    closeBreakdownPanel();
  }
}

function closeBreakdownPanel() {
  if (breakdownPanel) { breakdownPanel.remove(); breakdownPanel = null; }
  document.removeEventListener('click', outsideClickHandler);
}

function saveToVocabulary(entry) {
  chrome.storage.local.get(['vocabulary'], (data) => {
    const vocab = data.vocabulary || [];
    if (vocab.some((v) => v.word === entry.word && v.lang === entry.lang)) {
      const btn = breakdownPanel && breakdownPanel.querySelector('.vlog-save-btn');
      if (btn) { btn.textContent = '✓ 已收藏'; btn.disabled = true; }
      return;
    }
    vocab.push({ ...entry, savedAt: Date.now() });
    chrome.storage.local.set({ vocabulary: vocab }, () => {
      const btn = breakdownPanel && breakdownPanel.querySelector('.vlog-save-btn');
      if (btn) { btn.textContent = '✓ 已收藏'; btn.disabled = true; }
    });
  });
}

// ── OCR: frame capture + Tesseract ────────────────────────────────────

// region: { x, y, w, h } as 0–1 proportions of video size
function captureVideoFrame(video, region) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sx = Math.floor(vw * region.x);
  const sy = Math.floor(vh * region.y);
  const sw = Math.floor(vw * region.w);
  const sh = Math.floor(vh * region.h);
  if (sw <= 0 || sh <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

let tesseractWorker = null;

async function initTesseract() {
  if (tesseractWorker) return;
  // Tesseract.js v4: worker and language data loaded from CDN
  tesseractWorker = await Tesseract.createWorker('kor+jpn', 1, {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/worker.min.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4/tesseract-core.wasm.js',
    logger: () => {}
  });
}

async function runOCR(canvas) {
  await initTesseract();
  const { data } = await tesseractWorker.recognize(canvas);
  return data.text.trim().replace(/\s+/g, ' ');
}

let ocrInterval = null;
let lastOcrText = '';
let ocrRegion = { x: 0, y: 0.75, w: 1, h: 0.25 }; // default: bottom 25%

async function startOcrPolling(video) {
  if (ocrInterval) return;
  ocrInterval = setInterval(async () => {
    try {
      const canvas = captureVideoFrame(video, ocrRegion);
      if (!canvas) return;
      const text = await runOCR(canvas);
      const lang = detectLang(text);
      if (!lang || !text || text === lastOcrText) return;
      lastOcrText = text;
      showOcrOverlay(video, text, lang);
    } catch (_) {
      // silent fail (Tesseract initializing, video paused, etc.)
    }
  }, 2000);
}

function stopOcrPolling() {
  clearInterval(ocrInterval);
  ocrInterval = null;
  lastOcrText = '';
}

// ── OCR region selection ───────────────────────────────────────────────

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

function showRegionSelector(video, onConfirm) {
  const rect = video.getBoundingClientRect();

  const overlay = document.createElement('div');
  overlay.className = 'vlog-region-overlay';
  overlay.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;

  const hint = document.createElement('div');
  hint.className = 'vlog-region-hint';
  hint.textContent = '拖拽选择字幕区域';

  const btnRow = document.createElement('div');
  btnRow.className = 'vlog-region-btn-row';

  const defaultBtn = document.createElement('button');
  defaultBtn.className = 'vlog-region-btn';
  defaultBtn.textContent = '默认底部 25%';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'vlog-region-btn vlog-region-confirm';
  confirmBtn.textContent = '确认选区';
  confirmBtn.disabled = true;

  btnRow.append(defaultBtn, confirmBtn);

  const selection = document.createElement('div');
  selection.className = 'vlog-region-selection';

  overlay.append(hint, btnRow, selection);
  document.body.appendChild(overlay);

  let dragging = false, startX = 0, startY = 0;
  let pendingRegion = null;

  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay && e.target !== hint) return;
    dragging = true;
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    selection.style.display = 'block';
    e.preventDefault();
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const cx = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const cy = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const x = Math.min(startX, cx);
    const y = Math.min(startY, cy);
    const w = Math.abs(cx - startX);
    const h = Math.abs(cy - startY);
    selection.style.left = x + 'px';
    selection.style.top = y + 'px';
    selection.style.width = w + 'px';
    selection.style.height = h + 'px';
    if (w > 20 && h > 10) {
      pendingRegion = {
        x: x / rect.width,
        y: y / rect.height,
        w: w / rect.width,
        h: h / rect.height
      };
      confirmBtn.disabled = false;
    }
  });

  overlay.addEventListener('mouseup', () => { dragging = false; });

  defaultBtn.addEventListener('click', () => {
    overlay.remove();
    onConfirm({ x: 0, y: 0.75, w: 1, h: 0.25 });
  });

  confirmBtn.addEventListener('click', () => {
    if (!pendingRegion) return;
    overlay.remove();
    onConfirm(pendingRegion);
  });
}

// ── OCR overlay ────────────────────────────────────────────────────────

let ocrOverlay = null;

function showOcrOverlay(video, text, lang) {
  const rect = video.getBoundingClientRect();

  if (!ocrOverlay) {
    ocrOverlay = document.createElement('div');
    ocrOverlay.className = 'vlog-ocr-overlay';
    document.body.appendChild(ocrOverlay);
  }

  ocrOverlay.style.cssText = `
    left: ${rect.left}px;
    top: ${rect.top + rect.height * 0.88}px;
    width: ${rect.width}px;
  `;

  const originalEl = document.createElement('div');
  originalEl.className = 'vlog-ocr-original';
  renderClickableTokens(originalEl, text, lang);

  const transEl = document.createElement('div');
  transEl.className = 'vlog-ocr-translation';
  transEl.textContent = '翻译中…';

  ocrOverlay.innerHTML = '';
  ocrOverlay.append(originalEl, transEl);

  chrome.runtime.sendMessage({ type: 'TRANSLATE', text, lang }, (res) => {
    if (!ocrOverlay) return;
    transEl.textContent = res && res.ok ? res.translation : '翻译失败';
  });
}

function hideOcrOverlay() {
  if (ocrOverlay) { ocrOverlay.remove(); ocrOverlay = null; }
}

// ── Main orchestration ─────────────────────────────────────────────────

let currentMode = 'dom';

function switchToOcrMode() {
  if (currentMode === 'ocr') return;
  currentMode = 'ocr';

  const video = document.querySelector('video');
  if (!video) return;

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
  if (currentMode === 'dom') return;
  currentMode = 'dom';
  stopOcrPolling();
  hideOcrOverlay();
}

// Entry point
startDomDetection((text, lang, el) => {
  if (currentMode === 'ocr') switchToDomMode();
  showInlineTranslation(el, text, lang);
});
