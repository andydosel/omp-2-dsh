# dsh-channel-wechat

微信(Tencent iLink Bot / 「ClawBot」)渠道插件,可**独立安装**进任意 dsh profile:
host 侧长轮询 iLink `getupdates`,把每个微信 peer 映射成稳定的 dsh 会话,把助手输出
分段发回微信;浏览器侧自带**会话头部 WECHAT 徽标**与 `wechatChannel` 投影。
不依赖本套件其它插件,也不依赖 `dsh-util` / `dsh-mode-ui`。

## 包里有什么

| 面 | 内容 |
|---|---|
| host(`lib/index.js`,行 `channel-wechat`) | iLink 长轮询、按 peer 的会话复用、分段发送/重试、`/wechat` 命令、DM 配对、媒体 |
| client(`lib/client.js`) | `conversation.session.header.utilities` 座位的 `WECHAT on/off` 徽标(点击执行 `/wechat status`),读取 host 侧的 `wechatChannel` 投影 |
| bundle(`cordis.patch.yml`) | 一行 `insert`:`id: channel-wechat` / `name: '@dsh-plugin/dsh-channel-wechat'`,默认配置见文件内注释 |

## 独立安装

前置:**Node ≥ 24**;**dsh ≥ 0.2.1-rc.2**(0.2.0-rc.2 会禁用插件行)。

> 若全局 `dsh` 仍是 0.2.0-rc.2,把下文的 `dsh` 换成 dsh monorepo 里的本仓 CLI:
> `node <dsh仓库>\apps\cli\lib\bin.js`(本机即 `C:\Users\Vantage_XLST\Documents\dsh`)。

1. 包内构建(源码安装时必需;Release 包已带 `lib/`):

   ```powershell
   cd C:\path\to\omp-2-dsh\plugins\dsh-channel-wechat
   pnpm install        # 套件仓库根已 install 过则跳过;单独 clone 时在本包目录执行
   pnpm run build      # tsc host + tsc client + tsdown --env.DSH_BUILD_FACE client
   ```

   产物:`lib/index.js`(host)、`lib/client.js`(浏览器 bundle)、`lib/status-projection.js`。

2. 装进任意 profile(示例名 `my-wechat`;写进已有 `web` profile 也可以):

   ```powershell
   dsh plugin --profile my-wechat add C:\path\to\omp-2-dsh\plugins\dsh-channel-wechat
   ```

   `dsh plugin add` 会把包写成 profile 的 `dependencies`(本地目录为 `link:`),并把本包的
   bundle 追加到该 profile `package.json` 的 `dsh.profile.bundles`;首次使用会自动初始化
   profile(只含 `@deepseek-ai/dsh-base`)。**新 profile 若要浏览器界面**,把
   `@deepseek-ai/dsh-web-app` 也加进 `dsh.profile.bundles`。

3. 填 iLink 凭证(见下节「连接微信」),然后启动:

   ```powershell
   dsh --profile my-wechat --no-open --port 3097
   ```

4. 验证配置层与客户端面:

   ```powershell
   dsh --profile my-wechat --dump-config | Select-String -Context 0,8 'dsh-channel-wechat'
   ```

   末尾应出现 `# == @dsh-plugin/dsh-channel-wechat` 段与 `- id: channel-wechat` 行;启动后
   页面 `__DSH_BOOT__` 里应出现 `@dsh-plugin/dsh-channel-wechat/client.js` 条目。

5. 卸载:

   ```powershell
   dsh plugin --profile my-wechat remove @dsh-plugin/dsh-channel-wechat
   ```

## 配置

默认值随包内 `cordis.patch.yml` 安装;想改就**按 id 覆盖**该 profile 的 `cordis.patch.yml`
(同名行 `- id: channel-wechat` 整体替换),或直接改
`node_modules/@dsh-plugin/dsh-channel-wechat/cordis.patch.yml`。**未知配置键会让插件启动失败**
(strict keys),拼写请对照 `src/config.ts`。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 挂载但不轮询,`/wechat` 仍可用并提示已禁用 |
| `accountId` | `''` | iLink bot 账号 id,形如 `c5610f3ce386@im.bot`(hermes 的 `WEIXIN_ACCOUNT_ID`)。空 = 通道不启动 |
| `token` | `''` | iLink token,形如 `{account_id}:{secret}`(hermes 的 `WEIXIN_TOKEN`)。空 = 通道不启动 |
| `stateDir` | `''` | 状态目录;空 = `$DSH_HOME/wechat`。可指向 hermes 的 `weixin/` 目录接管 `accounts/`、`pairing/` |
| `dmPolicy` | `pairing` | `open` / `allowlist` / `pairing` / `disabled` |
| `allowedUsers` | `[]` | `dmPolicy: allowlist` 时的微信 user id 列表 |
| `groupPolicy` | `disabled` | `disabled` / `open` / `allowlist` |
| `groupAllowedUsers` | `[]` | 群 allowlist |
| `homeChannel` | `''` | 可选:默认通知/投递的微信会话 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink API 根 |
| `cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体 CDN |
| `longPollTimeoutMs` | `35000` | `getupdates` 长轮询超时 |
| `sendChunkDelaySeconds` / `sendChunkRetries` / `sendChunkRetryDelaySeconds` | `1.5` / `4` / `1.0` | 分段发送节流与重试 |
| `splitMultilineMessages` | `false` | 多行消息是否按行拆分 |
| `textBatchDelaySeconds` / `textBatchSplitDelaySeconds` | `3.0` / `5.0` | 入站文本合批窗口 |
| `groupSessionsPerUser` / `threadSessionsPerUser` | `true` / `false` | 群/线程会话粒度 |

## 连接微信(用户要做什么)

1. **准备一个 iLink bot 账号**。本插件**没有扫码登录界面**:它用现成的 iLink bot 凭证直连
   腾讯 iLink API,凭证来源是既有部署(例如 hermes 的 `~/.hermes/.env` 里的
   `WEIXIN_ACCOUNT_ID` 与 `WEIXIN_TOKEN`)。没有 bot 账号则需要先按 iLink 机器人平台流程申请
   (一次性二维码登录由 hermes 的 `hermes gateway setup` → Weixin 项完成,扫码确认后
   `WEIXIN_ACCOUNT_ID`/`WEIXIN_TOKEN` 就写进 hermes 的 `.env`;本插件直接复用这两个值)。
   本机从 hermes 取值:

   ```powershell
   Select-String -Path "$env:LOCALAPPDATA\hermes\.env" -Pattern '^WEIXIN_(ACCOUNT_ID|TOKEN|BASE_URL|CDN_BASE_URL)='
   ```

   把 `accountId`/`token` 填进 profile 覆盖层(下一节),`stateDir` 建议指向
   `$env:LOCALAPPDATA\hermes\weixin`。
2. **同一账号只能有一个网关在线**(后启动者会被 403 掉消息)。如果 hermes 正在用这个账号:
   先停掉 hermes 网关(`hermes gateway stop`,或 `hermes -p <profile> gateway stop`);或保持
   hermes 停用,把 `stateDir` 指向 hermes 的 `weixin/` 目录
   (`C:/Users/<you>/AppData/Local/hermes/weixin`)以复用 `accounts/` 与 `pairing/`。
   插件会按 `stateDir` 是否为 `.../weixin` 自动把配对目录落到 hermes 的 `pairing/`。
3. 在 profile 配置里填 `accountId` / `token`(留空则通道不启动,日志会打印
   `startup skipped: ... accountId is required`),重启 dsh。推荐在该 profile 的
   `cordis.patch.yml` 里按 id 覆盖(不改包内默认值):

   ```yaml
   - id: channel-wechat
     config:
       accountId: '<your-account-id>@im.bot'
       token: '<your-account-id>@im.bot:<secret>'
       stateDir: 'C:\Users\<you>\AppData\Local\hermes\weixin'
   ```
4. 自检:在 dsh 里执行 `/wechat status`,应看到 `poll: running` 与账号信息;浏览器会话页
   **头部右上角 utilities 区**的 `WECHAT on` 徽标点亮(点击 = 执行 `/wechat status`)。
5. 配对(默认 `dmPolicy: pairing`):让同事在微信里给 bot 发一条消息,对方会收到 8 位配对码;
   你在 dsh 里 `/wechat pairing pending` 查看,再 `/wechat pairing approve <code>` 批准。
   其它命令:`/wechat pairing list`、`/wechat pairing revoke <user_id>`、`/wechat pairing clear-pending`、
   `/wechat status`、`/wechat config`。

> 没有凭证时插件仍会加载(徽标显示 `WECHAT off`),`/wechat` 会回答「配置未通过启动检查」,
> 不会崩溃也不会发网络请求。

## 与套件的关系

- **没有 `@dsh-plugin/*` 运行时 import**;需要的小工具都在本包内。
- 徽标与 `wechatChannel` 投影原本在 `dsh-mode-ui`,现已随本包发布。槽位 id 为
  `wechat-channel`(mode-ui 旧副本是 `mode-ui-wechat`),两者可短暂共存,收尾时移除 mode-ui 里的那一半。
- 不依赖 `dsh-task-board` / `dsh-question-board` / `dsh-util`。

## 已知限制

- 需要真实 iLink bot 账号才能验证收发;仓库内测试(`pnpm test`)覆盖协议解析、配对、分段发送、
  启动/命令路径,但不触网。
- 无二维码登录/扫码绑定流程;不支持同时托管多个 bot 账号(一个 profile 一行)。
- 与 hermes / OpenClaw 共用同一 iLink 账号时互斥。
