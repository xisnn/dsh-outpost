# dsh-outpost-butler

DSH Outpost 的宿主侧管家任务运行器。它把「手机交代目标、电脑持续执行、保存进度、中断恢复、交付结果」落在 DSH 宿主里，而不是依赖手机 App 在线。

## 它做什么

- 每个任务 = 一个 DSH 会话 + 一个持久 goal；
- 由 DSH 自带的 `dsh-goal-round-driver` 自动续轮，宿主空闲时继续执行；
- 任务状态机、串行 lane、检查点、重启恢复由本插件负责；
- 检测到真人插话时暂停 goal，任务进入 `waiting_user`；
- 审批仍由 `dsh-plugin-mobile-gateway` 唯一应答；本插件只观察、不自动批准；
- 提供 owner-only 的 TaskApi：创建、列表、详情、取消、恢复。

## 安装

仓库根目录可运行 `setup-butler.ps1 -NoRestart`。手动安装时先将源码打成归档：

```bash
npm pack ./dsh-outpost-butler --ignore-scripts
```

```bash
dsh plugin --profile web add ./local-dsh-outpost-butler-0.1.0.tgz
```

不要直接安装外部源码目录：pnpm 的目录链接可能使 DSH 内置模块无法解析。
保留安装归档，并确认 web profile 的 `dsh.profile.bundles` 包含本 bundle：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-outpost-butler"] } }
}
```

依赖 DSH `0.2.x`（`engines.dsh: ">=0.2.0 <0.3.0"`），宿主重启后需要重新加载 profile。

## TaskApi

所有路由都在 `/api/outpost/butler/` 下，由 DSH 的 connection 层做 cookie/Origin/Host 校验；非 owner 会被 403。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/outpost/butler/health` | 运行状态 |
| GET | `/api/outpost/butler/tasks` | 列表；可选 `?status=` |
| GET | `/api/outpost/butler/tasks/get?id=...` | 详情 |
| POST | `/api/outpost/butler/tasks/create` | 创建；支持 `Idempotency-Key` |
| POST | `/api/outpost/butler/tasks/cancel` | `{ "id": "..." }` |
| POST | `/api/outpost/butler/tasks/resume` | `{ "id": "..." }` |

创建参数：

```json
{
  "objective": "整理本周的发布记录并生成一份 markdown 摘要",
  "cwd": "E:/work/example",
  "title": "周报整理",
  "maxGoalRounds": 32,
  "autoResume": false
}
```

## 状态机

`created → preparing → running → completed | blocked | failed | cancelled`
`running → waiting_user`（真人插话、审批超时、goal 被 disarm、turn 异常）

- 宿主重启后，`preparing/running` 一律转 `waiting_user`，不会自动续跑；
- 只有创建时 `autoResume: true`，且本次重启打断的任务没有未决审批，才在启动时尝试 `goals.resume`；已因人工插话或审批中断暂停的任务保持暂停；
- `waiting_user/blocked` 可由 TaskApi `resume` 恢复；
- `completed/blocked` 由 `goal/change` 的 phase 驱动。
- 同一时刻只跑一个任务（单 lane）；其余 `created` 任务排队。

## 设计约束

- **不依赖 requestId 去重**：发送由 goal-round-driver 负责；本插件不重复发送。
- **任务→会话映射持久化**：journal 是权威，tasks 表是可重建快照；同一 Host 内写入串行，同幂等键并发创建复用任务；journal 损坏或写入结果不确定时停止写入。
- **交付物校验**：工作区内文件附相对路径、大小与 SHA-256；手机打开前复核。不可读、目录或越界路径不提供打开入口。
- **审批不抢答**：只读 `approval/asked` / `approval/decided`，不注册审批 answerer。允许后继续；拒绝、取消、不可用、5 分钟未决时暂停 goal 并取消 turn，等待显式继续；迟到确认不自动恢复。
- **多条审批**：持久化 `pendingApprovals` 数组，保留 `pendingApproval` 首项兼容旧客户端。Host audit ID 与网关 `approvalId` 不同，各自在对应链路内对账。
- **取消先收敛**：旧 agent 仍 running 时占住串行 lane，`agent/status` 确认停稳后才能启动下一任务。
- **插话即暂停**：`user/message` 的 `source.kind === 'user'` 会触发 `goals.pause`。
- **单 host**：storageDomain 没有跨进程锁；不要让桌面端和 CLI 同时写同一 profile。

## 测试

```bash
npm test
```

单元测试用 fake ctx 覆盖任务状态机、journal 重放、幂等创建、取消/恢复、真人插话和审批超时。真实 DSH 验证使用隔离 `DSH_HOME` + 本地 mock 模型，通过 TaskApi 创建/取消/恢复任务。
