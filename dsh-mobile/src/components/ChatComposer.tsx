/** Controlled input surface; ChatScreen owns drafts, staging and send state. */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import { formatBytes } from '../core/picker';
import { FileTypeBadge } from './FileTypeBadge';

interface ComposerAttachment {
  id: string;
  kind: 'image' | 'file';
  uri: string;
  name: string;
  size?: number;
}

export function ChatComposer({
  value, attachments, sending, uploading, running, maxLength,
  onChangeText, onAddAttachment, onRemoveAttachment, onSend, onStop,
}: {
  value: string;
  attachments: readonly ComposerAttachment[];
  sending: boolean;
  uploading: boolean;
  running: boolean;
  maxLength: number;
  onChangeText: (value: string) => void;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [focused, setFocused] = useState(false);
  const canSend = !sending && (!!value.trim() || attachments.length > 0);

  return (
    <View style={[styles.surface, focused ? styles.surfaceFocused : null]}>
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.attachmentScroll}
          contentContainerStyle={styles.attachmentRail}
        >
          {attachments.map(attachment => {
            return (
              <View key={attachment.id} style={styles.attachment}>
                {attachment.kind === 'image' ? (
                  <Image source={{ uri: attachment.uri }} style={styles.thumbnail} resizeMode="cover" />
                ) : (
                  <FileTypeBadge name={attachment.name} />
                )}
                <View style={styles.fileBody}>
                  <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{attachment.name}</Text>
                  {attachment.size !== undefined ? <Text style={styles.fileSize}>{formatBytes(attachment.size)}</Text> : null}
                </View>
                <Pressable
                  onPress={() => onRemoveAttachment(attachment.id)}
                  style={styles.remove}
                  accessibilityRole="button"
                  accessibilityLabel={`移除 ${attachment.name}`}
                >
                  <Text style={styles.removeText}>×</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      ) : null}

      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel="消息输入框"
        placeholder={uploading ? '正在上传附件…' : '发消息…'}
        placeholderTextColor={tv.colors.textTertiary}
        multiline
        maxLength={maxLength}
        underlineColorAndroid="transparent"
      />
      {value.length >= maxLength ? (
        <Text style={styles.limitHint}>已达 {maxLength} 字草稿上限，继续输入请先发送或删减</Text>
      ) : null}

      <View style={styles.toolbar}>
        <View style={styles.actions}>
          <Pressable
            onPress={onAddAttachment}
            disabled={sending}
            style={[styles.add, sending ? styles.muted : null]}
            accessibilityRole="button"
            accessibilityLabel="添加附件"
            accessibilityState={{ disabled: sending }}
          >
            <Text style={styles.addIcon}>＋</Text>
            <Text style={styles.addText}>添加</Text>
          </Pressable>
          {running ? (
            <Pressable onPress={onStop} style={styles.stop} accessibilityRole="button" accessibilityLabel="打断当前回复">
              <View style={styles.stopDot} />
              <Text style={styles.stopText}>打断</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          style={[styles.send, !canSend ? styles.sendDisabled : null]}
          accessibilityRole="button"
          accessibilityLabel="发送消息"
          accessibilityState={{ disabled: !canSend, busy: sending }}
        >
          {sending ? <ActivityIndicator color={tv.colors.textSecondary} size="small" /> : <Text style={[styles.sendIcon, !canSend ? styles.sendIconDisabled : null]}>↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    surface: {
      marginHorizontal: tv.layout.screenPadding,
      backgroundColor: C.bgRaised,
      borderRadius: tv.radius.xl,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      paddingTop: tv.space.sm,
      paddingBottom: tv.space.xs,
    },
    surfaceFocused: { borderColor: C.accentDim },
    input: {
      minHeight: 44,
      maxHeight: tv.layout.composerMaxHeight,
      color: C.text,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.4,
      paddingHorizontal: tv.space.lg,
      paddingTop: Platform.OS === 'ios' ? 8 : 6,
      paddingBottom: Platform.OS === 'ios' ? 8 : 6,
      textAlignVertical: 'top',
    },
    attachmentScroll: { flexGrow: 0 },
    attachmentRail: { paddingHorizontal: tv.space.sm, paddingBottom: tv.space.xs, gap: tv.space.sm },
    attachment: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 176,
      maxWidth: 240,
      minHeight: 60,
      paddingLeft: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
    },
    thumbnail: { width: 40, height: 40, borderRadius: tv.radius.sm, backgroundColor: C.bgOverlay },
    fileBody: { flexShrink: 1, minWidth: 64, marginLeft: tv.space.sm },
    fileName: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    fileSize: { color: C.textSecondary, fontSize: tv.type.xs, marginTop: 2 },
    remove: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    removeText: { color: C.textSecondary, fontSize: 22 },
    limitHint: { color: C.warning, fontSize: tv.type.xs, paddingHorizontal: tv.space.lg, paddingTop: tv.space.xs },
    toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: tv.space.xs, paddingTop: tv.space.xs },
    actions: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
    add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44, paddingHorizontal: tv.space.sm, borderRadius: tv.radius.md },
    addIcon: { color: C.textSecondary, fontSize: 22 },
    addText: { color: C.textSecondary, fontSize: tv.type.sm, marginLeft: tv.space.xs },
    muted: { opacity: 0.5 },
    stop: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: tv.space.sm, borderRadius: tv.radius.md },
    stopDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: C.danger, marginRight: tv.space.xs },
    stopText: { color: C.danger, fontSize: tv.type.sm },
    send: { width: 44, height: 44, borderRadius: tv.radius.pill, backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center' },
    sendDisabled: { backgroundColor: C.bgOverlay },
    sendIcon: { color: C.onAccent, fontSize: 22, fontWeight: tv.weight.semibold, marginTop: -2 },
    sendIconDisabled: { color: C.textTertiary },
  });
}
