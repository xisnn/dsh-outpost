/**
 * 「执行过程组」卡片（F-02）。
 *
 * 把一轮回答里的 Thinking / 工具调用收进一个折叠组：
 *   · 执行中：组头显示运行状态，并常驻一行「最近动态」，进度不会被藏起来；
 *   · 执行完：默认折叠，摘要「已执行 N 步 · 耗时 X 秒」；
 *   · 点开：按原始顺序展示思考与工具记录（思考仍用 ThinkingAccordion，
 *     工具仍用 ToolCard，不复制任何新的复制入口）。
 *
 * 最终回答由聊天页渲染在组外（见 ChatScreen），不会混进来。
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { workGroupSummary, type WorkGroupView } from '../core/workGroup';
import { useTheme } from '../design/theme';
import { radius, space, type, weight, toolMeta } from '../design/tokens';
import { AssistantText } from './Message';
import { FileCard } from './FileCard';
import { isImagePath } from './AssistantRichText';
import { Collapse } from './ui';
import { ThinkingAccordion } from './Thinking';
import { ToolCard } from './ToolCard';

export function WorkGroupCard({
  group,
  sessionId,
}: {
  group: WorkGroupView;
  /** 透给文本 / 文件块（图片走网关下载需要） */
  sessionId?: string;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);

  const statusColor = group.failed
    ? tv.colors.danger
    : group.running
      ? tv.colors.textTertiary
      : tv.colors.success;

  const latest = group.latestTool;
  const latestText = latest
    ? `${toolMeta(latest.name).label}${latest.pending ? ' · 执行中' : latest.isError ? ' · 失败' : ' · 完成'}`
    : '';

  return (
    <View style={[styles.card, group.failed && styles.cardFailed]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }: { pressed: boolean }) => [
          styles.head,
          pressed ? { backgroundColor: tv.colors.bgCard } : null,
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={group.running ? '执行过程，进行中' : '执行过程，已完成'}
      >
        <View style={styles.iconCol}>
          {group.running ? (
            <ActivityIndicator size="small" color={tv.colors.textTertiary} />
          ) : (
            <View style={[styles.iconBadge, { borderColor: statusColor + '44' }]}>
              <Text style={[styles.iconChar, { color: statusColor }]}>
                {group.failed ? '!' : '✓'}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.main}>
          <Text style={[styles.title, group.failed && { color: tv.colors.danger }]}>
            {group.running ? '正在执行…' : workGroupSummary(group)}
          </Text>
          {group.running ? (
            <Text style={styles.live} numberOfLines={1}>
              {latestText ? `最近：${latestText}` : '思考中…'}
            </Text>
          ) : null}
        </View>

        <Text style={styles.chevron}>{open ? '⌃' : '⌄'}</Text>
      </Pressable>

      {open ? (
        <Collapse>
          <View style={styles.body}>
            {group.items.map((item) => {
              const key = `wg-${group.turn}-${item.index}`;
              const block = item.block;
              if (block.kind === 'reasoning') {
                return (
                  <ThinkingAccordion
                    key={key}
                    text={block.text}
                    done={!group.running || !block.streaming}
                  />
                );
              }
              if (block.kind === 'tool') return <ToolCard key={key} block={block} />;
              if (block.kind === 'file') {
                return (
                  <View key={key} style={styles.fileWrap}>
                    <FileCard
                      path={block.path}
                      alt={block.description}
                      image={isImagePath(block.path)}
                      sessionId={sessionId}
                    />
                  </View>
                );
              }
              return <AssistantText key={key} text={block.text} sessionId={sessionId} />;
            })}
          </View>
        </Collapse>
      ) : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    card: {
      marginHorizontal: space.lg + 2,
      marginBottom: space.sm,
      backgroundColor: C.toolBg,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.toolBorder,
      overflow: 'hidden',
    },
    cardFailed: { borderColor: C.dangerWash },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.md + 2,
      paddingVertical: 10,
    },
    iconCol: { width: 24, alignItems: 'center', justifyContent: 'center' },
    iconBadge: {
      width: 22,
      height: 22,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconChar: { fontSize: 11, fontWeight: weight.semibold },
    main: { flex: 1, marginLeft: space.sm + 2, minWidth: 0 },
    title: { color: C.textSecondary, fontSize: type.sm + 0.5, fontWeight: weight.medium },
    live: {
      color: C.textFaint,
      fontSize: type.xs,
      marginTop: 2,
    },
    chevron: { color: C.textFaint, fontSize: 12, marginLeft: space.sm },
    body: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.toolBorder,
      paddingTop: space.xs,
      paddingBottom: space.xs,
    },
    fileWrap: { paddingHorizontal: space.sm },
  });
}
