/**
 * 启动前的全局设置。
 *
 * 必须在 `App` 之前 import：配对页用 RN 核心的 `Clipboard` 读剪贴板，
 * 它在模块求值时就打废弃警告，晚于这里调用 ignoreLogs 就屏蔽不掉了。
 */
import { LogBox } from 'react-native';

LogBox.ignoreLogs(['Clipboard has been extracted']);
