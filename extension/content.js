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
let floatingOcrStatus = null;
let ocrFontColor = "white";
const ocrFontColorKey = "vlog_ocr_font_color";
let ocrDataCollectionEnabled = false;
const ocrDataCollectionKey = "vlog_ocr_data_collection_enabled";
const ocrDatasetKey = "vlog_ocr_dataset_samples";
const ocrDatasetTotalCountKey = "vlog_ocr_dataset_total_count";
const ocrLabelMapKey = "vlog_ocr_label_map_v1";
const ocrNoTextToken = "__NO_TEXT__";
const ocrDatasetMaxSamples = 120;
const ocrLowConfidenceThreshold = 70;
const ocrTimeBucketSeconds = 1;
let ocrLabelMap = {};

chrome.storage.local.get([ocrDataCollectionKey, ocrLabelMapKey], (data) => {
  ocrDataCollectionEnabled = Boolean(data[ocrDataCollectionKey]);
  ocrLabelMap =
    data[ocrLabelMapKey] && typeof data[ocrLabelMapKey] === "object"
      ? data[ocrLabelMapKey]
      : {};
});

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
    <div class="vlog-ocr-status"></div>
    <select class="vlog-ocr-color">
      <option value="white">WHITE</option>
      <option value="black">BLACK</option>
    </select>
  `;
  document.body.appendChild(floatingWindow);

  floatingOriginal = floatingWindow.querySelector(".vlog-float-original");
  floatingTranslated = floatingWindow.querySelector(".vlog-float-translated");
  floatingOcrStatus = floatingWindow.querySelector(".vlog-ocr-status");
  const colorSelect = floatingWindow.querySelector(".vlog-ocr-color");
  chrome.storage.local.get([ocrFontColorKey], (data) => {
    if (data[ocrFontColorKey]) {
      ocrFontColor = data[ocrFontColorKey];
      colorSelect.value = ocrFontColor;
    }
  });
  colorSelect.addEventListener("change", () => {
    ocrFontColor = colorSelect.value;
    chrome.storage.local.set({ [ocrFontColorKey]: ocrFontColor });
  });

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
function updateFloatingSubtitle(text, lang, options = {}) {
  createFloatingWindow();
  floatingWindow.style.display = "flex";

  const source = options.source || "dom";
  const confidence = Number.isFinite(options.confidence)
    ? Number(options.confidence)
    : null;
  if (source === "ocr" && confidence !== null) {
    floatingOcrStatus.textContent = `OCR ${Math.round(confidence)}%`;
    if (confidence < ocrLowConfidenceThreshold) {
      floatingWindow.classList.add("vlog-ocr-low-confidence");
    } else {
      floatingWindow.classList.remove("vlog-ocr-low-confidence");
    }
  } else {
    floatingOcrStatus.textContent = "";
    floatingWindow.classList.remove("vlog-ocr-low-confidence");
  }

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
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (ocrFontColor === "white") {
    ctx.filter = "contrast(1.6) brightness(1.15) saturate(1.05)";
  } else {
    ctx.filter = "contrast(1.6) brightness(0.9) saturate(1.05)";
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.filter = "none";

  try {
    return canvas.toDataURL("image/png");
  } catch (e) {
    // Canvas tainted by cross-origin video — nothing we can do here
    console.warn("[Vlog OCR] Canvas tainted (cross-origin video):", e.message);
    return null;
  }
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data));
  });
}

function storageSet(payload) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function getVideoKey() {
  const host = location.hostname;
  const path = location.pathname || "";
  const url = new URL(location.href);
  if (host.includes("youtube.com")) {
    const v = url.searchParams.get("v");
    if (v) return `yt:${v}`;
  }
  if (host.includes("youtu.be")) {
    const id = path.replace(/^\/+/, "").split("/")[0];
    if (id) return `yt:${id}`;
  }
  if (host.includes("bilibili.com")) {
    const m = path.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (m) return `bili:${m[1]}`;
  }
  return `${host}${path}`;
}

function getTimeBucket(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds / ocrTimeBucketSeconds);
}

function normalizeOcrText(text) {
  return String(text || "").trim();
}

function buildMatchKey(videoKey, timeBucket, rawText) {
  return `${videoKey}|${timeBucket}|${normalizeOcrText(rawText)}`;
}

function findCorrectionInMap(videoKey, timeBucket, rawText) {
  const key = buildMatchKey(videoKey, timeBucket, rawText);
  if (typeof ocrLabelMap[key] === "string" && ocrLabelMap[key]) {
    return ocrLabelMap[key];
  }

  const byVideo = ocrLabelMap[videoKey];
  if (byVideo && typeof byVideo === "object") {
    const byBucket = byVideo[String(timeBucket)];
    if (byBucket && typeof byBucket === "object") {
      const value = byBucket[normalizeOcrText(rawText)];
      if (typeof value === "string" && value) return value;
    }
  }

  return null;
}

function resolveCorrectedText(videoKey, timeBucket, rawText) {
  if (!rawText) return null;
  const buckets = [timeBucket - 1, timeBucket, timeBucket + 1];
  for (const bucket of buckets) {
    if (bucket < 0) continue;
    const corrected = findCorrectionInMap(videoKey, bucket, rawText);
    if (corrected) return corrected;
  }
  return null;
}

function compressOcrSampleDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxWidth = 640;
      const scale = img.width > maxWidth ? maxWidth / img.width : 1;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

let ocrDatasetWriteQueue = Promise.resolve();

function queueOcrSample(sample) {
  if (!ocrDataCollectionEnabled) return;

  const prev = ocrDatasetWriteQueue;
  ocrDatasetWriteQueue = Promise.resolve();
  prev
    .catch(() => {})
    .then(async () => {
      const compressedDataUrl = await compressOcrSampleDataUrl(sample.dataUrl);
      if (!compressedDataUrl) return;

      const data = await storageGet([ocrDatasetKey, ocrDatasetTotalCountKey]);
      const list = Array.isArray(data[ocrDatasetKey]) ? data[ocrDatasetKey] : [];
      const totalCount = Number.isFinite(Number(data[ocrDatasetTotalCountKey]))
        ? Number(data[ocrDatasetTotalCountKey])
        : 0;
      const record = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        capturedAt: sample.capturedAt,
        videoKey: sample.videoKey,
        currentTimeSec: sample.currentTimeSec,
        timeBucket: sample.timeBucket,
        matchKey: sample.matchKey,
        hostname: sample.hostname,
        pageUrl: sample.pageUrl,
        text: sample.text,
        correctedText: sample.correctedText || null,
        lang: sample.lang,
        confidence: sample.confidence,
        accepted: Boolean(sample.accepted),
        dropReason: sample.dropReason || null,
        cjkRatio: sample.cjkRatio,
        fontColor: sample.fontColor,
        region: sample.region,
        frameSize: sample.frameSize,
        imageDataUrl: compressedDataUrl,
      };
      list.unshift(record);
      if (list.length > ocrDatasetMaxSamples) {
        list.length = ocrDatasetMaxSamples;
      }
      await storageSet({
        [ocrDatasetKey]: list,
        [ocrDatasetTotalCountKey]: totalCount + 1,
      });
    });
}

let ocrInterval = null;
let ocrInFlight = false; // prevent overlapping OCR requests
let lastOcrText = "";
let ocrRegion = { x: 0, y: 0.75, w: 1, h: 0.25 }; // default: bottom 25%
const localOcrBridgeUrl = "http://127.0.0.1:3000/ocr";

async function requestOcrFromLocalBridge(dataUrl) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(localOcrBridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timerId);
  }
  if (!response.ok) {
    throw new Error(`Local OCR bridge HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload && payload.error) {
    throw new Error(payload.error);
  }
  const text = normalizeOcrText(payload && (payload.text || payload.texts));
  let confidence = Number.isFinite(payload && payload.confidence)
    ? Number(payload.confidence)
    : null;
  if (confidence !== null) {
    confidence = confidence <= 1 ? confidence * 100 : confidence;
    confidence = Math.max(0, Math.min(100, confidence));
  }
  return { ok: true, text, confidence };
}

function requestOcrFromExtension(dataUrl) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "OCR", dataUrl }, (res) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || "";
        if (message.includes("Extension context invalidated")) {
          stopOcrPolling();
        }
        resolve({ ok: false, error: message });
        return;
      }
      resolve(res || { ok: false });
    });
  });
}

function handleOcrResult(video, dataUrl, res) {
  if (!res || !res.ok) return;

  const text = normalizeOcrText(res.text);
  const confidence = Number.isFinite(res.confidence)
    ? Number(res.confidence)
    : null;
  const currentTimeSec = Number.isFinite(video.currentTime)
    ? Number(video.currentTime.toFixed(3))
    : 0;
  const timeBucket = getTimeBucket(currentTimeSec);
  const videoKey = getVideoKey();
  const matchKey = buildMatchKey(videoKey, timeBucket, text);
  const lang = detectLang(text);
  let cjkRatio = null;
  let dropReason = null;

  if (!text) {
    dropReason = "empty_text";
  } else if (text.length > 60) {
    dropReason = "too_long";
  } else {
    const cjkCount = (text.match(/[\uAC00-\uD7A3\u3040-\u30FF\u4E00-\u9FAF]/g) || []).length;
    cjkRatio = cjkCount / text.length;
    if (cjkRatio < 0.4) {
      dropReason = "low_cjk_ratio";
    } else if (!lang) {
      dropReason = "lang_unknown";
    } else if (text === lastOcrText) {
      dropReason = "duplicate";
    }
  }

  const correctedText = resolveCorrectedText(videoKey, timeBucket, text);

  queueOcrSample({
    capturedAt: Date.now(),
    videoKey,
    currentTimeSec,
    timeBucket,
    matchKey,
    hostname: location.hostname,
    pageUrl: `${location.origin}${location.pathname}`,
    text,
    correctedText,
    lang,
    confidence,
    accepted: dropReason === null,
    dropReason,
    cjkRatio: cjkRatio === null ? null : Number(cjkRatio.toFixed(4)),
    fontColor: ocrFontColor,
    region: { ...ocrRegion },
    frameSize: { width: video.videoWidth, height: video.videoHeight },
    dataUrl,
  });

  if (dropReason) return;
  lastOcrText = text;
  if (correctedText === ocrNoTextToken) return;
  const outputText = correctedText || text;
  const outputLang = detectLang(outputText) || lang;
  updateFloatingSubtitle(outputText, outputLang, { source: "ocr", confidence });
}

function startOcrPolling(video) {
  if (ocrInterval) return;

  ocrInterval = setInterval(() => {
    if (ocrInFlight) return; // serialize polling requests
    const dataUrl = captureVideoFrameDataUrl(video, ocrRegion);
    if (!dataUrl) return;

    ocrInFlight = true;

    (async () => {
      try {
        let res;
        try {
          res = await requestOcrFromLocalBridge(dataUrl);
        } catch (_e) {
          res = await requestOcrFromExtension(dataUrl);
        }
        handleOcrResult(video, dataUrl, res);
      } finally {
        ocrInFlight = false;
      }
    })();
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
    updateFloatingSubtitle(text, lang, { source: "dom" });
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes[ocrFontColorKey]) {
    ocrFontColor = changes[ocrFontColorKey].newValue || "white";
    if (floatingWindow) {
      const colorSelect = floatingWindow.querySelector(".vlog-ocr-color");
      if (colorSelect) colorSelect.value = ocrFontColor;
    }
  }

  if (changes[ocrDataCollectionKey]) {
    ocrDataCollectionEnabled = Boolean(changes[ocrDataCollectionKey].newValue);
  }

  if (changes[ocrLabelMapKey]) {
    const nextMap = changes[ocrLabelMapKey].newValue;
    ocrLabelMap = nextMap && typeof nextMap === "object" ? nextMap : {};
  }
});
