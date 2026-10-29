/**
 * 消息气泡与助手文本。
 *
 * 视觉：
 * - 用户气泡：深色圆角 + 细描边，右对齐，最大宽 84%
 * - 长文本自动折叠 + 底部渐隐（多层半透明叠加模拟 mask）
 * - 助手文本：无气泡，左对齐，行高宽松
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/theme';
import { layout, motion, radius, space, type, weight } from '../design/tokens';
import type { AttachRef } from '../core/types';
import type { UploadApi } from '../core/rpc/upload';
import { AttachmentGallery } from './Attachment';
import { AssistantRichText } from './AssistantRichText';
import { CopyTextButton } from './CopyTextButton';
import { copyTextToClipboard } from './clipboard';

/** 长按复制后的提示停留时长 */
const COPIED_HINT_MS = 1200;

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
  /** 长按复制后短暂显示「已复制」——没有这个反馈，用户不知道复制成功没有 */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = null;
    },
    [],
  );

  /**
   * 长按气泡 = 复制这条消息。
   *
   * 为什么用长按而不是常驻按钮：用户消息是用户自己打的，复制频率远低于
   * 助手回复；为它常驻一行操作会明显加重视觉负担。气泡里的正文是
   * `selectable` 的，Android 上长按可能先被文本选择吃掉 —— 所以这里
   * 只作为「顺手可用」的补充，助手消息另有明确的「复制」入口。
   */
  const onLongPress = useCallback(() => {
    if (!text || !text.trim()) return;
    if (!copyTextToClipboard(text)) return;
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_HINT_MS);
  }, [text]);

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
          onLongPress={onLongPress}
          delayLongPress={350}
          style={({ pressed }: { pressed: boolean }) => [
            styles.userBubble,
            collapsed && { maxHeight: motion.collapseThresholdPx, overflow: 'hidden' },
            pressed && needsFold ? { opacity: 0.9 } : null,
          ]}
          accessibilityHint="长按复制这条消息"
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
        {copied ? <Text style={styles.copiedChip}>已复制</Text> : null}
      </View>
    </View>
  );
}

/**
 * 助手消息下方的「复制全文」。
 *
 * 放在正文末尾、右对齐：不抢正文注意力，但一眼能找到；
 * 只对「一轮里的最后一条助手步骤」渲染（见 ChatScreen 的 finalAssistantKeys），
 * 避免中间步骤各挂一个按钮。
 */
export function AssistantCopyRow({ text }: { text: string }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  if (!text || !text.trim()) return null;
  return (
    <View style={styles.copyRow}>
      <CopyTextButton text={text} variant="bar" accessibilityLabel="复制这条消息" />
    </View>
  );
}

export function AssistantText({
  text,
  sessionId,
}: {
  text: string;
  /** 会话 id：透给 RichText，让内嵌图片能走网关下载 */
  sessionId?: string;
}) {
  const trimmed = text?.trim();
  // 空文本不渲染，避免留下孤立的空白块
  if (!trimmed) return null;
  // 必须走 AssistantRichText：它会把 markdown 里的 ![](path) 拆成文件引用，
  // 图片才能真正显示成图。
  // 这里曾经是纯 <Text>，结果管家贴的 ![封面](cover.jpg) 在手机上
  // 只是一串字（或者被吞掉），用户看到的就是「图片显示不了」。
  return <AssistantRichText text={trimmed} sessionId={sessionId} />;
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

    /** 长按复制后的短暂提示：绝对定位，不参与布局（否则气泡会跳一下） */
    copiedChip: {
      position: 'absolute',
      right: 8,
      bottom: -7,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.sm,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      color: C.accentBright,
      fontSize: type.micro,
      overflow: 'hidden',
    },

    /** 助手消息「复制全文」所在行：与正文同缩进、右对齐 */
    copyRow: {
      paddingHorizontal: layout.screenPadding + layout.assistantInset,
      alignItems: 'flex-end',
      marginTop: -2,
      marginBottom: space.xs,
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
