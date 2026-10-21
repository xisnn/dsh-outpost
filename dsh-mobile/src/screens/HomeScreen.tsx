/**
 * 首页：底部 tab 容器。
 *
 * 两种形态：
 *  - 普通模式：工作区 | 我的
 *  - 管家模式：管家 | 我的（首页直接就是跟管家的对话，工作区列表退到「我的」里）
 *
 * 两个 pane 都**常驻挂载**，只用 display:none 隐藏：
 * 这样切回来滚动位置不丢，而且「我的」的余额/用量在后台就预取好了，
 * 点进去是现成的（余额接口要 2-5 秒，不然每次都要看转圈）。
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { TabBar, type HomeTab } from '../components/TabBar';
import { useTheme } from '../design/theme';
import { ButlerWorkspacePicker } from '../components/ButlerWorkspacePicker';
import { useApp } from '../App';
import { useNav } from '../nav/NavHost';
import { ChatScreen } from './ChatScreen';
import { ProfileScreen } from './ProfileScreen';
import { WorkspacesScreen } from './WorkspacesScreen';

/** 管家会话还没建好时的占位 */
function ButlerBoot({ busy }: { busy: boolean }) {
  const tv = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: tv.colors.bg }]}>
      {busy ? <ActivityIndicator color={tv.colors.accent} /> : null}
      <Text style={[styles.bootText, { color: tv.colors.textTertiary }]}>
        {busy ? '正在准备管家…' : '管家还没有准备好，去「我的」里重试一次'}
      </Text>
    </View>
  );
}

export function HomeScreen() {
  const tv = useTheme();
  const {
    butlerMode,
    butlerSessionId,
    butlerBusy,
    butlerNeedWorkspace,
    pickButlerWorkspace,
    store,
  } = useApp();
  const [tab, setTab] = useState<HomeTab>(butlerMode ? 'butler' : 'workspaces');

  // 模式切换时校正当前 tab（「我的」保留，其余落到该模式的首个 tab）
  useEffect(() => {
    setTab((cur) => {
      if (cur === 'me') return 'me';
      return butlerMode ? 'butler' : 'workspaces';
    });
  }, [butlerMode]);

  // 点了通知横幅 → 跳到对应会话。
  // 通知在 NavHost 外面渲染，拿不到 nav，所以走 store 传一个「请求」过来。
  const nav = useNav();
  useEffect(() => {
    const consume = () => {
      const sid = store.consumeOpenSession();
      if (sid) nav.push('Chat', { sessionId: sid });
    };
    // 挂载时先检查一次（可能在别的页面点的通知）
    consume();
    const unsub = store.subscribe(consume);
    return unsub;
  }, [store, nav]);

  const tabs: HomeTab[] = butlerMode ? ['butler', 'me'] : ['workspaces', 'me'];

  return (
    <View style={[styles.root, { backgroundColor: tv.colors.bg }]}>
      {/**
       * 首次开启管家模式、还没绑项目时，这里负责让用户选。
       * 注意：这个弹层只在「管家的 ChatScreen 还没挂载」时用 ——
       * 会话建好后，切项目由 ChatScreen 顶栏那个按钮负责。
       * 两处都挂就会出现两个 Modal 互相挡触摸（用户点了没反应）。
       */}
      <ButlerWorkspacePicker
        visible={butlerMode && !butlerSessionId && butlerNeedWorkspace}
        workspaces={store.workspaces}
        onPick={pickButlerWorkspace}
        onCancel={() => {}}
      />
      <View style={styles.body}>
        {butlerMode ? (
          <View style={[styles.pane, tab === 'butler' ? null : styles.hidden]}>
            {butlerSessionId ? (
              <ChatScreen
                // key 必须跟着 sessionId 变：切项目时会换成另一个会话，
                // 不加 key 的话 React 复用同一个实例，内部 state（滚动位置、
                // 草稿、展开状态）会串到新会话上。
                key={String(butlerSessionId)}
                sessionId={String(butlerSessionId)}
                title="DSH"
                butler
                embedded
              />
            ) : (
              <ButlerBoot busy={butlerBusy} />
            )}
          </View>
        ) : (
          <View style={[styles.pane, tab === 'workspaces' ? null : styles.hidden]}>
            <WorkspacesScreen />
          </View>
        )}
        <View style={[styles.pane, tab === 'me' ? null : styles.hidden]}>
          <ProfileScreen active={tab === 'me'} />
        </View>
      </View>
      <TabBar tab={tab} onChange={setTab} items={tabs} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  pane: { flex: 1 },
  hidden: { display: 'none' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  bootText: { fontSize: 13, marginTop: 12, textAlign: 'center' },
});
