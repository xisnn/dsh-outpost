/**
 * 配对帮助弹层：详细讲清楚「怎么连电脑」。
 *
 * 视觉与 ConfirmSheet 一致：居中浮动卡片、圆角、细分隔线，
 * 内容超长时卡片内部滚动，按钮固定在卡片底部。
 */
import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

/**
 * 这里只是「示例命令」，不要写死开发者的路径或 IP —— 开源后每个用户的环境都不一样。
 * 真正的启动方式以 README 为准，卡片里给一个能看懂的骨架。
 */
const CMD_LAN = 'dsh --profile web --host 0.0.0.0 --port 3095';
const CMD_TAILNET = 'dsh --profile web --host <tailscale-ip> --port 3095';

export function PairingHelpSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={styles.card}
          onPress={() => {
            /* 吃掉点击，别传给背景 */
          }}
        >
          <Text style={styles.title}>怎么连接电脑</Text>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            <Step
              styles={styles}
              n={1}
              title="电脑上启动 DSH Web 服务"
              desc="在电脑终端里启动 DSH 的 web 模式，它会打印一条带 token 的链接和二维码。"
            />
            <View style={styles.code}>
              <Text style={styles.codeText}>{CMD_LAN}</Text>
            </View>

            <Step
              styles={styles}
              n={2}
              title="选一种网络方式，让手机能访问这个地址"
              desc={
                '· 同一个 WiFi —— 用电脑的局域网 IP（最常见，如 192.168.1.10）\n'
                + '· Tailscale —— 人在外面时用 100.x 内网 IP，手机也装上并登录同一账号\n'
                + '· 自己的公网 —— 域名 / frp / 隧道都行，App 只认一个 URL'
              }
            />
            <View style={styles.code}>
              <Text style={styles.codeText}>{CMD_TAILNET}</Text>
            </View>

            <Step
              styles={styles}
              n={3}
              title="三种配对方式，任选一种"
              desc={
                '· 扫二维码 —— 点「扫码」，对准终端里的二维码，最快\n'
                + '· 粘贴整行链接 —— 复制终端打印的那一行贴到 Token 框，地址会自动识别\n'
                + '· 只粘 token —— 前面地址手动填'
              }
            />

            <View style={styles.divider} />
            <Text style={styles.faqTitle}>常见问题</Text>

            <Faq
              styles={styles}
              q="重启电脑上的服务后要重新配对吗？"
              a="不用。服务重启只是换了一个 token（只给首次配对用），已经配对的手机靠 cookie 免登录，有效期 30 天。"
            />
            <Faq
              styles={styles}
              q="不小心退出了登录？"
              a="配对页顶部会出现「上次的配对还在 · 直接继续」，点一下就能恢复，不需要重新找 token。"
            />
            <Faq
              styles={styles}
              q="一直连不上？"
              a="依次检查：电脑上的服务还在跑、地址和端口填对了、手机和电脑在同一网络（同一 WiFi 或同一个 Tailscale 账号）。"
            />
            <Faq
              styles={styles}
              q="token 会泄露吗？"
              a="token 等于这台服务的钥匙，只应发给自己的手机。局域网广播发现功能默认不广播 token，就是为了避免同一 WiFi 下的其他人拿到。"
            />
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              onPress={onClose}
              style={({ pressed }: { pressed: boolean }) => [
                styles.confirmBtn,
                pressed ? { opacity: 0.85 } : null,
              ]}
            >
              <Text style={styles.confirmText}>知道了</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Step({
  styles,
  n,
  title,
  desc,
}: {
  styles: ReturnType<typeof makeStyles>;
  n: number;
  title: string;
  desc: string;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepBadgeText}>{n}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepDesc}>{desc}</Text>
      </View>
    </View>
  );
}

function Faq({
  styles,
  q,
  a,
}: {
  styles: ReturnType<typeof makeStyles>;
  q: string;
  a: string;
}) {
  return (
    <View style={styles.faq}>
      <Text style={styles.faqQ}>{q}</Text>
      <Text style={styles.faqA}>{a}</Text>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(20,24,32,0.38)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: tv.space.xl,
    },
    card: {
      width: '100%',
      maxWidth: 360,
      maxHeight: '80%',
      borderRadius: 18,
      backgroundColor: C.bgRaised,
      overflow: 'hidden',
    },
    title: {
      color: C.text,
      fontSize: tv.type.lg,
      fontWeight: tv.weight.semibold,
      paddingHorizontal: tv.space.lg,
      paddingTop: tv.space.lg,
      paddingBottom: tv.space.md,
    },
    body: { flexGrow: 0, flexShrink: 1 },
    bodyContent: { paddingHorizontal: tv.space.lg, paddingBottom: tv.space.md },

    step: { flexDirection: 'row', marginBottom: tv.space.md },
    stepBadge: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: C.accentWash,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: tv.space.md,
      marginTop: 1,
    },
    stepBadgeText: { color: C.accentBright, fontSize: tv.type.micro, fontWeight: tv.weight.semibold },
    stepBody: { flex: 1 },
    stepTitle: { color: C.text, fontSize: tv.type.base, fontWeight: tv.weight.medium },
    stepDesc: {
      color: C.textSecondary,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.55,
      marginTop: 4,
    },

    code: {
      marginLeft: 34,
      marginTop: -tv.space.sm,
      marginBottom: tv.space.md,
      padding: tv.space.md,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgCard,
    },
    codeText: { color: C.textSecondary, fontSize: tv.type.micro, lineHeight: tv.type.micro * 1.6 },

    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginTop: tv.space.sm,
      marginBottom: tv.space.md,
    },
    faqTitle: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      letterSpacing: 0.6,
      marginBottom: tv.space.sm,
    },
    faq: { marginBottom: tv.space.md },
    faqQ: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    faqA: {
      color: C.textSecondary,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.55,
      marginTop: 3,
    },

    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
      backgroundColor: C.bgRaised,
      paddingTop: tv.space.md,
    },
    confirmBtn: {
      marginHorizontal: tv.space.lg,
      marginBottom: tv.space.lg,
      paddingVertical: 13,
      borderRadius: tv.radius.md,
      backgroundColor: C.accent,
      alignItems: 'center',
    },
    confirmText: { color: C.onAccent, fontSize: tv.type.base, fontWeight: tv.weight.medium },
  });
}
