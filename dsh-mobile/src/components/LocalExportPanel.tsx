import React, {useEffect, useMemo, useRef, useState} from 'react';
import {AppState, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {MotionPressable as Pressable} from './MotionPressable';
import {MotionModal} from './MotionModal';
import {useTheme} from '../design/theme';
import {prepareTextExport} from '../core/exportText';
import {saveLocalText} from '../core/localExport';

interface Props {
  title: string;
  text: string;
  fileName: string;
  description?: string;
  allowOriginal?: boolean;
  previewContent?: React.ReactNode;
  onClose: () => void;
}
const PREVIEW_CHARS = 16000;

/** A panel so message actions can change mode without stacking Android Modals. */
export function LocalExportPanel({title, text, fileName, description, allowOriginal = true, previewContent, onClose}: Props) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const owner = useMemo(() => ({}), [text, fileName, allowOriginal]);
  const latest = useRef(owner); latest.current = owner;
  const mounted = useRef(false);
  const working = useRef(false);
  const epoch = useRef(0);
  const renderEpoch = epoch.current;
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState<{owner: object; value: boolean}>({owner, value: false});
  const [feedback, setFeedback] = useState<{owner: object; message: string} | null>(null);
  const includeOriginal = allowOriginal && original.owner === owner && original.value;
  const snapshot = useMemo(() => {
    try {return {value: prepareTextExport(text, includeOriginal), error: ''};}
    catch (error) {return {value: null, error: error instanceof Error ? error.message : '无法导出正文'};}
  }, [text, includeOriginal]);
  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {epoch.current++; setOriginal({owner: latest.current, value: false});}
    });
    return () => {mounted.current = false; sub.remove();};
  }, []);
  const save = async () => {
    if (!mounted.current || latest.current !== owner || epoch.current !== renderEpoch || AppState.currentState !== 'active' || working.current || !snapshot.value) return;
    working.current = true; setBusy(true); setFeedback(null);
    try {
      const result = await saveLocalText(snapshot.value.text, fileName);
      if (mounted.current && latest.current === owner) setFeedback({owner, message: result.message});
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <View style={styles.panel}>
    <Text style={styles.title} accessibilityRole="header">{title}</Text>
    <Text style={styles.description}>{description ?? '只导出选定正文。默认隐藏可识别的凭据，请检查预览后保存。'}</Text>
    {allowOriginal && snapshot.value?.hasCredentials ? <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>包含原文凭据</Text>
      <Switch accessibilityLabel="包含原文凭据" value={includeOriginal} disabled={busy}
        onValueChange={value => {
          if (mounted.current && latest.current === owner && epoch.current === renderEpoch && !working.current && AppState.currentState === 'active') {
            setOriginal({owner, value}); setFeedback(null);
          }
        }} />
    </View> : null}
    <ScrollView style={styles.preview} contentContainerStyle={styles.previewContent}>
      {previewContent ?? <Text selectable style={styles.body}>{snapshot.value?.text.slice(0, PREVIEW_CHARS) ?? snapshot.error}</Text>}
    </ScrollView>
    {snapshot.value && snapshot.value.text.length > PREVIEW_CHARS ? <Text style={styles.hint}>仅预览前 16000 字；文件包含全部选定正文。</Text> : null}
    {feedback?.owner === owner ? <Text accessibilityLiveRegion="polite" style={styles.feedback}>{feedback.message}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="保存到手机" disabled={busy || !snapshot.value}
      onPress={() => void save()} style={styles.save}>
      <Text style={styles.saveText}>{busy ? '正在保存…' : '保存到手机'}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={onClose} style={styles.close}>
      <Text style={styles.closeText}>返回</Text>
    </Pressable>
  </View>;
}

export function LocalExportSheet({visible, ...props}: Props & {visible: boolean}) {
  const tv = useTheme();
  return <MotionModal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={props.onClose}>
    <View style={{flex: 1, justifyContent: 'flex-end', backgroundColor: tv.colors.scrim, padding: tv.space.md, paddingBottom: tv.space.xxl}}>
      {visible ? <LocalExportPanel {...props} /> : null}
    </View>
  </MotionModal>;
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    panel: {width: '100%', maxWidth: 560, alignSelf: 'center', maxHeight: '88%', backgroundColor: tv.colors.bg, borderRadius: tv.radius.xl, borderWidth: StyleSheet.hairlineWidth, borderColor: tv.colors.border, padding: tv.space.xl},
    title: {color: tv.colors.text, fontSize: tv.type.xl, fontWeight: tv.weight.semibold},
    description: {color: tv.colors.textSecondary, fontSize: tv.type.sm, lineHeight: 20, marginVertical: tv.space.sm},
    toggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, gap: tv.space.sm},
    toggleLabel: {flex: 1, color: tv.colors.text, fontSize: tv.type.sm},
    preview: {flexShrink: 1, backgroundColor: tv.colors.bgCard, borderRadius: tv.radius.sm, marginVertical: tv.space.sm},
    previewContent: {padding: tv.space.md},
    body: {color: tv.colors.text, fontSize: tv.type.sm, lineHeight: 21},
    hint: {color: tv.colors.textTertiary, fontSize: tv.type.xs, lineHeight: 18},
    feedback: {color: tv.colors.textSecondary, fontSize: tv.type.sm, lineHeight: 20, marginVertical: tv.space.sm},
    save: {minHeight: 44, justifyContent: 'center', alignItems: 'center', backgroundColor: tv.colors.accent, borderRadius: tv.radius.md, marginTop: tv.space.sm},
    saveText: {color: tv.colors.onAccent, fontSize: tv.type.base, fontWeight: tv.weight.medium},
    close: {minHeight: 44, justifyContent: 'center', alignItems: 'center'},
    closeText: {color: tv.colors.textSecondary, fontSize: tv.type.base},
  });
}
