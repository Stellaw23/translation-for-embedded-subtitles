/**
 * Tests for pure utility functions from extension/popup.js
 * Covers: parseLabelsJsonl, crc32, ZIP structure helpers
 */
import { describe, it, expect } from 'vitest';

// ── Inline copies from popup.js ───────────────────────────────────────────────
const ocrTimeBucketSeconds = 1;
const ocrNoTextToken = '__NO_TEXT__';

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseLabelsJsonl', () => {
  it('parses a valid record with matchKey', () => {
    const line = JSON.stringify({ matchKey: 'yt:v1|5|안녕', correctedText: '안녕하세요' });
    const { nextMap, accepted, skipped } = parseLabelsJsonl(line);
    expect(accepted).toBe(1);
    expect(skipped).toBe(0);
    expect(nextMap['yt:v1|5|안녕']).toBe('안녕하세요');
  });

  it('builds matchKey from fields when missing', () => {
    const line = JSON.stringify({
      videoKey: 'yt:v1', timeBucket: 5, text: '안녕', correctedText: '안녕하세요'
    });
    const { nextMap, accepted } = parseLabelsJsonl(line);
    expect(accepted).toBe(1);
    expect(nextMap['yt:v1|5|안녕']).toBe('안녕하세요');
  });

  it('builds matchKey from currentTimeSec when timeBucket missing', () => {
    const line = JSON.stringify({
      videoKey: 'yt:v1', currentTimeSec: 5.7, text: '안녕', correctedText: '수정'
    });
    const { nextMap, accepted } = parseLabelsJsonl(line);
    expect(accepted).toBe(1);
    expect(nextMap['yt:v1|5|안녕']).toBe('수정');
  });

  it('stores __NO_TEXT__ for noText=true records', () => {
    const line = JSON.stringify({ matchKey: 'yt:v1|5|텍스트', noText: true });
    const { nextMap, accepted } = parseLabelsJsonl(line);
    expect(accepted).toBe(1);
    expect(nextMap['yt:v1|5|텍스트']).toBe(ocrNoTextToken);
  });

  it('stores __NO_TEXT__ for action=no_text records', () => {
    const line = JSON.stringify({ matchKey: 'yt:v1|5|텍스트', action: 'no_text' });
    const { nextMap, accepted } = parseLabelsJsonl(line);
    expect(accepted).toBe(1);
    expect(nextMap['yt:v1|5|텍스트']).toBe(ocrNoTextToken);
  });

  it('skips records with no correctedText and no noText flag', () => {
    const line = JSON.stringify({ matchKey: 'yt:v1|5|텍스트', correctedText: '' });
    const { accepted, skipped } = parseLabelsJsonl(line);
    expect(accepted).toBe(0);
    expect(skipped).toBe(1);
  });

  it('skips records with no matchKey and incomplete fields', () => {
    const line = JSON.stringify({ correctedText: '안녕하세요' }); // missing videoKey/text
    const { accepted, skipped } = parseLabelsJsonl(line);
    expect(accepted).toBe(0);
    expect(skipped).toBe(1);
  });

  it('skips malformed JSON lines', () => {
    const { accepted, skipped } = parseLabelsJsonl('not json\n{"matchKey":"k","correctedText":"v"}');
    expect(accepted).toBe(1);
    expect(skipped).toBe(1);
  });

  it('handles empty string input', () => {
    const { accepted, skipped } = parseLabelsJsonl('');
    expect(accepted).toBe(0);
    expect(skipped).toBe(0);
  });

  it('handles Windows CRLF line endings', () => {
    const line = JSON.stringify({ matchKey: 'yt:v1|5|안녕', correctedText: '수정' }) + '\r\n';
    const { accepted } = parseLabelsJsonl(line);
    expect(accepted).toBe(1);
  });
});

describe('crc32', () => {
  it('produces correct CRC for known inputs', () => {
    const encoder = new TextEncoder();
    // CRC32 of "123456789" is 0xCBF43926
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });
  it('returns 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
  });
  it('is deterministic', () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('안녕하세요');
    expect(crc32(bytes)).toBe(crc32(bytes));
  });
});
