# dsh Web 搜索能力现状调研（RESEARCH-WEBSEARCH-STATUS）

> 只读调研。结论：**我们的 dsh 实例已经具备可用的 `web_search`（Web 搜索）能力，无 `web_fetch`（Web 抓取）能力。** 启用 web_search 需要 0 改动（依赖链已挂齐 + `DEEPSEEK_API_KEY` 已存在）；启用 web_fetch 才是"添加配置行 + 装依赖"的活。
> 以下所有证据均为 `file:line`，来自本机 `dsh` monorepo 与 `dsh-plugin`。

---

## 一、各层是否包含 web 能力行

### 1. 我们的 profile（patch 层）

| 文件 | web-search / web-fetch / web 提供方行 | 结论 |
|---|---|---|
| `plugin/profile-main/cordis.patch.yml` | **无**（通读全文：只有 compact-mode / vibe-mode / tool-read-write / advisor / mode-ui / channel-wechat / agent-presets 七组） | 我们**没有**添加任何 web 搜索行 |
| `plugin/profile-personal/cordis.patch.yml` | **无**（只有 persona / memory / title-zh） | 个人层也没有 |

→ 确认：profile 层确实**未加** web 搜索。我们的 web 能力完全来自 base bundle 的默认挂载 + 机器上已有的 key，与我们的 patch 无关。

### 2. base / web profile 的默认行（`packages/bundle/base/cordis.patch.yml`）

| 行 id | 包名 | 关键配置 | 行号 |
|---|---|---|---|
| `web` | `@deepseek-ai/dsh-web` | `searchProvider: deepseek-official`（只 pin 搜索，未 pin fetch） | `base/cordis.patch.yml:404-407` |
| `web-search-deepseek` | `@deepseek-ai/dsh-web-search-deepseek` | `apiKeyEnv: DEEPSEEK_API_KEY` | `base/cordis.patch.yml:409-412` |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `fetch: false`、`searchTimeoutMs: 60000` | `base/cordis.patch.yml:414-418` |

配套注释 `base/cordis.patch.yml:395-403` 明确：
- "Every mode enables the stable model-facing **web_search** tool."
- "DeepSeek search resolves the **same DEEPSEEK_API_KEY** credential the Models page manages for chat, at each search; its Messages endpoint is separate from the chat-completions endpoint, so it takes its own base-URL override."
- "**Fetch stays disabled and no fetch provider is mounted**"（fetch 被禁且未挂任何抓取 provider）。

### 3. 现有的 web 提供方包清单（`packages/web/`）

| 包 | 类型 | 默认挂载？ |
|---|---|---|
| `web-search-deepseek` | 搜索提供方（id = `deepseek-official`） | ✅ base 挂载（`web-search-deepseek` 行） |
| `web-search-exa` | 搜索提供方 | ❌ 包存在，未挂载（无行） |
| `web-search-perplexity` | 搜索提供方 | ❌ 包存在，未挂载（无行） |
| `web-fetch-http` | 抓取提供方 | ❌ 包存在，未挂载（无行） |
| `tool-web` | 模型面前端工具（注册 `web_search` / `web_fetch`） | ✅ base 挂载；⛔ **web surface 的 host 行被禁**，改由 preset 重挂（见下） |
| `web` | `ctx.web` 服务（提供方选择器） | ✅ base 挂载（`web` 行） |

---

## 二、dsh 的 web 能力与配置要求

### tool-web（模型面工具：`packages/web/tool-web/src/index.ts`）

- 注册两个工具：`web_search`（搜索）、`web_fetch`（抓取）——`tool-catalog.md:1829-1871`（`@deepseek-ai/dsh-tool-web` → `web_fetch`、`web_search`）。
- 开关（`tool-web/src/index.ts` 的 `Config`；`config-catalog.md:2721-2743`）：
  - `search`（注册 `web_search`）：**默认 `true`**。
  - `fetch`（注册 `web_fetch`）：**默认 `true`**，但 base 与我们的 preset 都显式 `fetch: false`。
  - `searchTimeoutMs`/`fetchTimeoutMs` 默认 30000；base 将 search 提到 60000。
- 依赖 `ctx.tools` / `ctx.web` / `ctx.systemPrompt`（`tool-web/src/index.ts`）——提供方选择在 `ctx.web` 后面，模型可见 schema 稳定。

### web 服务（`@deepseek-ai/dsh-web`，`config-catalog.md:2851-2861`）

- `searchProvider` / `fetchProvider`：显式 pin；缺省时"正好一个可用提供方"才自动选择。base 已 pin `searchProvider: deepseek-official`。

### web-search-deepseek（`packages/web/web-search-deepseek`）

- **存在**。provider id = `deepseek-official`（`provider.ts` `DEEPSEEK_PROVIDER_ID`）。
- **key**：`apiKeyEnv` **默认 `DEEPSEEK_API_KEY`**（`index.ts` `DEFAULT_API_KEY_ENV`；`config-catalog.md:2929`）。base 行显式 `apiKeyEnv: DEEPSEEK_API_KEY`（`base/cordis.patch.yml:412`）。
- **路由**：不是走 chat-completions，而是 **DeepSeek 的 Anthropic 兼容 Messages 搜索 API**——默认 endpoint `https://api.deepseek.com/anthropic/v1`、模型 `deepseek-v4-flash`、`anthropic-version: 2023-06-01`、单请求最多 5 次服务端 `web_search` 工具调用（`provider.ts` 常量）。换 endpoint 走 `DEEPSEEK_SEARCH_BASE_URL` env，或 `config.baseURL` / settings 区 `web-search-deepseek`。
- **结论：搜索复用 `DEEPSEEK_API_KEY`**，与聊天同一把 key（`base/cordis.patch.yml:395-398` 注释、`config-catalog.md:855-858` 同一适配器默认）。**不需要单独的 key，不需要单独的 llm-deepseek 适配器**（走 Messages 端点，独立于 chat-completions 适配器）。
- 需要 `llm-deepseek` 提供方吗？**不需要**。搜索是独立于 chat 的 auxiliary Messages 请求，只依赖 `ctx.web`（注入 = `['web']`，`web-search-deepseek/src/index.ts`）。

---

## 三、模型如何触发搜索（命令面）

- 触发工具是 **`web_search`**（由 `@deepseek-ai/dsh-tool-web` 注册），**不是** `web_fetch`。
- 在哪可见/可用：必须满足三条同时成立——
  1. `ctx.web` 服务在（host `web` 行，base 挂载，web surface **未**禁）。
  2. 一个搜索提供方在 `ctx.web`（`web-search-deepseek` 行，base 挂载，web surface **未**禁）。
  3. 模型所在 agent 的 preset **挂载了 `tool-web` 行**。
- **web surface 的关键点**：web-app bundle 在 host 层禁用了 `tool-web`（`packages/bundle/web-app/cordis.patch.yml:407-408`），但**没禁** `web` 与 `web-search-deepseek`。模型面 `web_search` 靠 **agent preset** 的 `tool-web` 行挂回 per-agent。
  - 官方 `standard` preset：挂 `tool-web`（`apps/cli/config/agent-presets/standard/agent.cordis.yml` 末段）。
  - **我们的 `standard-rw` preset（profile 默认 `default: standard-rw`）同样挂 `tool-web`**，配置 `fetch: false`、`searchTimeoutMs: 60000`（`plugin/profile-main/agent-presets/standard-rw/agent.cordis.yml` 末段）——所以 `web_search` 对我们的 web 会话**可见可用**，`web_fetch` **不可见**（fetch:false）。

---

## 四、verdict 表

| 能力 | 在我们的 profile 里？ | base 默认启用？ | 由什么配置/key 启用 | 估算工作量 |
|---|---|---|---|---|
| `web_search`（DeepSeek 搜索） | ❌ 没加（全靠 base 默认） | ✅ 默认启用（搜索），提供方 `deepseek-official` 已挂，key 走 `DEEPSEEK_API_KEY` | 无需额外配置；仅需 `DEEPSEEK_API_KEY` 存在 | **0（已完成）**——依赖链全挂齐 |
| `web_fetch`（抓取） | ❌ 没加 | ❌ 默认禁用（base 与 standard-rw preset 均 `fetch: false`，且 base **未挂** `web-fetch-http` 提供方） | ① preset `tool-web` 行改 `fetch: true`；② 挂 `@deepseek-ai/dsh-web-fetch-http` 提供方行（含 baseURL/proxy 配置）；③ 鉴于 SSRF 顾虑需要决定目标范围 | 中（配置行 + 需确认 `web-fetch-http` 可解析，base bundle 未列其为依赖 → 可能要装依赖/构建） |
| `web-search-exa` / `web-search-perplexity` | ❌ 没加 | ❌ 未挂载 | 加一行 + 各自的 API key / baseURL 配置 | 中（配置行 + 确认包可解析 + 独立 key） |
| host 层 `tool-web` | — | web-surface 禁用（web-app `tool-web` 行） | 由 preset per-agent 重挂 | — |

---

## 五、最终结论

**我们当前的 dsh 实例有可用的 web 搜索（`web_search`），没有 web 抓取（`web_fetch`）。**

- 链条已完整：`standard-rw` preset 挂 `tool-web`（注册 `web_search`）→ `ctx.web` 服务在 → `web-search-deepseek` 提供方（id `deepseek-official`，`apiKeyEnv: DEEPSEEK_API_KEY`）→ 环境里 `DEEPSEEK_API_KEY` 已设（len 35）。**搜索是开箱即用的**，我们 profile 没有也不需要在 profile 里加任何 web 行。
- `web_fetch` 默认关闭（`fetch: false` 且无抓取 provider），模型拿不到 URL 抓取工具。

**最小启用路径（如果你想要的是搜索）**：什么都不用做——`web_search` 已可用。只要保证环境变量/凭据 `DEEPSEEK_API_KEY` 有效即可（本机已检测到）。

**若要启用 `web_fetch`**（次选，需你确认走这条路）：
1. 在 `standard-rw` preset 的 `tool-web` 行把 `fetch: false` → `fetch: true`（改配置行，无需改码）。
2. 在 profile/base 层新增一行挂 `@deepseek-ai/dsh-web-fetch-http`（`ctx.web` 的 fetch 提供方），并给 `web` 行 pin `fetchProvider`；该包未列入 base bundle 依赖，先确认能解析（profile node_modules 或加依赖，属于安装/构建步骤）。
3. 抓取有 SSRF 顾虑（base 注释明言 fetch 被禁就是"等 SSRF 保护就绪"），`web-fetch-http` 需配置可抓取的范围/proxy。
4. 若改用 exa / perplexity：换挂对应提供方行 + 配各自 key（均为独立 key，不复用 DEEPSEEK_API_KEY）。

（注：搜索走的是 DeepSeek 的 **Anthropic 兼容 Messages 搜索 API**（`api.deepseek.com/anthropic/v1`，模型 `deepseek-v4-flash`），**不复用** llm-deepseek 适配器，**不需**单独 key；它与聊天共用 `DEEPSEEK_API_KEY`。）
