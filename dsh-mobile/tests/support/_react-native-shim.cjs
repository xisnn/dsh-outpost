/**
 * `react-native` 的 Node 替身。
 *
 * ## 为什么需要
 *
 * 产品代码里有些模块直接 import react-native（`notify.ts` 要 AppState /
 * Vibration、`updater.ts` 要 Linking / Platform、`fileSave.ts` 要
 * Share / Platform）。
 *
 * 而 react-native 的入口是 **Flow 语法**，Node 的转译器（esbuild/tsx）
 * 解析不了，直接 `import` 会报：
 *
 *     react-native/index.js:27:7: ERROR: Unexpected "typeof"
 *
 * 所以测试里必须把它重定向到这个替身。
 *
 * ## 只实现测试用得到的部分
 *
 * 原则：**不实现产品逻辑**。这里每一个函数都只是「不报错 + 返回一个
 * 合理的空值」，让业务流程能跑通。任何依赖真实 RN 行为的东西都要在
 * 真机上验证 —— 这个文件的存在不代表那些行为被测过。
 */

const noop = () => undefined;

/** 模拟 AppState：测试里不会真的切前后台，固定 active */
const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: noop }),
  removeEventListener: noop,
};

/** 模拟 Platform */
const Platform = {
  OS: 'android',
  Version: 34,
  select: (obj) => (obj && 'android' in obj ? obj.android : obj && obj.default),
  constants: {},
};

/** 模拟 Share —— 只记录最后一次调用，供断言用 */
const shareCalls = [];
const Share = {
  async share(content) {
    shareCalls.push(content);
    return { action: 'sharedAction' };
  },
  dismissedAction: 'dismissedAction',
  sharedAction: 'sharedAction',
  __calls: shareCalls,
  __reset() {
    shareCalls.length = 0;
  },
};

/** 模拟 Vibration */
const vibrateCalls = [];
const Vibration = {
  vibrate(pattern) {
    vibrateCalls.push(pattern);
  },
  cancel: noop,
  __calls: vibrateCalls,
  __reset() {
    vibrateCalls.length = 0;
  },
};

/** 模拟 Linking */
const openCalls = [];
const Linking = {
  async openURL(url) {
    openCalls.push(url);
    return true;
  },
  async canOpenURL() {
    return true;
  },
  addEventListener: () => ({ remove: noop }),
  __calls: openCalls,
  __reset() {
    openCalls.length = 0;
  },
};

/** 模拟 Dimensions */
const Dimensions = {
  get: () => ({ width: 1080, height: 2400, scale: 2.75, fontScale: 1 }),
  addEventListener: () => ({ remove: noop }),
};

/** 模拟 Alert —— 记录调用，供断言 */
const alertCalls = [];
const Alert = {
  alert(title, message, buttons) {
    alertCalls.push({ title, message, buttons });
  },
  __calls: alertCalls,
  __reset() {
    alertCalls.length = 0;
  },
};

/**
 * StyleSheet —— 必须真的把样式对象**摊平**返回。
 *
 * 产品代码会读 `styles.foo` 然后传给组件。如果这里返回 undefined，
 * 一些运行时逻辑（比如读 padding 算布局）会崩。直接原样返回最省事。
 */
const StyleSheet = {
  create: (obj) => obj,
  flatten: (s) => (Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s),
  hairlineWidth: 1,
  absoluteFill: {},
  absoluteFillObject: {},
};

module.exports = {
  AppState,
  Alert,
  Dimensions,
  Linking,
  Platform,
  Share,
  StyleSheet,
  Vibration,
  // 组件在 Node 里不会被渲染，给个占位即可
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  TextInput: 'TextInput',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  RefreshControl: 'RefreshControl',
  Switch: 'Switch',
  FlatList: 'FlatList',
  // 常用工具
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: noop };
    }
    removeAllListeners() {}
  },
  Animated: {
    Value: class {
      constructor(v) {
        this.v = v;
      }
      setValue() {}
      interpolate() {
        return this;
      }
      addListener() {
        return { remove: noop };
      }
    },
    ValueXY: class {
      constructor() {
        this.x = { setValue() {} };
        this.y = { setValue() {} };
      }
      setValue() {}
      setOffset() {}
      flattenOffset() {}
      extractOffset() {}
    },
    timing: () => ({ start: (cb) => cb && cb({ finished: true }) }),
    spring: () => ({ start: (cb) => cb && cb({ finished: true }) }),
    createAnimatedComponent: (c) => c,
    event: () => noop,
  },
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 1080, height: 2400, scale: 2.75, fontScale: 1 }),
  // 让 `import * as RN` 也能取到 default
  default: {},
};
