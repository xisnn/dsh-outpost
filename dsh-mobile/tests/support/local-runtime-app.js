// Isolated Android integration entry. Never the product entrypoint.
import React, {useEffect, useState} from 'react';
import {AppRegistry, Button, SafeAreaView, ScrollView, Text, NativeModules} from 'react-native';
import {localDsh} from '../../src/core/localDsh';

function Probe() {
  const [state, setState] = useState({phase: 'loading'});
  const [query, setQuery] = useState(null);
  const [error, setError] = useState('');
  const refresh = () => localDsh.snapshot().then(setState).catch(e => setError(e.code ?? String(e)));
  useEffect(() => {void refresh();return localDsh.subscribe(refresh);}, []);
  const run = job => {setError('');Promise.resolve().then(job).then(refresh).catch(e => setError(e.code ?? String(e)));};
  return <SafeAreaView style={{flex: 1}}><ScrollView contentContainerStyle={{padding: 24}}>
    <Text accessibilityRole="header">P1 原生桥集成验证</Text>
    <Text testID="phase">{state.phase}</Text>
    <Text testID="generation">{state.generation ?? 'none'}</Text>
    <Text testID="cursor">{String(state.cursor ?? 0)}</Text>
    <Text testID="error">{error}</Text>
    <Button title="刷新状态" onPress={refresh}/>
    <Button title="启动本机 DSH" onPress={() => run(() => localDsh.start(state.requiresReconciliation ? state.generation : null))}/>
    <Button title="查询管家" onPress={() => run(async () => setQuery(await localDsh.query(state.generation, 'snapshot')))}/>
    <Button title="停止本机 DSH" onPress={() => run(() => localDsh.stop())}/>
    <Button title="核对事件" onPress={() => run(async () => setQuery(await localDsh.events(0)))}/>
    <Text testID="query">{query ? JSON.stringify(query) : ''}</Text>
    <Text>{NativeModules.OutpostLocalDsh ? 'native-module-present' : 'native-module-missing'}</Text>
  </ScrollView></SafeAreaView>;
}
AppRegistry.registerComponent('DshPocket', () => Probe);
