const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const app = express();

// Restrict CORS to the chrome-extension:// scheme only
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'));
    }
  },
}));
app.use(express.json({ limit: '10mb' }));

// Shared secret — content.js must send X-OCR-Secret matching this value.
// Generate once and store in a local config file, or set via env var.
const OCR_SECRET = process.env.OCR_SECRET || '';

if (!OCR_SECRET) {
  console.warn('[WARN] OCR_SECRET env var not set — secret header check disabled. Set OCR_SECRET for production use.');
}

const CLI_PATH = process.env.VISION_OCR_PATH
  || path.join(__dirname, '../tools/macos-vision-ocr/macos-vision-ocr-arm64');
const TEMP_IMG = '/tmp/vlog_ocr_temp.png';

app.post('/ocr', (req, res) => {
  if (OCR_SECRET) {
    const clientSecret = req.headers['x-ocr-secret'] || '';
    if (!crypto.timingSafeEqual(Buffer.from(clientSecret), Buffer.from(OCR_SECRET))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  try {
    const image = String((req.body && req.body.image) || '');
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(TEMP_IMG, base64Data, 'base64');

    let output;
    try {
      output = execSync(
        `"${CLI_PATH}" --img "${TEMP_IMG}" --rec-langs "ja-JP,ko-KR,en-US"`,
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
      ).toString();
    } finally {
      try { fs.unlinkSync(TEMP_IMG); } catch (_e) {}
    }
    const visionResult = JSON.parse(output);

    const observations = Array.isArray(visionResult.observations) ? visionResult.observations : [];
    const fullText = observations.length
      ? observations.map((item) => item.text || '').join('')
      : String(visionResult.texts || '');

    const avgConf = observations.length
      ? observations.reduce((sum, item) => sum + (Number(item.confidence) || 0), 0) / observations.length
      : 0.99;

    res.json({ text: fullText.trim(), confidence: avgConf });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'OCR 失败' });
  }
});

app.listen(3000, () => console.log('Mac Vision OCR Bridge running on port 3000'));
