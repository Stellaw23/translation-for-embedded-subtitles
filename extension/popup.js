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
  const ocrDataToggle = document.getElementById('ocr-data-toggle');
  const ocrDataCount = document.getElementById('ocr-data-count');
  const ocrDataHint = document.getElementById('ocr-data-hint');
  const exportOcrJsonlBtn = document.getElementById('export-ocr-jsonl-btn');
  const exportOcrZipBtn = document.getElementById('export-ocr-zip-btn');
  const importOcrLabelsBtn = document.getElementById('import-ocr-labels-btn');
  const importOcrLabelsFile = document.getElementById('import-ocr-labels-file');
  const ocrLabelStatus = document.getElementById('ocr-label-status');
  const ocrDataCollectionKey = 'vlog_ocr_data_collection_enabled';
  const ocrDatasetKey = 'vlog_ocr_dataset_samples';
  const ocrDatasetTotalCountKey = 'vlog_ocr_dataset_total_count';
  const ocrLabelMapKey = 'vlog_ocr_label_map_v1';
  const ocrNoTextToken = '__NO_TEXT__';
  const ocrTimeBucketSeconds = 1;

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

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function dataUrlToUint8Array(dataUrl) {
    const idx = dataUrl.indexOf(',');
    if (idx < 0) return null;
    const base64 = dataUrl.slice(idx + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  }

  const crcTable = buildCrcTable();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function toDosDateTime(ts) {
    const d = new Date(ts || Date.now());
    const year = Math.max(1980, d.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    return { dosDate, dosTime };
  }

  function createZipBlob(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = encoder.encode(entry.name);
      const dataBytes = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
      const crc = crc32(dataBytes);
      const { dosDate, dosTime } = toDosDateTime(entry.timestamp);
      const utf8Flag = 0x0800;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, utf8Flag, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dosTime, true);
      localView.setUint16(12, dosDate, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, dataBytes.length, true);
      localView.setUint32(22, dataBytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, utf8Flag, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, dosTime, true);
      centralView.setUint16(14, dosDate, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, dataBytes.length, true);
      centralView.setUint32(24, dataBytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
  }

  function getFileExtFromDataUrl(dataUrl) {
    if (dataUrl.startsWith('data:image/png')) return 'png';
    if (dataUrl.startsWith('data:image/webp')) return 'webp';
    return 'jpg';
  }

  function getOcrDataset(cb) {
    chrome.storage.local.get([ocrDatasetKey], (data) => {
      cb(Array.isArray(data[ocrDatasetKey]) ? data[ocrDatasetKey] : []);
    });
  }

  function getLabelMapCount(cb) {
    chrome.storage.local.get([ocrLabelMapKey], (data) => {
      const map = data[ocrLabelMapKey];
      const count = map && typeof map === 'object' ? Object.keys(map).length : 0;
      cb(count);
    });
  }

  function renderOcrLabelStatus() {
    getLabelMapCount((count) => {
      ocrLabelStatus.textContent = `纠错库 ${count} 条`;
    });
  }

  function buildMatchKey(videoKey, timeBucket, text) {
    return `${String(videoKey).trim()}|${Number(timeBucket)}|${String(text || '').trim()}`;
  }

  function parseLabelsJsonl(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const nextMap = {};
    let accepted = 0;
    let skipped = 0;

    lines.forEach((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch (_e) {
        skipped += 1;
        return;
      }
      if (!record || typeof record !== 'object') {
        skipped += 1;
        return;
      }

      const noText = record.noText === true || record.action === 'no_text';
      const correctedText = String(
        record.correctedText ?? record.correct ?? record.targetText ?? ''
      ).trim();
      if (!noText && !correctedText) {
        skipped += 1;
        return;
      }

      let matchKey = String(record.matchKey || '').trim();
      if (!matchKey) {
        const rawText = String(record.text ?? record.rawText ?? record.ocrText ?? '').trim();
        const videoKey = String(record.videoKey || '').trim();
        let timeBucket = Number(record.timeBucket);
        if (!Number.isFinite(timeBucket)) {
          const timeSec = Number(record.currentTimeSec ?? record.currentTime ?? record.timestampSec);
          if (Number.isFinite(timeSec) && timeSec >= 0) {
            timeBucket = Math.floor(timeSec / ocrTimeBucketSeconds);
          }
        }
        if (videoKey && Number.isFinite(timeBucket) && rawText) {
          matchKey = buildMatchKey(videoKey, timeBucket, rawText);
        }
      }

      if (!matchKey) {
        skipped += 1;
        return;
      }

      nextMap[matchKey] = noText ? ocrNoTextToken : correctedText;
      accepted += 1;
    });

    return { nextMap, accepted, skipped };
  }

  function mergeLabelMap(nextMap, cb) {
    chrome.storage.local.get([ocrLabelMapKey], (data) => {
      const existing = data[ocrLabelMapKey] && typeof data[ocrLabelMapKey] === 'object'
        ? data[ocrLabelMapKey]
        : {};
      const merged = Object.assign({}, existing, nextMap);
      chrome.storage.local.set({ [ocrLabelMapKey]: merged }, () => {
        cb(Object.keys(existing).length, Object.keys(merged).length);
      });
    });
  }

  function renderOcrDataStatus() {
    chrome.storage.local.get([ocrDataCollectionKey, ocrDatasetKey, ocrDatasetTotalCountKey], (data) => {
      const enabled = Boolean(data[ocrDataCollectionKey]);
      const samples = Array.isArray(data[ocrDatasetKey]) ? data[ocrDatasetKey] : [];
      const total = Number.isFinite(Number(data[ocrDatasetTotalCountKey]))
        ? Number(data[ocrDatasetTotalCountKey])
        : samples.length;
      ocrDataToggle.checked = enabled;
      ocrDataCount.textContent = `(${samples.length}/${total})`;
      exportOcrJsonlBtn.disabled = samples.length === 0;
      exportOcrZipBtn.disabled = samples.length === 0;
      if (samples.length > 0) {
        ocrDataHint.textContent = `缓存上限 120（循环覆盖），累计已采集 ${total} 条`;
      } else if (enabled) {
        ocrDataHint.textContent = '当前 0 条：播放视频进入 OCR 后会自动累计';
      } else {
        ocrDataHint.textContent = '先打开采集样本，再播放视频积累数据';
      }
    });
  }

  renderVocab();
  renderOcrDataStatus();
  renderOcrLabelStatus();
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.vocabulary) renderVocab();
    if (changes[ocrDataCollectionKey] || changes[ocrDatasetKey]) renderOcrDataStatus();
    if (changes[ocrLabelMapKey]) renderOcrLabelStatus();
  });

  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['vocabulary'], (data) => {
      const json = JSON.stringify(data.vocabulary || [], null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      downloadBlob(blob, 'vocabulary.json');
    });
  });

  ocrDataToggle.addEventListener('change', () => {
    chrome.storage.local.set({ [ocrDataCollectionKey]: ocrDataToggle.checked });
  });

  exportOcrJsonlBtn.addEventListener('click', () => {
    getOcrDataset((samples) => {
      if (samples.length === 0) return;
      const lines = samples.map((sample) => JSON.stringify(sample));
      const blob = new Blob([`${lines.join('\n')}\n`], { type: 'application/x-ndjson' });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(blob, `ocr-samples-${stamp}.jsonl`);
    });
  });

  exportOcrZipBtn.addEventListener('click', () => {
    getOcrDataset((samples) => {
      if (samples.length === 0) return;
      const entries = [];
      const jsonlLines = [];
      samples.forEach((sample) => {
        const imageDataUrl = sample.imageDataUrl || '';
        const ext = getFileExtFromDataUrl(imageDataUrl);
        const safeId = String(sample.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
        const imagePath = `images/${safeId}.${ext}`;
        const imageBytes = dataUrlToUint8Array(imageDataUrl);
        if (imageBytes) {
          entries.push({
            name: imagePath,
            data: imageBytes,
            timestamp: sample.capturedAt
          });
        }
        const { imageDataUrl: _discard, ...meta } = sample;
        jsonlLines.push(JSON.stringify({ ...meta, imagePath }));
      });
      entries.push({
        name: 'metadata.jsonl',
        data: `${jsonlLines.join('\n')}\n`,
        timestamp: Date.now()
      });
      const zipBlob = createZipBlob(entries);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(zipBlob, `ocr-samples-${stamp}.zip`);
    });
  });

  importOcrLabelsBtn.addEventListener('click', () => {
    importOcrLabelsFile.value = '';
    importOcrLabelsFile.click();
  });

  importOcrLabelsFile.addEventListener('change', () => {
    const file = importOcrLabelsFile.files && importOcrLabelsFile.files[0];
    if (!file) return;

    importOcrLabelsBtn.disabled = true;
    ocrLabelStatus.textContent = '正在导入...';

    const reader = new FileReader();
    reader.onload = () => {
      const { nextMap, accepted, skipped } = parseLabelsJsonl(reader.result);
      if (accepted === 0) {
        importOcrLabelsBtn.disabled = false;
        ocrLabelStatus.textContent = `导入失败：有效记录 0 条，跳过 ${skipped} 条`;
        return;
      }
      mergeLabelMap(nextMap, (_beforeCount, afterCount) => {
        importOcrLabelsBtn.disabled = false;
        ocrLabelStatus.textContent = `导入成功：新增/更新 ${accepted} 条，跳过 ${skipped} 条，纠错库总计 ${afterCount} 条`;
      });
    };
    reader.onerror = () => {
      importOcrLabelsBtn.disabled = false;
      ocrLabelStatus.textContent = '导入失败：文件读取错误';
    };
    reader.readAsText(file, 'utf-8');
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
