/**
 * 设备管理页：列出电脑上已配对的手机，可以远程撤销。
 *
 * ## 为什么需要
 *
 * 「清除所有授权」只能撤销**本机**。但如果用户发现电脑上多了一台
 * 不认识的设备（比如旧手机卖掉前忘了退出、或者怀疑凭据泄露），
 * 得有个地方能看到全貌并处理掉。
 *
 * ## 数据来源
 *
 *   GET  /mgw/devices                    列出（含 online / lastSeenAt）
 *   POST /mgw/devices/<id>/revoke        撤销
 *
 * 都是网关管理接口，需要 App 现有的 Cookie 鉴权。
 *
 * ## 交互设计
 *
 * · 每台设备显示：名字、最后活跃时间、是否在线
 * · 点「撤销」走二次确认 —— 这是不可逆操作，误触代价大
 * · 撤销成功后从列表移除（不用整页刷新）
 * · 撤销当前设备时会警告：撤销后本机审批功能会断，需要重新配对
 *
 * ## ⚠️ 五种状态必须分开
 *
 * 之前这里只有一个 `error: string | null` 和 `devices: []`，
 * 结果「请求失败」和「真的没有设备」长得一模一样 —— 断网时界面显示
 * 「还没有设备配对过」，用户以为设备记录全被清了。
 *
 * 现在显式区分：
 *   loading      正在读
 *   empty        请求成功，确实一台都没有
 *   list         请求成功，有数据
 *   unauthorized 登录态失效 → 引导重新配对
 *   network      连不上 → 引导检查网络后重试
 *   server       服务端错误 → 引导重试
 *
 * 另外：**错误不清空已成功加载的列表** —— 保留最后一次确认成功的数据，
 * 只在顶部加一条错误提示。用户正在看的设备不会因为一次刷新失败消失。
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../design/theme';
import { radius, space, type, weight } from '../design/tokens';
import { useApp } from '../App';
import { Header } from '../components/Header';
import { Dot, Pill } from '../components/ui';
import {
  isSameDevice,
  listPairedDevices,
  revokeDevice,
  type DeviceListErrorKind,
  type PairedDevice,
} from '../core/deviceAuth';
import { CredentialKey, loadCredential } from '../core/secureStore';

/** 列表加载状态（见文件头的状态表） */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; devices: PairedDevice[] }
  | { kind: 'error'; error: DeviceListErrorKind; message: string };

/** 错误态的用户可读文案 + 下一步建议 */
const ERROR_TEXT: Record<DeviceListErrorKind, { title: string; hint: string }> = {
  network: {
    title: '连不上电脑',
    hint: '确认手机和电脑在同一个网络，然后点「重新加载」。',
  },
  unauthorized: {
    title: '登录状态已失效',
    hint: '需要在配对页重新扫一次电脑上的二维码。',
  },
  server: {
    title: '电脑那边出错了',
    hint: '可能是移动网关没开启或者版本不匹配，稍后重试。',
  },
};

export function DevicesScreen() {
  const tv = useTheme();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const { store, baseUrl, revokeOwnApproval } = useApp();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** 最后一次成功加载的数据 —— 刷新失败时不清空 */
  const [lastGood, setLastGood] = useState<PairedDevice[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * 本机的**服务端** device id（UUID）。
   *
   * ⚠️ 这是「哪一行是这台手机」的主判据 —— 服务端列表只返回 UUID，
   * 不返回客户端标识（见 tests/protocol-contract-spec.mjs）。
   * 用它匹配才能可靠认出自己。
   */
  const [selfId, setSelfId] = useState<string | undefined>();
  /** 本机的客户端标识（dsh-outpost-xxx）—— 兜底判据 */
  const [selfClientId, setSelfClientId] = useState<string | undefined>();
  /** 正在撤销的设备 id */
  const [revoking, setRevoking] = useState<string | null>(null);

  // 订阅 store：底部「审批授权已撤销」那条提示读的是 store.gatewayStatus，
  // 而 store 是可变对象 —— 不订阅的话撤销后要等别的重渲染才会出现。
  const [, forceRender] = useState(0);
  useEffect(() => {
    const unsub = store.subscribe(() => forceRender((n) => n + 1));
    return unsub;
  }, [store]);

  const load = useCallback(async () => {
    if (!baseUrl) {
      setState({
        kind: 'error',
        error: 'network',
        message: '还没连接电脑',
      });
      return;
    }
    try {
      const [cookie, myId, myServerId] = await Promise.all([
        loadCredential(CredentialKey.cookie),
        loadCredential(CredentialKey.gatewayDeviceId),
        loadCredential(CredentialKey.gatewayServerDeviceId),
      ]);
      // 两个 id 都拿：服务端列表里只有 UUID，客户端标识只存在于
      // X-DSH-Device-ID 里。任一能匹配上都算「这台手机」。
      setSelfId(myServerId ?? myId);
      setSelfClientId(myId);

      const result = await listPairedDevices(baseUrl, cookie);
      if (result.ok) {
        setState({ kind: 'ready', devices: result.devices });
        setLastGood(result.devices);
      } else {
        // 失败**不**清 lastGood —— 已确认的数据留着，
        // 只在顶部提示错误（见下面渲染）。
        setState({ kind: 'error', error: result.kind, message: result.message });
      }
    } catch {
      // listPairedDevices 自己已经兜了网络异常，走到这里说明是别的问题
      // （比如 Keystore 读失败）。同样按「读不到」处理，不伪装成空列表。
      setState({ kind: 'error', error: 'server', message: '读取设备列表失败' });
    } finally {
      setRefreshing(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const doRevoke = useCallback(
    async (device: PairedDevice) => {
      if (!baseUrl) return;
      const isSelf = isSameDevice(device, selfClientId, selfId);
      setRevoking(device.id);
      try {
        const cookie = await loadCredential(CredentialKey.cookie);
        // 这里用 revokeDevice（直接拿服务端 UUID 撤）而不是 revokeOwnDevice：
        // 管理页拿到的就是列表里的 device.id，本来就是服务端主键。
        const outcome = await revokeDevice(baseUrl, cookie, device.id);

        // ⚠️ 服务端结果和本地清理结果是**两件事**，不能混着报。
        //
        // 之前只要 outcome !== 'failed' 就从列表移除、当作成功。
        // 但「服务端撤销失败 + 本地清理成功」也是 failed —— 那种情况下
        // 提示「撤销成功」是假的，用户以为踢掉了，其实电脑上还留着。
        if (outcome === 'failed') {
          Alert.alert(
            '撤销失败',
            '网络不通或者没有权限，电脑上的授权**还在**。\n\n' +
              '请确认手机和电脑在同一个网络后重试。\n' +
              '如果这是本机，本机的审批连接已经停止，不会再自动连回去。',
          );
          // 服务端没撤掉，但如果是本机，本地仍然要停止自动连接 ——
          // 否则「撤销失败」就等于「什么都没发生」，用户无法自救。
          //
          // 不需要手动 setState 触发重渲染：store 订阅（见上面 useEffect）
          // 会在 gatewayStatus 变成 'revoked' 时自动重渲染。
          if (isSelf) {
            await revokeOwnApproval();
          }
          return;
        }

        // 成功（或服务端本来就没有）→ 从列表移除
        setState((prev) => {
          if (prev.kind !== 'ready') return prev;
          return { kind: 'ready', devices: prev.devices.filter((d) => d.id !== device.id) };
        });
        setLastGood((prev) => (prev ? prev.filter((d) => d.id !== device.id) : prev));

        // 撤销的是本机 → 本地也要进入「未授权」状态：
        // 停审批连接、清设备凭据、禁止自动重连。
        // 只做服务端那半边的话，客户端会在几秒后自动重新配对回来。
        if (isSelf) {
          const local = await revokeOwnApproval();
          if (!local.localOk) {
            Alert.alert(
              '已撤销，但本机清理不完整',
              '电脑上的授权已经撤销。但本机的设备凭据没能完全清除，' +
                '建议到「我的 → 退出并清除所有授权」再清一次。',
            );
          }
        }
      } finally {
        setRevoking(null);
      }
    },
    [baseUrl, selfId, selfClientId, revokeOwnApproval],
  );

  const askRevoke = useCallback(
    (device: PairedDevice) => {
      const isSelf = isSameDevice(device, selfClientId, selfId);
      Alert.alert(
        isSelf ? '撤销这台手机？' : `撤销「${device.name}」？`,
        isSelf
          ? '撤销后这台手机就失去审批权限，需要重新扫码配对才能用。\n\n' +
              '（聊天不受影响 —— 只有「在手机上批准命令执行」这一项会停。）'
          : '撤销后这台设备立即失去审批权限，下次连接会被拒绝。\n\n' +
              '如果这是你自己的旧手机，撤销是正确的做法。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '撤销',
            style: 'destructive',
            onPress: () => {
              void doRevoke(device);
            },
          },
        ],
      );
    },
    [selfId, selfClientId, doRevoke],
  );

  const loading = state.kind === 'loading';
  const errorState = state.kind === 'error' ? state : null;
  /** 当前要渲染的列表：成功用新的，失败用上次成功的 */
  const devices: PairedDevice[] | null =
    state.kind === 'ready' ? state.devices : lastGood;

  return (
    <View style={styles.root}>
      <Header title="设备管理" showBack />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tv.colors.accent} />
          <Text style={styles.hint}>正在读取…</Text>
        </View>
      ) : errorState && devices === null ? (
        // 一次都没成功过 → 整页错误态（带重试入口）
        <View style={styles.center}>
          <Text style={styles.errorIcon}>⚠</Text>
          <Text style={styles.errorText}>{ERROR_TEXT[errorState.error].title}</Text>
          <Text style={styles.errorHint}>{ERROR_TEXT[errorState.error].hint}</Text>
          <Text style={styles.errorDetail}>{errorState.message}</Text>
          <Pressable
            onPress={() => {
              setState({ kind: 'loading' });
              void load();
            }}
            style={({ pressed }: { pressed: boolean }) => [
              styles.retryBtn,
              pressed ? { opacity: tv.motion.pressOpacity } : null,
            ]}
          >
            <Text style={styles.retryText}>重新加载</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tv.colors.textTertiary}
              colors={[tv.colors.accent]}
              progressBackgroundColor={tv.colors.bgCard}
            />
          }
        >
          {/* 刷新失败但有历史数据：顶部一条错误条，列表保留 */}
          {errorState ? (
            <View style={styles.errorBar}>
              <Text style={styles.errorBarText}>
                {ERROR_TEXT[errorState.error].title} · 下面是上次读到的结果
              </Text>
              <Pressable
                onPress={() => {
                  setRefreshing(true);
                  void load();
                }}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.errorBarBtn,
                  pressed ? { opacity: tv.motion.pressOpacity } : null,
                ]}
              >
                <Text style={styles.errorBarBtnText}>重试</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={styles.intro}>
            这些是已经和这台电脑配对过、并且拿过审批权限的设备。
            {'\n'}如果看到不认识的设备，撤销它。
          </Text>

          {devices && devices.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>◌</Text>
              <Text style={styles.empty}>还没有设备配对过</Text>
              <Text style={styles.emptyHint}>
                在手机上扫电脑上的二维码，就会出现在这里
              </Text>
            </View>
          ) : null}

          {(devices ?? []).map((d) => {
            const self = isSameDevice(d, selfClientId, selfId);
            const busy = revoking === d.id;
            return (
              <View key={d.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <View style={styles.nameRow}>
                    <Text style={styles.deviceName} numberOfLines={1}>
                      {d.displayName || d.name || '未命名设备'}
                    </Text>
                    {self ? (
                      <Pill
                        text="这台手机"
                        color={tv.colors.accent}
                        bg={tv.colors.accentWash}
                      />
                    ) : null}
                  </View>
                  {d.online ? (
                    <View style={styles.onlineRow}>
                      <Dot color={tv.colors.success} size={5} />
                      <Text style={styles.onlineText}>在线</Text>
                    </View>
                  ) : null}
                </View>

                <Text style={styles.meta} numberOfLines={2}>
                  {formatDeviceMeta(d)}
                </Text>

                <View style={styles.actions}>
                  <Text
                    style={[styles.revokeBtn, busy ? styles.revokeBtnBusy : null]}
                    onPress={busy ? undefined : () => askRevoke(d)}
                    suppressHighlighting
                  >
                    {busy ? '撤销中…' : '撤销授权'}
                  </Text>
                </View>
              </View>
            );
          })}

          <Text style={styles.footerHint}>
            撤销是立即生效的，对方下次连接会被拒绝。
          </Text>
          <View style={{ height: space.xxxl }} />
        </ScrollView>
      )}

      {/* 审批通道状态提示：撤销本机后要明确告诉用户现在是什么状态 */}
      {store.gatewayStatus === 'revoked' ? (
        <View style={styles.revokedBar}>
          <Text style={styles.revokedText}>
            本机的审批授权已撤销，不会自动重新连接。
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** 生成「最后活跃 3 分钟前 · 配对于 2 天前」这类描述 */
function formatDeviceMeta(d: PairedDevice): string {
  const parts: string[] = [];
  if (d.lastSeenAt) {
    parts.push(`最后活跃 ${relTime(d.lastSeenAt)}`);
  } else {
    parts.push('从未连接');
  }
  if (d.createdAt) {
    parts.push(`配对 ${relTime(d.createdAt)}`);
  }
  if (d.connections && d.connections > 0) {
    parts.push(`${d.connections} 个连接`);
  }
  return parts.join(' · ');
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return day < 30 ? `${day} 天前` : `${Math.floor(day / 30)} 个月前`;
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  const L = tv.layout;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: L.screenPadding },
    content: { padding: L.screenPadding },

    intro: {
      color: C.textTertiary,
      fontSize: type.micro,
      lineHeight: type.xs * 1.6,
      marginBottom: space.md,
    },

    card: {
      backgroundColor: C.bgCard,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      padding: space.md,
      marginBottom: space.sm,
    },
    cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
    deviceName: {
      color: C.text,
      fontSize: type.sm,
      fontWeight: weight.medium,
      flexShrink: 1,
    },
    onlineRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    onlineText: { color: C.success, fontSize: type.micro },

    meta: {
      color: C.textTertiary,
      fontSize: type.micro,
      marginTop: 4,
      lineHeight: type.xs * 1.5,
    },

    actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.sm },
    revokeBtn: {
      color: C.danger,
      fontSize: type.micro,
      fontWeight: weight.medium,
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    revokeBtnBusy: { color: C.textFaint },

    emptyBox: { alignItems: 'center', paddingVertical: space.xxxl, gap: 6 },
    emptyIcon: { fontSize: 28, color: C.textFaint },
    empty: { color: C.textSecondary, fontSize: type.sm },
    emptyHint: { color: C.textFaint, fontSize: type.micro, textAlign: 'center' },

    errorIcon: { fontSize: 28, color: C.danger },
    errorText: { color: C.danger, fontSize: type.sm, textAlign: 'center', fontWeight: weight.medium },
    errorHint: { color: C.textSecondary, fontSize: type.micro, textAlign: 'center' },
    errorDetail: { color: C.textFaint, fontSize: type.micro, textAlign: 'center' },
    hint: { color: C.textFaint, fontSize: type.micro },

    retryBtn: {
      marginTop: space.sm,
      paddingHorizontal: space.lg,
      paddingVertical: space.xs,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: C.accentDim,
    },
    retryText: { color: C.accent, fontSize: type.xs, fontWeight: weight.medium },

    errorBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
      paddingVertical: space.xs,
      paddingHorizontal: space.sm,
      marginBottom: space.sm,
      borderRadius: radius.sm,
      backgroundColor: C.dangerWash,
    },
    errorBarText: { color: C.danger, fontSize: type.micro, flex: 1 },
    errorBarBtn: { paddingHorizontal: space.sm, paddingVertical: 2 },
    errorBarBtnText: { color: C.accent, fontSize: type.micro, fontWeight: weight.medium },

    revokedBar: {
      paddingHorizontal: L.screenPadding,
      paddingVertical: space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
      backgroundColor: C.bgCard,
    },
    revokedText: { color: C.textSecondary, fontSize: type.micro, textAlign: 'center' },

    footerHint: {
      color: C.textFaint,
      fontSize: type.micro,
      textAlign: 'center',
      marginTop: space.lg,
    },
  });
}
