import React, {useEffect, useMemo, useRef, useState} from 'react';
import {AppState, ScrollView, StyleSheet, Text, View} from 'react-native';
import {MotionPressable as Pressable} from './MotionPressable';
import {ConfirmSheet} from './ConfirmSheet';
import {useTheme} from '../design/theme';
import {maskCredentials} from '../core/credentialDisplay';
import type {HostQueueItem, HostQueueSnapshot} from '../core/conversationActions';
import {withdrawalRecovery, type WithdrawalCopy} from '../core/withdrawalRecovery';
interface QueueSource {
  conversationQueue(sessionId: string): Promise<HostQueueSnapshot>;
  withdrawQueuedText(sessionId: string, itemId: string): Promise<HostQueueItem>;
}
export function HostQueuePanel({source, sessionId, scope, recoveryScope, enabled, busy, onRestore}: {
  source: QueueSource; sessionId: string; scope: object; recoveryScope: string;
  enabled: boolean; busy: boolean; onRestore: (copy: WithdrawalCopy) => void;
}) {
  const tv = useTheme(), styles = useMemo(() => makeStyles(tv), [tv]);
  const [result, setResult] = useState<{scope:object; snapshot:HostQueueSnapshot} | null>(null);
  const [copies, setCopies] = useState<WithdrawalCopy[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<HostQueueItem | null>(null);
  const [discard, setDiscard] = useState<WithdrawalCopy | null>(null);
  const [mutating, setMutating] = useState(false);
  const live = useRef({scope, enabled}); live.current = {scope, enabled};
  const locked = useRef(false), refresh = useRef<() => void>(() => {});
  const mounted = useRef(true);
  useEffect(() => () => {mounted.current=false; live.current.enabled=false;}, []);
  useEffect(() => {
    let disposed = false;
    setPending(null); setDiscard(null); setError(''); setCopies([]);
    const load = () => {if (!disposed) setCopies(withdrawalRecovery.list(recoveryScope, sessionId));};
    const off = withdrawalRecovery.subscribe(load);
    void withdrawalRecovery.hydrate().then(load, () => {if (!disposed) setError('无法读取撤回文字副本，请稍后重试');});
    return () => {disposed=true; off();};
  }, [recoveryScope, sessionId, scope]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined;
    let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    const poll = async () => {
      if (disposed || !foreground || inFlight) return;
      inFlight = true;
      try {
        const snapshot = await source.conversationQueue(sessionId);
        if (!disposed && foreground) setResult({scope, snapshot});
      } catch {
        // Unsupported optional endpoint does not interfere with normal messaging.
        if (!disposed) setResult(null);
      } finally {
        inFlight = false;
        if (!disposed && foreground) timer = setTimeout(() => void poll(), busy ? 2500 : 15000);
      }
    };
    refresh.current = () => {if (timer) clearTimeout(timer); void poll();};
    void poll();
    const sub = AppState.addEventListener('change', state => {
      foreground = state === 'active';
      if (timer) clearTimeout(timer);
      if (foreground) void poll(); else setResult(null);
    });
    return () => {disposed=true; if (timer) clearTimeout(timer); sub.remove(); refresh.current=()=>{};};
  }, [source, sessionId, scope, enabled, busy]);
  const rows = enabled && result?.scope === scope ? result.snapshot.items : [];
  const restore = (copy: WithdrawalCopy) => {
    if (live.current.scope === scope && live.current.enabled && copy.state === 'confirmed') onRestore(copy);
  };
  const withdraw = async () => {
    if (!pending || locked.current || live.current.scope !== scope || !live.current.enabled) return;
    locked.current = true; setMutating(true); setError('');
    try {
      const latest = (await source.conversationQueue(sessionId)).items.find(row => row.itemId === pending.itemId);
      if (!latest || !latest.eligible || JSON.stringify(latest.message) !== JSON.stringify(pending.message)) throw new Error('排队消息已变化，请刷新后重新选择');
      if (live.current.scope !== scope || !live.current.enabled) return;
      const ticket = await withdrawalRecovery.prepare(recoveryScope, latest);
      if (live.current.scope !== scope || !live.current.enabled) throw new Error('会话已切换，未继续撤回，请核对排队状态');
      const removed = await source.withdrawQueuedText(sessionId, latest.itemId);
      const copy = await withdrawalRecovery.confirm(ticket, removed);
      // Receipt and text survive unmount. Only the currently owning screen may insert them.
      restore(copy);
      if (mounted.current && live.current.scope === scope) setPending(null);
    } catch (e) {
      if (mounted.current && live.current.scope === scope) {
        setPending(null);
        setError(e instanceof Error && /已变化|未继续|副本|草稿空间/.test(e.message) ? e.message : '未确认撤回结果。请核对电脑端队列与历史，不会自动重试或回填草稿。');
      }
    } finally {
      locked.current=false;
      if (mounted.current) {setMutating(false); if (live.current.scope === scope) refresh.current();}
    }
  };
  if (!rows.length && !copies.length && !error) return null;
  return <View style={styles.panel} accessibilityLabel="电脑端排队消息">
    <Text style={styles.heading}>电脑端队列{rows.length ? ` · ${rows.length}` : ''}</Text>
    <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      {rows.map(row => <View key={row.itemId} style={styles.row}>
        <View style={styles.body}><Text style={styles.hint}>{row.slot === 'next-step' ? '当前轮插话' : '下一轮处理'}</Text>
          <Text style={styles.text} numberOfLines={2}>{maskCredentials(row.text || '包含附件或自动消息')}</Text></View>
        {row.eligible && !copies.some(c => c.itemId === row.itemId) ? <Pressable accessibilityRole="button" accessibilityLabel={`撤回编辑：${maskCredentials(row.text)}`}
          disabled={mutating || !enabled} onPress={() => setPending(row)} style={styles.action}><Text style={styles.link}>撤回编辑</Text></Pressable> : <Text style={styles.note}>{copies.some(c => c.itemId === row.itemId) ? '请核对撤回记录' : '暂不支持撤回编辑'}</Text>}
      </View>)}
      {copies.map(copy => <View key={copy.itemId} style={styles.copy}>
        <Text style={styles.hint}>{copy.state === 'confirmed' ? copy.restored ? '已恢复草稿 · 保留文字副本' : '已撤回 · 文字待恢复' : '撤回结果未确认 · 保留原文字'}</Text>
        <Text style={styles.text} selectable numberOfLines={3}>{maskCredentials(copy.text)}</Text>
        <View style={styles.buttons}>
          {copy.state === 'confirmed' ? <Pressable accessibilityRole="button" accessibilityLabel={copy.restored ? '再次加入草稿' : '恢复撤回文字'} disabled={!enabled} style={styles.action} onPress={() => restore(copy)}><Text style={styles.link}>{copy.restored ? '再次加入草稿' : '加入草稿'}</Text></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="清理撤回副本" disabled={mutating} style={styles.action} onPress={() => setDiscard(copy)}><Text style={styles.hint}>清理副本</Text></Pressable>
        </View>
      </View>)}
    </ScrollView>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <ConfirmSheet visible={!!pending} title="撤回到草稿？" message="电脑确认撤回后，文字会追加到现有草稿，已有附件会保留。若消息已开始处理，将无法撤回。" confirmText={mutating ? '正在撤回…' : '撤回编辑'} cancelText="取消"
      onCancel={() => {if (!locked.current) setPending(null);}} onConfirm={() => void withdraw()}/>
    <ConfirmSheet visible={!!discard} title="清理文字副本？" message={discard?.state === 'unconfirmed' ? '这里只清理本机副本，电脑端消息可能仍会执行。请先核对队列和会话历史。' : '请确认草稿已保存或文字已不再需要。清理副本不会改变电脑端会话。'} confirmText="清理副本" cancelText="取消"
      onCancel={() => setDiscard(null)} onConfirm={() => {if (discard) void withdrawalRecovery.discard(discard).catch(() => setError('副本清理未保存，请重试')); setDiscard(null);}}/>
  </View>;
}
function makeStyles(tv: ReturnType<typeof useTheme>) {return StyleSheet.create({
  panel:{marginHorizontal:tv.layout.screenPadding, marginBottom:tv.space.sm, padding:tv.space.sm, backgroundColor:tv.colors.bgRaised, borderRadius:tv.radius.md, borderWidth:StyleSheet.hairlineWidth,borderColor:tv.colors.border},
  heading:{color:tv.colors.textSecondary,fontSize:tv.type.xs,paddingHorizontal:tv.space.xs,paddingBottom:tv.space.xs},
  list:{maxHeight:152}, row:{flexDirection:'row',alignItems:'center',minHeight:52}, body:{flex:1,gap:3},
  text:{color:tv.colors.text,fontSize:tv.type.sm}, hint:{color:tv.colors.textSecondary,fontSize:tv.type.xs},
  note:{color:tv.colors.textSecondary,fontSize:tv.type.xs,maxWidth:96,marginLeft:tv.space.sm},
  action:{minHeight:44,paddingHorizontal:tv.space.sm,justifyContent:'center'}, link:{color:tv.colors.accent,fontSize:tv.type.sm},
  copy:{paddingTop:tv.space.sm,gap:4}, buttons:{flexDirection:'row'}, error:{color:tv.colors.warning,fontSize:tv.type.xs,padding:tv.space.xs},
});}
