/**
 * P0-1 待发送气泡。
 *
 * 文本发送由 PendingSendRecord 驱动：这里展示“待发送 / 发送中 /
 * 结果未知 / 未发出 / 已受理”，并只把“用户明确重试”交给上层。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { layout, radius, space, type, weight } from '../design/tokens';
import type { PendingSendRecord } from '../core/pendingSend/types';
import { canAbandonPendingSend, canUserRetry } from '../core/pendingSend/state';
import { pendingSendSpinnerDelayMs } from '../core/pendingSend/ui';

export const PENDING_SEND_SPINNER_DELAY_MS = 600;

/** 延迟转圈：preparing/sending 持续超过 600ms 才显示，避免快速发送时闪烁。 */
function DelayedSpinner({ record }: { record: PendingSendRecord }) {
  const tv = useTheme();
  const delay = pendingSendSpinnerDelayMs(record);
  const [visible, setVisible] = useState(delay === 0);

  useEffect(() => {
    if (delay === null) {
      setVisible(false);
      return;
    }
    if (delay <= 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay, record.state, record.updatedAt]);

  if (delay === null) return null;
  return (
    <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
      {visible ? <ActivityIndicator size="small" color={tv.colors.accent} /> : null}
    </View>
  );
}

function statusOf(record: PendingSendRecord): { label: string; tone: 'muted' | 'warning' | 'danger' | 'accent' } {
  switch (record.state) {
    case 'queued':
      return { label: '待发送（新消息）', tone: 'muted' };
    case 'ready':
      return { label: '待发送', tone: 'muted' };
    case 'preparing':
      return { label: '准备发送…', tone: 'muted' };
    case 'sending':
      return { label: '发送中…', tone: 'accent' };
    case 'accepted':
      return { label: '已受理，等待会话确认', tone: 'muted' };
    case 'unknown':
      return { label: '结果未知，可能已在电脑执行', tone: 'warning' };
    case 'failed':
      return { label: '未发出', tone: 'danger' };
    case 'expired': {
      const from = record.expiredFrom;
      if (from === 'unknown' || from === 'sending') {
        return {
          label: '已过期，发送结果未确认，可能已执行（附件已清理）',
          tone: 'warning',
        };
      }
      if (from === 'accepted') {
        return {
          label: '已过期，服务端曾受理但未确认（附件已清理）',
          tone: 'muted',
        };
      }
      return { label: '已过期，未发送（附件已清理）', tone: 'muted' };
    }
    case 'abandoned':
      return { label: '已放弃', tone: 'muted' };
    case 'confirmed':
      return { label: '已确认', tone: 'muted' };
    default:
      return { label: record.state, tone: 'muted' };
  }
}

export function PendingSendBubble({
  record,
  busy = false,
  onRetry,
  onRemove,
}: {
  record: PendingSendRecord;
  busy?: boolean;
  onRetry: (record: PendingSendRecord) => void;
  onRemove?: (record: PendingSendRecord) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const status = statusOf(record);
  const retryable = canUserRetry(record);
  const removable = canAbandonPendingSend(record) && !!onRemove;
  const toneColor =
    status.tone === 'warning'
      ? tv.colors.warning
      : status.tone === 'danger'
        ? tv.colors.danger
        : status.tone === 'accent'
          ? tv.colors.accent
          : tv.colors.textTertiary;

  return (
    <View style={styles.wrap}>
      <View style={styles.bubble}>
        <Text style={styles.text}>{record.text}</Text>
        {record.attachments.length > 0 ? (
          <View style={styles.attachments}>
            {record.attachments.map((a) => (
              <Text key={`${a.stagedUri}-${a.name}`} style={styles.attachment} numberOfLines={1}>
                {a.kind === 'image' ? '图片' : '文件'}：{a.name}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={styles.footer}>
          <DelayedSpinner record={record} />
          <Text style={[styles.status, { color: toneColor }]}>{status.label}</Text>
          {retryable ? (
            <Pressable
              disabled={busy}
              onPress={() => onRetry(record)}
              style={({ pressed }: { pressed: boolean }) => [
                styles.retry,
                pressed ? { opacity: tv.motion.pressOpacity } : null,
              ]}
            >
              <Text style={styles.retryText}>
                {record.state === 'unknown' || record.state === 'failed'
                  ? '安全重试（复用原 ID）'
                  : '继续发送'}
              </Text>
            </Pressable>
          ) : null}
          {removable ? (
            <Pressable
              disabled={busy}
              onPress={() => onRemove?.(record)}
              style={({ pressed }: { pressed: boolean }) => [
                styles.remove,
                pressed ? { opacity: tv.motion.pressOpacity } : null,
              ]}
            >
              <Text style={styles.removeText}>移除</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      paddingHorizontal: layout.screenPadding,
      paddingTop: space.sm,
    },
    bubble: {
      alignSelf: 'flex-end',
      maxWidth: '88%',
      backgroundColor: C.bgCard,
      borderColor: C.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.lg,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    text: {
      color: C.text,
      fontSize: type.base,
      lineHeight: Math.round(type.base * 1.4),
    },
    attachments: {
      marginTop: space.xs,
      gap: 2,
    },
    attachment: {
      color: C.textTertiary,
      fontSize: type.xs,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: space.xs,
      gap: space.sm,
    },
    status: {
      flex: 1,
      fontSize: type.xs,
    },
    retry: {
      paddingHorizontal: space.sm,
      paddingVertical: 3,
      borderRadius: radius.sm,
      backgroundColor: C.bg,
      borderColor: C.borderStrong,
      borderWidth: StyleSheet.hairlineWidth,
    },
    retryText: {
      color: C.accent,
      fontSize: type.xs,
      fontWeight: weight.medium,
    },
    remove: {
      paddingHorizontal: space.sm,
      paddingVertical: 3,
      borderRadius: radius.sm,
      backgroundColor: C.bg,
      borderColor: C.borderStrong,
      borderWidth: StyleSheet.hairlineWidth,
    },
    removeText: {
      color: C.danger,
      fontSize: type.xs,
      fontWeight: weight.medium,
    },
  });
}
