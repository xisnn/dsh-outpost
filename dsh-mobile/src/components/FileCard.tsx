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
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import ReactNativeBlobUtil from 'react-native-blob-util';

import { useTheme } from '../design/theme';
import { useApp } from '../App';
import { fetchRemoteFile, openLocalFile, type RemoteFile } from '../core/fileUrl';
import { downloadWorkspaceFile } from '../core/gatewayFiles';
import { ImageViewer } from './ImageViewer';
import { DocumentViewer, canPreviewInside } from './DocumentViewer';

export function FileCard({
  path,
  alt,
  image,
  sessionId,
}: {
  /** 电脑上的绝对路径，或相对工作区的路径 */
  path: string;
  /** markdown 里的 alt 文本 */
  alt?: string;
  /** 是否按图片渲染 */
  image?: boolean;
  /** 会话 id：有它就能走网关下载（比 /api/file 可靠） */
  sessionId?: string;
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
    if (/^[A-Za-z]:\\/.test(path) || /^\\\\/.test(path)) return path;
    if (!butlerWorkspace) return path;
    const rel = path.replace(/^[\\/]+/, '');
    return `${butlerWorkspace}\\${rel}`;
  }, [path, butlerWorkspace]);
  const [local, setLocal] = useState<RemoteFile | null>(null);
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

  const name = path.split(/[\\/]/).pop() ?? path;

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
  const screenW = Dimensions.get('window').width;
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
        const f = await fetchRemoteFile(fileBaseUrl, fileCookie, absPath);
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
    })();
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
  }, [image, absPath, path, sessionId, fileBaseUrl, fileCookie, gatewayChannel]);

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
  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const f =
        local ??
        (await fetchRemoteFile(fileBaseUrl, fileCookie, absPath));
      setLocal(f);

      // ⚠️ 不要依赖 `docFile`（它来自 local，setLocal 是异步的）。
      // 这里已经拿到了 f，直接用它开查看器，避免「先 null 再有值」
      // 导致 DocumentViewer 重新挂载 + 重新解析（又是一次闪）。
      if (image) {
        setViewerOpen(true);
        return;
      }
      if (canPreviewInside(f.name)) {
        setDocFileOverride({ uri: f.uri, name: f.name });
        setDocOpen(true);
        return;
      }
      await openLocalFile(f);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : '打开失败');
    } finally {
      setBusy(false);
    }
  };

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
          accessibilityLabel={`查看图片 ${alt || name}`}
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
              {failed}
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
        accessibilityLabel={`打开 ${name}`}
      >
        <Text style={styles.icon}>{failed ? '⚠' : iconFor(name)}</Text>
        <View style={styles.meta}>
          <Text style={styles.name} numberOfLines={1}>
            {alt || name}
          </Text>
          <Text style={styles.path} numberOfLines={1}>
            {failed ?? (busy ? '正在打开…' : path)}
          </Text>
        </View>
        {busy ? <ActivityIndicator size="small" color={tv.colors.accent} /> : null}
      </Pressable>

      {/* 文档内置查看：md / docx / xlsx / csv */}
      {local ? (
        <DocumentViewer
          visible={docOpen}
          file={docFile}
          onClose={() => setDocOpen(false)}
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

function iconFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx'].includes(ext)) return 'XLS';
  if (['zip', 'rar', '7z'].includes(ext)) return 'ZIP';
  return '文件';
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
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      marginVertical: tv.space.sm,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    icon: {
      width: 40,
      textAlign: 'center',
      color: C.accentBright,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.semibold,
    },
    meta: { flex: 1, marginLeft: tv.space.sm },
    name: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    path: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 2 },
  });
}
