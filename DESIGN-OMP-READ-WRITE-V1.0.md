# 设计文档 v1.1:迁移 omp 的 read / write 工具(dsh 插件)

> 状态:设计草案,等待拍板点确认后开发
> 基线:dsh master 本地 clone `C:/Users/Vantage_XLST/Documents/dsh`(纯参考);开发在 `C:/Users/Vantage_XLST/Documents/dsh-plugin/plugin/` 独立项目
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户
> 依据:omp `tools/read.md`、`tools/write.md`;omp `tools/inspect_image.md`;dsh 侧调研 `RESEARCH-FS-TOOLS.md`(证据 file:line)

---

## 1. 需求

把 omp 的 `read` / `write` 工具迁移为 dsh 插件,获得 omp 的"单工具全能"体验:

- **read**:一个 `path` 字符串 + 尾部选择器(`:A-B` / `:A+C` / 多区间 / `:raw` / `:conflicts`),覆盖:文本文件(行窗口)、目录树、归档(.tar/.tar.gz/.tgz/.zip/.jar/.war/.ear/.apk)、SQLite(表列表/schema/行/查询)、URL(渲染管线)、文档(.pdf/.docx/.pptx/.xls/.rtf/.epub)、notebook(.ipynb)、图片。
- **inspect_image**(第五工具):把本地图片 + 问题发给视觉模型,返回文字分析(对应 omp `inspect_image`;dsh 当前无此工具)。
- **write**:文件整写、归档条目写(原子重写容器)、SQLite 行 insert/update/delete、merge-conflict 解析。

## 2. 概念对齐(omp ↔ dsh 现状)

| 能力 | omp read/write | dsh 现状(tool-fs) | 差距 |
|---|---|---|---|
| 文本文件读 | `:A-B`/`:A+C`/多区间/`:raw`,行号,1+3 上下文行,300 行默认 | `read{file_path, offset?, limit?}`,仅 UTF-8,上限 2000 行/2000 字符/50KiB | 无选择器语法;无上下文行 |
| 目录 | 树渲染(depth 2/perDir 12,带大小/时间) | `FS_NOT_REGULAR_FILE` 报错 | 缺失 |
| 归档读 | 全格式 + `:inner/path` + 行区间 | 无 | 缺失 |
| SQLite | 表列表/schema/行/`?q=` | 无 | 缺失(全仓无 sqlite 实现) |
| URL | 渲染管线(reader mode/alternates/raw) | `web_fetch` 存在但 **base 默认 `fetch:false` 禁用**;200k 字符 cap | 默认不可用 |
| 文档/notebook | markit 转换 + 行区间 | 无 | 缺失 |
| 图片 | read 内联返回 image block | 独立 `read_image`(4 格式,需 attachments+image 路由) | 已覆盖(独立工具) |
| 文件写 | 整写(UTF-16 units 计"字节") | `write{file_path, content}` 整写 + `fs/write-intent` CAS | 已覆盖 |
| 归档写 | 原子重写容器 | 无 | 缺失 |
| SQLite 写 | 行 insert/update/delete(JSON5) | 无 | 缺失 |
| conflict | `:conflicts` + `conflict://` 解析 | 无 | 缺失 |
| 新鲜度模型 | hashline `[path#TAG]` 快照校验 | `FsVersion` token + `fs/observed` + provider CAS | **不移植 hashline**,保留 dsh 模型 |

**关键结论**:dsh 工具层整个不存在归档/SQLite/文档/notebook/选择器实现;read/write 迁移是"增强 + 新增能力"的组合,不是翻译。

## 3. 关键约束(调研确认,设计前提)

1. **同 scope 重名注册必抛错**(`tool "read" is already registered`),无 last-wins;跨层可 shadow(agent 作用域 shadow 全局)。
2. **组合粒度是包级整行**:`@deepseek-ai/dsh-tool-fs` 一行注册 read/read_image/write/edit 四工具;禁用整行 = 四工具全丢,**edit 与 read_image 是替换 read/write 的连带损失,必须由插件补回**(至少 edit——`fs-observation-policy` 的 `fs/edit-intent` 依赖新 read 的 `fs/observed`)。
3. **新文件工具必须走 `ctx.fs` + `fs/*` 事件**:读后 `ctx.emit('fs/observed', target, {kind:'present', version}, exec)`;写前 `ctx.waterfall('fs/write-intent', …)`;编辑走 `fs/edit-intent`;沙箱提升经 `ctx.sandboxPolicy.resolve()` + `ctx.approval`。违反则保留的 edit 全部 `FS_NOT_OBSERVED`、读后写保护失效。
4. **web 面差异**:host 层 tool-fs 已禁,模型面工具在 agent presets(`standard`/`code`);web 替换 = 复制 preset、删 tool-fs 行、加迁移插件行。
5. 实现模板:照抄 `tool-fs/src/read.ts` 的 defineTool 契约(规范值 + render + presentationMeta + presentCall/presentResult 纯函数)与 `read-render.ts` 的 Cordis-free 窗口层。

## 4. 插件结构(单包 `dsh-tool-read-write`,独立项目)

```
plugin/dsh-tool-read-write/
  src/
    index.ts          # 四工具组合注册:read/write/edit/read_image(替换 tool-fs 全家)
    read/
      index.ts        # 执行器:path 解析 + 能力分支
      selectors.ts    # :A-B/:A+C/多区间/:raw/:conflicts 解析(Cordis-free 纯函数)
      render.ts       # 窗口化/渲染/meta 纯函数(照 read-render.ts)
      directory.ts    # 目录树(depth 2/perDir 12)
      archive.ts      # 归档读(tar/zip 族;node:zlib + tar 解析,见拍板点 4)
      sqlite.ts       # SQLite 只读(node:sqlite 或 better-sqlite3,见拍板点 4)
      url.ts          # URL 渲染(node fetch + 基础 HTML→text)
    write/
      index.ts        # 文件/归档条目/SQLite 行
      archive-write.ts# 原子重写容器
      sqlite-write.ts # 行写(JSON5 parse)
    edit.ts           # 移植 dsh edit(fs/edit-intent + CAS)
    read-image.ts     # 移植 dsh read_image(attachments 条件注册)
    inspect-image.ts  # 第五工具:图片分析(视觉模型调用)
    sandbox.ts        # 沙箱提升(共享 tool-fs 模式)
    invariant.ts
  tests/
```

依赖(发布版 `@next`):cordis(peer)、schemastery、dsh-fs、dsh-tools、dsh-session、dsh-llm、dsh-sandbox-policy、dsh-approval、dsh-attachment(read_image 条件);sqlite/tar/文档转换库见拍板点 4–5。

## 5. read 设计(v1 范围)

能力分支顺序(照 omp):URL → 内部 URL(v1 不做,见拍板点 6)→ 文件路径字面优先 → 归档 → SQLite → 本地文件 → 目录 → 类型分支。

- **选择器语法**(`selectors.ts`,纯函数):`:raw`/`:N`/`:A-B`/`:A+C`/多区间合并/`:range:raw`;1 索引;`:0` 抛错;未识别 `:...` 落入路径(归档/SQLite 用);字面路径优先于选择器解释。
- **文本文件**:`ctx.fs.resolve` + `stat` → `streamText`/`readText` → 行窗口(带 1+3 上下文行,仅单有界非 raw);上限沿用:2000 行/2000 字符/50KiB,新增默认行 300(可选);越界给提示不抛;成功后 `fs/observed`。
- **目录树**:`listDir` 递归 depth 2、perDir 12,大小/相对时间,空目录 `(empty directory)`。
- **归档**:后缀识别 `.tar/.tar.gz/.tgz/.zip/.jar/.war/.ear/.apk`;`:inner/path` 规范化(拒绝 `..`);目录列子项(500 上限);文本条目 UTF-8;二进制给提示。
- **SQLite 读**:`.sqlite/.sqlite3/.db/.db3` + 头魔数校验;`:table`(schema+5 样例行)/`:table:key`(单列 PK 或 rowid)/`:table?limit=…&where=…`(20 默认/500 上限,where 校验拒绝注释分号 UNION 等)/`?q=`(1000 行上限,只读打开)。
- **URL**(v1 简化):`http(s)`/`www.`;node fetch → JSON/纯文本直接返回,HTML 基础转文本;`:raw` 原文;结果截断 300 行/50KiB;失败给 `method: failed` 说明不抛。渲染管线(markit/alternates/feeds)不在 v1。
- **图片(多模态)**:沿用独立 `read_image` 工具(插件重注册)——把图以 inline image block 喂给支持 image 输入的模型,read 不做内联图片分支。
- **inspect_image(第五工具,视觉分析)**:输入 `path`(本地图片/附件引用)+ `question`;resolve 图片(格式 PNG/JPEG/GIF/WebP,头嗅探,20MiB 上限)→ 一次 `ctx.llm.stream()` 视觉调用(image block + question → 文字)→ 返回文本 + `{model, mimeType}`。视觉路由:`visionProvider`/`visionModel` 可配,空 = 沿用主路由;模型必须声明 image 输入否则拒绝。`inspectImageMode`: `auto`(仅当前模型无原生图片输入时注册,照 omp)/`on`/`off`。超时 `inspectImageTimeoutMs` 默认 300s;autoResize 为 v1.2 增强。
- **`:conflicts`**:v1.2(依赖冲突扫描,见拍板点 7)。

## 6. write 设计(v1 范围)

- **文件整写**:`ctx.fs.resolve` + `fs/write-intent` waterfall(缺省无条件;挂策略后 CAS)+ `ctx.fs.writeText` + `fs/observed`;输出 `{path, operation, before, after}`;exclusive 并发。
- **归档条目写**:识别归档选择器 → 读全条目 → 替换目标 → 临时文件原子重写;创建缺失父目录;zip 族保持 zip、tar.gz 保持 gzip。
- **SQLite 行写**:已存在 DB 才写;`:table` insert(JSON5 对象);`:table:key` 非空 content update、空 content delete;拒绝查询参数。
- **conflict:// 解析**:v1.2。
- 输出文案照 omp 语义(`Successfully wrote <chars> bytes to …`)。

## 7. 组合与替换(profile / preset 处理)

- **TUI/CLI(base 面)**:profile patch 禁用 `tool-fs` 行(带 `name` 守卫)+ 插入 `dsh-tool-read-write` 行(host 全局注册 read/write/edit/read_image)。
- **web 面**:复制 `standard`/`code` preset → 删 `tool-fs` 行 → 加 `dsh-tool-read-write` 行;同一 preset scope 不并存。
- 保留:`tool-fs-search`(grep/glob)、`tool-str-replace-editor`、`fs-observation-policy`、`fs-sandbox`、`tool-web` 行不动(不冲突)。

## 8. 配置

```yaml
- id: tool-read-write
  name: '@dsh-plugin/dsh-tool-read-write'
  config:
    readDefaultLimit: 300        # 无选择器默认行数
    readMaxLines: 2000
    readMaxLineLength: 2000
    readMaxBytes: 51200
    directoryDepth: 2
    directoryPerDir: 12
    archiveListLimit: 500
    sqliteQueryLimit: 20
    sqliteQueryMax: 500
    sqliteRawQueryMaxRows: 1000
    urlMaxLines: 300
    urlMaxBytes: 51200
    inspectImageMode: auto       # auto|on|off;auto = 仅模型无原生图片输入时注册
    inspectImageTimeoutMs: 300000 # 视觉调用超时(ms)
    inspectImageMaxBytes: 20971520 # 20MiB 输入上限
    visionProvider: ''           # inspect_image 视觉路由;空 = 沿用主路由
    visionModel: ''
    writeEnabled: true
    sqliteWriteEnabled: true
    archiveWriteEnabled: true
```

## 9. 拍板点(全部确认)

1. **替换策略**:禁用 tool-fs 整行、插件补回 read/write/edit/read_image 全家(推荐,模型行为无缝)—— ✅ 确认(按推荐,禁用 tool-fs 整行,补回全家)
2. **read 默认行数**:300(omp 默认)还是保留 2000? —— ✅ 确认(300,omp 默认)
3. **URL 分支进 read v1**:自带 node fetch + 基础 HTML→text(推荐)vs v1 不做 URL、改用开启 web_fetch 行? —— ✅ 确认(自带 fetch + 基础 HTML→text)
4. **SQLite 实现**:Node 24 内置 `node:sqlite`(零依赖,推荐;需验证可用性)vs `better-sqlite3`(原生编译)。 —— ✅ 确认(node:sqlite;实现时验证可用性,不行 fallback better-sqlite3)
5. **归档实现**:`node:zlib` + 自写 tar 解析(轻,推荐 v1)vs 引 tar/zip 库。ZIP 用 zlib inflate + 自解析中央目录。 —— ✅ 确认(zlib + 自写 tar/zip 解析)
6. **内部 URL**(`agent://`/`skill://`/`history://` 等):v1 不做(dsh 已有 session-query/skill 工具覆盖),确认? —— ✅ 确认(v1 不做内部 URL)
7. **`:conflicts` + conflict:// 写**:v1.2(需先做冲突扫描),确认? —— ✅ 确认(v1.2 做 conflicts)
8. **文档/notebook 转换**:v1.2+(依赖 pdf/docx 转换库,重),确认? —— ✅ 确认(v1.2+ 做文档/notebook)
9. **inspect_image 作为第五工具加入 v1** —— ✅ 已确认(用户拍板)。

## 10. 风险

- edit/read_image 重注册须与 `fs/*` 事件契约完全一致,否则保留的观测策略断裂(第一约束)。
- sqlite/tar 实现若引原生依赖(better-sqlite3)增加安装负担;`node:sqlite` 若 API 不稳定需锁 Node 版本。
- URL 分支无渲染管线,质量低于 omp;HTML→text 是朴素实现。
- 替换后 `str_replace_editor` 的 view 与我们的 read 并存,模型可能混淆——系统提示词需澄清(照 tool-fs 的 `tool:read` section 模式)。

## 11. 验证(免 API key)

`constraints`/`typecheck`/`build` + 单测:选择器解析(边界)、行窗口/上下文行/截断、目录树、归档读(zip/tar 夹具)、SQLite 读(临时库)、URL(mock fetch)、write 全路径(fs/write-intent 事件、CAS、归档原子写、SQLite 行写)、edit/read_image 回归(`fs/observed` 联动)、`--dump-config` 替换生效。

## 12. 变更记录

- **v1.0**(2026-08-17):初始设计,等待拍板点确认。
- **v1.1**(2026-08-17):新增第五工具 inspect_image(图片+问题→视觉模型→文字分析);拍板点 9 确认。
- **v1.2**(2026-08-17):拍板点 1–8 全部确认(按推荐);inspect_image 视觉路由前提注明(需配置 visionProvider/visionModel,否则该工具不可用)。
