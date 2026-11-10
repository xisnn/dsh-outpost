import fs from 'node:fs';
import path from 'node:path';
import {SandboxedFileSystem} from '@deepseek-ai/dsh-fs-sandbox';
import {FsError} from '@deepseek-ai/dsh-fs';

// Single-workspace provider. Trusted DSH storage/credentials use their own
// services; model-facing file capabilities receive this confined provider.
// This is a path policy for trusted tools, not same-UID arbitrary-code isolation.
export default class WorkspaceFileSystem extends SandboxedFileSystem {
  constructor(ctx, config) {
    super(ctx, config);
    const root = ctx.sandboxPolicy.workspaceRoot;
    if (!path.isAbsolute(root)) throw new Error('Local workspace must be absolute');
    const info = fs.lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local workspace root must be a real directory');
    this.root = fs.realpathSync(root);
    this.rootIdentity = {dev: info.dev, ino: info.ino};
  }
  denied() { return new FsError('Local workspace path denied', 'FS_SANDBOX_DENIED'); }
  inside(file) {
    const relative = path.relative(this.root, file);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  verifyRoot() {
    const info = fs.lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino) throw this.denied();
  }
  async resolve(file, opts) {
    this.verifyRoot();
    // Resolution is identity mapping; authority is enforced on operations.
    // DSH instruction discovery probes ancestors, so metadata outside the root
    // is masked as absent instead of interrupting the trusted discovery loop.
    return super.resolve(file, opts);
  }
  async fresh(target, signal) {
    // Resolve the canonical identity again immediately before the operation.
    // A cached target whose ancestor was replaced by an outside symlink fails.
    const checked = await this.resolve(super.processPath(target), {signal});
    if (!this.inside(super.processPath(checked))) throw this.denied();
    return checked;
  }
  async stat(target, signal) {
    const checked = await this.resolve(super.processPath(target), {signal});
    return this.inside(super.processPath(checked)) ? super.stat(checked, signal) : undefined;
  }
  async lstat(file, opts, signal) {
    const checked = await this.resolve(file, {...opts, signal});
    return this.inside(super.processPath(checked)) ? super.lstat(file, opts, signal) : undefined;
  }
  async readText(target, signal) { return super.readText(await this.fresh(target, signal), signal); }
  async streamText(target, signal) {
    const provider = this;
    return (async function* () {
      const checked = await provider.fresh(target, signal);
      yield* await SandboxedFileSystem.prototype.streamText.call(provider, checked, signal);
    })();
  }
  async readBytes(target, signal, maxBytes) { return super.readBytes(await this.fresh(target, signal), signal, maxBytes); }
  async readByteRange(target, range, signal) { return super.readByteRange(await this.fresh(target, signal), range, signal); }
  async listDir(target, signal) {
    const entries = await super.listDir(await this.fresh(target, signal), signal);
    const allowed = [];
    for (const entry of entries) {
      try { allowed.push({...entry, target: await this.fresh(entry.target, signal)}); }
      catch (error) { if (error.code !== 'FS_SANDBOX_DENIED') throw error; }
    }
    return allowed;
  }
  async watch(target, changed, signal) { return super.watch(await this.fresh(target, signal), changed, signal); }
  async writeText(target, content, expected, signal, policy) { return super.writeText(await this.fresh(target, signal), content, expected, signal, policy); }
  async editText(target, edit, expected, signal, policy) { return super.editText(await this.fresh(target, signal), edit, expected, signal, policy); }
  async patchText(target, hunks, expected, signal, policy) { return super.patchText(await this.fresh(target, signal), hunks, expected, signal, policy); }
  async deleteFile(target, expected, signal, policy) { return super.deleteFile(await this.fresh(target, signal), expected, signal, policy); }
  async moveFile(source, destination, options, signal, policy) { return super.moveFile(await this.fresh(source, signal), await this.fresh(destination, signal), options, signal, policy); }
  processPathFromHostPath(file) {
    this.verifyRoot();
    try { const real = fs.realpathSync(file); return this.inside(real) ? real : undefined; }
    catch { return undefined; }
  }
}
