# 研究结论:out-of-tree 插件能否把会话事件标记为 `ignorable: true`

> 结论先行:**(B) 不能**。在不改动 monorepo 任何文件的前提下,out-of-tree 插件**没有任何方式**让自己的会话事件带上 `ignorable: true` 标记。`ignorable` 是一个**事件信封(instance)属性**,不是 `SessionEventMap` 声明属性;`session.append` 在内部构造信封时不接受该字段;仓库里也不存在任何可供插件喂入的运行时注册表。因此持久化读侧(resume)必然拒绝这些事件。
>
> 可行的修复路径只有三条:(1) 把事件声明放进 monorepo 并重新生成目录(核心包文件变更);(2) 不再发会话事件,徽章数据改走别的通道(如插件自有存储/投影);(3) 接受使用这些模式的会话在 resume 时整个无法加载。

---

## 1. `ignorable` 的机制:信封实例属性,与声明无关

`SessionEventMap` 的每个成员只声明 **type → payload 数据类型**。`ignorable` 不在映射里,它是事件**信封**(`SessionEvent`)上的可选字段:

- `packages/core/session/src/types.ts:421-422` — `SessionEvent` 信封声明:`ignorable?: true`,注释明确:"marks an event a reader may safely skip when it does not recognize `type`. Absent means required"。
- `packages/core/session/src/index.ts:225-241` — 信封校验 switch 显式列出 `case 'ignorable'`(第 226 行),且值只能是 `true`(第 239 行:`event['ignorable'] !== undefined && event['ignorable'] !== true` → throw)。这证明信封是**持久化的一个字段**,与 `type/seq/time/data/surfaceOp/sourceEventSeqs` 并列。

也就是说:目录(known-event-types.ts)只决定"这个 type 我认不认识",`ignorable` 决定"不认识的 type 是否可跳过"。两者正交。

## 2. 生成器只扫事件名,`ignorable` 不在生成内容里

`scripts/gen-persistence-catalog.ts`:

- 扫描范围:`globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot })`(`gen-persistence-catalog.ts:169`)——**只扫 monorepo 内 `packages/<group>/<pkg>/src/`**,out-of-tree 插件目录永远不在扫描范围。
- 采集的数据结构 `LogEventEntry` 只有 `name/scope/payload/declaration/doc/source`(`gen-persistence-catalog.ts:68-88`)——**没有任何 ignorable 字段可读**。声明里也不存在这样的字段可表达。
- 产出 `packages/core/session/src/known-event-types.ts` 是一个纯 `ReadonlySet<string>` 类型名集合(`known-event-types.ts:19-45`),**集合内没有任何事件带 ignorable 标记**(整个文件无一个 `ignorable` 字样);文件头注释自己写明(`known-event-types.ts:10-16`):"the persistence read path refuses to interpret a log containing a type outside this set **unless the event carries the envelope's `ignorable` marker**… Downstream (out-of-repo) plugin events are outside this list **by construction**; a registration surface for them is **deferred until such a consumer exists**."

即:仓库自身就声明了——out-of-repo 事件**天然不在目录里**,且**尚无注册面**。

## 3. 读侧判定:目录命中 或 信封带标记,二选一

- 判读门:`packages/session/session-persistence/src/coordinator.ts:1062-1066`
  ```ts
  for (const event of events) {
    if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
    throw this.unsupported(meta, `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`)
  }
  ```
  唯一豁免条件就是 `event.ignorable === true`(信封实例字段)。该方法运行于所有读路径:load(`coordinator.ts:882-885`)、readFrom(`:898-901`、`:862-865`)、inspect、prepare 种子校验(`:1307-1310`)。**整个 session 一起拒绝**,不是只跳过一个事件。
- 标记能随持久化往返,证明读侧逻辑对"信封带标记"的事件是接受的:
  - 测试实证:`packages/session/session-persistence/tests/coordinator-contract.ts:709-724` —— 手工构造的 out-of-repo 事件 `plugin/test`(data 为非对象)带上 `ignorable: true` 后,`inspect`/`readFrom` 均通过;同文件 `:1360-1381` —— 无标记的未知类型 `future/event` 以 `SessionFormatUnsupportedError` 拒绝,带 `ignorable: true` 则 `load` 成功。
  - SQLite:信封 `ignorable` 落库为 INTEGER 列(`session-persistence-sqlite/src/schema.ts:143-144`),写入时 `event.ignorable === true ? 1 : null`(`index.ts:42`),读出时恢复 `{ ignorable: true }`(`schema.ts:209`)。
  - JSONL:`StorageRecord = SessionEvent | ChunkRow`,事件信封原样存储(`chunk-rows.ts:69-70`),`decodeStorageRecord` 对非 chunk 记录原样返回(`chunk-rows.ts:339-342`),字段无损往返。
  - 线上 wire schema 也承认该字段:`host/apiproxy/src/api/sessions.schema.ts:41-49`(`ignorable: z.literal(true).optional()`)。

**所以读侧"能不能过"完全取决于写侧有没有把 `ignorable: true` 放进事件信封。** 问题收敛到:插件的实时写路径能不能做到。

## 4. 写侧:没有任何实时路径能放入该标记

### 4.1 `session.append` 没有 ignorable 选项(也无兄弟 API)

- 签名:`packages/core/session/src/index.ts:604-608`
  ```ts
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>
  ```
  第三参仅对 surface 事件存在,且类型是 `SurfaceIntent`(`types.ts:380-382`,只含 `surfaceOp`/`sourceEventSeqs`)。
- 信封由 append **内部构造**,字段写死为 `type/seq/time/data[/surfaceOp/sourceEventSeqs]`(`index.ts:632-638` 的 `deepFreeze({ type, seq, time, data, ...surfaceMetadata })`),**没有任何位置能带 `ignorable`**;事件随后 `deepFreeze` 冻结并 push 进日志,`session/event` firehose 广播的就是这个对象(`index.ts:646-653`),持久化 write-behind 原样入队(`session-persistence/src/write-behind.ts`,enqueue 收到的就是该事件)。
- 全仓搜索 `appendRaw|appendUntyped|appendEvent` 均无定义;Session 只有这一个写入口。

### 4.2 其余信封可写的路径都不适用于"实时发事件"

- **Session seed(`create`)**:`Session.create(id, seed)` / `ctx.sessions.create(id, { seed })` 接受完整信封(含 `ignorable: true`,见 §1 的 `index.ts:225-241`)。但 seed 是**构造期**回放/fork/resume 用,seed 事件**从不发布**到 `session/event`(index.ts:450-454 明确 "constructor seeds do not emit"),且构造后无法追加。插件往共享会话里实时 append,用不上这条。
- **持久化裸写(`ctx.sessionPersistence.create/append` 收原始 `SessionEvent[]`)**:技术上接受带 `ignorable: true` 的信封(测试 `coordinator-contract.ts:1374-1381` 即如此写入并成功 load)。但这会绕过实时 Session 日志:事件不进 live session、不广播,而且 write-behind 随后会把同 seq 的实时 append 再次落库,造成 seq 冲突/日志分裂。不是合法的"发会话事件"路径。

### 4.3 无任何运行时注册表可喂

搜索 `registerEventType|registerSchema|registerIgnorable|sessionEventSchema` 全仓无匹配。读侧唯一判据 `KNOWN_SESSION_EVENT_TYPES` 是**静态生成集合**(`coordinator.ts:12` 导入),没有任何 Service/注册 API 能在运行时扩充或把某类型标为可忽略。插件 `ctx` 上没有可挂的钩子。

## 5. 实时侧确认:问题只在 resume

- 投影:`SessionProjectionRegistry` 按 `SessionProjectionMap`(类型层面同样可 declaration merge)注册的 unit 驱动,未注册类型的事件不驱动任何 unit,不报错(`session-projection/src/index.ts`);`SessionEventMap` 声明合并后,`session.append('compact/mode', …)` 类型与运行时都畅通(插件 invariant 默认分支:插件自有事件不设约束,`core/session/src/invariant.ts:68-70` 注释 "Context and plugin-owned log-only events may be appended between model executions")。
- 客户端:事件折页对未知类型走"documented default"(`host/apiproxy/src/api/sessions.schema.ts:40` 注释 "the client fold handles unknown types via its documented default")。
- 因此 live 全链路(append → firehose → 投影 → 客户端徽章)都工作;**唯一断点是 resume**:持久化读侧(§3)对不在目录且无标记的事件拒绝整条日志。

## 6. 插件的现状(证据)

- `dsh-compact-mode/src/mode.ts:24-27`、`dsh-vibe-mode/src/index.ts:19-22`、`dsh-advisor/src/types.ts:23-26`、`dsh-channel-wechat/src/types.ts:23-26` —— 均以 `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`(只声明 payload 类型,声明处**没有任何 ignorable 表达位**)。
- 写侧均为 `session.append('compact/mode'|'vibe/mode'|'advisor/status'|'wechat/channel', …)`(`dsh-advisor/src/advisor.ts:243-246`、`dsh-channel-wechat/src/adapter.ts:203`),即 §4.1 的无标记路径。

## 7. 修复路径(每条都需要明确取舍)

1. **把事件声明放进 monorepo,重新生成目录**(核心包文件变更,唯一能让 resume 无感的方式)
   - 在 monorepo `packages/*/*/src/**/*.ts` 内(含 in-repo 插件包)声明 `compact/mode`、`vibe/mode`、`advisor/status`、`wechat/channel`,然后跑 `pnpm run gen-persistence-catalog` → 重写 `packages/core/session/src/known-event-types.ts` + `docs/persistence-catalog.md`;CI 的 `verify-persistence-catalog`(doc-sync 的一部分)强制目录新鲜。
   - 生成器要求成员有 string-literal 名、显式 payload 类型、JSDoc、不继承、不重复(`gen-persistence-catalog.ts:169-250`);与 `plan/mode`、`compaction/*` 的 in-repo 先例完全一致。
   - 代价:改的是核心包**生成数据文件**(运行时/逻辑零改动),与"插件仓库外置"目标冲突;若要求核心包文件一字不动,此路不通。
2. **不再发会话事件,徽章数据走别的通道**
   - 徽章/状态改由插件自有存储(如独立持久化 domain)或 `ctx.sessionProjections.register(...)`(运行时注册的投影 unit,plan 同款,`RESEARCH-WEBUI-EXTENSIBILITY.md:89-91` 所述)承载;不写 session 日志就没有 resume 拒绝问题。
   - 代价:状态不再能从会话日志重建(live 投影可保留,resume 后回到 init/默认态),需要新的状态源与一致性约定;dsh-advisor/dsh-channel-wechat 目前不发事件,本身属于这条路径的一部分。
3. **接受 resume 断点**
   - 用过这些模式的会话在 resume 时**整条日志被拒**("refusing to interpret the log",`coordinator.ts:1064`),不是跳过单个事件;用户只能清空/丢弃该会话。适合内测阶段接受,不适合任何有持久价值的会话。

## 附:对先前结论的核验

先前 worker 的结论**属实**:"`append()` 没有 ignorable 选项"——证据见 §4.1;"不存在把 out-of-tree 事件标记为 ignorable 的 API"——证据见 §4.2/§4.3(seed 与持久化裸写虽能带标记,但都不是插件的实时事件通道,且后者会造成日志分裂)。本报告的增量结论:`ignorable` 不是声明属性而是信封实例属性(§1),读侧判定是"目录 ∪ 信封标记"(§3),因此**唯一的理论写入口是信封**,而实时写路径不暴露信封,死结成立。

---

### 证据索引(文件:行)

| 事实 | 位置 |
|---|---|
| `ignorable?: true` 是信封字段 | `packages/core/session/src/types.ts:421-422` |
| 信封校验接受/限定 `ignorable: true` | `packages/core/session/src/index.ts:225-241` |
| append 签名:无 ignorable 参数 | `packages/core/session/src/index.ts:604-608` |
| append 内部构造信封(无 ignorable) | `packages/core/session/src/index.ts:632-638` |
| seed 事件不发布 firehose | `packages/core/session/src/index.ts:450-454` |
| 生成目录为纯字符串集合,无 ignorable | `packages/core/session/src/known-event-types.ts:10-19`(注释)+ `:19-45`(集合) |
| 生成器扫描范围仅 monorepo | `scripts/gen-persistence-catalog.ts:169` |
| 生成器数据结构无 ignorable 字段 | `scripts/gen-persistence-catalog.ts:68-88` |
| 读侧判定:目录 ∪ 信封标记 | `packages/session/session-persistence/src/coordinator.ts:1062-1066` |
| 读侧运行于 load/readFrom/inspect/prepare | `coordinator.ts:862-865`、`:882-885`、`:898-901`、`:1307-1310` |
| out-of-repo 事件带标记可通过(测试) | `packages/session/session-persistence/tests/coordinator-contract.ts:709-724`、`:1360-1381` |
| SQLite 标记列往返 | `packages/session/session-persistence-sqlite/src/index.ts:42`、`schema.ts:58-59,143-144,209` |
| JSONL 信封原样存储 | `packages/core/session/src/chunk-rows.ts:69-70,339-342` |
| wire schema 承认 ignorable | `packages/host/apiproxy/src/api/sessions.schema.ts:41-49` |
| 无运行时注册表(全仓无 registerSchema/registerEventType 等) | 全仓 grep 无命中 |
| 插件声明(仅 payload,无 ignorable 位) | `plugin/dsh-compact-mode/src/mode.ts:24-27`、`plugin/dsh-vibe-mode/src/index.ts:19-22`、`plugin/dsh-advisor/src/types.ts:23-26`、`plugin/dsh-channel-wechat/src/types.ts:23-26` |
| 插件实时 append | `plugin/dsh-advisor/src/advisor.ts:243-246`、`plugin/dsh-channel-wechat/src/adapter.ts:203` |
| 实时侧容忍未知事件 | `session-projection/src/index.ts`(按注册 unit 驱动)、`host/apiproxy/src/api/sessions.schema.ts:40` 注释 |
