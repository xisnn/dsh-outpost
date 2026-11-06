import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useApp} from '../App';
import {useTheme} from '../design/theme';
import {MotionModal as Modal} from './MotionModal';
import {MotionPressable as Pressable} from './MotionPressable';
import {CredentialText} from './CredentialText';
import {formatBytes} from '../core/picker';
import {normalizeBaseUrl} from '../core/pairing';
import {displayCredentials, findCredentials} from '../core/credentialDisplay';
import {sharedComposerInbox, type SharedMessage} from '../core/sharedComposer';
import {acknowledgeSharedMessage, discardSharedMessage, listSharedMessages, subscribeSharedMessages} from '../core/shareIntake';

/** External shares stay local until an explicit destination is chosen and the draft receives them. */
export function SharedInboxHost() {
  const {store, baseUrl, butlerMode, butlerSessionId} = useApp();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [, force] = useState(0);
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{scope: object; messageId: string; sessionId: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(false);
  const scope = useMemo(() => ({}), [store, baseUrl, butlerMode, butlerSessionId]);
  const live = useRef(scope);
  live.current = scope;
  const mounted = useRef(false);
  const working = useRef(false);
  const generation = useRef(0);
  const pending = useRef<{source: object; id: string} | null>(null);
  const current = () => mounted.current && live.current === scope;
  const connected = () => normalizeBaseUrl(store.fileBaseUrl) === normalizeBaseUrl(baseUrl) &&
    store.connection === 'connected' && !store.authInvalidated;
  const reload = async () => {
    const version = ++generation.current;
    try {
      const items = await listSharedMessages();
      if (!current() || version !== generation.current) return;
      setMessages(items); setLoadError(false);
    } catch {
      if (current() && version === generation.current) {setLoadError(true); setError('无法读取分享内容，请重试');}
    }
  };
  useEffect(() => {
    mounted.current = true;
    working.current = false;
    setBusy(false); setSelected(null); setError(''); setLoadError(false); setMessages([]); setDismissed(new Set());
    const unsubscribeStore = store.subscribe(() => force(value => value + 1));
    const changed = () => {setDismissed(new Set()); void reload();};
    const unsubscribeInbox = subscribeSharedMessages(changed);
    const subscription = AppState.addEventListener('change', state => {if (state === 'active') changed();});
    void reload();
    return () => {
      mounted.current = false; generation.current++;
      if (pending.current) sharedComposerInbox.cancel(pending.current.source, pending.current.id);
      pending.current = null;
      unsubscribeStore(); unsubscribeInbox(); subscription.remove();
    };
  }, [scope, store]); // callbacks are owned by this exact identity
  const message = messages.find(item => !dismissed.has(item.id));
  const preview = useMemo(() => message ? displayCredentials(message.text, findCredentials(message.text)).slice(0, 2000) : '', [message]);
  const sessions = store.sessions.filter(session => !session.parentSessionId && session.origin !== 'subagent' && session.agentAvailable);
  const appliedSessionId = message ? sharedComposerInbox.appliedDestination(store, message.id) : undefined;
  const sessionId = appliedSessionId ?? (selected?.scope === scope && selected.messageId === message?.id ? selected.sessionId : '');
  const usable = !!appliedSessionId || (connected() && sessions.some(session => session.sessionId === sessionId));
  const hasContent = !!message && (!!message.text || message.files.length > 0);
  const later = () => {
    if (working.current) return;
    if (message) setDismissed(values => new Set([...values, message.id]));
    setLoadError(false); setError('');
  };
  const discard = async () => {
    if (!message || !current() || working.current || sharedComposerInbox.isApplied(store, message.id)) return;
    working.current = true; setBusy(true); setError('');
    try {await discardSharedMessage(message.id); if (current()) {setMessages(items => items.filter(item => item.id !== message.id)); setSelected(null);}}
    catch {if (current()) setError('未能丢弃分享内容，请重试');}
    finally {if (current()) {working.current = false; setBusy(false);}}
  };
  const add = async () => {
    if (!message || !current() || working.current || !hasContent || (!appliedSessionId && (!connected() ||
        !sessions.some(session => session.sessionId === sessionId)))) return;
    working.current = true; setBusy(true); setError('');
    const owner = {source: store, id: message.id};
    pending.current = owner;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!sharedComposerInbox.isApplied(store, message.id)) {
        sharedComposerInbox.enqueue(store, sessionId, message, butlerMode && sessionId === butlerSessionId ? 'butler' : 'chat');
        store.requestOpenSession(sessionId);
      }
      const applied = await Promise.race([
        sharedComposerInbox.waitApplied(store, message.id),
        new Promise<boolean>(resolve => {timer = setTimeout(() => resolve(false), 10000);}),
      ]);
      if (!applied) {sharedComposerInbox.cancel(store, message.id); throw new Error('not-applied');}
      // The receiving component committed the draft. Keep native files, mark only the inbox receipt.
      if (!current()) return;
      await acknowledgeSharedMessage(message.id);
      if (current()) {setMessages(items => items.filter(item => item.id !== message.id)); setSelected(null);}
    } catch {
      sharedComposerInbox.cancel(store, message.id);
      if (current()) setError(sharedComposerInbox.isApplied(store, message.id)
        ? '内容已加入草稿，收件记录未能更新。请重试确认'
        : '分享尚未加入草稿，请保持连接后重试');
    } finally {
      if (timer) clearTimeout(timer);
      if (pending.current === owner) pending.current = null;
      if (current()) {working.current = false; setBusy(false);}
    }
  };
  if (!message && !loadError) return null;
  return <Modal visible transparent animationType="fade" onRequestClose={later}>
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.title}>分享给 Outpost</Text>
        <Text style={styles.hint}>预览内容并选择会话，加入后由你决定何时发送。</Text>
        <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
          {message ? <>
            {message.text ? <View style={styles.preview}><Text style={styles.body}>{preview}</Text>
              {message.text.length > 2000 ? <Text style={styles.hint}>仅预览前 2000 字，导入时保留全文</Text> : null}</View> : null}
            {message.files.map((file, index) => <View key={index} style={styles.file}>
              <CredentialText text={file.name} style={styles.body} />
              <Text style={styles.hint}>{file.kind === 'image' ? '图片' : '文件'} · {formatBytes(file.size ?? 0)}</Text>
            </View>)}
            {message.skipped.map((reason, index) => <CredentialText key={index} text={reason} style={styles.warning} />)}
            <Text style={styles.label}>加入哪个会话</Text>
            {!connected() ? <Text style={styles.hint}>连接服务后可以选择会话，分享内容会先保留在本机。</Text> : null}
            {connected() && sessions.length === 0 ? <Text style={styles.hint}>还没有可写会话。稍后处理，先创建一个会话。</Text> : null}
            {sessions.map(session => {
              const chosen = session.sessionId === sessionId;
              const title = butlerMode && session.sessionId === butlerSessionId ? '管家' : session.projections?.values?.title || '未命名会话';
              return <Pressable key={session.sessionId} disabled={busy || !!appliedSessionId || !connected()}
                accessibilityRole="radio" accessibilityState={{checked: chosen, disabled: busy || !!appliedSessionId || !connected()}}
                accessibilityLabel={chosen ? '已选择目标会话' : '选择目标会话'}
                onPress={() => {if (current() && !working.current && !sharedComposerInbox.isApplied(store, message.id)) {setSelected({scope, messageId: message.id, sessionId: session.sessionId}); setError('');}}}
                style={[styles.session, chosen ? {borderColor: tv.colors.accent, backgroundColor: tv.colors.bgCard} : null]}>
                <Text style={[styles.radio, {color: chosen ? tv.colors.accent : tv.colors.textTertiary}]}>{chosen ? '●' : '○'}</Text>
                <View style={styles.sessionBody}><CredentialText text={title} style={styles.body} />
                  <CredentialText text={session.cwd || session.sessionId} style={styles.hint} /></View>
              </Pressable>;
            })}
            <Text style={styles.hint}>现有文字和附件会保留。文字超出输入上限时，分享原文会作为 TXT 附件加入。</Text>
          </> : null}
          {error ? <Text accessibilityRole="alert" style={styles.warning}>{error}</Text> : null}
        </ScrollView>
        {busy ? <ActivityIndicator color={tv.colors.accent} /> : null}
        {message ? <Pressable accessibilityRole="button" accessibilityLabel="加入草稿" disabled={busy || !usable || !hasContent}
          onPress={() => {void add();}} style={[styles.primary, {opacity: busy || !usable || !hasContent ? 0.45 : 1}]}>
          <Text style={styles.primaryText}>{busy ? '正在处理…' : appliedSessionId ? '重试确认' : '加入草稿'}</Text>
        </Pressable> : <Pressable accessibilityRole="button" onPress={() => {void reload();}} style={styles.primary}><Text style={styles.primaryText}>重试读取</Text></Pressable>}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" disabled={busy || (!!message && sharedComposerInbox.isApplied(store, message.id))} onPress={() => {void discard();}} style={styles.action}><Text style={styles.hint}>丢弃这次分享</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={later} style={styles.action}><Text style={styles.body}>稍后处理</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {flex: 1, backgroundColor: C.scrim, justifyContent: 'center', alignItems: 'center', padding: 20},
    card: {width: '100%', maxWidth: 520, maxHeight: '88%', backgroundColor: C.bgRaised, borderRadius: tv.radius.lg, padding: 20, flexShrink: 1},
    title: {fontSize: tv.type.lg, fontWeight: tv.weight.semibold, color: C.text},
    hint: {fontSize: tv.type.xs, lineHeight: 19, color: C.textTertiary, marginTop: 4},
    content: {flexShrink: 1, marginVertical: 12},
    preview: {backgroundColor: C.bgCard, borderRadius: tv.radius.sm, padding: 12},
    body: {fontSize: tv.type.sm, lineHeight: 21, color: C.text},
    file: {paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.border},
    warning: {fontSize: tv.type.xs, lineHeight: 19, color: C.danger, marginVertical: 8},
    label: {fontSize: tv.type.sm, fontWeight: tv.weight.semibold, color: C.text, marginTop: 20, marginBottom: 8},
    session: {flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.border, borderRadius: tv.radius.sm, padding: 12, marginBottom: 8, minHeight: 52},
    radio: {fontSize: 20, marginRight: 12}, sessionBody: {flex: 1},
    primary: {backgroundColor: C.accent, borderRadius: tv.radius.sm, alignItems: 'center', padding: 14, marginTop: 8},
    primaryText: {color: C.onAccent, fontSize: tv.type.sm, fontWeight: tv.weight.semibold},
    actions: {flexDirection: 'row', justifyContent: 'space-between'}, action: {paddingVertical: 14, paddingHorizontal: 4, minHeight: 44},
  });
}
