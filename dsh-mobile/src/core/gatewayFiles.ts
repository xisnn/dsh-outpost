/**
 * 通过移动网关下载会话工作区里的文件（主要是图片）。
 *
 * 为什么需要它：DSH 的 `/api/file?path=` 只能读绝对路径，而管家发的图片
 * 是**相对工作区**的路径（`cover-smell.jpg`、`cover_out/x.png`）。
 * 之前靠 `/api/file` 拼路径，遇到中文名、带冒号的名字就失败，
 * 表现就是聊天里一个灰方块。
 *
 * 网关提供了按会话工作区解析的下载通道：
 *   file-download-open  { sessionId, path }        → transferId + size + chunkBytes
 *   file-download-read  { transferId, offset }     → base64 块
 *   file-download-cancel{ transferId }
 *
 * offset 必须严格用「上一块的 offset + 解码后字节数」，协议明确不支持续传。
 *
 * 走的是同一条 WebSocket 连接（审批网关已经建立），不额外开连接。
 */

import ReactNativeBlobUtil from 'react-native-blob-util';

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface DownloadedFile {
  /** 本地 file:// 路径 */
  path: string;
  /** 原始文件名 */
  name: string;
  /** 字节数 */
  size: number;
  /** 服务端给的类型（可能不准，调用方自己按扩展名兜底） */
  mediaType: string;
}

/** 网关帧收发的最小接口，避免这里依赖具体 WebSocket 实现 */
export interface FrameChannel {
  send(obj: Record<string, unknown>): void;
  /** 等一个满足条件的帧 */
  waitFor(kind: string, match: (f: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** base64 → 字节数（不实际解码，只要长度） */
function base64Bytes(s: string): number {
  if (!s) return 0;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

/**
 * 下载一个工作区相对路径的文件。
 *
 * @param channel 已连接的网关通道
 * @param sessionId 会话 id（决定工作区根目录）
 * @param relPath 工作区相对路径（例如 `cover_out/x.png`）
 * @param onProgress 进度回调
 */
export async function downloadWorkspaceFile(
  channel: FrameChannel,
  sessionId: string,
  relPath: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadedFile> {
  const requestId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. 打开
  channel.send({ type: 'file-download-open', sessionId, path: relPath, requestId });
  const opened = await channel.waitFor(
    'file-download-opened',
    (f) => f.requestId === requestId,
    15000,
  );
  const transferId = String(opened.transferId ?? '');
  const size = Number(opened.size ?? 0);
  const name = String(opened.name ?? relPath.split('/').pop() ?? 'file');
  const mediaType = String(opened.mediaType ?? 'application/octet-stream');
  if (!transferId) throw new Error('网关没有返回 transferId');

  // 2. 分块拉
  const dest = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/dsh-${Date.now()}-${name.replace(/[^\w.\-]/g, '_')}`;
  const parts: string[] = [];
  let offset = 0;
  let received = 0;

  try {
    for (;;) {
      channel.send({ type: 'file-download-read', transferId, offset });
      const chunk = await channel.waitFor(
        'file-download-chunk',
        (f) => f.transferId === transferId && Number(f.offset) === offset,
        30000,
      );
      const data = String(chunk.data ?? '');
      parts.push(data);
      const bytes = base64Bytes(data);
      received += bytes;
      offset += bytes;
      onProgress?.({ received, total: size });
      if (chunk.eof === true) break;
      if (bytes === 0) throw new Error('网关返回空块');
    }

    // 3. 落盘
    //
    // ⚠️ 这里**绝对不能**把每块的 base64 直接拼起来再整体解码。
    //
    // 每块的 base64 都是**独立编码**的，末尾可能带 `=` padding：
    //   块1: QUFBQUFBQUE=
    //   块2: QkJCQkJCQkI=
    // 直接拼成 'QUFBQUFBQUE=QkJCQkJCQkI=' 后，解码器遇到中间的 `=` 就认为
    // 数据结束了 —— 结果只解出第一块。
    //
    // 实测症状：2.5 MB 的图，5 块拉完后文件只有 524288 字节（正好第一块），
    // PNG 头正常但整体截断，<Image> 解码失败 → 界面上是一个灰方块。
    // 这就是「图片显示不了」的真凶。
    //
    // 正确做法：**逐块追加写入**，每次都用 base64 模式解码后 append。
    // blob-util 的 writeFile 在 append 模式下会把内容接在文件末尾。
    await ReactNativeBlobUtil.fs.writeFile(dest, parts[0], 'base64');
    for (let i = 1; i < parts.length; i += 1) {
      await ReactNativeBlobUtil.fs.appendFile(dest, parts[i], 'base64');
    }
    return { path: `file://${dest}`, name, size: received, mediaType };
  } catch (e) {
    // 失败要显式取消，否则服务端句柄要等 2 分钟空闲才释放
    channel.send({ type: 'file-download-cancel', transferId });
    throw e;
  }
}

/**
 * 文件名是否适合直接交给下载通道。
 *
 * 实测发现带**中文冒号**的名字（`山脚客栈：雾岭茶香.png`）会让部分路径
 * 处理失败。这里不做替换（服务端是权威），只用来给调用方一个降级判断。
 */
export function hasRiskyName(path: string): boolean {
  return /[：:<>"|?*\u0000]/.test(path);
}
