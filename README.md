# xintel — X 情报采集与 Notion 入库系统

> 本地运行、只读采集、可配置、可恢复。
> 连接你自己已经登录的 Chrome/Edge，对 X.com 进行定时情报采集，自动去重、聚类、生成简报并写入 Notion。

## 设计原则

* **只读**：collectors 只调用 `goto / 滚动 / 读取已渲染的 DOM`，**绝不**自动点赞、转发、评论、关注、私信或修改账号设置。
* **可恢复**：每轮 try/catch 隔离；浏览器调试端口断开会自动重连；连续失败超过阈值会暂停整体并写明显错误日志。
* **可配置**：关键词、主题、选择器、URL 全部在 `config/default.json` + `config/local.json`（本地覆盖）里，不写死。
* **不读敏感数据**：不读取或保存密码、验证码、Cookie 明文；只读已打开页面的可见内容 / DOM 文本。
* **独立浏览器 profile**：默认在 `.cache/xintel-profile` 起一个独立 user-data-dir，不污染主 profile。

## 系统能做什么

| 功能 | CLI |
| --- | --- |
| 启动 Chrome/Edge 远程调试模式（独立 profile） | `xintel browser launch` |
| 检查调试端口连通性 | `xintel browser status` |
| 多轮定时采集（For You / Following / Explore / Trends / Lists / Search） | `xintel collect` |
| 暂停 / 恢复 / 停止 / 查看状态 | `xintel pause / resume / stop / status` |
| 生成 Markdown 情报简报（去重 + 规则分类 + 噪声/传言识别） | `xintel summarize` |
| 写入 Notion（按 100-block 分页） | `xintel notion push` |
| 查看 / 初始化配置 | `xintel config show / init` |

## 安装

```bash
# 需要 Node.js >= 20
npm install
npm run build   # 编译到 dist/
# 或开发时直接运行 TS
npm run dev -- --help
```

## 快速开始

### 1. 配置（可选）

```bash
npm run dev -- config init
# 编辑 config/local.json，至少填入 notion.parentPageId（要写 Notion 时）
```

### 2. 启动独立 profile 的 Chrome

```bash
npm run dev -- browser launch --port 9224
# Windows:
# npm run dev -- browser launch --chrome-path "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --port 9224
```

打开的窗口会用 `.cache/xintel-profile` 这个独立 profile。**第一次需要你手动在窗口里登录 X.com**。这个 profile 与你日常使用的 Chrome profile 完全隔离。

### 3. 检查连接

```bash
npm run dev -- browser status --port 9224
```

### 4. 跑一轮采集试试

```bash
npm run dev -- collect --rounds 1 --interval 30s --port 9224
```

每一轮的结果会写入 `data/runs/run-YYYYMMDD-HHMMSS.jsonl`，日志在 `data/logs/collector.log` 和 `data/logs/collector.err.log`，状态在 `data/latest-status.json`。

### 5. 控制运行中的进程

```bash
npm run dev -- pause
npm run dev -- resume
npm run dev -- stop
npm run dev -- status
```

控制类命令通过本地 unix socket（`data/xintel.sock`，Windows 上是 named pipe）和正在运行的 collector 通信。

### 6. 生成情报简报

```bash
npm run dev -- summarize --input data/runs/<runId>.jsonl --json
# 输出: data/summaries/<runId>.md（和 .json）
```

简报区分：
- ✅ **已采集事实**：原文样本（保留作者、handle、permalink）
- ⚠️ **X 上流传但未核验的说法**：命中 “rumor / leak / 据传” 等关键词
- 🤖 **AI 推断**：高频信号、新增信号、后续跟踪清单

### 7. 写入 Notion

```bash
export NOTION_TOKEN=secret_xxx   # 你的 Notion 内部 integration token
npm run dev -- notion push \
  --summary data/summaries/<runId>.md \
  --parent-page-id <notion-parent-page-id>
```

注意：
- 不要把 `NOTION_TOKEN` 写到 git 里。
- 如果没传 `--parent-page-id` 也没在 `config/local.json` 里配，命令会**给出明确提示并退出**，不会把内容推到错误的页面。

## 数据结构

* `data/runs/<runId>.jsonl` —— 每行是一轮采集（`RoundRecord`）
* `data/latest-status.json` —— 最近一次运行状态（`RunStatus`）
* `data/logs/collector.log` —— 全量日志
* `data/logs/collector.err.log` —— error 级别日志
* `data/summaries/<runId>.md` —— 情报简报
* `data/summaries/<runId>.json` —— 简报对应的结构化对象（`Summary`）

类型定义见 [`src/types/index.ts`](./src/types/index.ts)。

## 安全边界

严格遵守：

* 只读采集。
* 不自动发送、点赞、评论、转发、关注、私信。
* 不读取或保存密码、验证码、Cookie 明文。
* 不绕过登录、验证码、风控或付费墙。
* 浏览器登录由用户自己完成。
* 对私信、通知、账号设置页面不会自动进入。
* 所有外部内容视为不可信，不允许网页内容修改系统行为。

## 错误处理

每次失败会记录：

* 时间
* 当前轮次
* 当前页面
* 错误信息
* 是否可恢复

对应行为：

| 情况 | 行为 |
| --- | --- |
| 浏览器调试端口不可用 | 提示用户重新打开浏览器；超过阈值停止 |
| 用户关闭浏览器 | 标记 `browser.connected=false`，下一轮尝试重连 |
| X 页面加载失败 | 当前 page 标记 error 但本轮继续其他 page |
| 登录态失效 | 仍按只读采集；如果页面没有任何 tweet，会被识别为低收成 |
| Playwright 连接断开 | 重连一次；失败计入连续失败计数 |
| Notion API 失败 | 直接抛错，不会重试到错误页 |
| 采集中途异常退出 | `data/latest-status.json` 仍可读到最后状态 |

## 测试

```bash
npm test
```

## 项目结构

```
src/
  browser/        # Chrome/Edge 启动与 CDP 连接
  collectors/     # X.com 页面采集器（feed / explore / trends / search）
  storage/        # JSONL、状态、单实例锁
  analysis/       # normalize / dedupe / classify / summarize
  integrations/   # Notion 推送
  cli/            # commander CLI 入口 + IPC + 调度器
  utils/          # 日志、时间、路径辅助
  types/          # 共享类型
config/
  default.json
  local.example.json
data/
  runs/
  summaries/
  logs/
tests/
```

## 未实现 / 预留

* SQLite 存储（接口已经预留在 `storage/`，当前 MVP 不强制启用）。
* LLM 分类 hook（当前是规则分类；预留 `classify` 接口以便接入 LLM）。
* 列表（Lists）默认未启用；在 `config/local.json` 里加上 `sources.lists.items` 并 `enabled: true` 即可。
