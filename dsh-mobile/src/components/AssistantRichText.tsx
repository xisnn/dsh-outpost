/**
 * 渲染助手回复，把里面的本地文件引用变成可点击的卡片 / 图片。
 *
 * 纯解析逻辑在 core/filerefs.ts（可单测），这里只负责渲染。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { splitFileRefs } from '../core/filerefs';
import { FileCard } from './FileCard';
import { MarkdownView } from './MarkdownView';

export { splitFileRefs, isImagePath } from '../core/filerefs';

export function AssistantRichText({
  text,
  inset = true,
  sessionId,
}: {
  text: string;
  /** 是否自带左右内边距。嵌在卡片里时应传 false，避免双重缩进 */
  inset?: boolean;
  /** 会话 id：透给 FileCard 走网关下载（相对路径/中文名更可靠） */
  sessionId?: string;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const segs = useMemo(() => splitFileRefs(text), [text]);

  // 没有文件引用：整段走 Markdown 渲染
  //
  // 之前这里是纯 <Text>，导致 AI 输出里的 `**加粗**`、`#` 标题、
  // `| 表格 |` 全部原样显示星号和竖线。现在统一交给 MarkdownView。
  if (!segs.some((s) => s.kind === 'file')) {
    return <MarkdownView text={text.trim()} inset={inset} />;
  }

  return (
    <View style={[styles.row, inset ? null : styles.rowFlat]}>
      {segs.map((s, i) =>
        s.kind === 'file' ? (
          <FileCard
            key={`f${i}`}
            path={s.path}
            alt={s.alt}
            image={s.image}
            sessionId={sessionId}
          />
        ) : (
          <MarkdownView key={`t${i}`} text={s.text.trim()} inset={false} />
        ),
      )}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    row: { paddingHorizontal: tv.layout.screenPadding, marginVertical: tv.space.xs },
    rowFlat: { paddingHorizontal: 0 },
    body: {
      color: C.text,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.55,
    },
  });
}