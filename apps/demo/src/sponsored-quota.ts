import { mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// One fixed allowance, retained across restarts; failed runs still consume a slot.
export class SponsoredQuota {
  constructor(readonly directory: string, readonly limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Sponsored allowance must be between 1 and 10 runs');
  }

  async remaining() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory);
    return this.limit - Array.from({ length: this.limit }, (_, i) => `${i + 1}.reserved`).filter(name => files.includes(name)).length;
  }

  async reserve() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (let i = 1; i <= this.limit; i++) {
      try {
        const handle = await open(join(this.directory, `${i}.reserved`), 'wx', 0o600);
        try { await handle.sync(); } finally { await handle.close(); }
        return i;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('The sponsored demo allowance is exhausted. No run was started.');
  }
}
