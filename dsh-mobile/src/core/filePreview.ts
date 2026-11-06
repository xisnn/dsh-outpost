/** Small, inert text excerpts. Never interpret HTML, scripts or links in a card. */
export const FILE_PREVIEW_MAX_BYTES = 256 * 1024;
export const FILE_PREVIEW_MAX_CHARS = 1200;
export const FILE_PREVIEW_MAX_LINES = 8;

export function isTextPreviewable(name: string): boolean {
  return /\.(?:md|markdown|txt|json|jsonc|log|yaml|yml|toml|ini|xml|html?|css|js|jsx|mjs|cjs|ts|tsx|py|sh|ps1|sql|csv)$/i.test(name);
}

export function fileExcerpt(text: string): string {
  // Bound work before splitting, preserve indentation and avoid broken surrogate pairs.
  const prefix = text.slice(0, FILE_PREVIEW_MAX_CHARS).replace(/^﻿/, '');
  return prefix.split(/\r\n|\n|\r/).slice(0, FILE_PREVIEW_MAX_LINES).join('\n').replace(/[\uD800-\uDBFF]$/, '');
}
