/**
 * 消息气泡与助手文本。
 *
 * 视觉：
 * - 用户气泡：深色圆角 + 细描边，右对齐，最大宽 84%
 * - 长文本自动折叠 + 底部渐隐（多层半透明叠加模拟 mask）
 * - 助手文本：无气泡，左对齐，行高宽松
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/theme';
import { layout, motion, radius, space, type, weight } from '../design/tokens';
import type { AttachRef } from '../core/types';
import type { UploadApi } from '../core/rpc/upload';
import { AttachmentGallery } from './Attachment';

export function UserBubble({
  text,
  time,
  parts,
  sessionId,
  api,
}: {
  text: string;
  time?: number;
  /** 附件（图片 / 文件） */
  parts?: AttachRef[];
  sessionId?: string;
  api?: UploadApi;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [expanded, setExpanded] = useState(false);
  const [needsFold, setNeedsFold] = useState(false);

  const onLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
    if (!expanded && !needsFold && e.nativeEvent.layout.height > motion.collapseThresholdPx) {
      setNeedsFold(true);
    }
  };

  const collapsed = needsFold && !expanded;
  const hasText = !!text && text.trim().length > 0;
  const hasParts = !!parts && parts.length > 0;
  const gallery =
    hasParts && sessionId && api ? (
      <AttachmentGallery sessionId={sessionId} parts={parts} api={api} />
    ) : null;

  // 纯附件消息：不套气泡，免得图片外面多一层灰底
  if (!hasText) {
    return (
      <View style={[styles.userRow, styles.userRowBare]}>
        <View style={styles.userCol}>{gallery}</View>
      </View>
    );
  }

  return (
    <View style={styles.userRow}>
      <View style={styles.userCol}>
        {gallery}
        <Pressable
          onPress={() => needsFold && setExpanded((v) => !v)}
          style={({ pressed }: { pressed: boolean }) => [
            styles.userBubble,
            collapsed && { maxHeight: motion.collapseThresholdPx, overflow: 'hidden' },
            pressed && needsFold ? { opacity: 0.9 } : null,
          ]}
        >
          <View onLayout={onLayout}>
            <Text style={styles.userText} selectable>
              {text}
            </Text>
          </View>

          {collapsed ? (
            <>
              <View pointerEvents="none" style={styles.fade1} />
              <View pointerEvents="none" style={styles.fade2} />
              <View pointerEvents="none" style={styles.fade3} />
              <View style={styles.expandRow}>
                <Text style={styles.expandText}>展开全文</Text>
              </View>
            </>
          ) : null}
        </Pressable>
      </View>
    </View>
  );
}

export function AssistantText({ text }: { text: string }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const trimmed = text?.trim();
  // 空文本不渲染，避免留下孤立的空白块
  if (!trimmed) return null;
  return (
    <View style={styles.assistantRow}>
      <Text style={styles.assistantText} selectable>
        {trimmed}
      </Text>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  const BUBBLE = C.bubbleUser;
  return StyleSheet.create({
    userRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: layout.screenPadding,
      marginTop: space.md,
      marginBottom: space.sm,
    },
    /** 只有附件、没有文字时少给一点上间距 */
    userRowBare: { marginTop: space.sm },
    /** 附件竖排 + 气泡，整体靠右、限制最大宽度 */
    userCol: {
      maxWidth: `${layout.bubbleMaxWidthRatio * 100}%`,
      alignItems: 'flex-end',
    },
    userBubble: {
      maxWidth: '100%',
      backgroundColor: BUBBLE,
      borderRadius: radius.bubble,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.bubbleUserBorder,
      paddingHorizontal: space.lg,
      paddingVertical: space.md - 1,
    },
    userText: {
      color: C.text,
      fontSize: type.base,
      lineHeight: type.base * type.lineHeight,
      letterSpacing: 0.1,
    },
    // 三段渐变：越往下越接近气泡色
    fade1: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: motion.collapseFadePx * 0.66,
      height: motion.collapseFadePx * 0.34,
      backgroundColor: BUBBLE,
      opacity: 0.25,
    },
    fade2: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: motion.collapseFadePx * 0.33,
      height: motion.collapseFadePx * 0.33,
      backgroundColor: BUBBLE,
      opacity: 0.6,
    },
    fade3: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: motion.collapseFadePx * 0.33,
      backgroundColor: BUBBLE,
      opacity: 0.95,
      borderBottomLeftRadius: radius.bubble,
      borderBottomRightRadius: radius.bubble,
    },
    expandRow: {
      position: 'absolute',
      bottom: 6,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    expandText: {
      color: C.accentBright,
      fontSize: type.xs,
      fontWeight: weight.medium,
    },

    assistantRow: {
      paddingHorizontal: layout.screenPadding + layout.assistantInset,
      marginBottom: space.md,
    },
    assistantText: {
      color: C.text,
      fontSize: type.base,
      lineHeight: type.base * 1.62,
      letterSpacing: 0.15,
    },
  });
}
