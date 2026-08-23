# 设计文档 v1.0:vibe 异步 worker UI(async wait + 完成自送达 + worker 列表)

> 状态:设计定稿(拍板点全部确认),开发中
> 依据:omp worker/steer 语义;`RESEARCH-WEBUI-EXTENSIBILITY.md`(证据 file:line);vibe 会话模型调研
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户

---

## 1. 需求

- **async wait**:请求派发后不阻塞主会话,支持 await 续接;完成结果**自送达**(steer 回主会话)。
- **worker 列表 UI**:右侧 dock 展示活跃 worker 状态、可进入/返回主会话。
- **vibe/workers 事件**:vibe 模式广播 worker 生命周期事件,驱动 UI 与 annex 再生成。

## 2. 决策记录(全部确认)

- **A1 有界首查 + 用户消息打断**:首查有界(等待窗口上限),用户发消息可打断 await。
- **A2 steer 自送达(ack 防双投)**:worker 完成经 steer 主动送达主会话;ack 机制防止结果重复投递。
- **A3 超时只通知**:await 超时仅通知主会话,不自动决定去留。
- **A4 删除 waitMode**:异步为唯一模式;阻塞 = 退出 vibe 模式。
- **C1 不新开 vibe_status**:不做独立查询工具,worker 信息查询走 `read agent://<sessionId>`。
- **C2 omp 四态 + starting**:worker 状态采用 omp 四态(live/parked/released…)并新增 `starting` 态。
- **C3 右侧 dock + 默认隐藏已完成 + 返回主会话按钮**:UI 形态定为右侧 dock,默认折叠已完成 worker,提供返回主会话按钮。
- **C4 vibe/workers 事件 + annex 再生成**:vibe 模式广播 workers 事件,触发 annex 信息再生成。

## 3. 实现分工

- **host(async/settings/投影)**:异步执行、设置项、状态投影。
- **client dock + settings 面板**:右侧 dock UI 与设置面板。
- **read agent://**:worker 信息查询(`read agent://<sessionId>`)。
- **annex + api-proxy +1 行**:api-proxy 白名单追加(`settings-not-exposed` 门控),annex 配套。

## 4. 变更记录

- **v1.0**(2026-08-21):初始定稿。
