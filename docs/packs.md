# Segment Packs — 客户群可插拔配置

xintel 通过 **Segment Pack** 机制让一套后端（采集 + 去重 + 分类 + 简报 + 推送）支持多种客户群。
每个 pack 是一份独立的 JSON，包含该客户群的：

- 关键词词典 / 主题分类（`topics`）
- 推荐采集源（X 搜索查询、List 名单）
- 简报模板（章节、口吻、长度、是否双语）
- LLM system / user prompt（如果开启 LLM 增强）
- 默认推送渠道（可被 `config.push.channels` 覆盖）

## 内置 Pack

| 文件 | 客户群 | 主题 | 简报口吻 |
| --- | --- | --- | --- |
| `config/packs/ai-watcher.json` | AI 研究员 / 工程师 / 创业者 / 投资人 | OpenAI / Anthropic / Google AI / Meta AI / xAI / 中国 AI / 算力 / 评测 / 融资 / 安全 / Agent | `researcher` — 学术风格 + 中英双语 + [FACT]/[INFER]/[RUMOR] 三分标记 |
| `config/packs/crypto-trader.json` | 加密交易者 / DeFi / 链上分析 | BTC / ETH / SOL+memecoin / 宏观 / 稳定币 / 交易所 / 清算 / 黑客 / 链上 | `trader` — 短平快 + Emoji（📈📉🐋🚨）+ 链上信号 |
| `config/packs/finance-media.json` | 财经媒体作者 / 宏观研究 / 卖方分析师 | Fed / 美股财报 / 七姐妹 / 中美 / 商品 / 外汇债券 / 中国宏观 / 地缘 / IPO/并购 | `media` — 素材式 + 多引用 + 适合二次写作 |

## 启用与切换

**方式 1：固定配置（推荐）**

编辑 `config/local.json`：

```json
{
  "packs": {
    "enabled": ["ai-watcher"]
  }
}
```

启用多个 pack（采集源与主题会合并，不冲突时第一个 pack 的简报模板生效）：

```json
{
  "packs": {
    "enabled": ["ai-watcher", "finance-media"]
  }
}
```

**方式 2：单次命令覆盖**

```bash
xintel --pack ai-watcher summarize --input data/runs/xxx.jsonl
xintel --pack crypto-trader,finance-media collect --rounds 10
```

## 自定义 Pack

把一个新的 JSON 文件放到 `config/packs/` 下（或在 `config.packs.searchPaths` 里加自定义目录），文件名就是 pack 名字（不带扩展名）。最小骨架：

```json
{
  "name": "my-pack",
  "description": "Internal R&D briefing for our team",
  "version": "0.1.0",
  "audience": "Our team",
  "language": "zh",
  "searchQueries": [
    { "name": "competitor-A", "q": "CompanyName launch product", "live": true }
  ],
  "lists": [],
  "topics": {
    "competitor": {
      "label": "竞品动态",
      "keywords": ["竞品名", "launch", "product"]
    }
  },
  "fallbackTopic": "other",
  "rumorHints": ["rumor", "传闻"],
  "noiseHints": ["promo", "giveaway"],
  "llmSystemPrompt": "你是负责竞品监控的研究员…",
  "llmUserPromptTemplate": "请根据下面的素材，按主题归纳本日要点…\n\n素材:\n{{topicDump}}\n\n昨日基线: {{previousDayCounts}}",
  "reportTemplate": {
    "title": "竞品监控日报",
    "introNote": "本简报覆盖核心竞品在 X 上的公开动态。",
    "sections": ["summary", "topics", "trends", "highFrequency", "newSignals", "rumors", "noise", "followups", "appendix"],
    "includeTrends": true,
    "includeRumors": true,
    "includeAppendix": true,
    "maxSamplesPerTopic": 5,
    "reportTone": "researcher"
  },
  "pushChannels": []
}
```

字段说明：

- `topics[*].watchHandles`（可选）：关注的核心账号列表，分类时会优先匹配 handle。
- `rumorHints`：出现这些词就归到「需要核验的传言」章节。
- `noiseHints`：出现这些词就归到「噪声与风险」章节，不计入主题信号。
- `language`：`zh` / `en` / `zh-en`。
- `reportTone`：`researcher` / `trader` / `media` —— 控制简报风格。
- `llmUserPromptTemplate` 模板变量：
  - `{{topicDump}}` — 当日已分类的样本（每主题最多 `maxSamplesPerTopic` 条）
  - `{{previousDayCounts}}` — 前一日同 pack 的主题计数（JSON）
  - `{{maxSamplesPerTopic}}` — 数字字面量

## 合并策略

加载 pack 时遵循 **additive merge（增量合并）**：

- 主题：以 base 配置 `classify.topics` 为基础，pack 里的 `topics` **追加**到不存在的 key，已有的 key 不会被覆盖。
- 搜索查询：以 `sources.search.queries` 为基础，**追加**不存在的 name。
- 推送渠道：以 `push.channels` 为准；pack 里的 `pushChannels` 作为参考默认值，不会自动启用。

这样设计的目的是：**用户的本地配置永远是 source of truth**，pack 只是提供初始词典 + prompt + 模板。

## 健康检查

启用 pack 后跑 `xintel doctor` 会看到：

```
[OK]   Segment packs
        2 pack(s) loaded: ai-watcher(11 topics), finance-media(9 topics)
```

如果指定的 pack 名字找不到，doctor 会报 `[WARN]` 并给出可用 pack 列表。
