// Device-registry path resolution for the mobile gateway.
//
// The gateway stores paired-device credentials, its own installation identity
// and its Cloudflare state under one data directory. That directory must be the
// same root the rest of DeepSeek Harness uses, otherwise an instance launched
// with an isolated `$DSH_HOME` silently reads and writes the operator's real
// device registry.
//
// Precedence mirrors `@deepseek-ai/dsh-home-paths` (`resolveDshHome`):
//   explicit configuration > non-blank `$DSH_HOME` > `~/.dsh`
// A whitespace-only `$DSH_HOME` counts as unset so a blank override can never
// resolve the registry into the current working directory.
//
// The helper is deliberately self-contained: the plugin is also installed
// outside a Harness tree, where the core package is not resolvable.
import os from 'node:os'
import path from 'node:path'

export const DSH_HOME_ENV = 'DSH_HOME'
export const DSH_HOME_DIR_NAME = '.dsh'
export const DEVICE_REGISTRY_NAME = 'mobile-gateway-devices.json'

function expandHomePath(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** Resolve the Harness data root: `$DSH_HOME` when set, else `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const fromEnv = env[DSH_HOME_ENV]
  const root = typeof fromEnv === 'string' && fromEnv.trim().length > 0
    ? expandHomePath(fromEnv)
    : path.join(os.homedir(), DSH_HOME_DIR_NAME)
  return path.resolve(root)
}

/**
 * Resolve the paired-device registry file.
 *
 * An explicit `deviceFile` is returned verbatim, exactly as before, so existing
 * configurations (including relative paths) keep their current spelling and
 * their derived `.gateway.json` / `.cloudflare.json` siblings.
 */
export function resolveDeviceFile(options = {}, env = process.env) {
  const explicit = options.deviceFile
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return path.join(resolveDshHome(env), DEVICE_REGISTRY_NAME)
}