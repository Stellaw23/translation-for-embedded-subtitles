// extension/popup.js

document.addEventListener('DOMContentLoaded', () => {
  // ── Enable / disable ────────────────────────────────────────────────
  const enableToggle = document.getElementById('enable-toggle');

  function queryCurrentTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) cb(tabs[0].id);
    });
  }

  // Get current status
  queryCurrentTab((tabId) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError) return; // content script not injected
      enableToggle.checked = res && res.enabled;
    });
  });

  enableToggle.addEventListener('change', () => {
    const type = enableToggle.checked ? 'ENABLE' : 'DISABLE';
    queryCurrentTab((tabId) => {
      chrome.tabs.sendMessage(tabId, { type }, (res) => {
        if (chrome.runtime.lastError) { enableToggle.checked = false; }
      });
    });
  });

  // ── Backend config ─────────────────────────────────────────────────
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

  // Load saved config
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

  // ── Vocabulary list ─────────────────────────────────────────────────
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
        // Use textContent to avoid XSS
        const wordSpan = document.createElement('span');
        wordSpan.className = 'vocab-word';
        wordSpan.textContent = entry.word;
        const metaSpan = document.createElement('span');
        metaSpan.className = 'vocab-meta';
        metaSpan.textContent = `${entry.reading} · ${entry.meaning}`;
        const delBtn = document.createElement('button');
        delBtn.className = 'vocab-delete';
        delBtn.textContent = '×';
        delBtn.title = '删除';
        delBtn.dataset.index = i;
        item.append(wordSpan, metaSpan, delBtn);
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
}); // end DOMContentLoaded
