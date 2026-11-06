export interface NavigationColumns {
  masterIndex: number;
  detailIndex: number;
  masterWidth: number;
  detailWidth: number;
}
/** Window dimensions in dp; height includes a docked keyboard's resized area. */
export function navigationColumns(
  screens: readonly {name: string}[], width: number, height: number,
  rootIsList = false, fontScale = 1,
): NavigationColumns | null {
  if (![width, height, fontScale].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.max(1, fontScale);
  if (width / scale < 900 || height / scale < 600) return null;
  const detailIndex = screens.length - 1;
  if (screens[detailIndex]?.name !== 'Chat') return null;
  let masterIndex = detailIndex - 1;
  while (masterIndex >= 0) {
    const name = screens[masterIndex].name;
    if (name === 'Sessions' || name === 'Workspaces' || (masterIndex === 0 && name === 'Home' && rootIsList)) break;
    masterIndex--;
  }
  if (masterIndex < 0) return null;
  const masterWidth = Math.round(Math.min(340 * scale, Math.max(300 * scale, width * 0.28)));
  return {masterIndex, detailIndex, masterWidth, detailWidth: width - masterWidth};
}
