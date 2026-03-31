const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const CLI_PATH = '/Users/wujunxing/Desktop/projects/translation/tools/macos-vision-ocr/macos-vision-ocr-arm64';
const TEMP_IMG = '/tmp/vlog_ocr_temp.png';

app.post('/ocr', (req, res) => {
  try {
    const image = String((req.body && req.body.image) || '');
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(TEMP_IMG, base64Data, 'base64');

    const output = execSync(
      `"${CLI_PATH}" --img "${TEMP_IMG}" --rec-langs "ja-JP,ko-KR,en-US"`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const visionResult = JSON.parse(output);

    const fullText = Array.isArray(visionResult.observations)
      ? visionResult.observations.map((item) => item.text || '').join('')
      : String(visionResult.texts || '');

    res.json({ text: fullText.trim(), confidence: 0.99 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'OCR 失败' });
  }
});

app.listen(3000, () => console.log('🚀 Mac Vision OCR Bridge running on port 3000'));
