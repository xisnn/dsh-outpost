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

export { splitFileRefs, isImagePath } from '../core/filerefs';

export function AssistantRichText({
  text,
  inset = true,
}: {
  text: string;
  /** 是否自带左右内边距。嵌在卡片里时应传 false，避免双重缩进 */
  inset?: boolean;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const segs = useMemo(() => splitFileRefs(text), [text]);

  // 没有文件引用就走纯文本路径，避免无谓的嵌套
  if (!segs.some((s) => s.kind === 'file')) {
    return (
      <View style={[styles.row, inset ? null : styles.rowFlat]}>
        <Text style={styles.body} selectable>
          {text.trim()}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.row, inset ? null : styles.rowFlat]}>
      {segs.map((s, i) =>
        s.kind === 'file' ? (
          <FileCard key={`f${i}`} path={s.path} alt={s.alt} image={s.image} />
        ) : (
          <Text key={`t${i}`} style={styles.body} selectable>
            {s.text.trim()}
          </Text>
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