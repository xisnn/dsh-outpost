/**
 * 本机运行时状态钩子（P3）。
 *
 * - 只在页面可见（active）时轮询；页面隐藏后不再向原生桥发请求；
 * - 运行中 2.5s 一次，空闲 8s 一次，避免在「我的」页签后台空转；
 * - 订阅原生 changed 事件只作为提前刷新提示，权威状态仍来自 snapshot；
 * - 所有调用经过 LocalRuntimeClient 串行化，不会触发 BRIDGE_BUSY。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { localDsh, type BundledDistribution } from '../core/localDsh';
import { createLocalRuntimeBridge } from '../core/localRuntimeBridge';
import { pickRuntimePackage } from '../core/picker';
import {
  LocalRuntimeClient,
  normalizeRuntimeCode,
  type LocalRuntimeSnapshot,
} from '../core/localRuntime';

export interface LocalRuntimeView {
  client: LocalRuntimeClient;
  supported: boolean;
  snapshot: LocalRuntimeSnapshot | null;
  error: string | null;
  busy: boolean;
  distributions: BundledDistribution[];
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  importPackage: () => Promise<void>;
}

const RUNNING_POLL_MS = 2500;
const IDLE_POLL_MS = 8000;

export function useLocalRuntime(active: boolean): LocalRuntimeView {
  const client = useMemo(
    () => new LocalRuntimeClient(createLocalRuntimeBridge()),
    [],
  );
  const [snapshot, setSnapshot] = useState<LocalRuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [distributions, setDistributions] = useState<BundledDistribution[]>([]);
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  // A snapshot read error must clear on the next successful read; an action
  // error (start/stop/import) must stay visible until the next action.
  const errorSource = useRef<'read' | 'action' | null>(null);
  const mounted = useRef(true);
  const snapshotRef = useRef<LocalRuntimeSnapshot | null>(null);
  snapshotRef.current = snapshot;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!client.supported) return;
    let alive = true;
    void localDsh.bundledDistributions()
      .then(rows => { if (alive) setDistributions(Array.isArray(rows) ? rows.slice(0, 8) : []); })
      .catch(() => { if (alive) setDistributions([]); });
    return () => { alive = false; };
  }, [client.supported]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      client.dispose();
    };
  }, [client]);

  const refresh = useCallback(async () => {
    if (!client.supported) return;
    try {
      const next = await client.snapshot();
      if (!mounted.current) return;
      setSnapshot(next);
      if (errorSource.current === 'read') {
        errorSource.current = null;
        setError(null);
      }
    } catch (failure) {
      if (!mounted.current) return;
      errorSource.current = 'read';
      setError(normalizeRuntimeCode(failure));
    }
  }, [client]);

  const start = useCallback(async () => {
    if (!client.supported) return;
    errorSource.current = null;
    setError(null);
    setBusy(true);
    try {
      const next = await client.start();
      if (mounted.current) {
        setSnapshot(next);
        errorSource.current = null;
        setError(null);
      }
    } catch (failure) {
      if (mounted.current) {
        errorSource.current = 'action';
        setError(normalizeRuntimeCode(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client]);

  /**
   * Import a runtime package through the system picker. The native module
   * validates the artifact against the trusted manifest bundled in the APK;
   * the picked file alone is never trusted.
   */
  const importPackage = useCallback(async () => {
    if (!client.supported || busy) return;
    const distribution = distributions[0];
    if (!distribution) {
      errorSource.current = 'action';
      setError('BUNDLED_DISTRIBUTION_MISSING');
      return;
    }
    errorSource.current = null;
    setError(null);
    let picked;
    try {
      picked = await pickRuntimePackage();
    } catch {
      errorSource.current = 'action';
      setError('RUNTIME_PICKER_FAILED');
      return;
    }
    if (!picked) return;
    setBusy(true);
    try {
      await localDsh.install(distribution.id, picked.uri);
      const next = await client.snapshot();
      if (mounted.current) {
        setSnapshot(next);
        errorSource.current = null;
        setError(null);
      }
    } catch (failure) {
      if (mounted.current) {
        errorSource.current = 'action';
        setError(normalizeRuntimeCode(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, client, distributions]);

  const stop = useCallback(async () => {
    if (!client.supported) return;
    errorSource.current = null;
    setError(null);
    setBusy(true);
    try {
      const next = await client.stop();
      if (mounted.current) {
        setSnapshot(next);
        errorSource.current = null;
        setError(null);
      }
    } catch (failure) {
      if (mounted.current) {
        errorSource.current = 'action';
        setError(normalizeRuntimeCode(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    // The native service keeps running in the background; RN polling stops so
    // a hidden app does not wake the bridge every few seconds.
    if (!active || !client.supported || !appActive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const phase = snapshotRef.current?.phase;
      const delay = phase === 'running' || phase === 'starting' || phase === 'stopping'
        ? RUNNING_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(() => {
        if (stopped) return;
        void refresh().finally(() => { if (!stopped) schedule(); });
      }, delay);
    };

    void refresh().finally(() => { if (!stopped) schedule(); });
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = localDsh.subscribe(() => { void refresh(); });
    } catch {
      // A missing emitter only costs latency; polling still converges.
    }
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [active, appActive, client.supported, refresh]);

  return { client, supported: client.supported, snapshot, error, busy, distributions, refresh, start, stop, importPackage };
}
