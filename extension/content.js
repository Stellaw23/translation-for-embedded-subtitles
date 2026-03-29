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
