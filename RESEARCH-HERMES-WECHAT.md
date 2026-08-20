# Hermes 微信（WeChat ClawBot）集成研究报告

> 只读调研（未修改任何文件）。源码：`~/AppData/Local/hermes/hermes-agent`（HEAD cb3e41e2f）；
> 运行数据：`~/AppData/Local/hermes`（`.env`、`weixin/accounts/*`、`pairing/*`、`channel_directory.json`、`logs/gateway.log`）。
> 目的：为 dsh「WeChat ClawBot channel」插件移植提供依据。行号均以当前 HEAD 为准。

---

## 1. 集成到底是什么：腾讯 iLink Bot API（不是 ClawBot 网关）

**结论：Hermes 的 weixin 平台不连接任何 ClawBot/OpenClaw 网关，而是直连腾讯官方的 iLink Bot API**（`ilinkai.weixin.qq.com`）。`@im.bot` 账号即 iLink 机器人身份。OpenClaw 的微信支持（clawbot / `openclaw-weixin`）走的是**同一个 iLink 服务**——两者对同一账号是互斥的（HermesClaw 项目文档明确：两个网关同时开，后启动的会拿到 403 并掉消息，需代理分流）。

- 模块 docstring：`gateway/platforms/weixin.py:1-14` —— "Connects Hermes Agent to WeChat personal accounts via Tencent's iLink Bot API. Long-poll getupdates drives inbound delivery…"
- Hermes README 只把 [HermesClaw](https://github.com/AaronWong1999/hermesclaw)（"Community WeChat bridge: Run Hermes Agent and OpenClaw on the same WeChat account"）列为社区桥（`README.md:208`）；HermesClaw 架构图确认 Hermes/OpenClaw/OpenCode 三脑共用**一个 iLink 账号**，各自原生处理媒体解密与 AI 交互。

### 1.1 服务端点（全部为 HTTP POST/GET，JSON）

```
gateway/platforms/weixin.py:72-84
ILINK_BASE_URL      = "https://ilinkai.weixin.qq.com"
WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
EP_GET_UPDATES      = "ilink/bot/getupdates"      # 长轮询拉取消息（入站）
EP_SEND_MESSAGE     = "ilink/bot/sendmessage"     # 发文本/媒体（出站）
EP_SEND_TYPING      = "ilink/bot/sendtyping"      # 正在输入（需要 typing_ticket）
EP_GET_CONFIG       = "ilink/bot/getconfig"       # 拿 typing_ticket
EP_GET_UPLOAD_URL   = "ilink/bot/getuploadurl"    # 媒体上传预授权（拿 CDN URL + aeskey 约定）
EP_GET_BOT_QR       = "ilink/bot/get_bot_qrcode"  # QR 登录第一步
EP_GET_QR_STATUS    = "ilink/bot/get_qrcode_status"  # QR 登录轮询
```

- **传输**：纯 HTTP(S)，无 WebSocket/webhook。入站是 **long-poll**：`POST getupdates`，默认超时 35s（`LONG_POLL_TIMEOUT_MS = 35_000`，`:86`），服务端可返回 `longpolling_timeout_ms` 建议值，轮询循环采纳（`:1337-1341`）。用 `get_updates_buf` 作为游标（见 4.3）。
- **认证**（`:210-225` `_headers`）：`Authorization: Bearer <token>`，另带 `AuthorizationType: ilink_bot_token`、`iLink-App-Id: bot`、`iLink-App-ClientVersion`（`(2<<16)|(2<<8)|0`）、随机 `X-WECHAT-UIN`。
- **token 格式**：`.env:448` `WEIXIN_TOKEN=c5610f3ce386@im.bot:06000068c69ce61d598e886562badd5eddae9f`，即 `{account_id}:{secret}`。
- **会话/上下文**：出站每条消息必须回显入站时收到的 `context_token`（docstring `:8-9`）；会话过期 `errcode=-14`，频率限制 `errcode=-2`（`:94-95`）。
- **媒体**：AES-128-ECB 加密后走腾讯 CDN（`novac2c.cdn.weixin.qq.com/c2c/upload|download?encrypted_query_param=…`，`:338-345`），SSRF 白名单 `:647-657`。媒体项内嵌 `aes_key`（注意：给 API 的 `aes_key` 是 **base64(hex字符串)**，不是 base64(原始字节)，`:2037-2042` 注释有专门踩坑说明）。

### 1.2 配对/审批流（`pairing/weixin-approved.json`）

两级「配对」：

1. **账号级 QR 登录**（一次性）：`hermes gateway setup` → `hermes_cli/gateway.py:4978 _setup_weixin()` → `qr_login()`（`weixin.py:1003-1136`）：`GET get_bot_qrcode?bot_type=3` → 终端渲染二维码 → 轮询 `get_qrcode_status?qrcode=<hex>`，状态机 `wait → scaned → (scaned_but_redirect: 换 redirect_host 作 base_url) → expired(刷新，最多3次) → confirmed`；confirmed 返回 `ilink_bot_id / bot_token / baseurl / ilink_user_id`，写入 `weixin/accounts/<id>.json`（`:236-248`）。
2. **DM 用户审批**（`WEIXIN_DM_POLICY=pairing`）：未知用户发 DM → gateway 生成 8 位配对码发给用户（`run.py:7523-7553`，限流 10 分钟/人），owner 执行 `hermes pairing approve weixin <code>`（`hermes_cli/pairing.py:69`）→ 写入 `pairing/weixin-approved.json`。配对码只存 SHA-256 哈希 + salt（`gateway/pairing.py:204-260`，`ALPHABET` 32 字符无 0/O/1/I，1 小时过期，每平台最多 3 个 pending，5 次失败锁 1 小时 `:44-52`）。授权判定在 `run.py:7207 if self.pairing_store.is_approved(...)`。

---

## 2. 消息流（入站/出站）与会话映射

### 2.1 入站

`_poll_loop`（`:1316`）长轮询 → 每条 msg 异步 `_process_message`（`:1382`）：

1. 取 `from_user_id`；丢弃空 sender、自身账号消息；去重：`message_id` TTL 300s + 文本 md5 内容指纹（`:96,1390-1400`）。
2. `_guess_chat_type`（`:361-368`）：有 `room_id`/`chat_room_id`，或 `to_user_id != account_id 且 msg_type==1` → group；否则 dm。群 id 取 room_id 或 to_user_id；`get_chat_info` 用 `chat_id.endswith("@chatroom")` 判群（`:2139-2141`）。
3. 策略闸门（intake 内先于 gateway 授权，`enforces_own_access_policy=True` `:1458`）：`group_policy`（默认 disabled）→ 群直接丢弃；`dm_policy`（默认 open；本机为 pairing，`.env:451`）→ `_is_dm_allowed`（`:1452`）。
4. 存 `context_token`（`ContextTokenStore` `:268-315` → `weixin/accounts/<id>.context-tokens.json`，键为 account+peer）；异步拉 `typing_ticket`（`getconfig`，`:1624-1640`）。
5. 媒体：`item_list` 逐项下载解密入缓存（图片 jpg / 视频 mp4 / 文件原名 / 语音 silk，`:1552-1620`）；语音若 iLink 已给转写文本（`voice_item.text`）则直接用文本（`:941-966 _extract_text`，含引用消息 `ref_msg` 前缀处理）。
6. 文本防抖批量合并（`:1468-1530`）：同会话快速连续文本合并，安静 3s（末块 ≥1800 字符用 5s）后派发。
7. 构造 `MessageEvent` → `build_source(chat_id=effective_chat_id, chat_type, user_id=sender_id, user_name=sender_id)`（`:1427-1436`）→ `handle_message(event)`（`base.py:3809`）。

**会话映射**（`gateway/session.py:600-666 build_session_key`）：
- DM：`agent:main:weixin:dm:{chat_id}`
- 群：`agent:main:weixin:group:{chat_id}[:thread][:user_id]`（`group_sessions_per_user` 默认 True 时按用户隔离）
- 运行实例实测：`agent:main:weixin:dm:o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat`（`logs/gateway.log:6377-6410`）。

**平台接入架构**（dsh 移植参照）：adapter 继承 `BasePlatformAdapter`（`base.py:1785`），`connect()/disconnect()/send()/send_typing()/get_chat_info()` 为抽象必实现，媒体为可选（`gateway/platforms/ADDING_A_PLATFORM.md` 完整清单）；插件路径零核心改动：`plugin.yaml` + `adapter.py` 通过 `ctx.register_platform()` 注册（`platform_registry.py` `PlatformEntry`：`env_enablement_fn / apply_yaml_config_fn / cron_deliver_env_var / standalone_sender_fn` 钩子）。

### 2.2 出站

agent 响应 → `adapter.send()`（`:1744-1810`）：

1. 解析 `MEDIA:` 标签与裸本地路径（`extract_media/extract_local_files`，`base.py:2886,2970`），媒体先发。
2. 文本 `_split_text`（`:879-939`）：默认 compact 单条（≤2000 字符）；超长按 markdown block 打包；`split_multiline_messages=true` 时按行拆气泡（legacy）。
3. 每条 chunk：`_send_message`（`:438-472`，`message_type=2 bot`、`message_state=2 finish`、`item_list=[{type:1,text_item:{text}}]`，带 `context_token`、随机 `client_id`）；块间延迟 1.5s（`WEIXIN_SEND_CHUNK_DELAY_SECONDS`），失败重试 4 次（`:1648-1740`）。
4. 错误处理：`errcode=-14` 会话过期 → 去掉 `context_token` 降级重试一次并清缓存；`-2` 频率限制 → 3x 退避；`-14/-2` + errmsg "unknown error" 视为过期会话而非限流（`:91-99`）。
5. 流式：`SUPPORTS_MESSAGE_EDITING = False`（`:1145`）→ 不支持编辑/草稿动画，走 "send-final-only"，最终一次性发完整消息。
6. Typing：`send_typing/stop_typing`（`:1811-1846`）用 getconfig 的 `typing_ticket`（缓存 600s）发 `status 1/2`。
7. 媒体出站 `_send_file`（`:1972-2068`）：`getuploadurl`（带 filekey、rawsize、rawfilemd5、filesize=AES padded size、aeskey hex）→ 本地 AES-128-ECB 加密 → POST CDN（优先 `upload_full_url`，回退构造 URL；**POST 而非 PUT**）→ 取响应头 `x-encrypted-param` → `sendmessage` 携带媒体 item（image/video/file/voice，`encrypt_type:1`）。语音出站不保证原生气泡，回退为文件附件（`:1864-1885` 注释 "not proven-working"）。

---

## 3. 配置与 CLI 面

### 3.1 `.env`（本机实际值，`:447-456`）

```
WEIXIN_ACCOUNT_ID=c5610f3ce386@im.bot
WEIXIN_TOKEN=c5610f3ce386@im.bot:06000068c69ce61d598e886562badd5eddae9f
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
WEIXIN_DM_POLICY=pairing        # open | allowlist | disabled | pairing
WEIXIN_ALLOW_ALL_USERS=false
WEIXIN_ALLOWED_USERS=
WEIXIN_GROUP_POLICY=disabled    # disabled | open | allowlist
WEIXIN_GROUP_ALLOWED_USERS=
WEIXIN_HOME_CHANNEL=o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat
```

另有可选：`WEIXIN_SEND_CHUNK_DELAY_SECONDS`(1.5)、`WEIXIN_SEND_CHUNK_RETRIES`(4)、`WEIXIN_SPLIT_MULTILINE_MESSAGES`(false)、`WEIXIN_HOME_CHANNEL_NAME`（`weixin.py:1147-1200`，`config.py:1727-1735`）。

### 3.2 配置装配

- `gateway/config.py:1694-1735 _apply_env_overrides()` 把 `WEIXIN_*` 映射到 `PlatformConfig.extra`：`account_id/token/base_url/cdn_base_url/dm_policy/group_policy/allow_from/group_allow_from/split_multiline_messages/home_channel`。也可在 `config.yaml` 写 `gateway.platforms.weixin.extra.*`（本机 config.yaml **无** weixin 段，纯 env 驱动）。
- 连接判定：`account_id` 与 token 都非空（`config.py:425,524-527`）。`check_weixin_requirements()` = aiohttp + cryptography（`:156`）。
- 单账号：`Platform.WEIXIN` 是单例枚举（`config.py:126`），每次 gateway 只有一个 weixin adapter（`run.py:6962 _create_adapter`）；账号凭据按文件持久化可换账号（`load_weixin_account` 回填 `weixin.py:1200-1203`）。

### 3.3 CLI

| 命令 | 位置 |
|---|---|
| `hermes gateway setup` → Weixin/WeChat 项：QR 登录 → DM 策略 → 群策略 → home channel | `hermes_cli/gateway.py:4261-4264, 4978-5134` |
| `hermes pairing {list\|approve\|revoke\|clear-pending}` | `hermes_cli/pairing.py:11-116` |
| `hermes gateway status`（Weixin 行：ACCOUNT_ID / HOME_CHANNEL） | `hermes_cli/status.py:438` |
| send_message 工具/cron：`WEIXIN_HOME_CHANNEL` 为默认投递目标，目标正则 `wxid_/gh_/v\d+_/wm_/wb_/@chatroom/filehelper` | `tools/send_message_tool.py:32,232-272`；`cron/scheduler.py:138` |

---

## 4. 渠道/账号数据模型（运行数据实拍）

| 文件 | 结构 | 说明 |
|---|---|---|
| `weixin/accounts/c5610f3ce386@im.bot.json` | `{token, base_url, user_id, saved_at}` | 账号凭据（`weixin.py:236-248`） |
| `weixin/accounts/c5610f3ce386@im.bot.context-tokens.json` | `{peer_user_id: context_token}` | 会话续传 token，按 account+peer 键（`:268-315`） |
| `weixin/accounts/c5610f3ce386@im.bot.sync.json` | `{get_updates_buf}` | 长轮询游标（base64，内含 protobuf 字段且**嵌着 account_id:token**，跨实现不可复用） |
| `pairing/weixin-approved.json` | `{user_id: {user_name, approved_at}}` | 已批准 DM 用户 |
| `pairing/weixin-pending.json` | `{entry_id: {hash, salt, user_id, user_name, created_at}}` | 待批准（码只存哈希） |
| `pairing/_rate_limits.json` | `{"weixin:<uid>": ts, "_failures:weixin": n, "_lockout:weixin": ts}` | 限流/锁 |
| `channel_directory.json` | `platforms.weixin[] = {id, name, type, thread_id}` | channel id = **用户 id**（DM）；由 session 历史回填（`channel_directory.py _build_from_sessions`，weixin 无主动枚举） |

- 标识格式：bot 账号 `<16hex>@im.bot`；用户 `<~26位字母数字下划线>@im.wechat`；群疑似 `<…>@chatroom`（未实测）。
- 本机唯一 channel：`o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat`（DM，type="dm"），与 `WEIXIN_HOME_CHANNEL`、approved 列表、context-tokens 键完全一致——即账号 owner 自己。

---

## 5. dsh「WeChat ClawBot channel」插件最小实现面 + 开放问题

### 5.1 必须实现（对照 Hermes `WeixinAdapter`）

1. **iLink HTTP 客户端**：`getupdates` 35s 长轮询（含 `get_updates_buf` 游标持久化）、`sendmessage`、`getconfig`、`getuploadurl`、CDN `upload/download`；全部请求头模拟（`Authorization: Bearer <token>`、`AuthorizationType: ilink_bot_token`、`iLink-App-Id: bot`、`iLink-App-ClientVersion`、`X-WECHAT-UIN`）。
2. **出站文本**：≤2000 字符/条、分块 + 块间延迟、`context_token` 回显、errcode -14 去 token 降级重试、-2 退避；`SUPPORTS_MESSAGE_EDITING=false`（无编辑流式）。
3. **入站规范化**：DM/群判定、自身消息过滤、message_id+内容指纹去重、文本防抖合并、`/命令` 识别、引用（ref_msg）前缀。
4. **会话映射**：DM/群 → 会话键（对齐 hermes `agent:main:weixin:dm:{user_id}` 以复用 state）；`context-tokens.json` 持久化。
5. **授权**：DM 配对码审批（或对接 hermes 的 `pairing/` 文件格式）+ allowlist/allow-all；群策略。
6. **媒体**：入站 AES-128-ECB 解密缓存（image/video/file/voice.silk，语音转写文本优先）；出站加密上传（`aes_key = base64(hex)` 坑！）。
7. **Typing**：`getconfig` 拉 ticket → `sendtyping` start/stop。
8. **可配置面**：`account_id/token/base_url/cdn_base_url/dm_policy/group_policy/allow_from/home_channel/send 延迟与重试/分块策略`。

### 5.2 开放问题（代码无法确定）

1. **iLink 是未公开的逆向协议**：端点/字段/errcode 语义无官方文档；`get_updates_buf` 是 protobuf 且内含 token，跨实现不可直接复用游标。若 dsh 与 hermes 同账号运行会**独占冲突**（HermesClaw 方案：代理化 base_url，dsh 可作为唯一 poller 转发，或复用其代理）。
2. **群聊可用性存疑**：`connect()` 明确警告 iLink bot 身份通常无法被拉进普通微信群、iLink 一般不投递群事件（`:1279-1288`）——群支持可能只在特定账号类型生效，`@chatroom` 格式未验证。
3. **context_token 生命周期**：何时过期（-14）、tokenless 降级发送的边界、`getconfig` 何时返回 `typing_ticket` 及其 600s TTL 都是推测值。
4. **语音出站不可用**（原生气泡未证实，只能文件附件）；`.silk` 转写为文本依赖 iLink 侧行为。
5. **多账号**：hermes 单例实现；dsh 若要多账号需自行管理多组凭据 + 多轮询循环（协议层无阻碍，凭据文件按 `<account_id>.json` 已天然分片）。
6. **限流具体阈值**未知（只有 -2 信号 + 指数退避），dsh 需自行调参验证。

---

## 关键结论（5 条）

1. **Hermes 微信对接 = 腾讯官方 iLink Bot API 直连**（`ilinkai.weixin.qq.com`，`ilink/bot/*` 端点），不是连接 ClawBot/OpenClaw 网关；"ClawBot" 与 Hermes 是同一服务的两个客户端，同账号互斥。
2. **纯 HTTP long-poll 长连接式**：`getupdates`（35s）+ `sendmessage` + `getconfig` + `getuploadurl` + CDN 上传下载，AES-128-ECB 媒体加密，`Bearer {account_id}:{secret}` 认证，无 WebSocket/Webhook。
3. **状态全落盘、可移植**：`weixin/accounts/<id>.json`（凭据）、`.context-tokens.json`（会话续传）、`.sync.json`（轮询游标）、`pairing/weixin-approved.json`（DM 审批）、`channel_directory.json`（渠道=用户 id）——dsh 可直接读写同一目录格式与 hermes 共存。
4. **出站限制明确**：2000 字符分块 + 1.5s 延迟、不支持消息编辑（send-final-only）、必须回显 `context_token`、-14 过期去 token 降级、语音出站回退文件。
5. **最小插件面已收敛**：一个 iLink 客户端 + BasePlatformAdapter 式接口（connect/disconnect/send/send_typing/get_chat_info + 媒体收发 + 配对审批 + 会话映射），对照 `gateway/platforms/ADDING_A_PLATFORM.md` 的插件路径即可。
