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
    let res;
    try {
      res = await fetch(`${this.config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.ollamaModel,
          messages: [{ role: 'user', content: prompt }],
          stream: false
        }),
        signal
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        throw new Error('Ollama 未运行，请启动 Ollama 或切换后端');
      }
      throw e;
    }
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
