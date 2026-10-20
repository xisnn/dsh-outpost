/**
 * Host 半边：本插件不需要 Host 侧逻辑。
 *
 * 架构说明：
 *
 *   插件面板（浏览器）
 *        ↓ fetch http://127.0.0.1:3199
 *   tunnel-service.mjs（本地小服务，node）
 *        ↓ 调用
 *   start-tunnel.ps1（实际启停 cloudflared + 重启 DSH）
 *
 * 为什么不直接在 Host 侧做：
 *   DSH 的自定义 Remote 方法需要「生成 codec」（@Remote 装饰器 + 代码生成
 *   工具链），纯 JS 插件接不进去。我试过 ctx.commands.register + 
 *   commands/execute，那个通道是「模拟用户敲斜杠命令」的，对不上。
 *
 * 所以退一步用最朴素的浏览器 → 本地 HTTP，没有技术不确定性，
 * 也不依赖 DSH 内部接口，升级不会坏。
 */
export function apply() {}
