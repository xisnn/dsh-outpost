/**
 * Debug-only P0 confirmation isolation and one-shot response-loss injection.
 * Every call site is guarded by `__DEV__`; release behavior is unchanged.
 */
const blocked = new Set<string>();
const dropOnce = new Set<string>();

export function armP0TestRequest(requestId: string, dropResponseOnce: boolean): void {
  blocked.add(requestId);
  if (dropResponseOnce) dropOnce.add(requestId);
  else dropOnce.delete(requestId);
}

/** Returns true at most once for a given requestId. */
export function shouldDropP0Response(requestId: string): boolean {
  if (!dropOnce.has(requestId)) return false;
  dropOnce.delete(requestId);
  return true;
}

export function blockP0Confirmation(requestId: string): void {
  blocked.add(requestId);
}

export function unblockP0Confirmation(requestId: string): void {
  blocked.delete(requestId);
}

export function isP0ConfirmationBlocked(requestId: string): boolean {
  return blocked.has(requestId);
}

export function clearP0TestState(): void {
  blocked.clear();
  dropOnce.clear();
}
