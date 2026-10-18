/**
 * 模型切换器 + 上下文用量条。
 *
 * 取 CDS 的 ModelSwitcherWithTokenGauge 思路：
 * - 顶栏显示当前模型 + 上下文占用百分比
 * - 点开弹出模型列表（按 provider 分组）
 * - 底部显示 token 用量明细
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApp } from '../App';
import { useTheme } from '../design/theme';
import { radius, space, type } from '../design/tokens';
import { flattenCatalog, findCatalogModel, type CatalogModel, type ModelCatalog } from '../core/rpc/model';

export interface ModelSwitcherProps {
  sessionId: string;
  currentProvider?: string | null;
  currentModel?: string | null;
  /** 当前思考强度（模型不支持时为 null/undefined） */
  currentReasoningEffort?: string | null;
  contextUsed: number;
  contextWindow: number;
  tokenUsage?: {
    uncachedInputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  onChanged?: () => void;
}

function fmt(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function ModelSwitcher({
  sessionId,
  currentProvider,
  currentModel,
  currentReasoningEffort,
  contextUsed,
  contextWindow,
  tokenUsage,
  onChanged,
}: ModelSwitcherProps) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const { store } = useApp();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const ratio = contextWindow > 0 ? contextUsed / contextWindow : 0;
  const pct = Math.round(ratio * 100);
  const gaugeColor =
    ratio > 0.9 ? tv.colors.danger : ratio > 0.75 ? tv.colors.warning : tv.colors.success;

  useEffect(() => {
    if (!open || catalog) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const c = await store.modelCatalog();
        setCatalog(c);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, catalog, store]);

  const pick = async (provider: string, model: CatalogModel) => {
    setSwitching(`${provider}/${model.id}`);
    setError(null);
    try {
      // 换模型时带上这个模型的默认档位，避免沿用上一个模型不存在的档位
      const effort = model.reasoning?.defaultEffort ?? model.reasoning?.efforts?.[0]?.id;
      await store.selectModel(sessionId, { provider, model: model.id, reasoningEffort: effort });
      setOpen(false);
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // writer-held = 该会话正被另一个进程（如桌面端 DSH）占用
      if (/writer-held|already owned|active write handle/i.test(msg)) {
        setError('这个会话正被电脑上的 DSH 占用，无法切换模型。\n先在电脑端关闭该会话，或换一个未被占用的会话。');
      } else {
        setError(msg);
      }
    } finally {
      setSwitching(null);
    }
  };

  /** 只改思考强度，模型不变 */
  const applyEffort = async (effortId: string) => {
    if (!effectiveProvider || !effectiveModel) return;
    setSwitching(`effort:${effortId}`);
    setError(null);
    try {
      await store.selectModel(sessionId, {
        provider: effectiveProvider,
        model: effectiveModel,
        reasoningEffort: effortId,
      });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(null);
    }
  };

  const flat = catalog ? flattenCatalog(catalog) : [];
  // 会话还没显式选过模型时，用目录里的默认模型兜底 ——
  // 否则空会话打开面板看不到「思考强度」
  const effectiveProvider = currentProvider ?? catalog?.default.provider ?? null;
  const effectiveModel = currentModel ?? catalog?.default.model ?? null;
  const effectiveEffort =
    currentReasoningEffort ??
    (currentModel ? null : catalog?.default.reasoningEffort ?? null);

  const currentEntry = findCatalogModel(flat, effectiveProvider, effectiveModel);
  const efforts = currentEntry?.reasoning?.efforts ?? [];
  const activeEffort = effectiveEffort ?? currentEntry?.reasoning?.defaultEffort ?? null;
  // 目录还没加载时用 id 兜底显示（off → Off），避免顶栏忽然少一截
  const activeEffortName =
    efforts.find((e) => e.id === activeEffort)?.name ??
    (activeEffort ? activeEffort.charAt(0).toUpperCase() + activeEffort.slice(1) : null);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }: { pressed: boolean }) => [styles.trigger, pressed && styles.triggerPressed]}
      >
        {/* 第一行：模型名 */}
        <Text style={styles.modelName} numberOfLines={1}>
          {effectiveModel ? String(effectiveModel).split('/').pop() : '默认模型'}
        </Text>
        {/* 第二行：上下文用量条 + 百分比 */}
        <View style={styles.gaugeRow}>
          <View style={styles.gaugeTrack}>
            <View
              style={[
                styles.gaugeFill,
                { width: `${Math.min(100, pct)}%`, backgroundColor: gaugeColor },
              ]}
            />
          </View>
          <Text style={[styles.pct, { color: gaugeColor }]}>{pct}%</Text>
        </View>
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={styles.backdropFill} onPress={() => setOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>模型</Text>

            {/* token 用量 */}
            <View style={styles.usageBox}>
              <View style={styles.usageRow}>
                <Text style={styles.usageLabel}>上下文</Text>
                <Text style={styles.usageValue}>
                  {fmt(contextUsed)} / {fmt(contextWindow)} ({pct}%)
                </Text>
              </View>
              {tokenUsage ? (
                <>
                  <View style={styles.usageRow}>
                    <Text style={styles.usageLabel}>输入（未缓存）</Text>
                    <Text style={styles.usageValue}>{fmt(tokenUsage.uncachedInputTokens)}</Text>
                  </View>
                  <View style={styles.usageRow}>
                    <Text style={styles.usageLabel}>输出</Text>
                    <Text style={styles.usageValue}>{fmt(tokenUsage.outputTokens)}</Text>
                  </View>
                  <View style={styles.usageRow}>
                    <Text style={styles.usageLabel}>缓存命中</Text>
                    <Text style={styles.usageValue}>{fmt(tokenUsage.cacheReadTokens)}</Text>
                  </View>
                </>
              ) : null}
            </View>

            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator color={tv.colors.accent} />
              </View>
            ) : error ? (
              <View style={styles.center}>
                <Text style={styles.error}>{error}</Text>
              </View>
            ) : (
              <FlatList
                data={flat}
                keyExtractor={(it) => `${it.provider}/${it.model.id}`}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                renderItem={({ item }: { item: (typeof flat)[number] }) => {
                  const active =
                    item.provider === effectiveProvider && item.model.id === effectiveModel;
                  const key = `${item.provider}/${item.model.id}`;
                  return (
                    <Pressable
                      style={({ pressed }: { pressed: boolean }) => [
                        styles.modelRow,
                        pressed && styles.modelRowPressed,
                        active && styles.modelRowActive,
                      ]}
                      onPress={() => void pick(item.provider, item.model)}
                      disabled={switching !== null}
                    >
                      <View style={styles.modelMain}>
                        <Text style={styles.modelTitle} numberOfLines={1}>
                          {item.model.name || item.model.id}
                        </Text>
                        <Text style={styles.modelSub} numberOfLines={1}>
                          {item.groupName} · {item.provider}
                        </Text>
                      </View>
                      {switching === key ? (
                        <ActivityIndicator color={tv.colors.accent} size="small" />
                      ) : active ? (
                        <Text style={styles.check}>✓</Text>
                      ) : null}
                    </Pressable>
                  );
                }}
                ListEmptyComponent={
                  <View style={styles.center}>
                    <Text style={styles.error}>没有可用模型</Text>
                  </View>
                }
              />
            )}

            {/* 思考强度：按当前模型支持的档位渲染（放在模型列表下面） */}
            {efforts.length > 0 ? (
              <View style={styles.effortBox}>
                <View style={styles.effortHead}>
                  <Text style={styles.effortLabel}>思考强度</Text>
                  {activeEffort ? (
                    <Text style={styles.effortNow}>
                      {efforts.find((e) => e.id === activeEffort)?.name ?? activeEffort}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.effortChips}>
                  {efforts.map((e) => {
                    const active = e.id === activeEffort;
                    const busy = switching === `effort:${e.id}`;
                    return (
                      <Pressable
                        key={e.id}
                        disabled={switching !== null}
                        onPress={() => void applyEffort(e.id)}
                        style={({ pressed }: { pressed: boolean }) => [
                          styles.effortChip,
                          active && styles.effortChipActive,
                          pressed && !active ? { opacity: 0.7 } : null,
                        ]}
                      >
                        {busy ? (
                          <ActivityIndicator size="small" color={tv.colors.accent} />
                        ) : (
                          <Text
                            style={[styles.effortChipText, active && styles.effortChipTextActive]}
                          >
                            {e.name}
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
                {(() => {
                  const desc = efforts.find((e) => e.id === activeEffort)?.description;
                  return desc ? (
                    <Text style={styles.effortDesc} numberOfLines={2}>
                      {desc}
                    </Text>
                  ) : null;
                })()}
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    trigger: {
      alignItems: 'flex-end',
      paddingHorizontal: space.sm,
      paddingVertical: 3,
      borderRadius: radius.sm,
    },
    triggerPressed: { backgroundColor: C.bgOverlay },
    gaugeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
    gaugeTrack: {
      width: 45,
      height: 3,
      borderRadius: 2,
      backgroundColor: C.border,
      overflow: 'hidden',
      marginRight: space.xs,
    },
    gaugeFill: { height: 4 },
    pct: { fontSize: 9, marginLeft: 5, fontVariant: ['tabular-nums'] },
    modelName: { color: C.textSecondary, fontSize: type.xs, maxWidth: 130 },

    backdrop: { flex: 1, backgroundColor: C.scrim, justifyContent: 'flex-end' },
    backdropFill: { flex: 1 },
    sheet: {
      backgroundColor: C.bgRaised,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      maxHeight: '78%',
      paddingTop: space.sm,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.borderStrong,
      marginBottom: space.sm,
    },
    sheetTitle: {
      color: C.text,
      fontSize: type.lg,
      fontWeight: '600',
      paddingHorizontal: space.lg,
      paddingBottom: space.sm,
    },
    usageBox: {
      marginHorizontal: space.lg,
      marginBottom: space.md,
      padding: space.md,
      backgroundColor: C.bg,
      borderRadius: radius.md,
    },

    // 思考强度
    effortBox: {
      marginHorizontal: space.lg,
      marginTop: space.xs,
      marginBottom: space.md,
      padding: space.md,
      backgroundColor: C.bg,
      borderRadius: radius.md,
    },
    effortHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: space.sm,
    },
    effortLabel: { color: C.textSecondary, fontSize: type.sm },
    effortNow: { color: C.accentBright, fontSize: type.sm, fontWeight: '500' },
    effortChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    effortChip: {
      minWidth: 56,
      alignItems: 'center',
      paddingVertical: 7,
      paddingHorizontal: space.md,
      borderRadius: radius.sm,
      backgroundColor: C.bgCard,
    },
    effortChipActive: { backgroundColor: C.accent },
    effortChipText: { color: C.textSecondary, fontSize: type.sm },
    effortChipTextActive: { color: C.onAccent, fontWeight: '500' },
    effortDesc: { color: C.textTertiary, fontSize: type.micro, marginTop: space.sm },
    usageRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 2,
    },
    usageLabel: { color: C.textTertiary, fontSize: type.xs },
    usageValue: { color: C.textSecondary, fontSize: type.xs, fontVariant: ['tabular-nums'] },
    list: { maxHeight: 360, flexGrow: 0 },
    listContent: { paddingBottom: 4 },
    modelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    modelRowPressed: { backgroundColor: C.bgOverlay },
    modelRowActive: { backgroundColor: C.accentWash },
    modelMain: { flex: 1, minWidth: 0 },
    modelTitle: { color: C.text, fontSize: type.base },
    modelSub: { color: C.textTertiary, fontSize: 10, marginTop: 2 },
    check: { color: C.accent, fontSize: type.lg },
    center: { padding: space.xxl, alignItems: 'center' },
    error: { color: C.danger, fontSize: type.sm, textAlign: 'center' },
  });
}
