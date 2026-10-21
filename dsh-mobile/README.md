# dsh-mobile

DSH Pocket 的 React Native App。

## 技术选型

| 项 | 选择 | 为什么 |
|---|---|---|
| 框架 | React Native 0.81.4 | 新架构（Fabric）+ Hermes |
| 语言 | TypeScript strict | 协议层字段多，类型能挡掉一半错误 |
| 导航 | **手写栈** | `@react-navigation/native-stack` 依赖 `react-native-screens`，后者在 RN 0.81 + Fabric 下有原生 ABI 不兼容（`RNSScreenStackHeaderConfigProps` 析构崩溃）。三层导航本身简单，自己写更可控 |
| 通知 | `react-native-notify-kit` | Notifee 已归档，官方指向这个新架构维护版。API 兼容，迁移成本低 |
| 手势 | `PanResponder`（RN 内置） | 不引第三方手势库 |

## 目录

```
src/
├── core/          协议层，不依赖 UI
│   ├── transport/   HTTP RPC + WebSocket 流
│   ├── rpc/         各领域 API（session / model / account）
│   ├── fold/        把事件流折叠成可渲染的消息结构
│   ├── store.ts     全局状态（订阅式，非 Redux）
│   ├── approvalGateway.ts  审批 WebSocket 客户端
│   ├── notify.ts    震动 + 系统通知
│   └── butler.ts    管家模式的系统提示词
├── nav/           导航栈 + 边缘手势
├── screens/       页面
├── components/    组件
└── design/        主题 token
```

## 开发

```bash
npm install
npm test          # 231 项单测 + typecheck
npm run android   # 需要 Android SDK + JDK 21
```

单测是纯 Node 跑的，用 `tsx` 直接执行，不依赖 Jest 或 RN 测试环境。
大多数测试读源码做结构断言（比如「`imageWrap` 不能有 `overflow:hidden`」），
目的是把踩过的坑钉死，防止以后被人「顺手」改回去。

## 几个容易踩的坑

这些都在代码注释里写了详细原因，这里列个索引：

| 坑 | 位置 |
|---|---|
| `overflow: 'hidden'` 在 Fabric 下把 `<Image>` 裁成 0，图片变灰块 | `components/FileCard.tsx` |
| `<Image>` 不能用 `width: '100%'`，Fabric 算不出宽度 | `components/FileCard.tsx` |
| WebSocket 必须带 `X-DSH-Device-ID` 头，RN 要用第三个参数传 | `core/approvalGateway.ts` |
| 网关端点不能硬编码 3081，要走 `/mgw/pair` 返回的同源地址 | `core/approvalGateway.ts` |
| 配对码一次性，401 时必须清 token 重新配对 | `core/approvalGateway.ts` |
| 父级 PanResponder 要用 Capture 版本，否则被 ScrollView 抢先 | `nav/NavHost.tsx` |
| `session/follow` 必须走 WS，HTTP 调会 signature-invalid | `core/transport/` |
| `session/follow` 的 address 必须包成 `{request:{address:{...}}}` | `core/store.ts` |

## 协议

DSH 内部 RPC 是逆向出来的，没有版本协商。形状、投影字段、更多坑见
[../docs/protocol-notes.md](../docs/protocol-notes.md)。
