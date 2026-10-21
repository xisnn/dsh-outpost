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
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

import { parseMarkdown, parseInline, type Block, type Inline } from '../core/markdown';

export { parseMarkdown, parseInline };

// ── 渲染 ────────────────────────────────────────────────────────────

export function MarkdownView({
  text,
  /** 嵌在卡片里时传 false，避免双重内边距 */
  inset = true,
}: {
  text: string;
  inset?: boolean;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <View style={inset ? styles.wrap : null}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </View>
  );
}

function BlockView({ block }: { block: Block }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  switch (block.kind) {
    case 'heading': {
      // 1~6 级压成三档，手机上字号差异太大反而乱
      const size =
        block.level === 1 ? tv.type.xl : block.level === 2 ? tv.type.lg : tv.type.base;
      return (
        <Text style={[styles.heading, { fontSize: size, lineHeight: size * 1.4 }]}>
          {inlineText(parseInline(block.text), styles)}
        </Text>
      );
    }
    case 'paragraph':
      return <Text style={styles.body}>{inlineText(parseInline(block.text), styles)}</Text>;
    case 'code':
      return (
        <View style={styles.codeBox}>
          {block.lang ? <Text style={styles.codeLang}>{block.lang}</Text> : null}
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
              <Text style={styles.listText}>{inlineText(parseInline(it), styles)}</Text>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text style={styles.quoteText}>{inlineText(parseInline(block.text), styles)}</Text>
        </View>
      );
    case 'hr':
      return <View style={styles.hr} />;
    case 'table':
      return (
        <View style={styles.table}>
          <View style={[styles.tr, styles.thead]}>
            {block.header.map((c, i) => (
              <Text key={i} style={[styles.th, styles.td]} numberOfLines={3}>
                {c}
              </Text>
            ))}
          </View>
          {block.rows.map((r, ri) => (
            <View key={ri} style={styles.tr}>
              {block.header.map((_, ci) => (
                <Text key={ci} style={styles.td} numberOfLines={4}>
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
    codeLang: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      marginBottom: 4,
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
