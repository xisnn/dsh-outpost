/** Theme-aware confirmation dialog with one primary action and a quiet cancel. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MotionModal as Modal } from './MotionModal';
import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import { actionStyles } from '../design/actionStyles';

export function ConfirmSheet({
  visible, title, message, confirmText = '确定', cancelText = '取消', destructive, onCancel, onConfirm,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tv = useTheme();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const actions = React.useMemo(() => actionStyles(tv), [tv]);
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <Pressable feedback="none" style={styles.backdrop} onPress={onCancel} accessible={false}>
        <View style={styles.card} accessibilityViewIsModal>
          <Pressable feedback="none" onPress={() => {}} accessible={false}>
            <Text style={styles.title} accessibilityRole="header">{title}</Text>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            <View style={styles.actions}>
              <Pressable onPress={onCancel} style={[actions.base, actions.quiet, styles.action]}
                accessibilityRole="button" accessibilityLabel={cancelText}>
                <Text style={actions.quietText}>{cancelText}</Text>
              </Pressable>
              <Pressable onPress={onConfirm} style={[actions.base, destructive ? actions.danger : actions.primary, styles.action]}
                accessibilityRole="button" accessibilityLabel={confirmText}>
                <Text style={destructive ? actions.dangerFillText : actions.primaryText}>{confirmText}</Text>
              </Pressable>
            </View>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: tv.colors.scrim, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
    card: { width: '100%', maxWidth: 340, borderRadius: tv.radius.lg, backgroundColor: tv.colors.bgRaised, padding: tv.space.xl },
    title: { color: tv.colors.text, fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    message: { color: tv.colors.textSecondary, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.55, marginTop: tv.space.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: tv.space.sm, marginTop: tv.space.lg },
    action: { flexShrink: 1 },
  });
}
