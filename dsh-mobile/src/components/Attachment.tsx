/** Chat attachment thumbnails share the same full-screen viewer as delivered images. */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';
import { ImageViewer } from './ImageViewer';
import { FileTypeBadge } from './FileTypeBadge';
import { useAttachmentImages } from './useAttachmentImages';
import { useTheme } from '../design/theme';
import { formatBytes } from '../core/picker';
import type { UploadApi } from '../core/rpc/upload';
import type { AttachRef } from '../core/types';
const THUMB = 148;

export function AttachmentGallery({ sessionId, parts, api }: { sessionId: string; parts: AttachRef[]; api: UploadApi }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const images = parts.filter((part): part is Extract<AttachRef, { kind: 'image' }> => part.kind === 'image');
  const files = parts.filter((part): part is Extract<AttachRef, { kind: 'file' }> => part.kind === 'file');
  const { statuses, retry, failed } = useAttachmentImages(api, sessionId, images);
  const [opened, setOpened] = useState<{ api: UploadApi; sessionId: string; index: number } | null>(null);
  if (parts.length === 0) return null;
  return (
    <View style={styles.gallery}>
      {images.length > 0 ? <View style={styles.imgRow}>
        {images.map((image, index) => {
          const state = statuses[index];
          const ratio = image.width && image.height && image.height > 0 ? image.width / image.height : 1;
          const width = Math.min(THUMB, THUMB * Math.max(ratio, 0.62));
          const height = Math.min(Math.max(64, Math.round(width / Math.max(ratio, 0.35))), THUMB * 1.6);
          const name = image.name || `图片 ${index + 1}`;
          return <Pressable key={`${image.attachmentId}-${index}`} disabled={state.phase === 'loading'}
            onPress={() => state.phase === 'failed' ? retry(index) : setOpened({ api, sessionId, index })}
            accessibilityRole="imagebutton" accessibilityLabel={state.phase === 'failed' ? `图片加载失败，点击重试 ${name}` : `查看图片 ${name}`}
            style={({ pressed }: { pressed: boolean }) => [styles.thumbBox, { width, height }, pressed && { opacity: 0.85 }]}>
            {state.uri ? <Image source={{ uri: state.uri }} style={{ width, height, borderRadius: tv.radius.md }} resizeMode="cover" onError={() => failed(index, state.uri!)} /> : (
              <View style={styles.thumbPlaceholder}>{state.phase === 'failed' ? <>
                <Text style={styles.failure}>加载失败</Text><Text style={styles.retry}>点击重试</Text>
              </> : <ActivityIndicator size="small" color={tv.colors.textTertiary} accessibilityLabel="正在加载图片" />}</View>
            )}
          </Pressable>;
        })}
      </View> : null}
      {files.map((file, index) => <View key={`${file.attachmentId}-${index}`} style={styles.fileChip}
        accessible accessibilityLabel={`文件 ${file.name || '未命名文件'}${file.bytes !== undefined ? `，${formatBytes(file.bytes)}` : ''}`}>
        <FileTypeBadge name={file.name} compact />
        <View style={styles.fileBody}><Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{file.name || '未命名文件'}</Text>
          {formatBytes(file.bytes) ? <Text style={styles.fileSize}>{formatBytes(file.bytes)}</Text> : null}
        </View>
      </View>)}
      <ImageViewer visible={opened?.api === api && opened.sessionId === sessionId} initialIndex={opened?.index ?? 0}
        images={images.map((image, index) => ({ uri: statuses[index].uri, caption: image.name || `图片 ${index + 1}`,
          failed: statuses[index].phase === 'failed', onRetry: () => retry(index),
          onError: () => { const uri = statuses[index].uri; if (uri) failed(index, uri); },
        }))} onClose={() => setOpened(null)} />
    </View>
  );
}
function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    gallery: { marginBottom: 6, alignItems: 'flex-end' },
    imgRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' },
    thumbBox: { borderRadius: tv.radius.md, marginLeft: tv.space.xs, marginBottom: tv.space.xs, backgroundColor: C.bgOverlay },
    thumbPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
    failure: { color: C.textSecondary, fontSize: tv.type.xs }, retry: { color: C.accent, fontSize: tv.type.xs },
    fileChip: { flexDirection: 'row', alignItems: 'center', maxWidth: 260, paddingVertical: 7, paddingHorizontal: 9, marginLeft: tv.space.xs, marginBottom: tv.space.xs, borderRadius: tv.radius.md, backgroundColor: C.bgCard, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
    fileBody: { flexShrink: 1, minWidth: 0, marginLeft: tv.space.sm },
    fileName: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    fileSize: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 1 },
  });
}
