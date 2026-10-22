/**
 * 输入弹层：给会话改名用。
 *
 * 为什么不复用 ConfirmSheet：那个只有「确认/取消」两个按钮，
 * 没有输入框。改名需要键盘 + 输入 + 字数限制，单独做更干净。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '../design/theme';

/** 标题最大长度（DSH 侧也有校验，这里先拦一道） */
export const MAX_TITLE_LEN = 80;

export function RenameSheet({
  visible,
  initialValue,
  busy = false,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  initialValue: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (next: string) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [text, setText] = useState(initialValue);

  // 每次打开都重置成当前标题
  useEffect(() => {
    if (visible) setText(initialValue);
  }, [visible, initialValue]);

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialValue.trim() && !busy;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.sheet}>
          <Text style={styles.title}>重命名会话</Text>
          <Text style={styles.hint}>改完只影响这个会话显示的名字，不影响内容</Text>

          <TextInput
            value={text}
            onChangeText={setText}
            style={styles.input}
            placeholder="会话名称"
            placeholderTextColor={tv.colors.textFaint}
            maxLength={MAX_TITLE_LEN}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => {
              if (canSave) onConfirm(trimmed);
            }}
          />
          <Text style={styles.counter}>
            {text.length} / {MAX_TITLE_LEN}
          </Text>

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btn,
                styles.btnGhost,
                pressed ? { opacity: tv.motion.pressOpacity } : null,
              ]}
            >
              <Text style={[styles.btnText, { color: tv.colors.textSecondary }]}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => onConfirm(trimmed)}
              disabled={!canSave}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btn,
                styles.btnPrimary,
                !canSave ? { opacity: 0.4 } : null,
                pressed && canSave ? { opacity: tv.motion.pressOpacity } : null,
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={tv.colors.bg} />
              ) : (
                <Text style={[styles.btnText, { color: tv.colors.bg }]}>保存</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'center',
      paddingHorizontal: tv.layout.screenPadding,
    },
    sheet: {
      backgroundColor: C.bgRaised,
      borderRadius: tv.radius.lg,
      padding: tv.space.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    title: {
      color: C.text,
      fontSize: tv.type.lg,
      fontWeight: tv.weight.semibold,
    },
    hint: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      marginTop: 4,
      marginBottom: tv.space.md,
    },
    input: {
      color: C.text,
      fontSize: tv.type.base,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    counter: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      textAlign: 'right',
      marginTop: 4,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: tv.space.sm,
      marginTop: tv.space.lg,
    },
    btn: {
      minWidth: 84,
      paddingVertical: tv.space.sm,
      paddingHorizontal: tv.space.md,
      borderRadius: tv.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnGhost: { backgroundColor: C.bgCard },
    btnPrimary: { backgroundColor: C.accent },
    btnText: { fontSize: tv.type.sm, fontWeight: tv.weight.medium },
  });
}
