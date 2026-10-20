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
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { useApp } from '../App';
import { fetchRemoteFile, openLocalFile, type RemoteFile } from '../core/fileUrl';
import { downloadWorkspaceFile } from '../core/gatewayFiles';

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

  const name = path.split(/[\\/]/).pop() ?? path;

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
      // 1. 网关
      const gw = store.gatewayChannel;
      if (gw && sessionId) {
        try {
          const f = await downloadWorkspaceFile(gw, sessionId, path, undefined);
          if (alive) setLocal({ uri: f.path, fsPath: f.path.replace(/^file:\/\//, ''), name: f.name });
          return;
        } catch {
          // 网关失败就往下走老路径
        }
      }
      // 2. /api/file
      try {
        const f = await fetchRemoteFile(
          store.fileBaseUrl,
          store.fileCookie,
          absPath,
        );
        if (alive) setLocal(f);
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : '读取失败');
      }
    })();
    return () => {
      alive = false;
    };
  }, [image, absPath, path, sessionId, store]);

  /** 用户点卡片：图片看大图，其他文件交给系统 */
  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const f =
        local ??
        (await fetchRemoteFile(store.fileBaseUrl, store.fileCookie, absPath));
      setLocal(f);
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
      <Pressable
        onPress={() => void onPress()}
        style={({ pressed }: { pressed: boolean }) => [
          styles.imageWrap,
          pressed ? { opacity: 0.85 } : null,
        ]}
        accessibilityRole="imagebutton"
        accessibilityLabel={`查看图片 ${alt || name}`}
      >
        <Image source={{ uri: local.uri }} style={styles.image} resizeMode="cover" />
        <Text style={styles.imageCaption} numberOfLines={1}>
          {alt || name}
        </Text>
      </Pressable>
    );
  }

  return (
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
      borderRadius: tv.radius.md,
      overflow: 'hidden',
      backgroundColor: C.bgCard,
    },
    image: { width: '100%', height: 220 },
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
