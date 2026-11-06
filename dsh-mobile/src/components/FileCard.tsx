/**
 * 文件卡片：把电脑上的文件（图片 / PDF / 其他）显示成可点击的卡片。
 *
 * 数据来源：DSH 的 `GET /api/file?path=<绝对路径>`。
 * 注意它只认 Cookie，而 RN 的 <Image> 不能带请求头，
 * 所以统一走 core/fileUrl.ts：先下载到本地缓存，再显示/打开。
 *
 * 行为：
 *   - 图片：内联预览，点击全屏
 *   - 其他文件：文件名 + 点击用系统应用打开
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';

import ReactNativeBlobUtil from 'react-native-blob-util';

import { useTheme } from '../design/theme';
import { useApp } from '../App';
import { fetchRemoteFile, openLocalFile, type RemoteFile } from '../core/fileUrl';
import { downloadWorkspaceFile } from '../core/gatewayFiles';
import { ImageViewer } from './ImageViewer';
import { DocumentViewer, canPreviewInside } from './DocumentViewer';
import { FileTypeBadge } from './FileTypeBadge';
import { formatBytes } from '../core/picker';
import { FILE_PREVIEW_MAX_BYTES, fileExcerpt, isTextPreviewable } from '../core/filePreview';

export function FileCard({
  path,
  alt,
  image,
  sessionId,
  workspacePath,
  expectedSha256,
  expectedSize,
}: {
  /** 电脑上的绝对路径，或相对工作区的路径 */
  path: string;
  /** markdown 里的 alt 文本 */
  alt?: string;
  /** 是否按图片渲染 */
  image?: boolean;
  /** 会话 id：有它就能走网关下载（比 /api/file 可靠） */
  sessionId?: string;
  workspacePath?: string;
  expectedSha256?: string;
  expectedSize?: number;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const { store, butlerWorkspace } = useApp();

  // 把 effect 真正依赖的东西提出来。
  //
  // 直接在依赖数组里写 `store` 是错的 —— store 每次 emit（消息、
  // 状态、团队变化）都换引用，effect 会重跑，图片又下载一遍。
  // 这三个是值/稳定引用：
  //   fileBaseUrl / fileCookie  字符串和 undefined，天然稳定
  //   gatewayChannel            store 里的稳定字段
  const fileBaseUrl = store.fileBaseUrl;
  const fileCookie = store.fileCookie;
  const gatewayChannel = store.gatewayChannel;

  // 管家偶尔发相对路径（cover_out/a.png），用当前项目路径拼成绝对路径。
  // 否则 /api/file 会 404。
  const absPath = useMemo(() => {
    if (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path)) return path;
    const root = workspacePath ?? butlerWorkspace;
    if (!root) return path;
    const separator = root.includes('\\') ? '\\' : '/';
    return `${root.replace(/[\\/]+$/, '')}${separator}${path}`;
  }, [path, workspacePath, butlerWorkspace]);
  const [localState, setLocalState] = useState<{ owner: object; file: RemoteFile } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 图片全屏查看器 */
  const [viewerOpen, setViewerOpen] = useState(false);
  /** 文档内置查看器 */
  const [docOpen, setDocOpen] = useState(false);
  /** 点击时当场拿到的文件信息（避免依赖 setLocal 的异步生效） */
  const [docFileOverride, setDocFileOverride] = useState<{
    uri: string;
    name: string;
  } | null>(null);
  const [reload, setReload] = useState(0);
  const opening = useRef(false);

  const name = path.split(/[\\/]/).pop() ?? path;
  const previewable = !image && isTextPreviewable(name);
  const [excerptState, setExcerptState] = useState<{ owner: object; text: string } | null>(null);
  const [previewHint, setPreviewHint] = useState('正在加载预览…');
  // Object identity also binds the active gateway. Stale callbacks cannot open an old file.
  const identity = useMemo(() => ({}), [absPath, path, sessionId, image, fileBaseUrl, fileCookie, gatewayChannel, expectedSha256, expectedSize]);
  const activeIdentity = useRef<object | null>(identity);
  activeIdentity.current = identity;
  const isActive = () => activeIdentity.current === identity;
  const local = localState?.owner === identity ? localState.file : null;
  const setLocal = (file: RemoteFile | null) => setLocalState(file ? { owner: identity, file } : null);
  const excerpt = excerptState?.owner === identity ? excerptState.text : null;
  const setExcerpt = (text: string | null) => setExcerptState(text === null ? null : { owner: identity, text });

  useEffect(() => {
    activeIdentity.current = identity;
    setLocal(null);
    setFailed(null);
    setBusy(false);
    opening.current = false;
    setExcerpt(null);
    setPreviewHint('正在加载预览…');
    setViewerOpen(false);
    setDocOpen(false);
    setDocFileOverride(null);
    return () => { activeIdentity.current = null; };
  }, [identity]);

  /**
   * 传给 DocumentViewer 的 file 对象。
   *
   * ⚠️ 必须 useMemo，不能用内联对象字面量。
   *
   * DocumentViewer 的 useEffect 依赖 `file` 这个对象本身。
   * 如果每次渲染都新建 `{ uri, name }`，引用每次都变 →
   * effect 每次都重跑 → 重新读文件、重新解析 docx →
   * 界面在 loading 和内容之间反复切换，**看起来就是一直闪屏**。
   *
   * 用户报的「打开 word 后每过几秒重新加载一次、阅读时一直闪」
   * 就是这个原因。
   *
   * 优先用 docFileOverride（点击时当场拿到的），
   * 因为 local 是 setState 异步更新的，可能还没生效。
   */
  const docFile = useMemo(
    () => docFileOverride ?? (local ? { uri: local.uri, name: local.name } : null),
    [docFileOverride, local],
  );

  // 图片显示宽度：屏幕宽减去左右内边距（见 fileBlockWrap 的 screenPadding*2）。
  // 用固定像素而不用 '100%' —— 见下面 <Image> 上的踩坑注释。
  // 注意：不要包 useMemo（依赖变化时可能拿到旧值/0），直接算。
  const { width: screenW } = useWindowDimensions();
  const imageWidth = Math.max(160, Math.round(screenW - tv.layout.screenPadding * 2 - 8));

  // 图片：进组件就开始拉，拉完直接显示。
  //
  // 两条路，按可靠性排序：
  //   1. 网关下载（按会话工作区解析）—— 能处理相对路径、中文名，
  //      甚至带冒号的文件名（实测 `山脚客栈：雾岭茶香.png` 走这条能通）
  //   2. /api/file?path=<绝对路径> —— 老路子，要求绝对路径拼对
  // 先试 1，失败再退回 2。
  useEffect(() => {
    if (!image) return;
    let alive = true;
    setLocal(null);
    setFailed(null);
    setBusy(true);
    void (async () => {
      // 1. 网关（只对工作区内相对路径有效；绝对路径会被拒）
      const gw = gatewayChannel;
      if (gw && sessionId && !/^[A-Za-z]:[\\/]/.test(path) && !/^\\\\/.test(path)) {
        try {
          const f = await downloadWorkspaceFile(gw, sessionId, path, undefined);
          if (alive) {
            setLocal({
              uri: f.path,
              fsPath: f.path.replace(/^file:\/\//, ''),
              name: f.name,
            });
          }
          return;
        } catch {
          // 网关失败就往下走老路径
        }
      }
      // 2. /api/file → 下载到本地缓存
      try {
        const f = await fetchRemoteFile(fileBaseUrl, fileCookie, absPath, { forceDownload: reload > 0 });
        if (!alive) return;
        setLocal(f);
        // 3. 关键：再读成 base64 data URI 作为兜底显示源。
        //
        // 为什么需要：RN 0.81 + 新架构（Fabric）下，<Image> 直接吃
        // `file://` 会「不报错但渲染成空白」—— onError 都不触发，
        // 界面上就是一块灰底。实测 2.5MB 的 PNG 文件本身完全有效
        // （头 89504e47、尺寸 1055×1491），下载也没问题，纯粹是
        // Fabric 的本地文件加载路径有问题。
        //
        // data URI 绕开文件系统，一定能解码。
        try {
          const b64 = await ReactNativeBlobUtil.fs.readFile(f.fsPath, 'base64');
          if (alive && typeof b64 === 'string' && b64.length > 0) {
            const mime = f.name.toLowerCase().endsWith('.png')
              ? 'image/png'
              : 'image/jpeg';
            setLocal({ ...f, uri: `data:${mime};base64,${b64}` });
          }
        } catch {
          // 读不出来就保持 file:// 原样，至少不会更糟
        }
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : '读取失败');
      }
    })().finally(() => { if (alive) setBusy(false); });
    return () => {
      alive = false;
    };
    // ⚠️ 依赖里**不能放 store**。
    //
    // store 是个大对象，任何一次 emit（消息进来、状态刷新、
    // 团队变化……）都会让组件重渲染。放进来意味着每次都要
    // 重新走一遍「下载 → 转 base64」，图片闪、流量白费。
    //
    // 真正需要的只有 baseUrl 和 cookie —— 用它们的值做依赖。
  }, [image, absPath, path, sessionId, fileBaseUrl, fileCookie, gatewayChannel, reload, identity]);

  /**
   * 转发：交给系统分享面板。
   *
   * 和「用系统应用打开」的区别：
   *   · 转发 → ACTION_SEND，微信/邮件能收到这个文件
   *   · 打开 → ACTION_VIEW，用某个 App 显示它
   * 微信接收分享走的是前者，所以「转发」必须用 SEND。
   */
  const doShare = async (f: RemoteFile) => {
    try {
      const { shareFile } = await import('../core/fileSave');
      const r = await shareFile(f.fsPath, f.name);
      if (!r.ok) {
        Alert.alert('转发失败', r.reason, [{ text: '好' }]);
      }
    } catch (e) {
      Alert.alert('转发失败', e instanceof Error ? e.message : String(e), [{ text: '好' }]);
    }
  };

  /**
   * 保存到手机下载目录。
   *
   * 成功后告诉用户存哪了 —— 「已保存」这种提示等于没说，
   * 用户还是要自己去找。
   */
  const doSave = async (f: RemoteFile) => {
    try {
      const { saveToDownloads } = await import('../core/fileSave');
      const r = await saveToDownloads(f.fsPath, f.name);
      Alert.alert(
        r.ok ? '已保存' : '保存失败',
        r.ok ? `已存到${r.where}，文件名：${f.name}` : r.reason,
        [{ text: '好' }],
      );
    } catch (e) {
      Alert.alert('保存失败', e instanceof Error ? e.message : String(e), [{ text: '好' }]);
    }
  };

  /** 用户点卡片：图片进全屏查看器，文档进内置查看器，其余交给系统 */
  const retryImage = () => {
    if (busy) return;
    setViewerOpen(false);
    setLocal(null);
    setFailed(null);
    setReload(value => value + 1);
  };
  const onPress = async (forceDownload = false, previewOnly = false) => {
    if (!isActive() || (!previewOnly && busy) || opening.current) return;
    if (image && failed) { retryImage(); return; }
    const retry = forceDownload || !!failed;
    opening.current = true;
    setBusy(true);
    setFailed(null);
    if (forceDownload) { setDocOpen(false); setExcerpt(null); }
    try {
      let f = retry || previewOnly ? null : local;
      const limit = previewOnly ? { maxBytes: FILE_PREVIEW_MAX_BYTES } : undefined;
      if (!f && gatewayChannel && sessionId && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) {
        try {
          const downloaded = await downloadWorkspaceFile(gatewayChannel, sessionId, path, undefined, limit);
          f = { uri: downloaded.path, fsPath: downloaded.path.replace(/^file:\/\//, ''), name: downloaded.name };
        } catch (error) {
          if (!isActive()) return;
          // Do not retry a known large file through another transport for an excerpt.
          if (previewOnly && error instanceof Error && error.message.includes('文件较大')) throw error;
        }
      }
      if (!isActive()) return;
      f ??= await fetchRemoteFile(fileBaseUrl, fileCookie, absPath, { forceDownload: retry, ...limit });
      if (!isActive()) return;
      if (expectedSha256 || expectedSize !== undefined) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const stat = await ReactNativeBlobUtil.fs.stat(f.fsPath);
          const digest = expectedSha256 ? await ReactNativeBlobUtil.fs.hash(f.fsPath, 'sha256') : null;
          if (!isActive()) return;
          const matches = (expectedSize === undefined || Number(stat.size) === expectedSize) &&
            (!expectedSha256 || digest?.toLowerCase() === expectedSha256.toLowerCase());
          if (matches) break;
          await ReactNativeBlobUtil.fs.unlink(f.fsPath).catch(() => undefined);
          if (!isActive()) return;
          setLocal(null);
          if (attempt === 1) throw new Error('文件内容与交付记录不一致，请让管家重新交付后再打开。');
          f = await fetchRemoteFile(fileBaseUrl, fileCookie, absPath, { forceDownload: true, ...limit });
        }
      }
      if (!isActive()) return;
      setFailed(null);
      setLocal(f);
      if (previewOnly) {
        const stat = await ReactNativeBlobUtil.fs.stat(f.fsPath);
        if (!Number.isFinite(Number(stat.size)) || Number(stat.size) > FILE_PREVIEW_MAX_BYTES) throw new Error('文件较大，点击后查看完整内容');
        const text = String(await ReactNativeBlobUtil.fs.readFile(f.fsPath, 'utf8'));
        if (!isActive()) return;
        if (text.includes('\u0000')) throw new Error('无法预览此文件，点击打开');
        setExcerpt(fileExcerpt(text));
        return;
      }
      if (image) { setViewerOpen(true); return; }
      if (canPreviewInside(f.name)) {
        setDocFileOverride({ uri: f.uri, name: f.name });
        setDocOpen(true);
        return;
      }
      await openLocalFile(f);
    } catch (e) {
      if (!isActive()) return;
      if (previewOnly) setPreviewHint(e instanceof Error ? e.message : '预览暂不可用，点击打开');
      else setFailed(e instanceof Error ? e.message : '打开失败');
    } finally {
      if (isActive()) { opening.current = false; setBusy(false); }
    }
  };

  useEffect(() => {
    if (!previewable) return;
    if (expectedSize !== undefined && expectedSize > FILE_PREVIEW_MAX_BYTES) {
      setPreviewHint('文件较大，点击后查看完整内容');
      return;
    }
    void onPress(false, true);
    // Fetch once per resource identity; transient store updates do not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // 图片加载成功 → 直接显示预览
  if (image && local) {
    return (
      <>
        <Pressable
          onPress={() => void onPress()}
          style={({ pressed }: { pressed: boolean }) => [
            styles.imageWrap,
            pressed ? { opacity: 0.85 } : null,
          ]}
          accessibilityRole="imagebutton"
          disabled={busy}
          accessibilityLabel={`${failed ? '重试图片' : '查看图片'} ${alt || name}`}
        >
          {/*
            ⚠️ 图片显示的两个必要条件（缺一个都会变成灰块）：
            1. <Image> 自身给「固定像素宽高」，不能用 width:'100%'；
            2. 外层容器**不能有 overflow:'hidden'**（Fabric 会裁成 0）。
            圆角放在 Image 自己的 style 上。
          */}
          <View style={{ width: imageWidth, height: imageWidth * 0.75 }}>
            <Image
              source={{ uri: local.uri }}
              style={{
                width: imageWidth,
                height: imageWidth * 0.75,
                borderRadius: tv.radius.md,
              }}
              resizeMode="cover"
              onError={(e) => {
                const msg =
                  (e.nativeEvent as { error?: string }).error ?? '图片解码失败';
                setFailed(`图片加载失败：${msg}`);
              }}
            />
          </View>
          {failed ? (
            <Text style={styles.imageCaption} numberOfLines={2}>
              {failed}，点击重试
            </Text>
          ) : (
            <Text style={styles.imageCaption} numberOfLines={1}>
              {alt || name}
            </Text>
          )}
        </Pressable>

        {/* 全屏看图：缩放 / 拖动 / 下滑关闭 / 长按保存 */}
        <ImageViewer
          visible={viewerOpen}
          images={[
            {
              uri: local.uri,
              caption: alt || name,
              failed: !!failed,
              onRetry: retryImage,
              onError: () => setFailed('图片加载失败'),
              // 长按保存用：本地缓存路径 + 文件名
              save: { fsPath: local.fsPath, name: local.name },
            },
          ]}
          onClose={() => setViewerOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => void onPress()}
        disabled={busy}
        style={({ pressed }: { pressed: boolean }) => [
          styles.card,
          pressed ? { opacity: 0.7 } : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${failed ? '重试加载' : '打开'} ${name}${alt && alt !== name ? `，${alt}` : ''}`}
      >
        {previewable ? (
          <View style={styles.previewBody}>
            <Text style={styles.previewText} numberOfLines={8} ellipsizeMode="tail">
              {excerpt === null ? previewHint : excerpt || '文件为空'}
            </Text>
          </View>
        ) : null}
        <View style={styles.fileRow}>
          <FileTypeBadge name={name} />
          <View style={styles.meta}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
              {name}
            </Text>
            {alt && alt !== name ? <Text style={styles.description} numberOfLines={2}>{alt}</Text> : null}
            {expectedSize !== undefined ? <Text style={styles.path}>{expectedSize === 0 ? '0 B' : formatBytes(expectedSize)}</Text> : null}
            <Text style={styles.path} numberOfLines={failed ? 2 : 1} ellipsizeMode={failed ? 'tail' : 'middle'}>
              {failed ?? (busy ? '正在打开…' : path)}
            </Text>
            {failed ? <Text style={styles.retryText}>点击重试</Text> : null}
          </View>
          {busy ? <ActivityIndicator size="small" color={tv.colors.accent} /> : null}
          {!busy && previewable ? <Text style={styles.openText}>查看全文</Text> : null}
        </View>
      </Pressable>

      {/* 文档内置查看：md / docx / xlsx / csv */}
      {local ? (
        <DocumentViewer
          visible={docOpen}
          file={docFile}
          onClose={() => setDocOpen(false)}
          onRetry={() => void onPress(true)}
          onShare={() => {
            if (!local) return;
            void doShare(local);
          }}
          onSave={() => {
            if (!local) return;
            void doSave(local);
          }}
        />
      ) : null}
    </>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    imageWrap: {
      marginVertical: tv.space.sm,
      // ⚠️ 这里绝对不能加 overflow:'hidden'。
      //
      // 踩坑记录（查了很久）：RN 0.81 + 新架构（Fabric）下，
      // 容器上带 overflow:'hidden' 会把里面的 <Image> 裁剪成 0 尺寸，
      // 渲染出来就是一块灰底 —— 但 onLoad 正常触发、文件也下载成功、
      // 尺寸计算也对，所以极难定位。去掉后立刻正常。
      //
      // 圆角改由 <Image> 自己的 borderRadius 实现（见下面 Image 的 style）。
      backgroundColor: C.bgCard,
    },
    // 只放不会被覆盖的样式；宽高在组件里按屏幕宽度算（见 <Image> 上方注释）
    image: { borderRadius: 0 },
    imageCaption: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      paddingHorizontal: tv.space.sm,
      paddingVertical: tv.space.xs,
    },
    previewBody: {
      padding: tv.space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
      backgroundColor: C.bgRaised,
      borderTopLeftRadius: tv.radius.md,
      borderTopRightRadius: tv.radius.md,
    },
    previewText: { color: C.textSecondary, fontFamily: 'monospace', fontSize: tv.type.xs, lineHeight: 21 },
    fileRow: { flexDirection: 'row', alignItems: 'center', padding: tv.space.md, minHeight: 72 },
    openText: { color: C.accent, fontSize: tv.type.micro, marginLeft: tv.space.sm },
    card: {
      marginVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    description: { color: C.textSecondary, fontSize: tv.type.xs, marginTop: tv.space.xs },
    meta: { flex: 1, minWidth: 0, marginLeft: tv.space.sm },
    name: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    path: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 2 },
    retryText: { color: C.accent, fontSize: tv.type.micro, marginTop: tv.space.xs },
  });
}
