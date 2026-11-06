/** Serialize native writes: a late display must finish before cancellation or replacement. */
export class LatestNotification<T> {
  private key = '';
  private revision = 0;
  private failed = true;
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly write: (value: T | null) => Promise<void>) {}

  set(value: T | null): Promise<void> {
    const key = JSON.stringify(value);
    if (key === this.key && !this.failed) return this.work;
    this.key = key;
    this.failed = false;
    const revision = ++this.revision;
    this.work = this.work.then(async () => {
      if (revision !== this.revision) return;
      try {
        await this.write(value);
      } catch {
        // Retry on the next poll; never spin on denied permission or native failure.
        if (revision === this.revision) this.failed = true;
      }
    });
    return this.work;
  }
}
