/**
 * 工具调用卡片。
 *
 * 视觉：
 * - 左侧状态点（执行中脉冲 / 完成绿 / 失败红）
 * - 工具图标 + 中文名 + 参数摘要（等宽字体）
 * - 展开：edit/write 显示简洁 Diff 预览；其它工具显示原始参数与输出预览
 * - 超长输出 / 超长 Diff 通过「查看完整…」打开全屏查看器（完整内容 + 复制全部）
 *
 * 复制入口的边界：
 *   · 卡片上**没有**常驻复制按钮；
 *   · 唯一入口在全屏查看器内部（复制全部）；
 *   · 卡片内正文、输出都是 selectable，可直接选一部分。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ToolBlock } from '../core/fold';
import { buildOutputPreview, parseToolDiff, toolPath, type DiffLine, type ToolDiff } from '../core/toolDiff';
import { useTheme } from '../design/theme';
import { radius, space, type, weight, toolMeta } from '../design/tokens';
import { Collapse } from './ui';
import { ToolOutputViewer } from './ToolOutputViewer';

type Styles = ReturnType<typeof makeStyles>;

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'description', 'sessionId', 'name']) {
    if (typeof o[key] === 'string' && o[key]) {
      const v = String(o[key]).replace(/\s+/g, ' ').trim();
      return v.length > 70 ? v.slice(0, 70) + '…' : v;
    }
  }
  const first = Object.entries(o).find(([, v]) => typeof v === 'string' && v);
  if (first) return String(first[1]).slice(0, 70);
  return JSON.stringify(input).slice(0, 70);
}

/** 执行中的脉冲点 */
function PulseDot({ color, styles }: { color: string; styles: Styles }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 1,
          duration: 750,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 0,
          duration: 750,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[
          styles.dotHalo,
          {
            backgroundColor: color,
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.05, 0.3] }),
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
          },
        ]}
      />
      <View style={[styles.dotCore, { backgroundColor: color }]} />
    </View>
  );
}

/** 一行 diff：前缀 + 文本，底色区分增删 */
function DiffPreviewRow({ line, styles }: { line: DiffLine; styles: Styles }) {
  const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  return (
    <View
      style={[
        styles.diffRow,
        line.kind === 'add' ? styles.diffRowAdd : null,
        line.kind === 'del' ? styles.diffRowDel : null,
      ]}
    >
      <Text style={styles.diffPrefix}>{prefix}</Text>
      <Text style={styles.diffText} numberOfLines={2}>
        {line.text || ' '}
      </Text>
    </View>
  );
}

export function ToolCard({ block }: { block: ToolBlock }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);
  /** 全屏查看器：看 diff 还是看输出 */
  const [viewer, setViewer] = useState<'diff' | 'output' | null>(null);
  const meta = toolMeta(block.name);
  const summary = summarize(block.input);

  // 解析失败一律回退原始参数（edit/write 结构不标准时不能让卡片空白）
  const diff = useMemo<ToolDiff | null>(() => parseToolDiff(block.name, block.input), [block.name, block.input]);
  const outputPreview = useMemo(() => buildOutputPreview(block.output), [block.output]);

  const statusColor = block.pending
    ? tv.colors.textTertiary
    : block.isError
      ? tv.colors.danger
      : tv.colors.success;
  const statusText = block.pending ? '执行中' : block.isError ? '失败' : '完成';

  const toggle = () => setOpen((v) => !v);

  return (
    <View style={[styles.card, block.isError && styles.cardError]}>
      {/* 只有头部负责展开/收起：卡片正文里还有按钮，整卡 Pressable 会抢点击 */}
      <Pressable
        onPress={toggle}
        style={({ pressed }: { pressed: boolean }) => [
          styles.head,
          pressed ? { backgroundColor: tv.colors.bgCard } : null,
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={styles.iconCol}>
          {block.pending ? (
            <PulseDot color={tv.colors.textTertiary} styles={styles} />
          ) : (
            <View style={[styles.iconBadge, { borderColor: statusColor + '44' }]}>
              <Text style={[styles.iconChar, { color: statusColor }]}>{meta.icon}</Text>
            </View>
          )}
        </View>

        <View style={styles.main}>
          <View style={styles.titleLine}>
            <Text style={styles.toolName} numberOfLines={1}>
              {meta.label}
            </Text>
            <Text style={[styles.status, { color: statusColor }]}>{statusText}</Text>
          </View>
          {summary ? (
            <Text style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
        </View>

        <Text style={styles.chevron}>{open ? '⌃' : '⌄'}</Text>
      </Pressable>

      {open ? (
        <Collapse>
          <View style={styles.body}>
            {diff ? (
              <>
                {diff.path ? (
                  <Text style={styles.diffPath} numberOfLines={1}>
                    {diff.path}
                  </Text>
                ) : null}
                <View style={styles.diffHeadRow}>
                  <Text style={styles.bodyLabel}>变更</Text>
                  <Text style={styles.diffStat}>
                    <Text style={{ color: tv.colors.success }}>+{diff.added}</Text>
                    <Text style={{ color: tv.colors.textFaint }}>{'  '}</Text>
                    <Text style={{ color: tv.colors.danger }}>−{diff.removed}</Text>
                  </Text>
                </View>
                <View style={styles.diffBox}>
                  {diff.preview.map((line, i) => (
                    <DiffPreviewRow key={`${line.kind}-${i}`} line={line} styles={styles} />
                  ))}
                </View>
                {diff.truncated ? (
                  <Pressable
                    onPress={() => setViewer('diff')}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.linkBtn,
                      pressed ? { opacity: tv.motion.pressOpacity } : null,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="查看完整差异"
                  >
                    <Text style={styles.linkText}>
                      查看完整差异（共 {diff.lines.length} 行）
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <>
                <Text style={styles.bodyLabel}>参数</Text>
                <Text style={styles.code} selectable>
                  {typeof block.input === 'string'
                    ? block.input
                    : JSON.stringify(block.input, null, 2)}
                </Text>
              </>
            )}

            {block.output !== undefined ? (
              <>
                <Text style={styles.bodyLabel}>输出</Text>
                {outputPreview.text ? (
                  <Text
                    style={[styles.code, block.isError && { color: tv.colors.danger }]}
                    selectable
                  >
                    {outputPreview.text}
                  </Text>
                ) : (
                  <Text style={styles.emptyText}>(无输出)</Text>
                )}
                {outputPreview.truncated ? (
                  <Pressable
                    onPress={() => setViewer('output')}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.linkBtn,
                      pressed ? { opacity: tv.motion.pressOpacity } : null,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="查看完整输出"
                  >
                    <Text style={styles.linkText}>
                      查看完整输出（共 {outputPreview.totalLines} 行）
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </View>
        </Collapse>
      ) : null}

      {/* 全屏查看器：完整内容 + 复制全部（卡片上没有复制按钮） */}
      <ToolOutputViewer
        visible={viewer !== null}
        title={`${meta.label} · ${viewer === 'diff' ? '差异' : '输出'}`}
        subtitle={diff?.path || toolPath(block.input)}
        content={viewer === 'output' ? block.output ?? '' : undefined}
        diff={viewer === 'diff' && diff ? diff : undefined}
        onClose={() => setViewer(null)}
      />
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
    cardError: { borderColor: C.dangerWash },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.md + 2,
      paddingVertical: 11,
    },
    iconCol: { width: 24, alignItems: 'center', justifyContent: 'center' },
    iconBadge: {
      width: 24,
      height: 24,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconChar: { fontSize: 12, fontWeight: weight.semibold },
    dotWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
    dotHalo: { position: 'absolute', width: 9, height: 9, borderRadius: 4.5 },
    dotCore: { width: 5, height: 5, borderRadius: 2.5 },
    main: { flex: 1, marginLeft: space.sm + 2, minWidth: 0 },
    titleLine: { flexDirection: 'row', alignItems: 'center' },
    toolName: { color: C.text, fontSize: type.sm + 0.5, fontWeight: weight.semibold },
    status: { fontSize: type.micro, marginLeft: space.sm, fontWeight: weight.medium },
    summary: {
      color: C.textFaint,
      fontSize: type.xs,
      marginTop: 3,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    chevron: { color: C.textFaint, fontSize: 12, marginLeft: space.sm },
    body: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.toolBorder,
      paddingHorizontal: space.md,
      paddingBottom: space.md,
      paddingTop: space.sm,
    },
    bodyLabel: {
      color: C.textFaint,
      fontSize: type.micro,
      fontWeight: weight.semibold,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginBottom: 5,
      marginTop: space.sm,
    },
    code: {
      color: C.textSecondary,
      fontSize: type.xs,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      lineHeight: 17,
    },
    emptyText: { color: C.textFaint, fontSize: type.xs },
    diffPath: {
      color: C.textFaint,
      fontSize: type.micro,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      marginTop: 2,
    },
    diffHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    diffStat: { fontSize: type.micro, marginTop: space.sm, fontFamily: 'monospace' },
    diffBox: {
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.toolBorder,
      overflow: 'hidden',
      marginTop: 2,
    },
    diffRow: {
      flexDirection: 'row',
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    diffRowAdd: { backgroundColor: C.successWash },
    diffRowDel: { backgroundColor: C.dangerWash },
    diffPrefix: { width: 12, color: C.textTertiary, fontSize: type.xs, lineHeight: 17 },
    diffText: {
      flex: 1,
      color: C.textSecondary,
      fontSize: type.xs,
      lineHeight: 17,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    linkBtn: { alignSelf: 'flex-start', marginTop: space.sm, paddingVertical: 2 },
    linkText: { color: C.accentBright, fontSize: type.xs, fontWeight: weight.medium },
  });
}
