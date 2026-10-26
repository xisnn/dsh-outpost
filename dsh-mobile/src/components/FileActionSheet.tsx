/**
 * 文件/图片的「更多操作」菜单。
 *
 * 交互参照微信看文件时的右上角三个点：
 *   · 点开从底部滑出一个动作面板
 *   · 每项一个图标 + 文字 + 简短说明
 *   · 危险动作（删除）用红色
 *   · 点面板外或返回键关闭
 *
 * 为什么不用 ActionSheetIOS / Alert：
 *   · Android 上 Alert 只能放按钮，不能放说明文字，用户看不懂
 *     「保存」和「转发」的区别
 *   · 自己画能控制排版、能加副标题、能和主题一致
 */

import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';
import { radius, space, type, weight } from '../design/tokens';

export interface MoreAction {
  /** 唯一标识，回调里用来区分 */
  key: string;
  /** 动作名，例如「保存到手机」 */
  label: string;
  /** 一行说明，告诉用户这个动作到底做什么 */
  hint?: string;
  /** 左侧图标（emoji 或字符，避免引图标库） */
  icon?: string;
  /** 危险动作（红色） */
  destructive?: boolean;
  /** 不可用（灰色，点了不响应） */
  disabled?: boolean;
}

export function FileActionSheet({
  visible,
  title,
  actions,
  onPick,
  onClose,
}: {
  visible: boolean;
  /** 面板顶部显示的文件名 */
  title: string;
  actions: MoreAction[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* 遮罩：点它关闭 */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* 面板本身要吃掉点击，否则点空白处会穿透到遮罩 */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}
          onPress={() => undefined}
        >
          <View style={styles.grabber} />
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>

          <ScrollView
            style={{ maxHeight: 420 }}
            contentContainerStyle={{ paddingVertical: space.xs }}
          >
            {actions.map((a) => (
              <Pressable
                key={a.key}
                disabled={a.disabled}
                onPress={() => {
                  onClose();
                  onPick(a.key);
                }}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.row,
                  pressed && !a.disabled ? { backgroundColor: tv.colors.bgHover } : null,
                  a.disabled ? { opacity: 0.4 } : null,
                ]}
              >
                <Text style={styles.icon}>{a.icon ?? '•'}</Text>
                <View style={styles.rowText}>
                  <Text
                    style={[
                      styles.label,
                      a.destructive ? { color: tv.colors.danger } : null,
                    ]}
                  >
                    {a.label}
                  </Text>
                  {a.hint ? <Text style={styles.hint}>{a.hint}</Text> : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            onPress={onClose}
            style={({ pressed }: { pressed: boolean }) => [
              styles.cancel,
              pressed ? { backgroundColor: tv.colors.bgHover } : null,
            ]}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: C.bgCard,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingTop: space.sm,
      paddingHorizontal: space.sm,
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.border,
      marginBottom: space.sm,
    },
    title: {
      color: C.textSecondary,
      fontSize: type.micro,
      textAlign: 'center',
      paddingHorizontal: space.md,
      marginBottom: space.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: space.md,
      paddingHorizontal: space.md,
      borderRadius: radius.sm,
    },
    icon: {
      width: 28,
      fontSize: 17,
      textAlign: 'center',
      color: C.textSecondary,
    },
    rowText: { flex: 1, marginLeft: space.sm },
    label: { color: C.text, fontSize: type.sm, fontWeight: weight.medium },
    hint: {
      color: C.textFaint,
      fontSize: type.micro,
      marginTop: 2,
      lineHeight: type.xs * 1.4,
    },
    cancel: {
      marginTop: space.xs,
      paddingVertical: space.md,
      borderRadius: radius.sm,
      alignItems: 'center',
    },
    cancelText: { color: C.textSecondary, fontSize: type.sm, fontWeight: weight.medium },
  });
}
