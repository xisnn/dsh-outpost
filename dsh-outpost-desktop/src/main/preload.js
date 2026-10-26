/**
 * 预加载脚本：渲染层与主进程之间唯一的通道。
 *
 * 安全约定：
 *   - contextIsolation: true，渲染层拿不到 Node
 *   - 只暴露这几个方法，不暴露任意 IPC 调用
 *   - 所有参数在主进程侧再校验一次（不信任渲染层）
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  /** 取一次完整状态（DSH / 局域网 / 隧道 / 配对信息） */
  getStatus: () => ipcRenderer.invoke('status:get'),

  /** 把文本生成二维码 data URL（主进程用 qrcode 库生成，渲染层只管显示） */
  makeQr: (text) => ipcRenderer.invoke('qr:make', text),

  /** 隧道操作：start / stop / repair */
  tunnel: (action) => ipcRenderer.invoke('tunnel:action', action),

  /** DSH 服务本身：start / stop */
  dsh: (action) => ipcRenderer.invoke('dsh:action', action),

  /** 已配对的设备列表 */
  listDevices: () => ipcRenderer.invoke('devices:list'),

  /** 复制文本到剪贴板 */
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),

  /** 开机自启开关 */
  setAutoLaunch: (enabled) => ipcRenderer.invoke('autolaunch:set', enabled),

  /** 失焦自动隐藏开关 */
  setAutoHide: (enabled) => ipcRenderer.invoke('autohide:set', enabled),

  /** 用系统浏览器打开链接 */
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  /** 隐藏面板（回到托盘） */
  hide: () => ipcRenderer.invoke('window:hide'),

  /** 退出程序 */
  quit: () => ipcRenderer.invoke('app:quit'),
});
