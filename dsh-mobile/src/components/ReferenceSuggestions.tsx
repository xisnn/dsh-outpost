import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {MotionPressable as Pressable} from './MotionPressable';
import {useTheme} from '../design/theme';
import {maskCredentials} from '../core/credentialDisplay';

export interface ReferenceChoice {key: string; label: string; detail?: string; mention: string; directory?: boolean}
export interface ReferenceSource {
  conversationReferences(sessionId: string, kind: 'file' | 'session', query: string): Promise<ReferenceChoice[]>;
}
export function ReferenceSuggestions({source, sessionId, query, scope, manual = false, onPick, onClose}: {
  source: ReferenceSource; sessionId: string; query: string; scope: object; manual?: boolean;
  onPick: (choice: ReferenceChoice) => void; onClose: () => void;
}) {
  const tv = useTheme(), styles = useMemo(() => makeStyles(tv), [tv]);
  const [kind, setKind] = useState<'file' | 'session'>('file');
  const [search, setSearch] = useState('');
  const [retry, setRetry] = useState(0);
  const term = manual ? search : query;
  const [result, setResult] = useState<{scope: object; term: string; kind: string; rows: ReferenceChoice[]; error?: string} | null>(null);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      void source.conversationReferences(sessionId, kind, term).then(rows => {
        if (!disposed) setResult({scope, term, kind, rows: rows.slice(0, 20)});
      }, () => {
        if (!disposed) setResult({scope, term, kind, rows: [], error: '暂时无法获取引用，请检查连接或当前 DSH 的接口支持'});
      });
    }, 250);
    return () => {disposed = true; clearTimeout(timer);};
  }, [source, sessionId, kind, term, scope, retry]);
  const current = result?.scope === scope && result.term === term && result.kind === kind ? result : null;
  return <View style={styles.panel} accessibilityLabel="引用候选">
    <View style={styles.heading}>
      {(['file', 'session'] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityLabel={tab === 'file' ? '引用文件' : '引用会话'} accessibilityState={{selected: kind === tab}} onPress={() => setKind(tab)} style={[styles.tab, kind === tab && styles.selected]}>
        <Text style={[styles.label, kind === tab && {color: tv.colors.accent}]}>{tab === 'file' ? '文件' : '会话'}</Text>
      </Pressable>)}
      <View style={styles.spacer}/><Pressable accessibilityRole="button" accessibilityLabel="关闭引用候选" style={styles.tab} onPress={onClose}><Text style={styles.hint}>关闭</Text></Pressable>
    </View>
    {manual ? <TextInput value={search} onChangeText={setSearch} placeholder="搜索文件或会话" placeholderTextColor={tv.colors.textTertiary} accessibilityLabel="搜索引用" style={styles.search} autoCorrect={false} autoCapitalize="none" maxLength={500}/> : null}
    {!current ? <View style={styles.state}><ActivityIndicator size="small" color={tv.colors.accent}/><Text style={styles.hint}>正在查找…</Text></View> : current.error ? <Pressable accessibilityRole="button" accessibilityLabel="重试获取引用" style={styles.state} onPress={() => {setResult(null); setRetry(n => n + 1);}}><Text style={styles.hint}>{current.error} · 重试</Text></Pressable> : <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
      {current.rows.length ? current.rows.map(row => <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={`插入引用：${maskCredentials(row.label)}`} onPress={() => onPick(row)} style={styles.row}>
        <Text style={styles.label} numberOfLines={1}>{maskCredentials(row.label)}</Text>
        {row.detail ? <Text style={styles.hint} numberOfLines={1}>{maskCredentials(row.detail)}</Text> : null}
      </Pressable>) : <Text style={styles.empty}>{kind === 'file' ? '当前项目没有匹配的文件' : '没有匹配的可见会话'}</Text>}
    </ScrollView>}
  </View>;
}
function makeStyles(tv: ReturnType<typeof useTheme>) {return StyleSheet.create({
  panel: {marginHorizontal: tv.layout.screenPadding, marginBottom: tv.space.sm, borderRadius: tv.radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: tv.colors.borderStrong, backgroundColor: tv.colors.bgRaised, overflow: 'hidden'},
  heading: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: tv.space.xs},
  tab: {minHeight: 44, minWidth: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: tv.space.sm, borderRadius: tv.radius.sm},
  selected: {backgroundColor: tv.colors.accentWash}, spacer: {flex: 1},
  label: {color: tv.colors.text, fontSize: tv.type.sm}, hint: {color: tv.colors.textSecondary, fontSize: tv.type.xs},
  search: {minHeight: 44, color: tv.colors.text, fontSize: tv.type.base, paddingHorizontal: tv.space.md},
  list: {maxHeight: 176}, row: {minHeight: 48, justifyContent: 'center', gap: 3, paddingHorizontal: tv.space.md, paddingVertical: tv.space.sm},
  empty: {color: tv.colors.textSecondary, fontSize: tv.type.xs, padding: tv.space.md}, state: {minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: tv.space.sm, paddingHorizontal: tv.space.md, paddingVertical: tv.space.sm},
});}
