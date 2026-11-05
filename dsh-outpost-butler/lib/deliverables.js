import path from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Resolve only regular files inside the task workspace, including symlinks. */
export async function describeDeliverable(cwd, file) {
  const result = { path: file.path, ...(file.description ? { description: file.description } : {}) };
  let handle;
  try {
    const root = await realpath(cwd);
    const absolute = await realpath(path.resolve(cwd, file.path));
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { ...result, unavailableReason: 'outside-workspace' };
    }
    handle = await open(absolute, 'r');
    const before = await handle.stat();
    if (!before.isFile()) return { ...result, unavailableReason: 'not-a-file' };
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return { ...result, unavailableReason: 'changed-during-read' };
    }
    return { ...result, relativePath: relative.split(path.sep).join('/'), size: after.size, sha256: hash.digest('hex') };
  } catch {
    return { ...result, unavailableReason: 'unreadable' };
  } finally {
    await handle?.close();
  }
}
