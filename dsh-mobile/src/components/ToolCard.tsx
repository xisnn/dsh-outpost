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
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ToolBlock } from '../core/fold';
import { toolStatus, TOOL_STATUS_LABEL } from '../core/toolStatus';
import { buildOutputPreview, parseToolDiff, toolPath, type DiffLine, type ToolDiff } from '../core/toolDiff';
import { useTheme } from '../design/theme';
import { useReduceMotion } from '../design/useReduceMotion';
import { MotionPressable as Pressable } from './MotionPressable';
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
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (reduceMotion) {
      v.setValue(0);
      return;
    }
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
  }, [v, reduceMotion]);
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
      <Text style={styles.diffPrefix} selectable={false}>
        {prefix}
      </Text>
      <Text style={styles.diffText} numberOfLines={2} selectable>
        {line.text || ' '}
      </Text>
    </View>
  );
}

function DetailSection({ title, open, onToggle, detail, children, styles }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  detail?: React.ReactNode;
  children: React.ReactNode;
  styles: Styles;
}) {
  return <View style={styles.section}>
    <Pressable onPress={onToggle} style={styles.sectionHead} accessibilityRole="button"
      accessibilityLabel={`工具${title}`} accessibilityState={{ expanded: open }}
      accessibilityHint="展开或收起这个分区">
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionDetail}>{detail}</View>
      <Text style={styles.chevron}>{open ? '⌃' : '⌄'}</Text>
    </Pressable>
    <Collapse open={open}><View style={styles.sectionContent}>{children}</View></Collapse>
  </View>;
}

export function ToolCard({ block }: { block: ToolBlock }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  /** Full text is kept separately from bounded card previews. */
  const [viewer, setViewer] = useState<'diff' | 'output' | 'input' | null>(null);
  const meta = toolMeta(block.name);
  const summary = summarize(block.input);

  // 解析失败一律回退原始参数（edit/write 结构不标准时不能让卡片空白）
  const diff = useMemo<ToolDiff | null>(() => parseToolDiff(block.name, block.input), [block.name, block.input]);
  const outputPreview = useMemo(() => buildOutputPreview(block.output), [block.output]);
  const inputText = useMemo(() => typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2) ?? '(无参数)', [block.input]);
  const inputPreview = useMemo(() => buildOutputPreview(inputText, 12, 1200, '参数'), [inputText]);

  const status = toolStatus(block);
  const statusColor = status === 'running' || status === 'unconfirmed'
    ? tv.colors.textTertiary
    : status === 'failed'
      ? tv.colors.danger
      : tv.colors.success;
  const statusText = TOOL_STATUS_LABEL[status];

  const toggle = () => setOpen((v) => !v);

  return (
    <View style={[styles.card, status === 'failed' && styles.cardError]}>
      {/* 只有头部负责展开/收起：卡片正文里还有按钮，整卡 Pressable 会抢点击 */}
      <Pressable
        onPress={toggle}
        style={({ pressed }: { pressed: boolean }) => [
          styles.head,
          pressed ? { backgroundColor: tv.colors.bgCard } : null,
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${meta.label}，${statusText}`}
        accessibilityHint="展开或收起工具详情"
      >
        <View style={styles.iconCol}>
          {status === 'running' ? (
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

      <Collapse open={open}>
        <View style={styles.body}>
          <DetailSection title={diff ? '参数与变更' : '参数'} open={inputOpen}
            onToggle={() => setInputOpen(value => !value)} styles={styles}
            detail={diff ? <Text style={styles.diffStat}>
              <Text style={{ color: tv.colors.success }}>+{diff.added}</Text>
              <Text style={{ color: tv.colors.textFaint }}>{'  '}</Text>
              <Text style={{ color: tv.colors.danger }}>−{diff.removed}</Text>
            </Text> : <Text style={styles.sectionHint}>{inputPreview.totalLines} 行</Text>}>
            {diff ? (
              <>
                {diff.path ? <Text style={styles.diffPath} numberOfLines={1} ellipsizeMode="middle" selectable>{diff.path}</Text> : null}
                <View style={styles.diffBox}>
                  {diff.preview.map((line, i) => <DiffPreviewRow key={`${line.kind}-${i}`} line={line} styles={styles} />)}
                </View>
                {diff.truncated ? <Pressable onPress={() => setViewer('diff')} style={styles.linkBtn}
                  accessibilityRole="button" accessibilityLabel="查看完整差异">
                  <Text style={styles.linkText}>查看完整差异（共 {diff.lines.length} 行）</Text>
                </Pressable> : null}
              </>
            ) : <Text style={styles.code} selectable>{inputPreview.text || '(无参数)'}</Text>}
            {diff || inputPreview.truncated ? <Pressable onPress={() => setViewer('input')} style={styles.linkBtn}
              accessibilityRole="button" accessibilityLabel="查看完整参数">
              <Text style={styles.linkText}>查看完整参数</Text>
            </Pressable> : null}
          </DetailSection>

          <DetailSection title="输出" open={outputOpen} onToggle={() => setOutputOpen(value => !value)} styles={styles}
            detail={<Text style={styles.sectionHint}>{block.output === undefined && status === 'unconfirmed' ? '未收到结果' : block.output === undefined && status === 'running' ? '等待返回' : `${outputPreview.totalLines} 行`}</Text>}>
            {outputPreview.text ? <Text style={[styles.code, status === 'failed' && { color: tv.colors.danger }]} selectable>
              {outputPreview.text}
            </Text> : <Text style={styles.emptyText}>{status === 'unconfirmed' ? '本轮已结束，但没有收到这个工具的结果' : status === 'running' ? '等待工具返回输出…' : '(无输出)'}</Text>}
            {outputPreview.truncated ? (
              <Pressable onPress={() => setViewer('output')} style={styles.linkBtn}
                accessibilityRole="button" accessibilityLabel="查看完整输出">
                <Text style={styles.linkText}>查看完整输出（共 {outputPreview.totalLines} 行）</Text>
              </Pressable>
            ) : null}
          </DetailSection>
        </View>
      </Collapse>

      {/* 全屏查看器：完整内容 + 复制全部（卡片上没有复制按钮） */}
      <ToolOutputViewer
        visible={viewer !== null}
        title={`${meta.label} · ${viewer === 'diff' ? '差异' : viewer === 'input' ? '参数' : '输出'}`}
        subtitle={diff?.path || toolPath(block.input)}
        content={viewer === 'output' ? block.output ?? '' : viewer === 'input' ? inputText : undefined}
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
    section: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.toolBorder },
    sectionHead: { minHeight: 44, flexDirection: 'row', alignItems: 'center' },
    sectionTitle: { color: C.textSecondary, fontSize: type.xs, fontWeight: weight.semibold },
    sectionDetail: { flex: 1, alignItems: 'flex-end', marginLeft: space.sm },
    sectionHint: { color: C.textFaint, fontSize: type.micro },
    sectionContent: { paddingBottom: space.md },
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
    diffStat: { fontSize: type.micro, fontFamily: 'monospace' },
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
    linkBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: space.xs },
    linkText: { color: C.accentBright, fontSize: type.xs, fontWeight: weight.medium },
  });
}
