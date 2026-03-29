# 韩文/日文 Vlog 学习 Chrome 扩展 — 设计文档

**日期：** 2026-03-29
**状态：** 已批准，待实现

---

## 1. 问题与目标

Language Reactor 等工具依赖独立字幕轨道（.srt / .ass），无法处理烧录进视频帧的内嵌字幕。本扩展的核心价值是**无论字幕以何种形式出现都能翻译**，主要服务于看韩/日 Vlog 学语言的中文用户。

**成功标准：**
- 在 Bilibili、YouTube 上自动检测到字幕并显示中文翻译
- 烧录字幕通过 OCR 识别后同样可翻译
- 点击原文中的词可获取读音、词性、中文释义
- 全程不需要手动操作，看视频即可学习

---

## 2. 整体架构

```
┌─────────────────────────────────────────────┐
│              Chrome Extension MV3            │
│                                              │
│  ┌──────────────────┐   ┌─────────────────┐  │
│  │  Content Script  │   │    Background   │  │
│  │                  │   │  Service Worker │  │
│  │ • MutationObserver◄──►• LLMClient      │  │
│  │ • Canvas 截帧    │   │  (Ollama/Claude)│  │
│  │ • 内联翻译注入   │   │• Tesseract OCR  │  │
│  │ • 拆词面板 UI    │   │• chrome.storage │  │
│  └──────────────────┘   └─────────────────┘  │
│                                              │
│  ┌──────────────────┐                        │
│  │  Popup           │                        │
│  │ • 后端配置       │                        │
│  │ • 单字本列表     │                        │
│  │ • 导出 JSON      │                        │
│  └──────────────────┘                        │
└─────────────────────────────────────────────┘
```

### 文件结构

```
extension/
├── manifest.json
├── background.js          # Service Worker：OCR + LLM 调用
├── content.js             # 注入页面：字幕检测 + UI 渲染
├── content.css            # 内联翻译 + 拆词面板样式
├── popup.html
├── popup.js               # 配置 + 单字本
├── popup.css
└── libs/
    └── tesseract.min.js   # 本地 OCR（kor + jpn 语言包）
```

---

## 3. 字幕检测策略

### 3.1 DOM 字幕（优先）

使用 `MutationObserver` 监听以下选择器：

| 平台 | 选择器 |
|------|--------|
| Bilibili | `.bilibili-player-video-subtitle span` |
| YouTube | `.ytp-caption-segment` |
| 通用兜底 | 包含韩文 `[\uAC00-\uD7A3]` 或日文 `[\u3040-\u30FF]` 的短文本元素 |

**节流：** 同一段文字 1 秒内不重复触发翻译。

**语言判断：** 用字符范围区分韩文/日文，传给 LLM 作为上下文。

### 3.2 OCR 字幕（兜底）

**触发条件：** DOM 检测连续 5 秒未找到字幕元素，自动切换到截帧模式。

**字幕区域选择：** 首次进入 OCR 模式时，在视频上叠加一个区域选择 UI，引导用户框出字幕大致位置：

```
┌─────────────────────────────┐
│         视频画面             │
│                             │
│  [点击并拖拽，框出字幕区域]  │
│                             │
│ ┌···················┐       │
│ │  <- 拖拽选择 ->   │       │
│ └···················┘       │
│  [确认]  [默认底部25%]       │
└─────────────────────────────┘
```

- 用户拖拽选出一个矩形区域，点击"确认"保存
- 提供"默认底部 25%"按钮跳过手动选择
- 选择结果以百分比坐标存入 `chrome.storage.local`（per 域名），下次同一网站自动复用，无需重复设置
- Popup 中可以手动重置区域选择

**流程：**
1. 每 2 秒用 Canvas API 截取 `<video>` 当前帧
2. 按用户选定区域（或默认底部 25%）裁剪画面
3. 发送给 Background Worker 跑 Tesseract（语言包：kor + jpn）
4. 与上一帧识别结果对比，文字变化时才触发翻译

**恢复：** OCR 模式下如果重新检测到 DOM 字幕，自动切回 DOM 模式。

---

## 4. LLM 抽象层（LLMClient）

Background Service Worker 中实现统一接口：

```javascript
class LLMClient {
  async translate(text, lang)   // 返回中文译文字符串
  async breakdown(word, lang)   // 返回结构化拆词对象
}
```

底层根据用户配置路由到：

| 后端 | 端点 | 认证 |
|------|------|------|
| Ollama（默认） | `http://localhost:11434/api/chat` | 无需 Key |
| Claude API | `https://api.anthropic.com/v1/messages` | API Key |

### 4.1 翻译 Prompt

```
你是{lang}学习助手。请将以下字幕翻译成中文，只返回译文，不加解释。
字幕：{text}
```

### 4.2 拆词 Prompt

```
请分析以下{lang}单词，严格以 JSON 格式返回，不加其他文字：
{"word": "原词", "reading": "读音（韩文用罗马拼音，日文用平假名）", "meaning": "中文释义", "pos": "词性"}
单词：{word}
```

### 4.3 节流与缓存

- 翻译结果缓存最近 20 条（原文 → 译文），相同原文不重复调用
- 拆词结果缓存（词 → 拆词结果），同一个词不重复调用
- 同时最多 1 个翻译请求 + 1 个拆词请求，新请求取消旧请求

### 4.4 错误处理

| 情况 | 处理 |
|------|------|
| Ollama 未启动 | 内联区域显示"Ollama 未运行，请检查本地服务" |
| Claude API Key 未设置 | 提示"请在扩展设置中填写 API Key" |
| 网络错误 | 显示"翻译失败，点击重试" |
| OCR 识别为空 | 静默跳过，不触发翻译 |

---

## 5. UI 设计

### 5.1 内联翻译（DOM 字幕模式）

在原字幕元素正下方注入一个 `<div class="vlog-translation">`，样式：
- 字体 14px，颜色 `#555`，半透明背景
- 原文分词为可点击 span，点击触发拆词

### 5.2 视频底部浮层（OCR 模式）

在 `<video>` 容器上叠加绝对定位浮层，固定在视频底部 10%：
- 上行：OCR 识别的原文（分词可点击）
- 下行：中文翻译
- 半透明黑底白字，不遮挡主要画面

### 5.3 拆词面板

点击原文中的词时弹出，悬浮在点击位置附近：

```
┌────────────────────────┐
│ [#b6d7a8 标题栏] 안녕  │
├────────────────────────┤
│ 读音：annyeong         │
│ 释义：你好             │
│ 词性：感叹词           │
│                    [★] │
└────────────────────────┘
```

- 点击面板外区域关闭
- ★ 按钮收藏到单字本
- 宽度 220px，标题栏 `#b6d7a8`，内容区 `#faf8f5`

### 5.4 配色系统

| 元素 | 颜色 |
|------|------|
| 拆词面板标题栏 | `#b6d7a8`（清爽绿） |
| 内容区背景 | `#faf8f5`（米白） |
| 内联翻译文字 | `#555555` |
| OCR 浮层背景 | `rgba(0,0,0,0.65)` |

---

## 6. 单字本

### 存储结构

```json
{
  "vocabulary": [
    {
      "word": "안녕",
      "reading": "annyeong",
      "meaning": "你好",
      "pos": "感叹词",
      "lang": "ko",
      "savedAt": 1234567890
    }
  ]
}
```

### Popup 布局

**上半部分 — 后端配置：**
```
后端：[Ollama（本地）▼] / [Claude API]

── Ollama 模式 ──
地址：http://localhost:11434
模型：qwen2.5:7b

── Claude 模式 ──
API Key：[___________________]
```

**下半部分 — 单字本：**
- 列表显示：原词 · 读音 · 释义（右侧删除按钮）
- 底部"导出 JSON"按钮，下载为 `vocabulary.json`

---

## 7. Manifest 权限

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "scripting", "activeTab"],
  "host_permissions": [
    "https://www.bilibili.com/*",
    "https://www.youtube.com/*",
    "http://localhost/*"
  ]
}
```

---

## 8. 范围外（本版本不做）

- 复习/抽认卡功能
- 同步到云端
- Firefox / Safari 支持
- 自动 Ollama 安装引导
