/**
 * Historical attachment data URIs, isolated by UploadApi object identity.
 * Limits apply across all API instances. Successful entries use LRU eviction;
 * failures evict in insertion order so automatic loads do not retry indefinitely.
 */
import type { UploadApi } from './rpc/upload';

export const IMAGE_CACHE_LIMITS = Object.freeze({
  maxEntries: 32,
  // Conservative UTF-16 estimate: two bytes per data URI character, including prefix.
  maxBytes: 24 * 1024 * 1024,
  maxFailures: 128,
});

const scopes = new WeakMap<UploadApi, number>();
let nextScope = 0;
const uris = new Map<string, string>();
let retainedBytes = 0;
const failed = new Set<string>();
const inflight = new Map<string, Promise<string | undefined>>();

function keyOf(api: UploadApi, sessionId: string, attachmentId: string): string {
  let scope = scopes.get(api);
  if (scope === undefined) {
    scope = nextScope++;
    scopes.set(api, scope);
  }
  // Tuple encoding avoids collisions when either ID contains a delimiter.
  return JSON.stringify([scope, sessionId, attachmentId]);
}

function forgetUri(key: string): void {
  const uri = uris.get(key);
  if (uri !== undefined) {
    retainedBytes -= uri.length * 2;
    uris.delete(key);
  }
}

function getUri(key: string): string | undefined {
  const uri = uris.get(key);
  if (uri !== undefined) {
    uris.delete(key);
    uris.set(key, uri);
  }
  return uri;
}

function retainUri(key: string, uri: string): void {
  forgetUri(key);
  const bytes = uri.length * 2;
  // Oversized successes are still returned to the caller, without evicting useful entries.
  if (bytes > IMAGE_CACHE_LIMITS.maxBytes) return;
  while (
    uris.size >= IMAGE_CACHE_LIMITS.maxEntries ||
    retainedBytes + bytes > IMAGE_CACHE_LIMITS.maxBytes
  ) {
    forgetUri(uris.keys().next().value!);
  }
  uris.set(key, uri);
  retainedBytes += bytes;
}

/**
 * Synchronous lookup. Pass the same API object used for loading.
 * Legacy calls without api remain valid but return a miss to prevent cross-connection reads.
 */
export function cachedImageUri(
  sessionId: string,
  attachmentId: string,
  api?: UploadApi,
): string | undefined {
  return api ? getUri(keyOf(api, sessionId, attachmentId)) : undefined;
}

/** Legacy calls without api return false; failures are connection-scoped too. */
export function imageFailed(attachmentId: string, sessionId: string, api?: UploadApi): boolean {
  return api ? failed.has(keyOf(api, sessionId, attachmentId)) : false;
}

/**
 * Return a data URI, or undefined on failure. Automatic loads reuse successes and
 * suppress retained failures. Explicit retry bypasses both, but joins an active load.
 */
export function loadImageUri(
  api: UploadApi,
  sessionId: string,
  attachmentId: string,
  options?: { retry?: boolean },
): Promise<string | undefined> {
  const key = keyOf(api, sessionId, attachmentId);
  const running = inflight.get(key);
  if (running) return running;

  if (options?.retry) {
    forgetUri(key);
    failed.delete(key);
  } else {
    const hit = getUri(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (failed.has(key)) return Promise.resolve(undefined);
  }

  // Defer the API call until pending is registered; synchronous throws become failures too.
  const p: Promise<string | undefined> = Promise.resolve()
    .then(() => api.readAttachment(sessionId, attachmentId))
    .then(({ mediaType, data }) => {
      const uri = `data:${mediaType};base64,${data}`;
      if (inflight.get(key) === p) {
        failed.delete(key);
        retainUri(key, uri);
      }
      return uri;
    })
    .catch(() => {
      if (inflight.get(key) === p) {
        failed.add(key);
        if (failed.size > IMAGE_CACHE_LIMITS.maxFailures) {
          failed.delete(failed.values().next().value!);
        }
      }
      return undefined;
    })
    .finally(() => {
      // Only this request can publish or clear its pending state.
      if (inflight.get(key) === p) inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}
