/**
 * 工作区设置底部弹层：改名 + 选 emoji 头像。
 *
 * 用 RN 原生 Modal / TextInput / Pressable，不引第三方 sheet 库。
 * 只做「本地展示层覆盖」——DSH 的 cwd 是路径本身，不能真的改名。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';
import { EMOJI_CHOICES, type WorkspaceCustom } from '../core/workspace-custom';

export function WorkspaceSheet({
  visible,
  path,
  fallbackName,
  current,
  onClose,
  onSave,
}: {
  visible: boolean;
  path: string;
  /** 目录原名（未自定义时显示） */
  fallbackName: string;
  current?: WorkspaceCustom;
  onClose: () => void;
  onSave: (patch: WorkspaceCustom) => void;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);

  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>(undefined);

  // 只在「打开」或「换了工作区」时用外部值初始化，
  // 否则 store 的任何 emit 都会把用户正在输入的内容冲掉。
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const key = visible ? path : null;
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (!visible) return;
    setName(current?.name ?? '');
    setEmoji(current?.emoji);
    // current 故意不进依赖：避免 emit 冲掉输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, path]);

  const displayName = name.trim() || fallbackName;
  const preview = emoji ?? (displayName.trim().charAt(0).toUpperCase() || '?');

  const save = () => {
    onSave({ name: name.trim() || undefined, emoji });
    onClose();
  };

  const reset = () => {
    onSave({ name: undefined, emoji: undefined });
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, tv.space.lg) }]}>
          <View style={styles.handle} />

          <View style={styles.titleRow}>
            <Text style={styles.title}>工作区设置</Text>
            <Text style={styles.path} numberOfLines={1}>
              {path || '未记录目录'}
            </Text>
          </View>

          {/* 头像预览 + emoji 选择 */}
          <View style={styles.previewRow}>
            <View style={styles.previewTile}>
              <Text style={styles.previewText}>{preview}</Text>
            </View>
            <View style={styles.previewBody}>
              <Text style={styles.previewName} numberOfLines={1}>
                {displayName}
              </Text>
              <Text style={styles.previewHint}>
                {current?.name || current?.emoji ? '已自定义（仅本机显示）' : '仅本机显示，不改真实目录名'}
              </Text>
            </View>
          </View>

          <Text style={styles.fieldLabel}>头像</Text>
          <View style={styles.emojiGrid}>
            {EMOJI_CHOICES.map((e) => {
              const active = e === emoji;
              return (
                <Pressable
                  key={e}
                  onPress={() => setEmoji(active ? undefined : e)}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.emojiCell,
                    active ? styles.emojiCellActive : null,
                    pressed ? { opacity: tv.motion.pressOpacity } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`头像 ${e}`}
                >
                  <Text style={styles.emojiText}>{e}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.fieldLabel}>名称</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={fallbackName}
            placeholderTextColor={tv.colors.textFaint}
            style={styles.input}
            maxLength={24}
            returnKeyType="done"
            onSubmitEditing={save}
            selectionColor={tv.colors.accent}
          />

          <View style={styles.btnRow}>
            <Pressable
              onPress={reset}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btnGhost,
                pressed && { opacity: tv.motion.pressOpacity },
              ]}
            >
              <Text style={styles.btnGhostText}>恢复默认</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btnGhost,
                pressed && { opacity: tv.motion.pressOpacity },
              ]}
            >
              <Text style={styles.btnGhostText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={save}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btnPrimary,
                pressed && { opacity: tv.motion.pressOpacity },
              ]}
            >
              <Text style={styles.btnPrimaryText}>保存</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: C.scrim,
    },
    sheet: {
      backgroundColor: C.bg,
      borderTopLeftRadius: tv.radius.xl,
      borderTopRightRadius: tv.radius.xl,
      paddingHorizontal: tv.layout.screenPadding,
      paddingTop: tv.space.sm,
    },
    handle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.borderStrong,
      marginBottom: tv.space.md,
    },
    titleRow: { marginBottom: tv.space.lg },
    title: { color: C.text, fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    path: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 3 },

    previewRow: { flexDirection: 'row', alignItems: 'center', marginBottom: tv.space.lg },
    previewTile: {
      width: 52,
      height: 52,
      borderRadius: tv.radius.md,
      backgroundColor: C.accentWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    previewText: { fontSize: 26, color: C.iconText },
    previewBody: { flex: 1, marginLeft: tv.space.md },
    previewName: { color: C.text, fontSize: tv.type.base, fontWeight: tv.weight.medium },
    previewHint: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 3 },

    fieldLabel: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      letterSpacing: 0.6,
      marginBottom: tv.space.sm,
    },
    emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: tv.space.lg },
    emojiCell: {
      width: 40,
      height: 40,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 6,
      marginBottom: 6,
      backgroundColor: C.bgCard,
    },
    emojiCellActive: {
      backgroundColor: C.accentWash,
      borderWidth: 1.5,
      borderColor: C.accent,
    },
    emojiText: { fontSize: 19 },

    input: {
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      color: C.text,
      fontSize: tv.type.base,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      marginBottom: tv.space.xl,
    },

    btnRow: { flexDirection: 'row', alignItems: 'center' },
    btnGhost: {
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      marginRight: tv.space.sm,
    },
    btnGhostText: { color: C.textSecondary, fontSize: tv.type.sm },
    btnPrimary: {
      flex: 1,
      paddingVertical: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.accent,
      alignItems: 'center',
    },
    btnPrimaryText: { color: C.onAccent, fontSize: tv.type.base, fontWeight: tv.weight.semibold },
  });
}
