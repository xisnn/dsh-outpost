/**
 * 轻量 Markdown 渲染。
 *
 * ## 为什么自己写
 *
 * 项目里原本**没有** markdown 库 —— 聊天里那些 `**加粗**` 是原样显示星号的。
 * 引一个 RN 的 markdown 库（react-native-markdown-display）要带
 * markdown-it + 一堆依赖，体积不小；而我们要支持的语法其实不多。
 *
 * 用到的语法：标题、加粗、斜体、行内代码、代码块、列表、引用、
 * 分割线、链接。表格单独处理（聊天里表格很常见）。
 *
 * ## 设计
 *
 * 解析和渲染分开：
 *   - `parseMarkdown(text)` → 块数组（纯函数，可单测）
 *   - `<MarkdownView>` → 按块渲染
 *
 * 行内样式（**加粗** 之类）用 `parseInline` 切成片段再逐段渲染。
 * 不追求 100% 符合 CommonMark，够用就行 —— 目标是让 AI 的输出好看，
 * 不是做通用 markdown 引擎。
 */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

import { parseMarkdown, parseInline, type Block, type Inline } from '../core/markdown';
import { CopyTextButton } from './CopyTextButton';

export { parseMarkdown, parseInline };

// ── 渲染 ────────────────────────────────────────────────────────────

export function MarkdownView({
  text,
  /** 嵌在卡片里时传 false，避免双重内边距 */
  inset = true,
  onLongPress,
}: {
  text: string;
  inset?: boolean;
  /** 长按正文（标题/段落/列表/引用/表格）→ 聊天页弹「复制全文」面板 */
  onLongPress?: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  /*
    长按菜单挂在**非代码块**外层的 Pressable 上，而不是包住整个 MarkdownView：
      · Text 自己的 onLongPress 在 Fabric 下和嵌套行内 Text 一起用时不可靠；
      · 代码块（case 'code'）右上角有独立的 CopyTextButton（Pressable），
        如果被外层 Pressable 包住，Android 上容易出现父子 Pressable 抢点击，
        且长按代码会误弹「复制全文」面板而不是选中代码。
      · 因此代码块独立渲染，正文块各自挂 onLongPress。
  */
  return (
    <View style={inset ? styles.wrap : null}>
      {blocks.map((b, i) => {
        const node = <BlockView key={i} block={b} />;
        if (!onLongPress || b.kind === 'code' || b.kind === 'hr') return node;
        return (
          <Pressable onLongPress={onLongPress} delayLongPress={400} key={i}>
            {node}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 正文文本的公共属性（目前为空：长按由外层 Pressable 承担）。
 *
 * ⚠️ 不要在这里加 `selectable`：Android 的原生文本选择由长按触发，
 * 和外层「长按弹复制菜单」会互相抢事件（实测两者都不触发）。
 * 正文的部分选择走聊天页的「选择文本」浮层（纯 Text + selectable，无手势竞争）。
 * 代码块不受影响：它没有长按菜单，仍然是 selectable。
 */
function bodyTextProps(_onLongPress?: () => void) {
  return { selectable: true as const };
}

function BlockView({ block }: { block: Block }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const textProps = bodyTextProps();

  switch (block.kind) {
    case 'heading': {
      // 1~6 级压成三档，手机上字号差异太大反而乱
      const size =
        block.level === 1 ? tv.type.xl : block.level === 2 ? tv.type.lg : tv.type.base;
      return (
        <Text
          style={[styles.heading, { fontSize: size, lineHeight: size * 1.4 }]}
          {...textProps}
        >
          {inlineText(parseInline(block.text), styles)}
        </Text>
      );
    }
    case 'paragraph':
      return (
        <Text style={styles.body} {...textProps}>
          {inlineText(parseInline(block.text), styles)}
        </Text>
      );
    case 'code':
      return (
        <View style={styles.codeBox}>
          {/* 标题栏：左边语言名，右边一键复制。
              复制按钮是「次要动作」，字号压到最小、常态几乎隐形（见 CopyTextButton） */}
          <View style={styles.codeHead}>
            <Text style={styles.codeLang} numberOfLines={1}>
              {block.lang ?? 'code'}
            </Text>
            <CopyTextButton text={block.text} accessibilityLabel="复制代码" />
          </View>
          <Text style={styles.codeText} selectable>
            {block.text}
          </Text>
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((it, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={styles.bullet}>{block.ordered ? `${i + 1}.` : '•'}</Text>
              <Text style={styles.listText} {...textProps}>
                {inlineText(parseInline(it), styles)}
              </Text>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text style={styles.quoteText} {...textProps}>
            {inlineText(parseInline(block.text), styles)}
          </Text>
        </View>
      );
    case 'hr':
      return <View style={styles.hr} />;
    case 'table':
      return (
        <View style={styles.table}>
          <View style={[styles.tr, styles.thead]}>
            {block.header.map((c, i) => (
              <Text key={i} style={[styles.th, styles.td]} numberOfLines={3} {...textProps}>
                {c}
              </Text>
            ))}
          </View>
          {block.rows.map((r, ri) => (
            <View key={ri} style={styles.tr}>
              {block.header.map((_, ci) => (
                <Text key={ci} style={styles.td} numberOfLines={4} {...textProps}>
                  {r[ci] ?? ''}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    default:
      return null;
  }
}

/** 把行内片段拼成一组 <Text> */
function inlineText(
  parts: Inline[],
  styles: ReturnType<typeof makeStyles>,
): React.ReactNode[] {
  return parts.map((p, i) => {
    switch (p.kind) {
      case 'bold':
        return (
          <Text key={i} style={styles.bold}>
            {p.text}
          </Text>
        );
      case 'italic':
        return (
          <Text key={i} style={styles.italic}>
            {p.text}
          </Text>
        );
      case 'code':
        return (
          <Text key={i} style={styles.inlineCode}>
            {p.text}
          </Text>
        );
      case 'link':
        // 不打开外链（避免引入 Linking 的权限问题），只做视觉区分
        return (
          <Text key={i} style={styles.link}>
            {p.text}
          </Text>
        );
      case 'image':
        // 图片语法但路径不是本地文件（外链 / 解析不了）。
        // 不显示感叹号，只显示 alt 文字，避免出现「!标题」这种残片。
        return <Text key={i}>{p.text}</Text>;
      default:
        return <Text key={i}>{p.text}</Text>;
    }
  });
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: { paddingHorizontal: tv.layout.screenPadding },
    heading: {
      color: C.text,
      fontWeight: tv.weight.semibold,
      marginTop: tv.space.md,
      marginBottom: tv.space.xs,
    },
    body: {
      color: C.text,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.55,
      marginVertical: tv.space.xs,
    },
    bold: { fontWeight: tv.weight.semibold },
    italic: { fontStyle: 'italic' },
    inlineCode: {
      fontFamily: 'monospace',
      fontSize: tv.type.sm,
      color: C.accentBright,
      backgroundColor: C.bgCard,
    },
    link: { color: C.accent, textDecorationLine: 'underline' },
    codeBox: {
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.sm,
      padding: tv.space.sm,
      marginVertical: tv.space.sm,
    },
    codeHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    codeLang: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      flexShrink: 1,
      marginRight: 8,
    },
    codeText: {
      fontFamily: 'monospace',
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      color: C.text,
    },
    list: { marginVertical: tv.space.xs },
    listRow: { flexDirection: 'row', marginVertical: 2 },
    bullet: {
      color: C.textSecondary,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.55,
      width: 20,
    },
    listText: {
      flex: 1,
      color: C.text,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.55,
    },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: C.border,
      paddingLeft: tv.space.sm,
      marginVertical: tv.space.sm,
    },
    quoteText: {
      color: C.textSecondary,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.55,
    },
    hr: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginVertical: tv.space.md,
    },
    table: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      borderRadius: tv.radius.sm,
      overflow: 'hidden',
      marginVertical: tv.space.sm,
    },
    tr: { flexDirection: 'row' },
    thead: { backgroundColor: C.bgCard },
    th: { fontWeight: tv.weight.semibold },
    td: {
      flex: 1,
      color: C.text,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.45,
      paddingHorizontal: 6,
      paddingVertical: 5,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
  });
}
