// Rurea production entry (agent-first). Selected via -PDSH_RUREA_ENTRY=index.rurea.js.
// The default dsh entry remains index.js (unchanged); this is the decoupled Rurea shell.
import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import './src/setup';
import RureaApp from './src/rurea/RureaApp';

// Must match MainActivity.getMainComponentName().
AppRegistry.registerComponent('DshPocket', () => RureaApp);
