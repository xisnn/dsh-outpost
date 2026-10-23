/**
 * 第三层：聊天屏。
 *
 * 视觉：
 * - 顶部：标题 + 一个精简状态行（轮次 / 上下文 / 模型）
 * - 内容：用户气泡右对齐、助手文本左对齐、工具卡与思考面板作为中间层
 * - 底部：浮动输入条 + 发送/打断
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useApp } from '../App';
import { useNav } from '../nav/NavHost';
import { Header } from '../components/Header';
import { useTheme } from '../design/theme';
import { layout, radius, space, type, weight } from '../design/tokens';
import { AssistantText, UserBubble } from '../components/Message';
import { AssistantRichText } from '../components/AssistantRichText';
import { TeamBar } from '../components/TeamBar';
import { TeamStrip } from '../components/TeamStrip';
import { TeamSheet } from '../components/TeamSheet';
import { SlideSegmented } from '../components/SlideSegmented';
import { TeammateNote } from '../components/TeammateNote';
import { CompletionNotice } from '../components/CompletionNotice';
import { ButlerThinking } from '../components/ButlerThinking';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { ButlerWorkspacePicker } from '../components/ButlerWorkspacePicker';
import { FileCard } from '../components/FileCard';
import { isImagePath } from '../core/filerefs';
import type { ButlerMode } from '../core/butler';
import { ThinkingAccordion, ThinkingDots } from '../components/Thinking';
import { ToolCard } from '../components/ToolCard';
import { ModelSwitcher } from '../components/ModelSwitcher';
import { pickAttachments, formatBytes, type PickMode } from '../core/picker';
import { guessImageMime, readFileBase64 } from '../core/rpc/upload';
import type { OutgoingAttachment } from '../core/store';
import { modeSwitchMessage } from '../core/butler';
import type { Block, ChatItem } from '../core/fold';
import type { SessionAddress } from '../core/types';

/** 管家模式（闲聊/计划）的持久化 key */
const BUTLER_PLAN_KEY = '@dsh/butlerPlan';

/** 待发送的本地附件 */
interface Draft {
  id: string;
  kind: 'image' | 'file';
  uri: string;
  name: string;
  size?: number;
  mime?: string;
}

export function ChatScreen({
  sessionId,
  title,
  butler = false,
  embedded = false,
  address,
  readOnly = false,
}: {
  sessionId: string;
  title?: string;
  /** 管家模式：空态文案 + 团队状态条 */
  butler?: boolean;
  /** 嵌在首页 tab 里（下面还有 tab 栏），底部安全区不用再留一次 */
  embedded?: boolean;
  /** 子 agent 会话要用的地址（队员事件流） */
  address?: SessionAddress;
  /** 只读（队员事件流不允许发消息） */
  readOnly?: boolean;
}) {
  const { store, baseUrl, butlerWorkspace, pickButlerWorkspace, butlerNeedWorkspace } = useApp();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [, force] = useState(0);
  const [draft, setDraft] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  // 管家模式：chat=闲聊（默认，直接回答）/ plan=计划（先对齐需求再派活）
  const [butlerMode, setButlerMode] = useState<ButlerMode>('chat');
  // 管家页顶部的「切换项目」弹层
  const [switchWs, setSwitchWs] = useState(false);
  const scrollRef = useRef<FlatList<ChatItem>>(null);
  const [nearBottom, setNearBottom] = useState(true);

  // 地址是对象，不能直接进依赖：用字符串 key 固定住
  const addressKey = address
    ? `${address.kind}:${address.kind === 'subagent' ? `${address.parentSessionId}/${address.childSessionId}` : address.sessionId}`
    : '';

  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    void store.openChat(sessionId, address);
    return () => {
      unsub();
      store.closeChat(sessionId);
    };
    // address 用 addressKey 代表，避免对象字面量导致每次重开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessionId, addressKey]);

  const chat = store.getChat(sessionId);
  const hasTeam = !!chat.agentTeam;

  // 恢复上次选的管家模式（全局一个，不按会话记）
  useEffect(() => {
    if (!butler) return;
    void (async () => {
      try {
        const saved = await AsyncStorage.getItem(BUTLER_PLAN_KEY);
        if (saved === 'plan') setButlerMode('plan');
      } catch {
        // 读不到就用默认（闲聊）
      }
    })();
  }, [butler]);

  /**
   * 切换闲聊/计划。
   *
   * 策略：**只在真正切换时补一条系统消息**，日常消息不带任何标记。
   *
   * 早先的做法是给每条用户消息尾部拼 `〔模式:闲聊〕`。问题是：
   *   · 100 轮对话就是 100 个标记，全都进上下文、进 token 计费
   *   · 模型每次都要重读一遍「现在是闲聊」，纯冗余
   *
   * 现在切换时发一条 `〔模式切换〕xxx`（fold 会滤掉，用户看不到），
   * 之后的消息就是纯用户输入。
   */
  const switchButlerMode = useCallback(
    (mode: ButlerMode) => {
      setButlerMode((prev) => {
        if (prev === mode) return prev;
        // 只在真的变了的时候发指令
        void store
          .send(sessionId, modeSwitchMessage(mode), [], 'queue')
          .catch(() => {
            // 发不出去不影响本地状态：靠下一条消息时的模式标记兜底
          });
        return mode;
      });
      void AsyncStorage.setItem(BUTLER_PLAN_KEY, mode);
    },
    [sessionId, store],
  );

  // 团队状态靠投影轮询刷新：team/* 事件不在会话日志里，拿不到增量
  useEffect(() => {
    if (!butler && !hasTeam) return;
    // 2 秒一次：团队状态和 running 都靠它刷新。
    // 之前是 5 秒，配合模型十几秒的首字延迟，用户会觉得发完消息没反应。
    const timer = setInterval(() => {
      void store.refreshChatMeta(sessionId);
    }, 2000);
    return () => clearInterval(timer);
  }, [store, sessionId, butler, hasTeam]);

  // 任务完成提示：显示第一条，5 秒后自动消
  const notice = store.teamNotices[0];
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => store.dismissNotice(notice.id), 5000);
    return () => clearTimeout(timer);
  }, [notice, store]);

  useEffect(() => {
    if (nearBottom) {
      const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
      return () => clearTimeout(timer);
    }
  }, [chat.items.length, nearBottom]);

  /**
   * 键盘弹出后把列表滚到底。
   *
   * 布局交给系统：manifest 里是 adjustResize，键盘弹出时窗口会自己缩小，
   * 输入框天然浮在键盘上方。**不要**再给容器加 marginBottom —— 那会和
   * adjustResize 叠加，把输入框顶到页面顶部去（真机上实测过）。
   * 这里只做两件小事：
   *   1. 键盘高度归零时把 paddingBottom 还原成安全区高度
   *   2. 键盘弹出后把消息列表滚到底，让用户看到最新内容
   */
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const addPicked = useCallback(async (mode: PickMode) => {
    setPickerOpen(false);
    setSendError(undefined);
    try {
      const picked = await pickAttachments(mode);
      if (picked.length === 0) return;
      const next: Draft[] = picked.map((p) => {
        const mime = p.mime ?? guessImageMime(p.name);
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          // 只有确实是图片格式的才当图片发（Host 只认 4 种图片 MIME）
          kind: mime && mime.startsWith('image/') ? 'image' : 'file',
          uri: p.uri,
          name: p.name,
          size: p.size,
          mime,
        };
      });
      setDrafts((cur) => [...cur, ...next]);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 把本地草稿变成可发送的附件（图片转 base64，文件先传上去换回执） */
  const resolveDrafts = useCallback(
    async (list: Draft[]): Promise<OutgoingAttachment[]> => {
      const out: OutgoingAttachment[] = [];
      for (const d of list) {
        if (d.kind === 'image') {
          const mediaType =
            d.mime && d.mime.startsWith('image/') ? d.mime : guessImageMime(d.name) ?? 'image/png';
          const data = await readFileBase64(d.uri);
          out.push({
            ref: {
              kind: 'image',
              attachmentId: `local-${d.id}`,
              mediaType,
              name: d.name,
              bytes: d.size,
              localUri: d.uri,
            },
            part: { type: 'image', mediaType, data, name: d.name },
          });
        } else {
          const receipt = await store.upload.uploadBinary(sessionId, d.uri, d.name);
          out.push({
            ref: {
              kind: 'file',
              attachmentId: receipt.file.attachmentId,
              name: receipt.file.name,
              bytes: receipt.file.bytes,
              localUri: d.uri,
            },
            part: { type: 'file', receiptId: receipt.receiptId },
          });
        }
      }
      return out;
    },
    [sessionId, store],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && drafts.length === 0) || sending) return;
    const pending = drafts;
    setSending(true);
    setSendError(undefined);
    setAttaching(pending.length > 0);
    setDraft('');
    setDrafts([]);
    try {
      const attachments = await resolveDrafts(pending);
      // 不再给每条消息拼 〔模式:xxx〕 —— 模式切换时已经单独发过指令了。
      // 每条都带标记会白烧 token（100 轮 = 100 个标记全进上下文）。
      await store.send(sessionId, text, attachments, 'queue');
      setNearBottom(true);
    } catch (e) {
      // 失败把草稿放回去，别让用户白选一遍
      setDraft(text);
      setDrafts(pending);
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      setAttaching(false);
    }
  }, [draft, drafts, sending, resolveDrafts, sessionId, store]);

  const renderBlocks = (blocks: Block[], keyPrefix: string) =>
    blocks.map((b, i) => {
      // 管家页只显示「人话」：工具调用留给队员事件流。
      // 但思考过程要留 —— 它在生成时可见，能明显减轻「干等着」的焦虑；
      // 跑完就自动收起成一行，不占地方。
      if (butler) {
        if (b.kind === 'text') {
          return <AssistantText key={`${keyPrefix}-t${i}`} text={b.text} sessionId={sessionId} />;
        }
        if (b.kind === 'reasoning') {
          const isLive = i === blocks.length - 1 && chat.running;
          return (
            <ButlerThinking key={`${keyPrefix}-r${i}`} text={b.text} live={isLive} />
          );
        }
        // 交付物：管家 present 出来的图片/文件，渲染成可点开的卡片
        if (b.kind === 'file') {
          return (
            <View key={`${keyPrefix}-f${i}`} style={styles.fileBlockWrap}>
              <FileCard
                path={b.path}
                alt={b.description}
                image={isImagePath(b.path)}
                sessionId={sessionId}
              />
            </View>
          );
        }
        return null;
      }
      if (b.kind === 'text') return <AssistantText key={`${keyPrefix}-t${i}`} text={b.text} sessionId={sessionId} />;
      if (b.kind === 'reasoning') {
        const isLive = i === blocks.length - 1 && chat.running;
        return <ThinkingAccordion key={`${keyPrefix}-r${i}`} text={b.text} done={!isLive} />;
      }
      if (b.kind === 'file') {
        return (
          <View key={`${keyPrefix}-f${i}`} style={styles.fileBlockWrap}>
            <FileCard
              path={b.path}
              alt={b.description}
              image={isImagePath(b.path)}
              sessionId={sessionId}
            />
          </View>
        );
      }
      return <ToolCard key={`${keyPrefix}-c${i}`} block={b} />;
    });

  // 空会话 = 还没有任何轮次、也没有内容；这种会话连不上属于正常（follow 流可能还没就绪）
  const isBlankChat = chat.turns.length === 0 && chat.items.length === 0;

  // 顶部显示的项目名（取路径最后一段）
  const butlerWsName = useMemo(() => {
    if (!butlerWorkspace) return null;
    const seg = butlerWorkspace.split(/[\\\\/]/).filter(Boolean).pop();
    return seg ?? butlerWorkspace;
  }, [butlerWorkspace]);

  // 最近一轮里还挂着的审批请求（已决的会被 fold 过滤掉）
  const pendingApprovals = useMemo(() => {
    const last = chat.turns.at(-1);
    return last?.approvals ?? [];
  }, [chat.turns]);

  // 审批网关的连/断已经上移到 App 级（见 App.tsx 的 GlobalNotices）。
  //
  // 原来在这里 connect + 卸载时 disconnect，问题有两个：
  //   1. 离开聊天页就收不到审批了（在列表页看审批时按钮点不了）
  //   2. 每次进会话都重新申请配对码，链路更长、更容易失败
  // 网关是旁路连接，常驻更稳。

  const statusLabel = chat.loading
    ? '加载中'
    : chat.running
      ? butler
        ? '管家在安排 · 你可以继续说'
        : '进行中'
      : chat.turns.length > 0
        ? `${chat.turns.length} 轮`
        : '空会话';

  return (
    <View style={styles.root}>
      <Header
        title={title ?? '对话'}
        subtitle={readOnly ? '只读 · 执行记录' : undefined}
        compact
        right={
          butler ? (
            <Pressable
              onPress={() => setSwitchWs(true)}
              hitSlop={10}
              style={({ pressed }: { pressed: boolean }) => [
                styles.wsBtn,
                pressed ? { opacity: 0.6 } : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel="切换项目"
            >
              <Text style={styles.wsBtnText} numberOfLines={1}>
                {butlerWsName ?? '选项目'}
              </Text>
              <Text style={styles.wsBtnChevron}>⌄</Text>
            </Pressable>
          ) : null
        }
      />

      {/* 管家页顶部：团队头像条（点开看谁在干什么） */}
      {butler ? <TeamStrip team={chat.agentTeam} onOpen={() => setTeamOpen(true)} /> : null}

      {/* 任务完成提示 */}
      {notice ? (
        <Pressable
          onPress={() => store.dismissNotice(notice.id)}
          style={styles.noticeBar}
          accessibilityRole="button"
          accessibilityLabel="关闭提示"
        >
          <View style={styles.noticeDot} />
          <Text style={styles.noticeText} numberOfLines={2}>
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {/* 状态行：轮次 + 模型 + 上下文 */}
      <View style={styles.statusRow}>
        <View style={styles.statusLeft}>
          {chat.running ? <ThinkingDots color={tv.colors.accent} /> : null}
          <Text
            style={[styles.statusText, chat.running && { color: tv.colors.accentBright }]}
          >
            {statusLabel}
          </Text>
        </View>
        <ModelSwitcher
          sessionId={sessionId}
          currentProvider={chat.provider}
          currentModel={chat.model}
          currentReasoningEffort={chat.reasoningEffort}
          contextUsed={chat.contextUsed}
          contextWindow={chat.contextWindow}
          tokenUsage={chat.tokenUsage}
          onChanged={() => void store.refreshChatMeta(sessionId)}
        />
      </View>

      {/* 管家模式：闲聊 / 计划（居中，仅管家页出现） */}
      {butler ? <SlideSegmented
          compact
          options={[
            { value: 'chat' as const, label: '闲聊' },
            { value: 'plan' as const, label: '计划' },
          ]}
          value={butlerMode}
          onChange={switchButlerMode}
        /> : null}

      {/* 有工具在等授权：手机端无法响应，明确告诉用户卡在哪、怎么办 */}
      <ApprovalBanner
        approvals={(store.pendingApprovals ?? []).map((a) => ({
          id: a.rpcId,
          toolName: a.toolName,
          reason: a.reason,
        }))}
        readonlyApprovals={pendingApprovals}
        gatewayOnline={store.gatewayStatus === 'online'}
        onAnswer={(a, outcome) => {
          const hit = (store.pendingApprovals ?? []).find((p) => p.rpcId === a.id);
          if (hit) store.answerApproval(hit, outcome);
        }}
      />

      {/* 加载失败必须让用户知道。
          之前这里加了「空会话且没内容就不显示」的条件，理由是「静默重试即可」——
          结果后端明明有 46 条记录、App 却只显示「空调话」，用户完全不知道为什么。
          错误信息宁可打扰，也好过让人对着空白猜。 */}
      {chat.error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText} numberOfLines={3}>
            {chat.error}
          </Text>
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/*
          ⚠️ 用 FlatList 而不是 ScrollView + map：长会话（100 轮以上）
          一次性渲染所有消息会明显卡顿。FlatList 只渲染可视区域附近的项。

          几个容易踩的点：
          1. `onContentSizeChange` 在 FlatList 里也会触发，行为一致；
          2. 自动滚到底用 `scrollToEnd`，但只在「本来就在底部」时才滚，
             否则用户往上翻历史时会被强行拽回底部；
          3. 「加载更早」按钮放在 ListHeaderComponent —— 它在列表最上方，
             和原来的视觉位置一致。
        */}
        <FlatList
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          data={chat.items}
          keyExtractor={(item: ChatItem) => item.key}
          // 长会话性能：控制首屏和每批渲染量
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          windowSize={9}
          removeClippedSubviews={false}
          onScroll={(e: {
            nativeEvent: {
              layoutMeasurement: { height: number };
              contentOffset: { y: number };
              contentSize: { height: number };
            };
          }) => {
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
            const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
            setNearBottom(distance < 80);
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (nearBottom) scrollRef.current?.scrollToEnd({ animated: false });
          }}
          ListHeaderComponent={
            chat.hasOlder ? (
              <Pressable
                style={({ pressed }: { pressed: boolean }) => [
                  styles.loadOlder,
                  pressed ? { opacity: 0.6 } : null,
                ]}
                onPress={() => void store.loadOlder(sessionId)}
                disabled={chat.loadingOlder}
              >
                {chat.loadingOlder ? (
                  <ActivityIndicator size="small" color={tv.colors.textTertiary} />
                ) : (
                  <Text style={styles.loadOlderText}>↑ 加载更早的消息</Text>
                )}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            chat.loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={tv.colors.accent} />
                <Text style={styles.loadingText}>正在读取会话…</Text>
              </View>
            ) : (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyMark}>{butler ? '◈' : '◇'}</Text>
                <Text style={styles.emptyTitle}>{butler ? '管家' : title ?? '新会话'}</Text>
                <Text style={styles.emptyText}>
                  {butler
                    ? '告诉管家你要做什么\n它会拆解任务、派给队员，再汇总给你'
                    : `在下面输入第一条消息\n指令会在电脑上执行`}
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            <>
              {chat.running ? (
                <View style={styles.liveRow}>
                  <ThinkingDots color={tv.colors.accent} size="large" />
                  <Text style={styles.liveText}>{butler ? '管家在思考…' : '继续中…'}</Text>
                </View>
              ) : null}
              <View style={{ height: space.lg }} />
            </>
          }
          renderItem={({ item }: { item: ChatItem }) => {
            if (item.kind === 'user') {
              return (
                <UserBubble
                  text={item.text}
                  time={item.time}
                  parts={item.parts}
                  sessionId={sessionId}
                  api={store.upload}
                />
              );
            }
            if (item.kind === 'divider') {
              return (
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>
                    {item.reason === 'aborted' ? '已打断' : item.reason ?? '中断'}
                  </Text>
                  <View style={styles.dividerLine} />
                </View>
              );
            }
            if (item.kind === 'teammate') {
              return <TeammateNote from={item.from} text={item.text} notice={item.notice} />;
            }
            // 派过活的那一轮：管家的汇总默认折叠，点开才看
            // （闲聊回复 delegated 为 false，直接显示，不打扰用户）
            if (item.delegated) {
              const doneCount = (chat.agentTeam?.tasks ?? []).filter(
                (t) => t.status === 'completed',
              ).length;
              return (
                <CompletionNotice taskCount={doneCount}>
                  {renderBlocks(item.blocks, item.key)}
                </CompletionNotice>
              );
            }
            return <View>{renderBlocks(item.blocks, item.key)}</View>;
          }}
        />

        {/* 输入区（队员事件流是只读的，不显示） */}
        {readOnly ? null : (
        <>
        <View
          style={[
            styles.composerWrap,
            {
              paddingBottom:
                kbHeight > 0 ? space.sm : embedded ? space.sm : Math.max(insets.bottom, space.sm),
            },
          ]}
        >
          {/* 普通聊天用底部团队条；管家模式用顶部头像条，别重复 */}
          {butler ? null : <TeamBar team={chat.agentTeam} />}

          {chat.running ? (
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [
                styles.stopBtn,
                pressed ? { opacity: 0.65 } : null,
              ]}
              onPress={() => void store.cancel(sessionId)}
            >
              <View style={styles.stopDot} />
              <Text style={styles.stopText}>打断</Text>
            </Pressable>
          ) : null}

          {sendError ? (
            <View style={styles.errRow}>
              <Text style={styles.errText} numberOfLines={2}>
                {sendError}
              </Text>
              <Pressable onPress={() => setSendError(undefined)} hitSlop={10}>
                <Text style={styles.errClose}>✕</Text>
              </Pressable>
            </View>
          ) : null}

          {/* 待发送附件：图片给缩略图，文件给 chip，都可单独删 */}
          {drafts.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.draftRail}
              style={styles.draftRailScroll}
              keyboardShouldPersistTaps="handled"
            >
              {drafts.map((d) => (
                <View key={d.id} style={styles.draftItem}>
                  {d.kind === 'image' ? (
                    <Image source={{ uri: d.uri }} style={styles.draftThumb} resizeMode="cover" />
                  ) : (
                    <View style={styles.draftFile}>
                      <Text style={styles.draftFileIcon}>▤</Text>
                      <View style={styles.draftFileBody}>
                        <Text style={styles.draftFileName} numberOfLines={1}>
                          {d.name}
                        </Text>
                        <Text style={styles.draftFileSize}>{formatBytes(d.size)}</Text>
                      </View>
                    </View>
                  )}
                  <Pressable
                    style={styles.draftRemove}
                    hitSlop={8}
                    onPress={() => setDrafts((cur) => cur.filter((x) => x.id !== d.id))}
                    accessibilityLabel={`移除 ${d.name}`}
                  >
                    <Text style={styles.draftRemoveText}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          <View style={styles.composerRow}>
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [
                styles.attachBtn,
                pressed ? { opacity: 0.6 } : null,
              ]}
              onPress={() => setPickerOpen(true)}
              disabled={sending}
              hitSlop={8}
              accessibilityLabel="添加附件"
            >
              <Text style={styles.attachIcon}>＋</Text>
            </Pressable>

            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={attaching ? '正在上传附件…' : '发消息…'}
              placeholderTextColor={tv.colors.textFaint}
              multiline
              maxLength={20000}
            />
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [
                styles.sendBtn,
                (!draft.trim() && drafts.length === 0) || sending ? styles.sendDisabled : null,
                pressed ? { opacity: 0.8 } : null,
              ]}
              onPress={() => void send()}
              disabled={(!draft.trim() && drafts.length === 0) || sending}
            >
              {sending ? (
                <ActivityIndicator color={tv.colors.bg} size="small" />
              ) : (
                <Text style={styles.sendIcon}>↑</Text>
              )}
            </Pressable>
          </View>
        </View>

        {/* 选附件：相册 / 文件 */}
        <Modal
          visible={pickerOpen}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setPickerOpen(false)}
        >
          <View style={styles.sheetBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerOpen(false)} />
            <View
              style={[
                styles.sheet,
                { paddingBottom: Math.max(insets.bottom, space.lg) },
              ]}
            >
              <View style={styles.sheetHandle} />
              <Pressable
                style={({ pressed }: { pressed: boolean }) => [
                  styles.sheetItem,
                  pressed ? { backgroundColor: tv.colors.bgRaised } : null,
                ]}
                onPress={() => void addPicked('images')}
              >
                <Text style={styles.sheetIcon}>◫</Text>
                <Text style={styles.sheetLabel}>图片</Text>
                <Text style={styles.sheetHint}>从相册选（png / jpg / gif / webp）</Text>
              </Pressable>
              <Pressable
                style={({ pressed }: { pressed: boolean }) => [
                  styles.sheetItem,
                  pressed ? { backgroundColor: tv.colors.bgRaised } : null,
                ]}
                onPress={() => void addPicked('files')}
              >
                <Text style={styles.sheetIcon}>▤</Text>
                <Text style={styles.sheetLabel}>文件</Text>
                <Text style={styles.sheetHint}>任意类型的文件</Text>
              </Pressable>
              <Pressable
                style={({ pressed }: { pressed: boolean }) => [
                  styles.sheetCancel,
                  pressed ? { opacity: 0.7 } : null,
                ]}
                onPress={() => setPickerOpen(false)}
              >
                <Text style={styles.sheetCancelText}>取消</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        </>
        )}
      </KeyboardAvoidingView>

      {/* 团队浮层：头像条点开，再点某个队员才进他的事件流 */}
      <TeamSheet
        visible={teamOpen}
        team={chat.agentTeam}
        onClose={() => setTeamOpen(false)}
        onOpenTasks={() => {
          setTeamOpen(false);
          nav.push('TaskBoard', { sessionId });
        }}
        onSelect={(member) => {
          setTeamOpen(false);
          nav.push('Subagent', {
            parentSessionId: sessionId,
            childSessionId: member.id,
            title: member.name,
          });
        }}
      />

      {/* 切换管家项目：换项目 = 换会话 = 换一套队员，上下文不会串 */}
      <ButlerWorkspacePicker
        visible={switchWs}
        workspaces={store.workspaces}
        allowCancel
        onCancel={() => setSwitchWs(false)}
        onPick={(path) => {
          setSwitchWs(false);
          pickButlerWorkspace(path);
        }}
      />
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    flex: { flex: 1 },

    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 40,
      paddingHorizontal: layout.screenPadding,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
    },
    statusLeft: { flexDirection: 'row', alignItems: 'center' },
    statusText: { color: C.textTertiary, fontSize: type.xs, marginLeft: 2 },

    noticeBar: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: layout.screenPadding,
      marginTop: 6,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.md,
      backgroundColor: C.successWash,
    },
    noticeDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: C.success,
      marginRight: space.sm,
    },
    noticeText: { flex: 1, color: C.success, fontSize: type.xs },
    errorBar: {
      backgroundColor: C.dangerWash,
      paddingHorizontal: layout.screenPadding,
      paddingVertical: space.sm,
    },
    errorText: { color: C.danger, fontSize: type.xs },

    scroll: { flex: 1 },
    scrollContent: { paddingTop: space.md, paddingBottom: space.md },
    loadOlder: { alignItems: 'center', paddingVertical: space.md },
    loadOlderText: { color: C.textTertiary, fontSize: type.xs },

    loadingBox: { alignItems: 'center', paddingVertical: space.xxxl },
    loadingText: { color: C.textTertiary, fontSize: type.sm, marginTop: space.md },
    emptyBox: { alignItems: 'center', paddingTop: 120, paddingHorizontal: space.xxl },
    emptyMark: { color: C.textFaint, fontSize: 40, marginBottom: space.lg },
    emptyTitle: {
      color: C.text,
      fontSize: type.xl,
      fontWeight: weight.semibold,
      marginBottom: space.sm,
      textAlign: 'center',
      letterSpacing: -0.3,
    },
    emptyText: {
      color: C.textTertiary,
      fontSize: type.sm,
      textAlign: 'center',
      lineHeight: type.sm * 1.6,
    },

    divider: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: layout.screenPadding * 2,
      marginVertical: space.lg,
    },
    dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.border },
    dividerText: { color: C.textFaint, fontSize: type.micro, marginHorizontal: space.sm },

    liveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: layout.screenPadding + 2,
      paddingVertical: space.sm,
    },
    liveText: { color: C.textTertiary, fontSize: type.xs, marginLeft: 6 },

    // 顶栏「切换项目」
    wsBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: 130,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.pill ?? 14,
      backgroundColor: C.bgCard,
    },
    wsBtnText: { color: C.textSecondary, fontSize: type.xs, flexShrink: 1 },
    wsBtnChevron: { color: C.textFaint, fontSize: type.micro, marginLeft: 3 },

    // 交付物卡片（assistant present 出来的文件）
    fileBlockWrap: { paddingHorizontal: layout.screenPadding },

    composerWrap: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
      paddingTop: space.sm,
      backgroundColor: C.bg,
    },
    stopBtn: {
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingVertical: 6,
      marginBottom: space.sm,
      borderRadius: radius.pill,
      backgroundColor: C.dangerWash,
    },
    stopDot: {
      width: 6,
      height: 6,
      borderRadius: 1.5,
      backgroundColor: C.danger,
      marginRight: 6,
    },
    stopText: { color: C.danger, fontSize: type.xs, fontWeight: weight.medium },

    composerRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: layout.screenPadding,
    },
    attachBtn: {
      width: 36,
      height: layout.composerMinHeight,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 2,
    },
    attachIcon: { color: C.textTertiary, fontSize: 24, fontWeight: weight.regular, marginTop: -2 },

    // ── 待发送附件 ────────────────────────────────────────────────
    draftRail: {
      paddingHorizontal: layout.screenPadding,
      paddingBottom: space.sm,
      alignItems: 'flex-end',
    },
    // 横向 ScrollView 在列容器里不加这个会被撑高
    draftRailScroll: { flexGrow: 0 },
    draftItem: { marginRight: space.sm },
    draftThumb: {
      width: 62,
      height: 62,
      borderRadius: radius.md,
      backgroundColor: C.bgOverlay,
    },
    draftFile: {
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: 200,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
    },
    draftFileIcon: { color: C.accentBright, fontSize: 16, marginRight: space.sm },
    draftFileBody: { flexShrink: 1 },
    draftFileName: { color: C.text, fontSize: type.xs, fontWeight: weight.medium },
    draftFileSize: { color: C.textFaint, fontSize: type.micro },
    draftRemove: {
      position: 'absolute',
      top: -6,
      right: -6,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: C.text,
      alignItems: 'center',
      justifyContent: 'center',
    },
    draftRemoveText: { color: C.bg, fontSize: 11, fontWeight: weight.bold },

    errRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: layout.screenPadding,
      marginBottom: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.md,
      backgroundColor: C.dangerWash,
    },
    errText: { flex: 1, color: C.danger, fontSize: type.xs },
    errClose: { color: C.danger, fontSize: type.sm, marginLeft: space.sm },

    // ── 附件选择弹层 ──────────────────────────────────────────────
    sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: C.scrim },
    sheet: {
      backgroundColor: C.bg,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingTop: space.sm,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.borderStrong,
      marginBottom: space.md,
    },
    sheetItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: layout.screenPadding,
      paddingVertical: space.lg,
    },
    sheetIcon: {
      width: 34,
      color: C.accentBright,
      fontSize: 20,
      textAlign: 'center',
    },
    sheetLabel: { color: C.text, fontSize: type.base, fontWeight: weight.medium, width: 56 },
    sheetHint: { color: C.textFaint, fontSize: type.xs, flex: 1 },
    sheetCancel: {
      marginTop: space.sm,
      marginHorizontal: layout.screenPadding,
      paddingVertical: space.md,
      borderRadius: radius.md,
      backgroundColor: C.bgRaised,
      alignItems: 'center',
    },
    sheetCancelText: { color: C.textSecondary, fontSize: type.base },
    input: {
      flex: 1,
      minHeight: layout.composerMinHeight,
      maxHeight: layout.composerMaxHeight,
      backgroundColor: C.bgRaised,
      borderRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      color: C.text,
      fontSize: type.base,
      lineHeight: type.base * 1.4,
      paddingHorizontal: space.lg,
      paddingTop: Platform.OS === 'ios' ? 12 : 10,
      paddingBottom: Platform.OS === 'ios' ? 12 : 10,
      marginRight: space.sm,
    },
    sendBtn: {
      width: layout.composerMinHeight,
      height: layout.composerMinHeight,
      borderRadius: layout.composerMinHeight / 2,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendDisabled: { backgroundColor: C.bgOverlay },
    sendIcon: { color: C.onAccent, fontSize: 20, fontWeight: weight.bold, marginTop: -2 },
  });
}
