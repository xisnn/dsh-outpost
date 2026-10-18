/**
 * 附件显示：图片缩略图 + 文件 chip + 点击看大图。
 *
 * 图片字节的来历：
 * - 刚发出的消息：本地有 `localUri`，直接用，不用等网络
 * - 历史消息：只有 `attachmentId`，走 `session/attachment` 取 base64，并缓存
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../design/theme';
import { cachedImageUri, imageFailed, loadImageUri } from '../core/attachment-cache';
import { formatBytes } from '../core/picker';
import type { UploadApi } from '../core/rpc/upload';
import type { AttachRef } from '../core/types';

const THUMB = 148;

/** 一张图（缩略图 + 点开大图） */
function ImagePart({
  sessionId,
  part,
  api,
  thumbSize = THUMB,
}: {
  sessionId: string;
  part: Extract<AttachRef, { kind: 'image' }>;
  api: UploadApi;
  thumbSize?: number;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [uri, setUri] = useState<string | undefined>(
    part.localUri ?? cachedImageUri(sessionId, part.attachmentId),
  );
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (uri) return;
    if (imageFailed(part.attachmentId, sessionId)) {
      setFailed(true);
      return;
    }
    let live = true;
    void loadImageUri(api, sessionId, part.attachmentId).then((u) => {
      if (!live) return;
      if (u) setUri(u);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [api, sessionId, part.attachmentId, uri]);

  // 按 Host 给的宽高比算缩略图高度，避免加载完跳一下
  const ratio =
    part.width && part.height && part.height > 0 ? part.width / part.height : 1;
  const boxW = Math.min(thumbSize, thumbSize * Math.max(ratio, 0.62));
  const boxH = Math.max(64, Math.round(boxW / Math.max(ratio, 0.35)));

  return (
    <>
      <Pressable
        onPress={() => uri && setOpen(true)}
        style={({ pressed }: { pressed: boolean }) => [
          styles.thumbBox,
          { width: boxW, height: Math.min(boxH, thumbSize * 1.6) },
          pressed && { opacity: 0.85 },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.thumbImg} resizeMode="cover" />
        ) : (
          <View style={styles.thumbPlaceholder}>
            {failed ? (
              <Text style={styles.thumbFailIcon}>◫</Text>
            ) : (
              <ActivityIndicator size="small" color={tv.colors.textTertiary} />
            )}
          </View>
        )}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.lightbox} onPress={() => setOpen(false)}>
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.lightboxImg}
              resizeMode="contain"
              accessibilityLabel={part.name ?? '图片'}
            />
          ) : null}
          <Text style={styles.lightboxHint}>
            {part.name ? `${part.name} · ` : ''}点任意处关闭
          </Text>
        </Pressable>
      </Modal>
    </>
  );
}

/** 一个文件 chip */
function FilePart({
  part,
}: {
  part: Extract<AttachRef, { kind: 'file' }>;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const size = formatBytes(part.bytes);
  return (
    <View style={styles.fileChip}>
      <View style={styles.fileIcon}>
        <Text style={styles.fileIconText}>▤</Text>
      </View>
      <View style={styles.fileBody}>
        <Text style={styles.fileName} numberOfLines={1}>
          {part.name ?? '文件'}
        </Text>
        {size ? <Text style={styles.fileSize}>{size}</Text> : null}
      </View>
    </View>
  );
}

/** 一条用户消息里的全部附件 */
export function AttachmentGallery({
  sessionId,
  parts,
  api,
}: {
  sessionId: string;
  parts: AttachRef[];
  api: UploadApi;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  if (parts.length === 0) return null;
  const images = parts.filter((p): p is Extract<AttachRef, { kind: 'image' }> => p.kind === 'image');
  const files = parts.filter((p): p is Extract<AttachRef, { kind: 'file' }> => p.kind === 'file');

  return (
    <View style={styles.gallery}>
      {images.length > 0 ? (
        // 用 flexWrap 而不是横向 ScrollView：RN 里横向 ScrollView 放在列容器中
        // 高度会被撑开，导致图片和气泡之间出现一大段空隙。
        <View style={styles.imgRow}>
          {images.map((p, i) => (
            <ImagePart
              key={`${p.attachmentId}-${i}`}
              sessionId={sessionId}
              part={p}
              api={api}
            />
          ))}
        </View>
      ) : null}
      {files.map((p, i) => (
        <FilePart key={`${p.attachmentId}-${i}`} part={p} />
      ))}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    gallery: { marginBottom: 6, alignItems: 'flex-end' },
    imgRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' },

    thumbBox: {
      borderRadius: tv.radius.md,
      overflow: 'hidden',
      marginLeft: tv.space.xs,
      marginBottom: tv.space.xs,
      backgroundColor: C.bgOverlay,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    thumbImg: { width: '100%', height: '100%' },
    thumbPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    thumbFailIcon: { color: C.textFaint, fontSize: 22 },

    fileChip: {
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: 260,
      paddingVertical: 7,
      paddingHorizontal: 9,
      marginLeft: tv.space.xs,
      marginBottom: tv.space.xs,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    fileIcon: {
      width: 28,
      height: 28,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.accentWash,
      marginRight: tv.space.sm,
    },
    fileIconText: { color: C.accentBright, fontSize: 14 },
    fileBody: { flexShrink: 1 },
    fileName: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    fileSize: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 1 },

    lightbox: {
      flex: 1,
      backgroundColor: C.scrim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    lightboxImg: { width: '100%', height: '82%' },
    lightboxHint: {
      color: 'rgba(255,255,255,0.8)',
      fontSize: tv.type.micro,
      position: 'absolute',
      bottom: 42,
    },
  });
}
