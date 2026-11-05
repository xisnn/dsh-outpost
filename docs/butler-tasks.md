# 管家任务（宿主侧持续执行）

> v0.18.2 新增。目标：手机交代目标，电脑持续执行，保存进度，中断后恢复，必要时手机审批，最后交付结果。

## 组成

| 部分 | 作用 |
|---|---|
| `dsh-outpost-butler` | DSH web profile 里的 Host bundle：任务状态机、串行 lane、持久 journal、TaskApi |
| DSH 自带 `dsh-goal-round-driver` | 宿主空闲时自动续轮，不需要手机在线 |
| 手机 App「任务」页 | 创建/查看/取消/恢复任务；任务详情里打开对应会话 |

一个任务 = 一个 DSH 会话 + 一个持久 goal。任务执行不依赖手机 WebSocket：
手机锁屏、退出 App、甚至卸载 App，只要 DSH 宿主进程还在，goal 就会继续。

## 安装

要求：DSH `0.2.x`，web profile 已包含 `@deepseek-ai/dsh-base`（默认包含 goal 与 goal-round-driver）。

### Windows 一键安装（推荐）

```powershell
.\setup-butler.ps1
```

脚本会找到 `dsh`，备份所选 profile 的清单、锁文件和配置，执行本地 bundle 安装，确保
`dsh.profile.bundles` 中只有一个管家 bundle，再检查 CLI 退出码与 `--dump-config` 的启用条目。
安装或组合失败时恢复已备份文件，并保留恢复目录；依赖目录内容无法完整回滚，需检查后重新安装依赖。

源码安装需要 Node.js/npm；脚本先运行 `npm pack --ignore-scripts`，再将归档交给 DSH CLI，
使模块留在所选 profile 内。不要直接安装外部源码目录的链接，否则 DSH 内置模块可能无法解析。

安装成功后，空闲端口可启动所选 profile；已占用端口的进程保持运行，脚本会提示手动重启。
自定义 `DSH_HOME` 会传给 CLI 和启动器。`--dump-config` 只证明配置组合成功，运行状态仍需检查 `/health`。

常用参数：

```powershell
.\setup-butler.ps1 -NoRestart          # 只安装，不重启
.\setup-butler.ps1 -Profile web -Port 3095
```

> 审批仍然需要 `.\setup-gateway.ps1` 安装移动网关；两个脚本互不替代。

### 手动安装

```bash
npm pack ./dsh-outpost-butler --ignore-scripts
```

然后用下方的归档安装命令。保留该归档，profile 的依赖清单会记录它的位置。

Release 中的 `local-dsh-outpost-butler-<bundle-version>.tgz` 也可安装：

```bash
dsh plugin --profile web add ./local-dsh-outpost-butler-0.1.0.tgz
```

bundle 自身版本与 App 版本分别管理。升级时停止所选 profile 的唯一 Host，备份 profile，
重新安装 bundle，检查 `dsh.profile.bundles` 中包含 `@local/dsh-outpost-butler`，
再重新启动。不要同时运行多个 Host。安装包 SHA-256 可用 Release 的 `SHA256SUMS.txt` 核对。

安装后重启 DSH Web。验证：

```bash
# 用 DSH 的 launch token 换 cookie 后
curl -b cookies.txt http://127.0.0.1:<port>/api/outpost/butler/health
# {"ok":true,"service":"dsh-outpost-butler","lane":null,"queued":0}
```

## 手机使用

1. 管家页右上角点「任务」；
2. 写下目标，选择工作区，设置最大轮数（默认 32）；
3. 创建后任务进入队列；同一时刻只跑一个任务；
4. 状态：
   - `执行中`：goal-round-driver 正在自动续轮；
   - `等待你`：你插话、审批超时、goal 被 disarm 或宿主重启；
   - `已阻塞`：轮数耗尽或模型报告 blocked；
   - `已完成` / `失败` / `已取消`。
5. 任务详情可以打开对应会话、继续执行、取消任务。

## 行为约定

- **手机退出不会停**：执行在 DSH 宿主；
- **宿主重启恢复**：执行中被重启打断的任务变为「等待你」；创建时勾选「宿主重启后自动继续」才会尝试续跑。已因人工插话、审批拒绝/超时而暂停的任务不自动恢复；重启前仍有未决审批的任务也需要手动继续；
- **人插话就暂停**：在任务会话里发消息会把 goal 暂停，任务进入「等待你」，需要点「继续执行」；
- **审批仍由手机网关应答**：任务详情显示全部未决审批数量，点「打开会话处理审批」进入现有审批 Dock；TaskApi 不提供批准接口。发送响应成功不等于审批已确认，确认丢失时仍保持「结果未知」锁定；
- **审批中断暂停**：允许一次后继续执行；拒绝、取消、不可用或 5 分钟未决会暂停 goal 并取消当前 turn，任务变为「等待你」。等当前 turn 停止、未决审批收敛后，才可手动「继续执行」。迟到的允许确认不会自动恢复任务；
- **审批与队列**：支持同任务多条未决审批，各自按 Host 事件 ID 对账；旧 turn 停稳前不启动下一任务。网关短暂断线时保留未决项，重连后由网关权威重放；
- **托管会话归属**：手机在发送旧管家的 prime、模式切换或 wake 控制消息前查询 Host 任务表，终态任务也保留归属；已托管会话不会再被手机自动驱动，普通显式消息仍可发送。无法确认归属时跳过自动驱动；
- **持久化**：同一个 Host 内的创建和更新串行写入 journal；同一幂等键并发创建返回同一任务。快照写失败可由 journal 重建；journal 损坏或写入结果不确定时停止继续写入，等待验证恢复；
- **单 host**：storageDomain 没有跨进程锁，不要让桌面端/CLI 同时写同一个 profile；
- **单 lane**：同一时刻一个任务；不同工作区也默认串行。

## TaskApi

所有路径在 `/api/outpost/butler/` 下，复用 DSH 的 cookie/Origin/Host 校验；非 owner 返回 403。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 运行状态 |
| GET | `/tasks` | 列表，可选 `?status=` |
| GET | `/tasks/get?id=...` | 详情 |
| POST | `/tasks/create` | 创建，支持 `Idempotency-Key` 头 |
| POST | `/tasks/cancel` | `{ "id": "..." }` |
| POST | `/tasks/resume` | `{ "id": "..." }` |

创建参数：

```json
{
  "objective": "整理本周发布记录并生成 markdown 摘要",
  "cwd": "E:/work/example",
  "title": "周报整理",
  "maxGoalRounds": 32,
  "autoResume": false
}
```

## 限制（v0.18.2 MVP）

- 只支持 auto 模式（计划模式待 v0.20）；
- 没有同工作区并行、附件目标、自动批准、远程推送、云执行；
- 电脑睡眠/关机/DSH 进程退出时任务停止；
- 交付物来自 `present`。工作区内可读的普通文件附带相对路径、大小和 SHA-256，手机打开前核对内容；文件变更后需要重新交付。无法读取或逃出工作区的路径只显示不可用说明；
- DSH 内部契约没有版本协商；升级后先跑本仓库的契约检查，再启用任务。
