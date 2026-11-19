import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/theme';

/**
 * P4-0.3 #22：息屏语义明示。与 native AgentService 的 ACTION_SCREEN_OFF → stop()
 * 行为逐字一致：息屏终止当前任务；仅切后台（FGS 继续）不影响执行。
 * 纯展示组件，不改变任何安全姿态；语义变更需另立产品决策。
 */
export const SCREEN_OFF_SEMANTICS_TEXT =
  '息屏即终止：屏幕关闭时当前任务会停止，亮屏后需重新发起；仅把应用切到后台不影响执行。';

export function AgentScreenOffNotice() {
  const tv = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.text, { color: tv.colors.textTertiary }]}>{SCREEN_OFF_SEMANTICS_TEXT}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingBottom: 6 },
  text: { fontSize: 12, lineHeight: 17 },
});
