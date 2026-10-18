# 参与开发

欢迎提 Issue 和 PR。改动前建议先看一遍 [开发记录](dsh-mobile/DEVELOPMENT.md)——
里面记了每个功能的设计取舍和踩过的坑，能省不少时间。

## 环境

| 依赖 | 版本 |
|---|---|
| Node.js | 20+ |
| JDK | 21 |
| Android SDK | compileSdk 35 / minSdk 24 |
| DSH | 0.2.1 及以上（跑后端用） |

## 本地跑起来

```bash
cd dsh-mobile
npm install
npm test          # 单测 + typecheck，提交前请确保通过
npm run android   # 需要连着模拟器或真机
```

调试时 App 连的是 Metro（8081），需要 `adb reverse tcp:8081 tcp:8081`。

## 代码结构

```
src/
├── core/           # 协议层，不依赖 React
│   ├── transport/  # WebSocket 多路复用 + HTTP RPC
│   ├── rpc/        # 各 endpoint 的封装（session / model / account / workspace）
│   ├── fold/       # 事件流 → 聊天气泡（纯函数，有单测）
│   ├── store.ts    # 全局状态
│   └── pairing.ts  # 配对文本解析（纯函数，有单测）
├── screens/        # 页面
├── components/     # 组件
└── design/         # 主题 token
```

**约定**：`core/` 里不放任何 React 代码，这样协议逻辑能直接在 Node 里跑单测
（`tests/*.mjs` 就是这么测的）。

## 提 PR 前

- `npm test` 通过
- 改动涉及协议层的话，在 `dsh-mobile/DEVELOPMENT.md` 里补一段说明
- 截图请不要带真实会话数据

## 关于 DSH 协议

App 用的 RPC 是逆向 DSH 桌面端得到的，没有官方文档，也没有版本协商。
如果你发现 DSH 升级后某个功能挂了，欢迎在 Issue 里贴出：

- DSH 版本
- 报错的 endpoint 和返回
- 复现步骤

调试时可以直接用 Node 打 session/follow 看原始事件流，格式见开发记录里的示例。
