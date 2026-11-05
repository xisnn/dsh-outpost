/** Short display label only; never used for MIME detection or opening files. */
export function fileTypeLabel(name?: string): string {
  const basename = name?.split(/[\\/]/).pop() ?? '';
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return '文件';
  const extension = basename.slice(dot + 1);
  return /^[a-z0-9]{1,6}$/i.test(extension) ? extension.toUpperCase() : '文件';
}
