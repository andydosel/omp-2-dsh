# 设计文档 v1.0:WeChat(ClawBot)通道插件(dsh)

> 状态:设计草案,等待拍板点确认后开发
> 依据:本机 hermes 源码调研 `RESEARCH-HERMES-WECHAT.md`(证据 file:line);hermes 运行数据(`~/AppData/Local/hermes/`)
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户

---

## 1. 需求

把 hermes 的"微信 ClawBot 对接"能力移植为 dsh 插件:让 dsh 通过微信与用户对话——用户在微信里给 bot 发消息,dsh agent 处理并回复(文本/媒体/正在输入)。

## 2. 调研结论(它到底是什么)

- **不是 ClawBot 网关**:hermes 的 weixin 平台直连**腾讯官方 iLink Bot API**(`https://ilinkai.weixin.qq.com`,端点 `ilink/bot/getupdates|sendmessage|getconfig|getuploadurl|get_bot_qrcode|get_qrcode_status`);`@im.bot` 账号即 iLink 机器人身份。OpenClaw 的 clawbot 走同一服务——**同账号互斥**(后启动者 403 掉消息)。
- **纯 HTTP long-poll**:入站 35s `getupdates` 长轮询 + `get_updates_buf` 游标;无 WebSocket/webhook。认证 `Authorization: Bearer {account_id}:{secret}` + `iLink-App-Id`/`ClientVersion`/`X-WECHAT-UIN` 头。
- **状态全落盘可移植**:`weixin/accounts/<id>.json`(凭据)、`.context-tokens.json`(会话续传 token)、`.sync.json`(游标,protobuf 含 token,跨实现不可复用)、`pairing/weixin-approved.json`(DM 审批)、`channel_directory.json`(渠道=用户 id)。
- **出站约束**:≤2000 字符分块 + 1.5s 块间延迟、必须回显 `context_token`、`errcode=-14` 去 token 降级重试、`-2` 退避;**不支持消息编辑**(send-final-only)、语音出站回退文件附件;媒体 AES-128-ECB 加密经腾讯 CDN。
- **授权**:账号级 QR 登录(一次性)+ DM 用户 8 位配对码审批(`WEIXIN_DM_POLICY=pairing`);群策略默认 disabled。
- **会话映射**(hermes):`agent:main:weixin:dm:{user_id}` / `group:{chat_id}[:thread][:user_id]`。
- **风险**:iLink 是**未公开的逆向协议**(端点字段/errcode/限流阈值无官方依据);群聊可用性存疑(bot 通常收不到普通群事件);与 hermes 同账号互斥。

## 3. dsh 映射(插件形态)

- **协议驱动插件**(extension cookbook 的 external protocol driver 模式):把 iLink 线上对端适配到 `ctx.agents`——入站消息 → create/resume agent 会话 → `followup`;agent 输出 → 出站分块发送。与 dsh 现有 ACP/JSON-RPC 驱动同构。
- **会话**:每个微信 peer 一个持久 dsh 会话(id 沿用 hermes 键以兼容数据);会话日志落盘(JSONL/SQLite)自动持久化。
- **存储**:凭据/context-token/配对/游标 → 插件自有存储(domain 或文件),**可复用 hermes 的 `weixin/accounts/`、`pairing/` 文件格式与目录**(零核心改动、可共存/迁移)。
- **命令**:`/wechat status`(账号/轮询/会话/用量)。
- **零核心改动**:纯插件;不碰会话模型/agent-loop/持久化 schema。

## 4. 插件结构(单包 `dsh-channel-wechat`,独立项目)

```
plugin/dsh-channel-wechat/
  src/
    index.ts            # 插件入口:启动轮询循环 + 命令注册
    ilink/
      client.ts         # HTTP 客户端:getupdates 长轮询/游标、sendmessage、getconfig、getuploadurl、CDN 上下传;请求头模拟
      crypto.ts         # AES-128-ECB 媒体加解密(注意 aes_key = base64(hex字符串) 的坑)
      media.ts          # 入站解密缓存(image/video/file/voice.silk;语音转写文本优先);出站加密上传
    adapter.ts          # 平台适配:connect/disconnect/send/send_typing/get_chat_info(镜像 hermes BasePlatformAdapter)
    inbound.ts          # 入站规范化:DM/群判定、自身消息过滤、去重(message_id+内容指纹)、防抖合并、引用前缀
    session-map.ts      # peer → dsh 会话键映射 + create/resume/followup
    outbound.ts         # 分块(2000 字符/1.5s)、context_token 回显、-14/-2 重试、send-final-only
    pairing.ts          # DM 配对码审批(复用 hermes pairing/ 文件格式)+ allowlist
    state.ts            # 凭据/context-token/游标持久化(复用 hermes 文件格式)
    config.ts           # Config 全部字段
    invariant.ts
  tests/
```

依赖(发布版 `@next`):cordis(peer)、schemastery、dsh-agent、dsh-session、dsh-llm、dsh-commands、dsh-storage(-domain)(可选,文件模式更自包含);HTTP 用 node 内置 fetch(长轮询 35s 需可配超时)。

## 5. 详细设计

### 5.1 轮询循环
- 启动:`ctx.effect` 内起单例 long-poll 循环:`POST getupdates`(超时 35s,采纳服务端 `longpolling_timeout_ms` 建议);每条消息异步处理;游标 `get_updates_buf` 落盘(启动恢复);异常退避重连(指数,可配);`ctx.effect` disposer 优雅停循环。
- 多账号:v1 单账号(hermes 同款);多账号为 v1.2(协议无阻碍,文件按 `<account_id>.json` 分片)。

### 5.2 入站
1. 取 `from_user_id`;丢弃空 sender/自身账号消息;去重(`message_id` TTL 300s + 文本 md5 指纹)。
2. `_guess_chat_type`:room/chat_room 或 `to_user_id != account_id` → group;否则 dm。
3. 策略闸门:group_policy(默认 disabled)丢弃群;dm_policy(open|allowlist|pairing|disabled)——pairing 下未知用户生成 8 位码(限流 10 分钟/人)并提示审批。
4. 存 `context_token`(按 account+peer);异步拉 typing_ticket(getconfig)。
5. 媒体:下载解密入缓存;语音若有 iLink 转写文本则用文本。
6. 文本防抖批量合并(安静 3s;末块 ≥1800 字符 5s)。
7. 构造事件 → `ctx.agents` 会话 → `followup`(user 文本;source `{kind:'user'}`)。

### 5.3 出站
- agent 输出 → `adapter.send()`:`MEDIA:` 标签/裸路径先发媒体;文本 ≤2000 字符分块、块间 1.5s;每条带 `context_token`、随机 `client_id`;`-14` 去 token 降级重试一次并清缓存、`-2` 3x 退避;send-final-only(无流式编辑);typing start/stop 用 ticket(缓存 600s)。
- 媒体出站:`getuploadurl` → 本地 AES 加密 → POST CDN(注意 POST 非 PUT)→ 取 `x-encrypted-param` → sendmessage 携带媒体 item;语音回退文件附件。

### 5.4 会话与持久化
- 会话键:DM `agent:main:weixin:dm:{user_id}`、群 `agent:main:weixin:group:{chat_id}[:thread][:user_id]`(对齐 hermes,可迁移 state)。
- context-tokens.json 按 (account, peer) 持久化;游标 .sync.json 持久化;凭据 accounts/<id>.json。
- 与 hermes 共存:仅当不同账号或 hermes 已停(同账号互斥)。

### 5.5 命令与配置

```yaml
- id: channel-wechat
  name: '@dsh-plugin/dsh-channel-wechat'
  config:
    enabled: true
    accountId: ''            # 如 c5610f3ce386@im.bot
    token: ''                # {account_id}:{secret}
    baseUrl: 'https://ilinkai.weixin.qq.com'
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c'
    dmPolicy: pairing        # open|allowlist|pairing|disabled
    allowedUsers: []
    groupPolicy: disabled    # disabled|open|allowlist
    groupAllowedUsers: []
    homeChannel: ''          # 默认投递目标(工具/cron)
    longPollTimeoutMs: 35000
    sendChunkDelaySeconds: 1.5
    sendChunkRetries: 4
    splitMultilineMessages: false
    stateDir: ''             # 空 = $DSH_HOME/wechat(可指向 hermes 目录以共存)
```

## 6. 拍板点(待确认)

1. **账号策略**:停 hermes、dsh 接管同一 iLink 账号(推荐:复用现有配对/账号数据,`stateDir` 指向 hermes 的 `weixin/`);还是独立新 bot 账号(可并存)?
2. **逆向协议风险**:iLink 无官方文档,限流/字段/断更可能变化——接受即做(推荐接受,hermes 已在用同协议证明可行)。
3. **群聊**:默认只做 DM(群投递不可靠,hermes 亦默认 disabled)——确认?
4. **存储兼容**:复用 hermes 文件格式(accounts/pairing/context-tokens,可共存迁移)vs 全新自有存储——推荐复用。
5. **包名**:`dsh-channel-wechat`——确认?
6. **端到端验证前提**:免 key 只能 mock HTTP 单测;真实收发需一个可用 iLink 账号(需停 hermes 或新账号)——接受此外部前提?

## 7. 风险

- 逆向协议:字段/限流/断更无官方依据;实现按 hermes 现有行为为基准,预留配置化。
- 同账号互斥:与 hermes 同开必冲突(403);文档明示 + 启动前检查(可选)。
- 群聊不可靠:默认 disabled;群支持标记为实验性。
- context_token/typing_ticket 生命周期为代码推断值,需实测调参。
- 语音出站原生不可用(文件附件回退);.silk 转写依赖 iLink 侧。

## 8. 验证(免 API key)

`constraints`/`typecheck`/`build` + 单测(mock HTTP):轮询循环(游标持久化/重连/优雅停)、入站规范化(去重/防抖/群判定/自身过滤)、出站分块(2000 字符/1.5s/context_token 回显/-14 降级/-2 退避)、配对审批(8 位码/哈希/限流)、媒体(加解密 fixture、aes_key base64(hex) 坑)、会话映射与持久化(文件格式与 hermes 兼容)、命令。真实端到端需 iLink 账号(外部前提)。

## 9. 变更记录

- **v1.0**(2026-08-17):初始设计,等待拍板点确认。
