# 管家模式的工具配置

## 问题：提示词写了，工具却没有

`butler.ts` 里写着：

> 派活前**一定先 list_agents**，看现有队员里有谁
> 有对口的 → 用 **send_message** 让他继续做
> 没有 → 才 **spawn_teammate** 新建

但 DSH 默认**没有启用**这些工具。查插件列表能看到：

```
include:tool-subagent-control      enabled=false   ← send_message / interrupt_agent
include:tool-subagent-list-agents  enabled=false   ← list_agents
include:tool-subagent              enabled=false   ← spawn_teammate
include:tool-subagent-fork         enabled=false   ← fork 模式
```

底层服务（`dsh-subagent` / `-spawn-in-process` / `-fork-in-process`）都是 active，
只是**模型面的工具被 shipped patch 标成了 disabled**。

后果：提示词的所有派活指令全部落空 —— 模型找不到工具，只能自己干。
这解释了为什么「管家能自己干活」，不是提示词生效了，是它根本没法派活。

## 修法：用 `disabled: false` 覆盖

在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 末尾加：

```yaml
- id: tool-subagent-control
  disabled: false
- id: tool-subagent-list-agents
  disabled: false
- id: tool-subagent
  disabled: false
- id: tool-subagent-fork
  disabled: false
```

然后重启 DSH Web。

### 为什么不是 insert 新行

DSH 官方的 plugin-development 说明写得很清楚：

> A shipped bundle can resolve a plugin row and leave it `disabled`.
> The row id and its reason are in the shipped patch.
> **Write a workspace bundle whose patch overrides that row with `disabled: false`**
> and inserts the Host rows it depends on.

**patch 是覆盖已有行，不是插入。** 我一开始试图用 `- id: tool-subagent-control` +
`name:` 重新定义整个条目，被静默忽略了 —— 因为 shipped patch 里那一行已经存在，
插入同 id 不生效。

只写 `disabled: false`，其余字段继承原有定义，这样最稳。

## 验证

```powershell
.\doctor.ps1
```

或者直接问管家：

> 列出你现在能用的所有跟子代理/队员相关的工具名称

启用前它列不出东西，启用后应该能看到：

```
spawn_teammate
list_agents
send_message
interrupt_agent
wait_agent
subagent
subagent_fork
team_task_create
team_task_get
team_task_list
team_task_update
workflow
```

### 实测一次真实派活

> 派一个队员（名字用 scout）去查一下当前目录有几个 .md 文件

正常的事件序列：

```
[tool/call] spawn_teammate {"name":"scout", ...}
[tool/call] wait_agent {"timeout_ms":120000}
  ├─ 队员会话里：[tool/call] glob / pwsh
  └─ 队员回报：  [tool/call] send_message {"target":"lead", ...}
```

## 三个工具各自的作用

| 工具 | 作用 | 场景 |
|---|---|---|
| `spawn_teammate` | 新建一个子代理 | 第一次派某类活 |
| `send_message` | 给已存在的子代理发消息 | **复用队员**，省掉重新读项目 |
| `list_agents` | 列出现有子代理 | 派活前查有没有对口的 |
| `wait_agent` | 等子代理完成 | 需要结果才能继续时 |
| `interrupt_agent` | 打断子代理 | 派错了要收回 |
| `team_task_*` | 共享任务板 | 多队员协作、有依赖关系时 |

`send_message` 复用是关键省钱点：同一个队员在同一个项目里继续干活，
不用重新读一遍项目文件。

## 想更进一步

社区有两个做得更完整的方案：

- [`dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) — 14 个协调工具、
  自动共享任务调度器、依赖 DAG、质量门禁（需求→实现→验证→审查→集成）
- [`dsh-paoding`](https://github.com/lifangjin/dsh-paoding) — 按角色裁工具面，
  主 agent 每次请求的工具开销降约 2/3

它们相比「提示词 + 官方工具」的优势在于**有状态机**：任务有 id、状态、
负责人、attempt，调度器原子领取就绪任务。而纯提示词靠模型自己记住派了什么，
不可靠。

如果以后觉得现在的方案不够用，可以装它们。当前先保持官方工具，
好处是零外部依赖、DSH 升级不会坏。
