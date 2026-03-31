/**
 * Tests for pure utility functions extracted from extension/content.js
 * These functions have no Chrome API dependencies and are fully testable.
 */
import { describe, it, expect } from 'vitest';

// ── Inline copies of pure functions from content.js ──────────────────────────
// (extension/content.js uses global scope, not ES modules)

const ocrTimeBucketSeconds = 1;
const ocrNoTextToken = '__NO_TEXT__';

function normalizeOcrText(text) {
  return String(text || '').trim();
}

function getTimeBucket(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds / ocrTimeBucketSeconds);
}

function buildMatchKey(videoKey, timeBucket, rawText) {
  return `${videoKey}|${timeBucket}|${normalizeOcrText(rawText)}`;
}

function findCorrectionInMap(ocrLabelMap, videoKey, timeBucket, rawText) {
  const key = buildMatchKey(videoKey, timeBucket, rawText);
  if (typeof ocrLabelMap[key] === 'string' && ocrLabelMap[key]) {
    return ocrLabelMap[key];
  }
  const byVideo = ocrLabelMap[videoKey];
  if (byVideo && typeof byVideo === 'object') {
    const byBucket = byVideo[String(timeBucket)];
    if (byBucket && typeof byBucket === 'object') {
      const value = byBucket[normalizeOcrText(rawText)];
      if (typeof value === 'string' && value) return value;
    }
  }
  return null;
}

function resolveCorrectedText(ocrLabelMap, videoKey, timeBucket, rawText) {
  if (!rawText) return null;
  const buckets = [timeBucket - 1, timeBucket, timeBucket + 1];
  for (const bucket of buckets) {
    if (bucket < 0) continue;
    const corrected = findCorrectionInMap(ocrLabelMap, videoKey, bucket, rawText);
    if (corrected) return corrected;
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('normalizeOcrText', () => {
  it('trims whitespace', () => {
    expect(normalizeOcrText('  hello  ')).toBe('hello');
  });
  it('handles null/undefined', () => {
    expect(normalizeOcrText(null)).toBe('');
    expect(normalizeOcrText(undefined)).toBe('');
  });
  it('coerces non-string input', () => {
    expect(normalizeOcrText(123)).toBe('123');
  });
});

describe('getTimeBucket', () => {
  it('buckets by 1s by default', () => {
    expect(getTimeBucket(0)).toBe(0);
    expect(getTimeBucket(0.5)).toBe(0);
    expect(getTimeBucket(1.0)).toBe(1);
    expect(getTimeBucket(1.999)).toBe(1);
    expect(getTimeBucket(2.0)).toBe(2);
  });
  it('returns 0 for negative time', () => {
    expect(getTimeBucket(-1)).toBe(0);
  });
  it('returns 0 for NaN/Infinity', () => {
    expect(getTimeBucket(NaN)).toBe(0);
    expect(getTimeBucket(Infinity)).toBe(0);
  });
});

describe('buildMatchKey', () => {
  it('builds key from parts', () => {
    expect(buildMatchKey('yt:abc', 10, '안녕하세요')).toBe('yt:abc|10|안녕하세요');
  });
  it('trims text in the key', () => {
    expect(buildMatchKey('yt:abc', 10, '  hello  ')).toBe('yt:abc|10|hello');
  });
});

describe('findCorrectionInMap', () => {
  it('finds flat match key', () => {
    const map = { 'yt:v1|5|안녕': '안녕하세요' };
    expect(findCorrectionInMap(map, 'yt:v1', 5, '안녕')).toBe('안녕하세요');
  });
  it('returns null when not found', () => {
    expect(findCorrectionInMap({}, 'yt:v1', 5, '안녕')).toBeNull();
  });
  it('skips empty string values', () => {
    const map = { 'yt:v1|5|안녕': '' };
    expect(findCorrectionInMap(map, 'yt:v1', 5, '안녕')).toBeNull();
  });
  it('finds nested videoKey/bucket/text format', () => {
    const map = { 'yt:v1': { '5': { '안녕': '안녕하세요' } } };
    expect(findCorrectionInMap(map, 'yt:v1', 5, '안녕')).toBe('안녕하세요');
  });
});

describe('resolveCorrectedText', () => {
  it('finds correction at exact bucket', () => {
    const map = { 'yt:v1|10|텍스트': '수정된텍스트' };
    expect(resolveCorrectedText(map, 'yt:v1', 10, '텍스트')).toBe('수정된텍스트');
  });
  it('finds correction in adjacent bucket (timeBucket+1)', () => {
    const map = { 'yt:v1|11|텍스트': '수정된텍스트' };
    expect(resolveCorrectedText(map, 'yt:v1', 10, '텍스트')).toBe('수정된텍스트');
  });
  it('finds correction in adjacent bucket (timeBucket-1)', () => {
    const map = { 'yt:v1|9|텍스트': '수정된텍스트' };
    expect(resolveCorrectedText(map, 'yt:v1', 10, '텍스트')).toBe('수정된텍스트');
  });
  it('returns null when empty rawText', () => {
    expect(resolveCorrectedText({}, 'yt:v1', 10, '')).toBeNull();
    expect(resolveCorrectedText({}, 'yt:v1', 10, null)).toBeNull();
  });
  it('skips negative buckets (timeBucket=0, no bucket -1 lookup)', () => {
    const map = {};
    expect(resolveCorrectedText(map, 'yt:v1', 0, '텍스트')).toBeNull();
  });
  it('returns __NO_TEXT__ sentinel from map', () => {
    const map = { 'yt:v1|5|텍스트': ocrNoTextToken };
    expect(resolveCorrectedText(map, 'yt:v1', 5, '텍스트')).toBe(ocrNoTextToken);
  });
});
