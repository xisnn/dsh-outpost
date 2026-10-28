/**
 * Debug-only P0 confirmation isolation. The module is inert in release builds:
 * every call site is guarded by `__DEV__`; production confirmation is unchanged.
 */
const blocked = new Set<string>();

export function blockP0Confirmation(requestId: string): void {
  blocked.add(requestId);
}

export function unblockP0Confirmation(requestId: string): void {
  blocked.delete(requestId);
}

export function isP0ConfirmationBlocked(requestId: string): boolean {
  return blocked.has(requestId);
}

export function clearP0Confirmations(): void {
  blocked.clear();
}
