import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const [ndk, destination, architectures] = process.argv.slice(2);
if (!ndk || !destination || !architectures) throw Error('Expected NDK, output directory and ABI list');
const targets = {'armeabi-v7a': 'armv7a-linux-androideabi24', 'arm64-v8a': 'aarch64-linux-android24', x86: 'i686-linux-android24', x86_64: 'x86_64-linux-android24'};
const host = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const clang = path.join(ndk, 'toolchains/llvm/prebuilt', host, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
const source = fileURLToPath(new URL('../android/app/src/main/cpp/runtime-runner.c', import.meta.url));
for (const abi of architectures.split(',')) {
  if (!targets[abi]) throw Error('Unsupported ABI');
  const directory = path.join(destination, abi);fs.mkdirSync(directory, {recursive: true});
  execFileSync(clang, [`--target=${targets[abi]}`, '-std=c11', '-O2', '-fPIE', '-pie', '-Wall', '-Wextra', '-Werror', '-Wl,-z,max-page-size=16384', source, '-o', path.join(directory, 'libdsh-runtime-runner.so')], {stdio: 'inherit'});
}
