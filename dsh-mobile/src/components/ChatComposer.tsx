/** Controlled input surface; ChatScreen owns drafts, staging and send state. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
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
  value, attachments, sending, uploading, running, maxLength, sendScope, enabled = true,
  onChangeText, onAddAttachment, onRemoveAttachment, onSend, onStop, selection, onSelectionChange, focusRequest,
}: {
  value: string;
  attachments: readonly ComposerAttachment[];
  sending: boolean;
  uploading: boolean;
  running: boolean;
  maxLength: number;
  /** New connection / conversation / visibility invalidates a previous choice. */
  sendScope?: object;
  enabled?: boolean;
  onChangeText: (value: string) => void;
  focusRequest?: number;
  selection?: {start: number; end: number};
  onSelectionChange?: (selection: {start: number; end: number}) => void;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  onSend: (mode: 'queue' | 'steer') => void;
  onStop: () => void;
}) {
  const tv = useTheme();
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (focusRequest !== undefined && enabled) inputRef.current?.focus();
  }, [focusRequest, enabled]);
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [focused, setFocused] = useState(false);
  const {fontScale} = useWindowDimensions();
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [wrapped, setWrapped] = useState<{length: number; width: number; scale: number} | null>(null);
  // Latch a measured wrap until the draft gets shorter. Measuring the wider
  // expanded input must not immediately collapse it and cause a layout loop.
  const expanded = running || uploading || attachments.length > 0 || value.includes('\n') || value.length >= maxLength ||
    !!(value.length && wrapped && value.length >= wrapped.length && wrapped.width === surfaceWidth && wrapped.scale === fontScale);
  const canSend = enabled && !sending && (!!value.trim() || attachments.length > 0);
  const scope = useMemo(() => ({}), [sendScope, running, enabled]);
  const [choice, setChoice] = useState<{ scope: object; mode: 'queue' | 'steer' }>({ scope, mode: 'queue' });
  const mode = running && choice.scope === scope ? choice.mode : 'queue';
  const live = useRef({ scope, canSend, sending });
  live.current = { scope, canSend, sending };
  const select = (next: 'queue' | 'steer') => {
    if (live.current.scope === scope && !live.current.sending && enabled) setChoice({ scope, mode: next });
  };
  const submit = () => {
    if (live.current.scope !== scope || !live.current.canSend) return;
    // The mode belongs to this message, never changes a persisted retry.
    live.current.canSend = false;
    setChoice({ scope, mode: 'queue' });
    onSend(mode);
  };

  return (
    <View style={[styles.surface, focused ? styles.surfaceFocused : null, !expanded && styles.surfaceCompact]}
      onLayout={event => setSurfaceWidth(event.nativeEvent.layout.width)}>
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
        ref={inputRef}
        style={[styles.input, !expanded && styles.inputCompact]}
        onContentSizeChange={event => {
          const singleLineHeight = tv.type.base * 1.4 * fontScale + (Platform.OS === 'ios' ? 16 : 12);
          if (!expanded && value.length > 0 && event.nativeEvent.contentSize.height > singleLineHeight + 4) {
            setWrapped({length: value.length, width: surfaceWidth, scale: fontScale});
          }
        }}
        value={value}
        onChangeText={onChangeText}
        selection={selection}
        onSelectionChange={event => onSelectionChange?.(event.nativeEvent.selection)}
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

      {running ? <View style={styles.sendModeWrap}>
        <View style={styles.sendModes} accessibilityRole="radiogroup" accessibilityLabel="运行中的消息处理方式">
          {(['queue', 'steer'] as const).map(option => <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityLabel={option === 'queue' ? '下一轮处理' : '插话到当前轮'}
            accessibilityState={{ checked: mode === option, disabled: sending || !enabled }}
            disabled={sending || !enabled}
            onPress={() => select(option)}
            style={[styles.sendMode, mode === option ? styles.sendModeSelected : null, sending || !enabled ? styles.muted : null]}
          ><Text style={[styles.sendModeText, mode === option ? styles.sendModeTextSelected : null]}>{option === 'queue' ? '下一轮' : '插话'}</Text></Pressable>)}
        </View>
        <Text style={styles.sendModeHint}>{mode === 'steer' ? '交给当前轮尽快处理，不会强停正在运行的工具' : '当前轮结束后，再处理这条消息'}</Text>
      </View> : null}

      <View pointerEvents="box-none" style={[styles.toolbar, !expanded && styles.toolbarCompact]}>
        <View pointerEvents="box-none" style={styles.actions}>
          <Pressable
            onPress={onAddAttachment}
            disabled={sending}
            style={[styles.add, sending ? styles.muted : null]}
            accessibilityRole="button"
            accessibilityLabel="添加附件"
            accessibilityState={{ disabled: sending }}
          >
            <Text style={styles.addIcon}>＋</Text>
            {expanded ? <Text style={styles.addText}>添加</Text> : null}
          </Pressable>
          {running ? (
            <Pressable onPress={onStop} style={styles.stop} accessibilityRole="button" accessibilityLabel="打断当前回复">
              <View style={styles.stopDot} />
              <Text style={styles.stopText}>打断</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={submit}
          disabled={!canSend}
          style={[styles.send, !canSend ? styles.sendDisabled : null]}
          accessibilityRole="button"
          accessibilityLabel="发送消息"
          accessibilityHint={running ? mode === 'steer' ? '将这条消息插话到当前轮' : '将这条消息排到下一轮' : undefined}
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
    surfaceCompact: {paddingTop: tv.space.xs},
    inputCompact: {marginHorizontal: 52, paddingHorizontal: tv.space.xs},
    toolbarCompact: {position: 'absolute', left: 0, right: 0, bottom: tv.space.xs, paddingTop: 0},
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
    sendModeWrap: { paddingHorizontal: tv.space.sm, paddingTop: tv.space.xs },
    sendModes: { flexDirection: 'row', backgroundColor: C.bgOverlay, borderRadius: tv.radius.md, padding: 3 },
    sendMode: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: tv.radius.sm },
    sendModeSelected: { backgroundColor: C.bgCard },
    sendModeText: { color: C.textSecondary, fontSize: tv.type.sm },
    sendModeTextSelected: { color: C.accent, fontWeight: tv.weight.semibold },
    sendModeHint: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, paddingHorizontal: tv.space.xs, paddingTop: tv.space.xs },
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
