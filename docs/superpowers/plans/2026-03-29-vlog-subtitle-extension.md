# 韩文/日文 Vlog 字幕翻译 Chrome 扩展 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Chrome 扩展，自动检测并翻译网页上的韩文/日文字幕（含烧录字幕），支持点词拆解和单字本收藏。

**Architecture:** Content Script handles DOM subtitle detection, Canvas frame capture, and renders a Draggable Floating UI; Background Service Worker acts as the message router with concurrency locks; Offscreen Document runs the Tesseract OCR engine safely; Popup handles configs and vocabulary.

**Tech Stack:** Chrome Extension MV3, Vanilla JS（无构建工具）, Tesseract.js v4（CDN worker）, Ollama API, Anthropic Claude API

---

## File Map

| File | Responsibility |
|------|------|
| `extension/manifest.json` | Metadata, permissions (`offscreen` added), content script declarations |
| `extension/background.js` | Service Worker: Message routing, LLM client init, Offscreen concurrency lock |
| `extension/offscreen.html` | Offscreen Document shell |
| `extension/offscreen.js` | Tesseract.js worker initialization and OCR processing (with crash recovery) |
| `extension/llm-client.js` | LLMClient Class: Ollama/Claude backend abstraction + LRU Cache |
| `extension/content.js` | Content script: Subtitle detection, Frame capture, Draggable Floating UI |
| `extension/content.css` | Draggable UI, Word breakdown panel styles |
| `extension/popup.html` | Popup layout |
| `extension/popup.js` | Popup logic: config read/write + vocabulary list |
| `extension/popup.css` | Popup styles |
| `extension/libs/tesseract.min.js` | Tesseract.js v4 local copy |
| `tests/test.html` | Pure JS unit test page |

---

## Task 1: 项目脚手架

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js`
- Create: `extension/offscreen.html`
- Create: `extension/offscreen.js`
- Create: `extension/llm-client.js`
- Create: `extension/content.js`
- Create: `extension/content.css`
- Create: `extension/popup.html`
- Create: `extension/popup.js`
- Create: `extension/popup.css`
- Create: `extension/libs/` (目录)
- Create: `tests/test.html`

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p extension/libs tests
touch extension/background.js extension/offscreen.html extension/offscreen.js \
      extension/llm-client.js extension/content.js extension/content.css \
      extension/popup.js extension/popup.css
```

- [ ] **Step 2: 写 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Vlog 字幕翻译",
  "version": "1.0.0",
  "description": "韩文/日文 Vlog 字幕实时翻译学习助手",
  "permissions": ["storage", "scripting", "activeTab", "offscreen"],
  "host_permissions": [
    "https://www.bilibili.com/*",
    "https://www.youtube.com/*",
    "http://localhost/*",
    "*://*/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup.html"
  },
  "web_accessible_resources": [
    {
      "resources": ["libs/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

- [ ] **Step 3: 写 popup.html 骨架**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="popup.css">
  <title>Vlog 字幕翻译</title>
</head>
<body>
  <div id="config-section">
    <h3>后端配置</h3>
    <div id="backend-toggle">
      <button class="tab active" data-backend="ollama">Ollama（本地）</button>
      <button class="tab" data-backend="claude">Claude API</button>
    </div>
    <div id="ollama-config">
      <label>地址<input id="ollama-url" type="text" value="http://localhost:11434"></label>
      <label>模型<input id="ollama-model" type="text" value="qwen2.5:7b"></label>
    </div>
    <div id="claude-config" hidden>
      <label>API Key<input id="claude-key" type="password" placeholder="sk-ant-..."></label>
    </div>
    <button id="save-config">保存</button>
    <span id="save-status"></span>
  </div>
  <hr>
  <div id="vocab-section">
    <h3>单字本 <span id="vocab-count"></span></h3>
    <div id="vocab-list"></div>
    <button id="export-btn">导出 JSON</button>
    <button id="reset-ocr-btn">重置 OCR 区域</button>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 4: 下载 Tesseract.js v4**

```bash
curl -L https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js \
  -o extension/libs/tesseract.min.js
```

预期：`extension/libs/tesseract.min.js` 文件存在，大小约 200KB+。

- [ ] **Step 5: 在 Chrome 加载扩展确认结构正常**

打开 `chrome://extensions/` → 开启开发者模式 → 加载已解压的扩展 → 选择 `extension/` 目录。

预期：扩展图标出现在工具栏，点击显示空白 popup，无报错。

- [ ] **Step 6: Commit**

```bash
git init
git add extension/ tests/
git commit -m "feat: extension scaffold with manifest, popup shell, and Tesseract"
```

---

## Task 2: LLMClient — Ollama/Claude 抽象层

**Files:**
- Modify: `extension/llm-client.js`
- Modify: `tests/test.html`

- [ ] **Step 1: 写 tests/test.html（先写测试）**

```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Unit Tests</title></head>
<body>
<pre id="output"></pre>
<script src="../extension/llm-client.js"></script>
<script>
const results = [];
function assert(name, condition) {
  results.push(condition ? `✅ ${name}` : `❌ ${name}`);
}

// LRUCache: basic get/set
const cache = new LRUCache(3);
cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
assert('LRUCache: get existing key', cache.get('a') === 1);
assert('LRUCache: has existing key', cache.has('b'));
assert('LRUCache: miss returns undefined', cache.get('z') === undefined);

// LRUCache: eviction — access 'a' to make it recent, then add 'd' to evict 'b'
cache.get('a');
cache.set('d', 4);
assert('LRUCache: evicts LRU (b)', !cache.has('b'));
assert('LRUCache: keeps recently accessed (a)', cache.has('a'));
assert('LRUCache: keeps newest (d)', cache.has('d'));
assert('LRUCache: size stays at max', cache.map.size === 3);

// breakdown JSON parse: strips markdown code fences
const rawWithFences = '```json\n{"word":"테스트","reading":"teseuteu","meaning":"测试","pos":"名词"}\n```';
const stripped = rawWithFences.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
const parsed = JSON.parse(stripped);
assert('Breakdown: strips markdown fences', parsed.word === '테스트');
assert('Breakdown: reading field', parsed.reading === 'teseuteu');
assert('Breakdown: meaning field', parsed.meaning === '测试');
assert('Breakdown: pos field', parsed.pos === '名词');

// breakdown JSON parse: no fences (plain JSON)
const rawPlain = '{"word":"こんにちは","reading":"konnichiwa","meaning":"你好","pos":"感叹词"}';
const parsedPlain = JSON.parse(rawPlain.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
assert('Breakdown: plain JSON (no fences)', parsedPlain.word === 'こんにちは');

document.getElementById('output').textContent = results.join('\n');
</script>
</body>
</html>
```

- [ ] **Step 2: 在浏览器打开 tests/test.html 确认全部失败（LRUCache 未定义）**

用 `open tests/test.html`，预期：控制台报 `LRUCache is not defined`。

- [ ] **Step 3: 写 llm-client.js**

```javascript
// extension/llm-client.js

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, val);
  }
  has(key) { return this.map.has(key); }
}

class LLMClient {
  constructor(config) {
    // config: { backend, ollamaUrl, ollamaModel, claudeApiKey }
    this.config = config;
    this._translateCache = new LRUCache(20);
    this._breakdownCache = new Map();
    this._translateController = null;
    this._breakdownController = null;
  }

  async translate(text, lang) {
    const cacheKey = `${lang}:${text}`;
    if (this._translateCache.has(cacheKey)) {
      return this._translateCache.get(cacheKey);
    }
    if (this._translateController) this._translateController.abort();
    this._translateController = new AbortController();
    const langName = lang === 'ko' ? '韩语' : '日语';
    const prompt = `你是${langName}学习助手。请将以下字幕翻译成中文，只返回译文，不加解释。\n字幕：${text}`;
    const result = await this._chat(prompt, this._translateController.signal);
    this._translateCache.set(cacheKey, result);
    return result;
  }

  async breakdown(word, lang) {
    const cacheKey = `${lang}:${word}`;
    if (this._breakdownCache.has(cacheKey)) {
      return this._breakdownCache.get(cacheKey);
    }
    if (this._breakdownController) this._breakdownController.abort();
    this._breakdownController = new AbortController();
    const langName = lang === 'ko' ? '韩语' : '日语';
    const prompt = `请分析以下${langName}单词，严格以JSON格式返回，不加其他文字：\n{"word":"原词","reading":"读音（韩文用罗马拼音，日文用平假名）","meaning":"中文释义","pos":"词性"}\n单词：${word}`;
    const raw = await this._chat(prompt, this._breakdownController.signal);
    const result = JSON.parse(
      raw.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '')
    );
    this._breakdownCache.set(cacheKey, result);
    return result;
  }

  async _chat(prompt, signal) {
    if (this.config.backend === 'claude') {
      return this._claudeChat(prompt, signal);
    }
    return this._ollamaChat(prompt, signal);
  }

  async _ollamaChat(prompt, signal) {
    const res = await fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      }),
      signal
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message.content.trim();
  }

  async _claudeChat(prompt, signal) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.claudeApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text.trim();
  }
}
```

- [ ] **Step 4: 刷新 tests/test.html 确认全部通过**

预期：所有行显示 ✅。

- [ ] **Step 5: Commit**

```bash
git add extension/llm-client.js tests/test.html
git commit -m "feat: LLMClient with Ollama/Claude backends, LRU cache, unit tests"
```

---

## Task 3: Background Service Worker — 消息路由 + Offscreen 并发锁

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: 先在 tests/test.html 确认 background 消息格式是约定好的**

追加到 `tests/test.html` 的 `<script>` 块末尾：
```javascript
// 消息格式契约（文档即测试）
const translateMsg = { type: 'TRANSLATE', text: '안녕하세요', lang: 'ko' };
const breakdownMsg = { type: 'BREAKDOWN', word: '안녕', lang: 'ko' };
assert('Message format: TRANSLATE has type/text/lang',
  translateMsg.type === 'TRANSLATE' && translateMsg.text && translateMsg.lang);
assert('Message format: BREAKDOWN has type/word/lang',
  breakdownMsg.type === 'BREAKDOWN' && breakdownMsg.word && breakdownMsg.lang);
document.getElementById('output').textContent = results.join('\n');
```

刷新 tests/test.html，确认新增测试通过。

- [ ] **Step 2: 写 background.js（含 Offscreen 并发锁 + OCR 路由）**

```javascript
// extension/background.js
importScripts('llm-client.js');

let client = null;
let offscreenReady = null;           // Promise resolved when offscreen sends READY
let creatingOffscreenPromise = null; // Concurrency guard — prevents double-creation

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

// Reset client whenever popup saves new config
chrome.storage.onChanged.addListener(() => { client = null; });

// Ensure exactly one Offscreen Document exists (concurrency-safe)
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;       // Already alive — nothing to do
  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;     // Another call is already in progress
  }

  creatingOffscreenPromise = (async () => {
    try {
      let readyResolve;
      offscreenReady = new Promise((r) => { readyResolve = r; });
      offscreenReady._resolve = readyResolve;

      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Run Tesseract OCR for burned-in subtitle recognition'
      });

      // Wait for offscreen.js to signal it has booted (5 s hard timeout)
      await Promise.race([
        offscreenReady,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('Offscreen boot timeout')), 5000)
        )
      ]);
    } finally {
      offscreenReady = null;
      creatingOffscreenPromise = null;
    }
  })();

  return creatingOffscreenPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen boot handshake
  if (msg.type === 'OFFSCREEN_READY') {
    if (offscreenReady && offscreenReady._resolve) offscreenReady._resolve();
    return;
  }

  if (msg.type === 'TRANSLATE') {
    getClient()
      .then((c) => c.translate(msg.text, msg.lang))
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'BREAKDOWN') {
    getClient()
      .then((c) => c.breakdown(msg.word, msg.lang))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Relay OCR requests: content.js → background → offscreen
  if (msg.type === 'OCR') {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({
        type: 'OFFSCREEN_OCR_TASK',
        dataUrl: msg.dataUrl
      }))
      .then((result) => sendResponse(result || { ok: false, error: 'No response from offscreen' }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
```

- [ ] **Step 3: 重载扩展，打开 Service Worker DevTools 确认无报错**

`chrome://extensions/` → 找到扩展 → 点击 "Service Worker" → 确认控制台无错误。

- [ ] **Step 4: 在任意页面 DevTools Console 手动测消息**

```javascript
chrome.runtime.sendMessage(
  {type: 'TRANSLATE', text: '안녕하세요', lang: 'ko'},
  (res) => console.log(res)
);
```

预期（Ollama 已运行）：`{ok: true, translation: "你好"}`
预期（Ollama 未运行）：`{ok: false, error: "Ollama 503: ..."}`

- [ ] **Step 5: Commit**

```bash
git add extension/background.js tests/test.html
git commit -m "feat: background SW with LLM routing + Offscreen concurrency lock + OCR relay"
```

---

## Task 4: DOM 字幕检测

**Files:**
- Modify: `extension/content.js`
- Modify: `tests/test.html`

- [ ] **Step 1: 先在 tests/test.html 写语言检测测试**

追加到 `tests/test.html` 的 `<script>` 末尾（在 `document.getElementById` 之前）：
```javascript
// detectLang tests（内联，因为 content.js 无法在测试页直接 importScripts）
function detectLang(text) {
  if (/[\uAC00-\uD7A3]/.test(text)) return 'ko';
  if (/[\u3040-\u30FF\u4E00-\u9FAF]/.test(text)) return 'ja';
  return null;
}
assert('detectLang: 한국어', detectLang('안녕하세요') === 'ko');
assert('detectLang: 日本語', detectLang('こんにちは') === 'ja');
assert('detectLang: English', detectLang('hello world') === null);
assert('detectLang: mixed with Korean', detectLang('hello 안녕') === 'ko');
assert('detectLang: mixed with Japanese', detectLang('hello こんにちは') === 'ja');
assert('detectLang: empty string', detectLang('') === null);
document.getElementById('output').textContent = results.join('\n');
```

刷新 tests/test.html，确认新增测试全部通过。

- [ ] **Step 2: 写 content.js 语言检测 + 字幕选择器**

```javascript
// extension/content.js

// ── 语言检测 ──────────────────────────────────────────────────────────
function detectLang(text) {
  if (/[\uAC00-\uD7A3]/.test(text)) return 'ko';
  if (/[\u3040-\u30FF\u4E00-\u9FAF]/.test(text)) return 'ja';
  return null;
}

// ── DOM 字幕选择器 ────────────────────────────────────────────────────
const SUBTITLE_SELECTORS = [
  '.bilibili-player-video-subtitle span',
  '.ytp-caption-segment',
];

function findSubtitleElement() {
  for (const sel of SUBTITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el;
  }
  // 通用兜底：找包含韩/日文的短文本元素（排除脚本/样式）
  const candidates = document.querySelectorAll('span, p');
  for (const el of candidates) {
    const text = el.textContent.trim();
    if (text.length > 1 && text.length < 200 && detectLang(text)) return el;
  }
  return null;
}

// ── 节流 ─────────────────────────────────────────────────────────────
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}
```

- [ ] **Step 3: 写 MutationObserver 字幕检测器**

```javascript
// 继续 content.js

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
```

- [ ] **Step 4: Commit**

```bash
git add extension/content.js tests/test.html
git commit -m "feat: DOM subtitle detection with MutationObserver, throttle, lang detection"
```

---

## Task 5: 悬浮字幕窗 — Draggable Floating Subtitle Window

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/content.css`

> **设计原则：** 废弃旧的"内联注入"和"OCR 专属浮层"两套割裂 UI。
> 无论来源是 DOM 抓取还是 OCR 识别，字幕文字都统一喂给同一个可拖拽悬浮窗展示。

- [ ] **Step 1: 写可点击 token 分词器（供悬浮窗和拆词面板共用）**

```javascript
// 继续 content.js

function renderClickableTokens(el, text, lang) {
  // Split into language blocks vs plain text
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
```

- [ ] **Step 2: 写可拖拽悬浮窗 + updateFloatingSubtitle**

```javascript
// 继续 content.js

let floatingWindow    = null;
let floatingOriginal  = null;
let floatingTranslated = null;

function createFloatingWindow() {
  if (floatingWindow) return;

  floatingWindow = document.createElement('div');
  floatingWindow.className = 'vlog-floating-window';
  floatingWindow.innerHTML = `
    <div class="vlog-drag-handle">::</div>
    <div class="vlog-float-content">
      <div class="vlog-float-original">等待识别…</div>
      <div class="vlog-float-translated"></div>
    </div>
  `;
  document.body.appendChild(floatingWindow);

  floatingOriginal   = floatingWindow.querySelector('.vlog-float-original');
  floatingTranslated = floatingWindow.querySelector('.vlog-float-translated');

  // ── Drag logic ──────────────────────────────────────────────────────
  const handle = floatingWindow.querySelector('.vlog-drag-handle');
  let dragging = false, sx, sy, ix, iy;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = floatingWindow.getBoundingClientRect();
    ix = r.left;    iy = r.top;
    // Switch from CSS bottom/left anchor to absolute left/top for free dragging
    floatingWindow.style.bottom    = 'auto';
    floatingWindow.style.transform = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    floatingWindow.style.left = `${ix + (e.clientX - sx)}px`;
    floatingWindow.style.top  = `${iy + (e.clientY - sy)}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// Single entry point for BOTH DOM and OCR subtitle results
function updateFloatingSubtitle(text, lang) {
  createFloatingWindow();
  floatingWindow.style.display = 'flex';

  renderClickableTokens(floatingOriginal, text, lang);
  floatingTranslated.textContent = '翻译中…';
  floatingTranslated.classList.remove('vlog-error');

  chrome.runtime.sendMessage({ type: 'TRANSLATE', text, lang }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      floatingTranslated.textContent = '翻译失败，请检查后端';
      floatingTranslated.classList.add('vlog-error');
      return;
    }
    floatingTranslated.textContent = res.translation;
  });
}

function hideFloatingWindow() {
  if (floatingWindow) floatingWindow.style.display = 'none';
}
```

- [ ] **Step 3: 写悬浮窗 CSS，追加到 content.css**

```css
/* extension/content.css */

/* ── Draggable floating subtitle window ─────────────────────────────── */
.vlog-floating-window {
  position: fixed;
  bottom: 10%;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  padding: 8px 16px 8px 32px;
  border-radius: 10px;
  z-index: 2147483647;
  min-width: 320px;
  max-width: 700px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  font-family: system-ui, sans-serif;
  cursor: default;
}

.vlog-drag-handle {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  cursor: grab;
  color: #666;
  font-weight: bold;
  font-size: 14px;
  user-select: none;
  letter-spacing: 1px;
}
.vlog-drag-handle:active { cursor: grabbing; }

.vlog-float-content  { flex: 1; text-align: center; }

.vlog-float-original {
  font-size: 17px;
  font-weight: 500;
  margin-bottom: 4px;
  line-height: 1.4;
}

.vlog-float-translated {
  font-size: 14px;
  color: #b6d7a8;
  line-height: 1.4;
}
.vlog-float-translated.vlog-error { color: #e74c3c; }

/* ── Clickable token (shared: floating window + breakdown panel) ─────── */
.vlog-token {
  cursor: pointer;
  border-radius: 2px;
  padding: 0 1px;
  transition: background 0.15s;
}
.vlog-token:hover { background: rgba(182, 215, 168, 0.45); }
```

- [ ] **Step 4: 重载扩展，验证悬浮窗**

确认：
- 扩展加载后，悬浮窗出现在页面底部中央，显示"等待识别…"
- 拖拽左侧 `::` 手柄可将悬浮窗自由移动到任意位置
- DOM 字幕触发后（Task 9 编排完成后），原文分词与翻译均在悬浮窗内更新
- 点击原文词触发拆词面板（Task 6 完成后验证）

- [ ] **Step 5: Commit**

```bash
git add extension/content.js extension/content.css
git commit -m "feat: draggable floating subtitle window (unified DOM + OCR UI)"
```

---

## Task 6: 拆词面板

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/content.css`

- [ ] **Step 1: 写拆词面板函数**

```javascript
// 继续 content.js

let breakdownPanel = null;

function showBreakdownPanel(word, lang, clientX, clientY) {
  closeBreakdownPanel();

  const panel = document.createElement('div');
  panel.className = 'vlog-breakdown-panel';
  panel.innerHTML = `
    <div class="vlog-panel-header">
      <span class="vlog-panel-word">${word}</span>
      <button class="vlog-panel-close" title="关闭">×</button>
    </div>
    <div class="vlog-panel-body">
      <div class="vlog-panel-loading">分析中…</div>
    </div>
  `;

  // 定位（避免超出视口）
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
      <div class="vlog-panel-row"><span class="vlog-label">读音</span><span>${d.reading}</span></div>
      <div class="vlog-panel-row"><span class="vlog-label">释义</span><span>${d.meaning}</span></div>
      <div class="vlog-panel-row"><span class="vlog-label">词性</span><span>${d.pos}</span></div>
      <div class="vlog-panel-footer">
        <button class="vlog-save-btn">★ 收藏</button>
      </div>
    `;
    panel.querySelector('.vlog-save-btn').addEventListener('click', () => {
      saveToVocabulary({ ...d, lang });
    });
  });

  // 点击面板外部关闭
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
    // 去重
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
```

- [ ] **Step 2: 写拆词面板样式，追加到 content.css**

```css
.vlog-breakdown-panel {
  width: 220px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
}

.vlog-panel-header {
  background: #b6d7a8;
  padding: 6px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.vlog-panel-word {
  font-weight: 600;
  font-size: 15px;
}

.vlog-panel-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  color: #444;
  line-height: 1;
  padding: 0 2px;
}
.vlog-panel-close:hover { color: #000; }

.vlog-panel-body {
  background: #faf8f5;
  padding: 8px 10px;
}

.vlog-panel-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  line-height: 1.5;
}

.vlog-label {
  color: #999;
  min-width: 28px;
  font-size: 11px;
  padding-top: 2px;
}

.vlog-panel-footer {
  margin-top: 8px;
  text-align: right;
}

.vlog-save-btn {
  background: #b6d7a8;
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  cursor: pointer;
  font-size: 12px;
}
.vlog-save-btn:hover { background: #9abf94; }
.vlog-save-btn:disabled { background: #ddd; cursor: default; }

.vlog-panel-loading,
.vlog-panel-error {
  color: #aaa;
  font-size: 12px;
  padding: 4px 0;
}
```

- [ ] **Step 3: 重载扩展，点击字幕中的词测试**

确认：
- 拆词面板在点击位置附近弹出
- 显示读音/释义/词性（约 1-3 秒后加载完）
- ★ 收藏后变为 ✓ 已收藏且按钮禁用
- 点击面板外部关闭

- [ ] **Step 4: Commit**

```bash
git add extension/content.js extension/content.css
git commit -m "feat: breakdown panel with reading/meaning/pos and one-click vocabulary save"
```

---

## Task 7: OCR — Offscreen Document + 帧截取

**Files:**
- Create: `extension/offscreen.html`
- Create: `extension/offscreen.js`
- Modify: `extension/content.js`

> **架构要点：** Tesseract 完全运行在 Offscreen Document 里（无 CSP 限制，不阻塞主线程）。
> `content.js` 只负责把视频帧编码成 JPEG dataUrl，通过 `OCR` 消息发给 `background.js`，
> 再由 background 转发给 `offscreen.js`，识别结果原路返回后喂给统一悬浮窗。

- [ ] **Step 1: 写 offscreen.html（Offscreen Document 外壳）**

```html
<!DOCTYPE html>
<html>
<head>
  <script src="libs/tesseract.min.js"></script>
  <script src="offscreen.js"></script>
</head>
<body></body>
</html>
```

- [ ] **Step 2: 写 offscreen.js（Tesseract Worker + 崩溃恢复）**

```javascript
// extension/offscreen.js
let tesseractWorker = null;
let initPromise = null;

async function initTesseract() {
  if (tesseractWorker) return tesseractWorker;
  if (initPromise) return initPromise;   // Guard against concurrent init calls

  initPromise = (async () => {
    const worker = await Tesseract.createWorker('kor+jpn', 1, {
      workerPath: chrome.runtime.getURL('libs/worker.min.js'),
      langPath:   'https://tessdata.projectnaptha.com/4.0.0',
      corePath:   chrome.runtime.getURL('libs/tesseract-core.wasm.js'),
    });
    tesseractWorker = worker;
    return worker;
  })().finally(() => { initPromise = null; });

  return initPromise;
}

// Signal background.js that this document has booted successfully
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'OFFSCREEN_OCR_TASK') return;

  (async () => {
    try {
      if (!msg.dataUrl) throw new Error('Missing dataUrl');
      const worker = await initTesseract();
      const { data } = await worker.recognize(msg.dataUrl);
      const text = data.text.trim().replace(/\s+/g, ' ');
      sendResponse({ ok: true, text });
    } catch (e) {
      // Kill zombie worker so the next frame gets a clean one (crash recovery)
      if (tesseractWorker) {
        try { await tesseractWorker.terminate(); } catch (_) {}
        tesseractWorker = null;
      }
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep sendResponse channel alive for async response
});
```

- [ ] **Step 3: 更新 content.js — 帧截取为 dataUrl，发消息给 Background**

```javascript
// 继续 content.js

// region: { x, y, w, h } — all values 0–1 relative to video dimensions
function captureVideoFrameDataUrl(video, region) {
  const vw = video.videoWidth,  vh = video.videoHeight;
  const sx = Math.floor(vw * region.x), sy = Math.floor(vh * region.y);
  const sw = Math.floor(vw * region.w), sh = Math.floor(vh * region.h);
  if (sw <= 0 || sh <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/jpeg', 0.85);
}

let ocrInterval = null;
let lastOcrText  = '';
let ocrRegion    = { x: 0, y: 0.75, w: 1, h: 0.25 }; // default: bottom 25%

function startOcrPolling(video) {
  if (ocrInterval) return;
  ocrInterval = setInterval(() => {
    const dataUrl = captureVideoFrameDataUrl(video, ocrRegion);
    if (!dataUrl) return;

    // Send frame to background → offscreen (Tesseract lives there, not here)
    chrome.runtime.sendMessage({ type: 'OCR', dataUrl }, (res) => {
      if (!res || !res.ok || !res.text) return;
      const text = res.text;
      const lang = detectLang(text);
      if (!lang || text === lastOcrText) return;
      lastOcrText = text;
      updateFloatingSubtitle(text, lang);  // ← unified floating window (Task 5)
    });
  }, 2000);
}

function stopOcrPolling() {
  clearInterval(ocrInterval);
  ocrInterval = null;
  lastOcrText = '';
}
```

- [ ] **Step 4: Commit**

```bash
git add extension/offscreen.html extension/offscreen.js extension/content.js
git commit -m "feat: Tesseract OCR moved to Offscreen Document; content.js sends OCR message via background"
```

---

## Task 8: OCR 区域选择 UI

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/content.css`

- [ ] **Step 1: 写区域持久化（per 域名）**

```javascript
// 继续 content.js

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
```

- [ ] **Step 2: 写区域选择 UI**

```javascript
// 继续 content.js

function showRegionSelector(video, onConfirm) {
  const rect = video.getBoundingClientRect();

  const overlay = document.createElement('div');
  overlay.className = 'vlog-region-overlay';
  overlay.style.cssText = `
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
  `;

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
```

- [ ] **Step 3: 写区域选择样式，追加到 content.css**

```css
.vlog-region-overlay {
  position: fixed;
  background: rgba(0, 0, 0, 0.45);
  cursor: crosshair;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 16px;
  gap: 8px;
}

.vlog-region-hint {
  color: #fff;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  pointer-events: none;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}

.vlog-region-btn-row {
  display: flex;
  gap: 8px;
  z-index: 1;
}

.vlog-region-btn {
  background: rgba(250, 248, 245, 0.92);
  border: none;
  border-radius: 4px;
  padding: 5px 14px;
  cursor: pointer;
  font-size: 13px;
  font-family: system-ui, sans-serif;
}
.vlog-region-btn:hover { background: rgba(255, 255, 255, 0.98); }

.vlog-region-confirm {
  background: #b6d7a8;
}
.vlog-region-confirm:hover { background: #9abf94; }
.vlog-region-confirm:disabled { opacity: 0.5; cursor: default; }

.vlog-region-selection {
  position: absolute;
  border: 2px solid #b6d7a8;
  background: rgba(182, 215, 168, 0.18);
  display: none;
  pointer-events: none;
}
```

- [ ] **Step 4: Commit**

```bash
git add extension/content.js extension/content.css
git commit -m "feat: OCR region selector UI with drag-to-select and per-domain persistence"
```

---

## Task 9: 内容脚本编排 — 统一悬浮窗模式切换

**Files:**
- Modify: `extension/content.js`

> **设计原则：** 不再有独立的 OCR 浮层或内联注入。两种模式（DOM / OCR）都通过同一个
> `updateFloatingSubtitle(text, lang)` 函数更新 Task 5 创建的可拖拽悬浮窗。
> 模式切换时只需停止/启动各自的检测器，并隐藏/显示悬浮窗。

- [ ] **Step 1: 写主编排逻辑（content.js 入口，放在文件尾部）**

```javascript
// content.js 尾部 — 主流程

let currentMode = 'dom';

function switchToOcrMode() {
  if (currentMode === 'ocr') return;
  currentMode = 'ocr';

  const video = document.querySelector('video');
  if (!video) return; // 页面无视频元素，不启动 OCR

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
  hideFloatingWindow(); // hide until DOM subtitle fires again
}

// ── 启动：DOM 字幕检测 ─────────────────────────────────────────────────
// When a DOM subtitle is found: stop OCR mode, feed text to unified floating window
startDomDetection((text, lang) => {
  if (currentMode === 'ocr') switchToDomMode();
  updateFloatingSubtitle(text, lang);
});
```

- [ ] **Step 2: Commit**

```bash
git add extension/content.js
git commit -m "feat: content script orchestration with unified floating window for DOM + OCR modes"
```

- [ ] **Step 3: 端到端手动测试**

**测试 A（DOM 字幕 — Bilibili/YouTube）：**
1. 打开含韩/日字幕视频
2. 悬浮窗出现，原文分词 + 中文翻译在窗内更新 ✓
3. 拖拽悬浮窗到合适位置 ✓
4. 点击原文词 → 拆词面板弹出 ✓
5. ★ 收藏 → Popup 单字本出现该词 ✓

**测试 B（OCR 模式 — 烧录字幕视频）：**
1. 打开含 `<video>` 但无 DOM 字幕的页面，等待 5 秒
2. 区域选择 UI 出现 → 拖拽选择字幕区域 → 点确认 ✓
3. 悬浮窗开始显示 OCR 识别文字 + 翻译（同一个窗口）✓

**测试 C（模式自动切换）：**
1. 进入 OCR 模式后，切换到有 DOM 字幕的视频
2. DOM 字幕触发 → OCR 轮询自动停止，悬浮窗内容切换为 DOM 字幕 ✓

---

## Task 10: Popup — 后端配置

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/popup.css`

- [ ] **Step 1: 写 popup.js 配置逻辑**

```javascript
// extension/popup.js

document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.tab');
  const ollamaSection = document.getElementById('ollama-config');
  const claudeSection = document.getElementById('claude-config');
  const ollamaUrlInput = document.getElementById('ollama-url');
  const ollamaModelInput = document.getElementById('ollama-model');
  const claudeKeyInput = document.getElementById('claude-key');
  const saveBtn = document.getElementById('save-config');
  const saveStatus = document.getElementById('save-status');

  let currentBackend = 'ollama';

  function applyBackendUI(backend) {
    currentBackend = backend;
    ollamaSection.hidden = backend !== 'ollama';
    claudeSection.hidden = backend !== 'claude';
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.backend === backend));
  }

  // 加载已保存配置
  chrome.storage.local.get(
    ['backend', 'ollamaUrl', 'ollamaModel', 'claudeApiKey'],
    (cfg) => {
      ollamaUrlInput.value = cfg.ollamaUrl || 'http://localhost:11434';
      ollamaModelInput.value = cfg.ollamaModel || 'qwen2.5:7b';
      claudeKeyInput.value = cfg.claudeApiKey || '';
      applyBackendUI(cfg.backend || 'ollama');
    }
  );

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => applyBackendUI(tab.dataset.backend));
  });

  saveBtn.addEventListener('click', () => {
    chrome.storage.local.set(
      {
        backend: currentBackend,
        ollamaUrl: ollamaUrlInput.value.trim(),
        ollamaModel: ollamaModelInput.value.trim(),
        claudeApiKey: claudeKeyInput.value.trim()
      },
      () => {
        saveStatus.textContent = '已保存 ✓';
        setTimeout(() => { saveStatus.textContent = ''; }, 1500);
      }
    );
  });
```

注意：此处不关闭 DOMContentLoaded 回调，下一个 Task 继续追加单字本逻辑。

- [ ] **Step 2: 写 popup.css**

```css
/* extension/popup.css */
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  width: 300px;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  color: #333;
  padding: 12px;
  background: #faf8f5;
}

h3 {
  font-size: 14px;
  margin-bottom: 8px;
  color: #444;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

#backend-toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}

.tab {
  flex: 1;
  padding: 5px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
}
.tab.active { background: #b6d7a8; border-color: #9abf94; font-weight: 600; }

label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 7px;
  font-size: 12px;
  color: #666;
}

input[type="text"],
input[type="password"] {
  padding: 4px 7px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
  width: 100%;
  background: #fff;
}
input:focus { outline: none; border-color: #b6d7a8; }

button {
  padding: 5px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  background: #b6d7a8;
}
button:hover { background: #9abf94; }

#save-config { margin-top: 4px; }
#save-status { margin-left: 8px; color: #4a7c59; font-size: 12px; }

hr { margin: 12px 0; border: none; border-top: 1px solid #e0ddd8; }

#vocab-count { font-weight: normal; color: #999; font-size: 12px; }

#vocab-list {
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 8px;
}

.vocab-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid #f0ede8;
  font-size: 12px;
}
.vocab-word { font-weight: 600; min-width: 50px; }
.vocab-meta { flex: 1; color: #888; margin: 0 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.vocab-delete { background: none; color: #c0392b; padding: 0 4px; font-size: 15px; line-height: 1; }
.vocab-delete:hover { background: none; color: #a93226; }

.vocab-empty { color: #bbb; font-size: 12px; padding: 4px 0; }

#export-btn,
#reset-ocr-btn {
  font-size: 12px;
  margin-right: 6px;
  background: #e8e4de;
}
#export-btn:hover,
#reset-ocr-btn:hover { background: #d5d0c9; }
```

- [ ] **Step 3: 在 Chrome 点击扩展图标验证**

确认：
- 两个 tab 切换正常，对应 config 区域显示/隐藏
- 保存后重新打开 Popup，数据已保留
- 切换后端并保存后，Background 的 `client = null` 被触发（下次翻译会重建）

- [ ] **Step 4: Commit**

```bash
git add extension/popup.js extension/popup.css
git commit -m "feat: popup config UI for Ollama/Claude backend selection with persistence"
```

---

## Task 11: Popup — 单字本 + 导出 + OCR 区域重置

**Files:**
- Modify: `extension/popup.js`

- [ ] **Step 1: 在 popup.js DOMContentLoaded 回调中追加单字本逻辑**

（接续 Task 10 的 popup.js，在 saveBtn 事件之后、关闭括号 `}` 之前追加）：

```javascript
  // ── 单字本 ──────────────────────────────────────────────────────────
  const vocabList = document.getElementById('vocab-list');
  const vocabCount = document.getElementById('vocab-count');
  const exportBtn = document.getElementById('export-btn');
  const resetOcrBtn = document.getElementById('reset-ocr-btn');

  function renderVocab() {
    chrome.storage.local.get(['vocabulary'], (data) => {
      const vocab = (data.vocabulary || []).sort((a, b) => b.savedAt - a.savedAt);
      vocabCount.textContent = `(${vocab.length})`;
      vocabList.innerHTML = '';
      if (vocab.length === 0) {
        vocabList.innerHTML = '<div class="vocab-empty">还没有收藏的词</div>';
        return;
      }
      vocab.forEach((entry, i) => {
        const item = document.createElement('div');
        item.className = 'vocab-item';
        item.innerHTML = `
          <span class="vocab-word">${entry.word}</span>
          <span class="vocab-meta">${entry.reading} · ${entry.meaning}</span>
          <button class="vocab-delete" data-index="${i}" title="删除">×</button>
        `;
        vocabList.appendChild(item);
      });
      vocabList.querySelectorAll('.vocab-delete').forEach((btn) => {
        btn.addEventListener('click', () => {
          vocab.splice(parseInt(btn.dataset.index), 1);
          chrome.storage.local.set({ vocabulary: vocab }, renderVocab);
        });
      });
    });
  }

  renderVocab();
  // 打开 Popup 时如果有新收藏，实时刷新
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.vocabulary) renderVocab();
  });

  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['vocabulary'], (data) => {
      const json = JSON.stringify(data.vocabulary || [], null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vocabulary.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  resetOcrBtn.addEventListener('click', () => {
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith('ocrRegion:'));
      chrome.storage.local.remove(keys, () => {
        resetOcrBtn.textContent = '已重置 ✓';
        setTimeout(() => { resetOcrBtn.textContent = '重置 OCR 区域'; }, 1500);
      });
    });
  });
}); // 关闭 DOMContentLoaded
```

- [ ] **Step 2: 完整端到端测试**

| 测试项 | 预期结果 |
|--------|---------|
| Bilibili 有韩/日 DOM 字幕视频 | 字幕下方出现中文翻译 |
| 点击原文词 | 拆词面板弹出，含读音/释义/词性 |
| 点击 ★ 收藏 | 按钮变为 ✓，Popup 单字本出现该词 |
| Popup 点击 × 删除词 | 列表更新，计数减少 |
| 点击"导出 JSON" | 下载 vocabulary.json，内容正确 |
| Popup 切换 Claude API 并保存 | 下次翻译改用 Claude（需填写 API Key）|
| OCR 模式触发（等 5 秒） | 区域选择 UI 出现（需页面有 `<video>`）|
| 选择区域后 | OCR 浮层在视频底部显示识别文字 + 翻译 |
| Popup 点击"重置 OCR 区域" | 下次进入 OCR 模式重新弹出区域选择 |

- [ ] **Step 3: 最终 commit**

```bash
git add extension/popup.js
git commit -m "feat: vocabulary list with delete, JSON export, OCR region reset"
```

---

## Self-Review

**Spec coverage check:**

| 设计文档需求 | 对应 Task |
|-------------|-----------|
| Content Script + Background 架构 | Task 1, 3 |
| LLMClient Ollama/Claude 抽象 | Task 2 |
| DOM 字幕 MutationObserver | Task 4 |
| Draggable Floating UI（DOM + OCR 统一悬浮窗）| Task 5, 9 |
| 点词拆解面板 | Task 6 |
| Tesseract OCR 截帧 | Task 7 |
| OCR 区域选择 + per-domain 存储 | Task 8 |
| 内容脚本编排 + DOM↔OCR 模式切换 | Task 9 |
| Popup 后端配置 | Task 10 |
| 单字本列表 + 导出 + OCR 区域重置 | Task 11 |
| 配色 #b6d7a8 / #faf8f5 | Task 6, 8, 10 |
| 节流 1 秒 + 缓存 20 条 | Task 2, 4 |
| 错误处理（Ollama 未运行/Claude 无 Key）| Task 5 |
| 5 秒无 DOM 字幕切换 OCR | Task 9 |

所有需求均有对应任务。✓
