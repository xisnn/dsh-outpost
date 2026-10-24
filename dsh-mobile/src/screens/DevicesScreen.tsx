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
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { listPairedDevices, revokeDevice, type PairedDevice } from '../core/deviceAuth';
import { CredentialKey, loadCredential } from '../core/secureStore';

export function DevicesScreen() {
  const tv = useTheme();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const { store, baseUrl } = useApp();

  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 本机的客户端 device id（判断哪一行是「这台手机」） */
  const [selfId, setSelfId] = useState<string | undefined>();
  /** 正在撤销的设备 id */
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!baseUrl) {
      setError('还没连接');
      setLoading(false);
      return;
    }
    try {
      const [cookie, myId] = await Promise.all([
        loadCredential(CredentialKey.cookie),
        loadCredential(CredentialKey.gatewayDeviceId),
      ]);
      setSelfId(myId);
      const list = await listPairedDevices(baseUrl, cookie);
      setDevices(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setLoading(false);
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

  const askRevoke = useCallback(
    (device: PairedDevice) => {
      const isSelf =
        device.clientDeviceId === selfId || (!!selfId && device.id === selfId);
      Alert.alert(
        isSelf ? '撤销这台手机？' : `撤销「${device.name}」？`,
        isSelf
          ? '撤销后这台手机就失去审批权限，需要重新扫码配对才能用。\n\n（如果你想换手机，或者怀疑自己泄露了凭据，选这个。）'
          : '撤销后这台设备立即失去审批权限，下次连接会被拒绝。\n\n如果这是你自己的旧手机，撤销是正确的做法。',
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
    [selfId],
  );

  const doRevoke = useCallback(
    async (device: PairedDevice) => {
      if (!baseUrl) return;
      setRevoking(device.id);
      try {
        const cookie = await loadCredential(CredentialKey.cookie);
        const outcome = await revokeDevice(baseUrl, cookie, device.id);
        if (outcome === 'failed') {
          Alert.alert('撤销失败', '网络不通或者没有权限。\n\n请确认手机和电脑在同一个网络后重试。');
          return;
        }
        // 成功（或服务端本来就没有）→ 从列表移除
        setDevices((prev) => (prev ? prev.filter((d) => d.id !== device.id) : prev));
      } finally {
        setRevoking(null);
      }
    },
    [baseUrl],
  );

  const isSelfDevice = useCallback(
    (device: PairedDevice) =>
      device.clientDeviceId === selfId || (!!selfId && device.id === selfId),
    [selfId],
  );

  return (
    <View style={styles.root}>
      <Header title="设备管理" showBack />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tv.colors.accent} />
          <Text style={styles.hint}>正在读取…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorIcon}>⚠</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.hint}>下拉可以重试</Text>
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
            const self = isSelfDevice(d);
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
    errorText: { color: C.danger, fontSize: type.sm, textAlign: 'center' },
    hint: { color: C.textFaint, fontSize: type.micro },

    footerHint: {
      color: C.textFaint,
      fontSize: type.micro,
      textAlign: 'center',
      marginTop: space.lg,
    },
  });
}
