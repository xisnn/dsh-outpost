import { AppRegistry } from 'react-native';

// 必须排在 App 之前：里面设置了 LogBox 过滤，晚于 App 模块求值就没用了
import './src/setup';
import App from './src/App';

// 必须与 android/app/src/main/java/.../MainActivity.kt 里的
// getMainComponentName() 完全一致，否则会报
// "DshPocket has not been registered"。
AppRegistry.registerComponent('DshPocket', () => App);
