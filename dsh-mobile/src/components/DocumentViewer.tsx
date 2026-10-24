/**
 * 内置文档查看器。
 *
 * 覆盖：
 *   - `.md`            直接当 markdown 渲染
 *   - `.docx`          mammoth 转 HTML → 自己解析成文本块渲染（保留标题/列表/表格）
 *   - `.xlsx` / `.xls` SheetJS 读成二维数组，按 sheet 分页显示
 *   - `.csv`           同 xlsx 路径
 *
 * 不做的：
 *   - `.doc` / `.ppt` / `.pptx`  → 仍交给系统应用。doc 是二进制老格式，
 *     mammoth 只吃 docx；PPT 是幻灯片布局，纯前端排版成本极高。
 *   - 图片 → 走 ImageViewer，不走这里。
 *
 * 为什么不用 WebView 显示 HTML：
 *   RN 项目里目前没有 react-native-webview，为一个 docx 预览引它不值当
 *   （多一个原生依赖 + 体积）。mammoth 转出来的 HTML 结构简单，
 *   直接解析成块渲染更轻。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ReactNativeBlobUtil from 'react-native-blob-util';

import { useTheme } from '../design/theme';
import { MarkdownView } from './MarkdownView';

export { docKindOf, canPreviewInside } from '../core/docx';
import { docKindOf, canPreviewInside, docxHtmlToBlocks, type DocxBlock } from '../core/docx';

// ── 查看器 ──────────────────────────────────────────────────────────

type LoadState =
  | { phase: 'loading' }
  | { phase: 'md'; text: string }
  | { phase: 'docx'; blocks: DocxBlock[] }
  | { phase: 'sheet'; sheets: { name: string; rows: string[][] }[] }
  | { phase: 'error'; message: string };

export function DocumentViewer({
  visible,
  file,
  onClose,
}: {
  visible: boolean;
  /** 本地缓存路径（file:// 前缀可有可无）+ 文件名 */
  file: { uri: string; name: string } | null;
  onClose: () => void;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [sheetIndex, setSheetIndex] = useState(0);

  const kind = file ? docKindOf(file.name) : 'unsupported';
  const fsPath = file?.uri.replace(/^file:\/\//, '') ?? '';
  const fileName = file?.name ?? '';

  // ⚠️ 下面这个 effect 的依赖里**不能直接放 `file` 对象**。
  //
  // 父组件只要重渲染一次（哪怕内容完全没变），`file={{...}}`
  // 也是新引用 → effect 重跑 → 重新读文件、重新解析 docx →
  // 界面在 loading 和内容之间反复切换。
  // 用户看到的就是「打开 word 后每隔几秒重新加载一次，阅读时一直闪」。
  //
  // 所以只依赖标量值：fsPath（字符串）和 kind（字符串字面量）。
  // 父组件那边也用 useMemo 稳定了引用，这里是第二道保险。
  useEffect(() => {
    if (!visible || !fsPath) return;
    let alive = true;
    setState({ phase: 'loading' });
    setSheetIndex(0);

    void (async () => {
      try {
        if (kind === 'md') {
          const text = await ReactNativeBlobUtil.fs.readFile(fsPath, 'utf8');
          if (alive) setState({ phase: 'md', text: String(text) });
          return;
        }

        if (kind === 'docx') {
          // mammoth 内部用 TextDecoder 解 XML，而 Hermes 没这个 API。
          // 必须先装 polyfill，否则报 `Property 'TextDecoder' doesn't exist`。
          const { installTextDecoderPolyfill } = await import('../core/textdecoder');
          installTextDecoderPolyfill();

          // 用 base64 读，再转 ArrayBuffer 给 mammoth
          const b64 = await ReactNativeBlobUtil.fs.readFile(fsPath, 'base64');
          const bin = atob(String(b64));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          const mammoth = await import('mammoth');
          const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
          if (alive) setState({ phase: 'docx', blocks: docxHtmlToBlocks(res.value) });
          return;
        }

        if (kind === 'sheet') {
          // ⚠️ 必须用 `xlsx/dist/xlsx.mini.min.js`，不能用包主入口 `xlsx`。
          //
          // 主入口会 `require('./dist/cpexcel.js')` 加载一整张代码页表，
          // 而 Metro 打不散那个动态 require，运行时报
          //   Requiring unknown module "867"
          // mini 版不含 cpexcel（245 KB vs 861 KB），也不依赖它，
          // 而且我们只需要「读 xlsx、转二维数组」，mini 完全够。
          const b64 = await ReactNativeBlobUtil.fs.readFile(fsPath, 'base64');
          const XLSX = await import('xlsx/dist/xlsx.mini.min.js');
          const lib = (XLSX as { default?: unknown }).default ?? XLSX;
          const wb = (lib as typeof import('xlsx')).read(String(b64), { type: 'base64' });
          const sheets = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name];
            const rows = (lib as typeof import('xlsx')).utils.sheet_to_json<string[]>(ws, {
              header: 1,
              raw: false,
              defval: '',
            }) as string[][];
            return { name, rows };
          });
          if (alive) setState({ phase: 'sheet', sheets });
          return;
        }

        if (alive) setState({ phase: 'error', message: '这种格式暂不支持内置查看' });
      } catch (e) {
        if (alive) {
          setState({
            phase: 'error',
            message: e instanceof Error ? e.message : '读取失败',
          });
        }
      }
    })();

    return () => {
      alive = false;
    };
    // 只依赖标量，不依赖 file 对象引用（见上面的注释）
  }, [visible, fsPath, kind]);

  if (!visible || !file) return null;

  const title = file.name;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* 顶栏 */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.backBtn}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.backBtn} />
        </View>

        {/* 内容 */}
        {state.phase === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={tv.colors.accent} />
            <Text style={styles.hint}>正在打开…</Text>
          </View>
        ) : state.phase === 'error' ? (
          <View style={styles.center}>
            <Text style={styles.errorIcon}>⚠</Text>
            <Text style={styles.errorText}>{state.message}</Text>
            <Text style={styles.hint}>可以点下面的按钮用系统应用打开</Text>
          </View>
        ) : state.phase === 'md' ? (
          <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
            <MarkdownView text={state.text} />
          </ScrollView>
        ) : state.phase === 'docx' ? (
          <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
            <DocxBlocksView blocks={state.blocks} />
          </ScrollView>
        ) : (
          <SheetView
            sheets={state.sheets}
            index={sheetIndex}
            onIndex={setSheetIndex}
            bottomInset={insets.bottom}
          />
        )}
      </View>
    </Modal>
  );
}

function DocxBlocksView({ blocks }: { blocks: DocxBlock[] }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  if (blocks.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>这个文档里没有可显示的文本</Text>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: tv.layout.screenPadding }}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          const size =
            b.level === 1 ? tv.type.xl : b.level === 2 ? tv.type.lg : tv.type.base;
          return (
            <Text key={i} style={[styles.heading, { fontSize: size }]}>
              {b.text}
            </Text>
          );
        }
        if (b.kind === 'list') {
          return (
            <View key={i} style={{ marginVertical: 6 }}>
              {b.items.map((it, j) => (
                <View key={j} style={styles.listRow}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.para}>{it}</Text>
                </View>
              ))}
            </View>
          );
        }
        if (b.kind === 'table') {
          return (
            <View key={i} style={styles.table}>
              {b.rows.map((r, ri) => (
                <View key={ri} style={[styles.tr, ri === 0 ? styles.thead : null]}>
                  {r.map((c, ci) => (
                    <Text
                      key={ci}
                      style={[styles.td, ri === 0 ? styles.th : null]}
                      numberOfLines={4}
                    >
                      {c}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={i} style={styles.para}>
            {b.text}
          </Text>
        );
      })}
    </View>
  );
}

function SheetView({
  sheets,
  index,
  onIndex,
  bottomInset,
}: {
  sheets: { name: string; rows: string[][] }[];
  index: number;
  onIndex: (i: number) => void;
  bottomInset: number;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const sheet = sheets[index];

  if (!sheet || sheet.rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>这个表格是空的</Text>
      </View>
    );
  }

  // 列宽：按列数均分，最少 90 保证能看清
  const colW = Math.max(90, Math.floor(SCREEN_W / Math.max(sheet.rows[0].length, 1)));

  return (
    <View style={{ flex: 1 }}>
      {/* sheet 切换 */}
      {sheets.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.sheetTabs}
          contentContainerStyle={{ paddingHorizontal: tv.layout.screenPadding, gap: 8 }}
        >
          {sheets.map((s, i) => (
            <Pressable
              key={s.name}
              onPress={() => onIndex(i)}
              style={[styles.sheetTab, i === index ? styles.sheetTabOn : null]}
            >
              <Text
                style={[
                  styles.sheetTabText,
                  i === index ? styles.sheetTabTextOn : null,
                ]}
                numberOfLines={1}
              >
                {s.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {/* 表格本体：双向滚动 */}
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <ScrollView contentContainerStyle={{ paddingBottom: bottomInset + 24 }}>
          <View>
            {sheet.rows.map((r, ri) => (
              <View key={ri} style={[styles.tr, ri === 0 ? styles.thead : null]}>
                {(r.length ? r : ['']).map((c, ci) => (
                  <Text
                    key={ci}
                    style={[
                      styles.td,
                      ri === 0 ? styles.th : null,
                      { width: colW },
                    ]}
                    numberOfLines={6}
                  >
                    {c === '' ? ' ' : String(c)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const SCREEN_W = Dimensions.get('window').width;

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
    },
    backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { fontSize: 30, color: C.accent, lineHeight: 34 },
    title: {
      flex: 1,
      textAlign: 'center',
      color: C.text,
      fontSize: tv.type.base,
      fontWeight: tv.weight.medium,
    },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    hint: { color: C.textTertiary, fontSize: tv.type.sm, marginTop: 10, textAlign: 'center' },
    errorIcon: { fontSize: 40, color: C.danger, marginBottom: 10 },
    errorText: { color: C.text, fontSize: tv.type.sm, textAlign: 'center' },
    heading: {
      color: C.text,
      fontWeight: tv.weight.semibold,
      marginTop: tv.space.md,
      marginBottom: tv.space.xs,
    },
    para: {
      color: C.text,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.55,
      marginVertical: 3,
    },
    listRow: { flexDirection: 'row', marginVertical: 2 },
    bullet: {
      color: C.textSecondary,
      fontSize: tv.type.base,
      lineHeight: tv.type.base * 1.55,
      width: 18,
    },
    table: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      borderRadius: tv.radius.sm,
      overflow: 'hidden',
      marginVertical: tv.space.sm,
    },
    tr: { flexDirection: 'row' },
    thead: { backgroundColor: C.bgCard },
    th: { fontWeight: tv.weight.semibold },
    td: {
      color: C.text,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.45,
      paddingHorizontal: 6,
      paddingVertical: 5,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    sheetTabs: { flexGrow: 0, paddingVertical: 8 },
    sheetTab: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgCard,
      maxWidth: 160,
    },
    sheetTabOn: { backgroundColor: C.accent },
    sheetTabText: { color: C.textSecondary, fontSize: tv.type.xs },
    sheetTabTextOn: { color: C.bg },
  });
}
