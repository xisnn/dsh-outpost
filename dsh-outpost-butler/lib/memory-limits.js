/** P4 memory limits shared by the store (pure tests) and the storage domain. */
export const MEMORY_KINDS = ['preference', 'project'];
export const MEMORY_LIMITS = { entries: 64, key: 64, value: 2048, history: 64 };
export const MEMORY_ID_PATTERN = /^mem-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BUTLER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
