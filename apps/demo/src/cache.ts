// Private cache files for the demo.
//
// The spy bot needs a directory cache and a catalog cache. Shared temp names like
// /tmp/wraps-demo-directory-cache.json let another local user plant a file or a symlink there.
// So the demo keeps its caches in a fresh mkdtemp directory with mode 0700, never follows
// symlinks, creates files with O_EXCL, and replaces a cache file only by rename.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

export class PrivateCacheDir {
  private constructor(readonly path: string) {}

  /** Makes a new private directory under the system temp directory (or `parent`). */
  static async create(parent = tmpdir()): Promise<PrivateCacheDir> {
    const path = await mkdtemp(join(parent, 'wraps-demo-'));
    // mkdtemp already uses 0700. Set it again so a strange umask cannot widen it.
    await chmod(path, 0o700);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`cache directory ${path} is not a plain directory`);
    if ((info.mode & 0o077) !== 0) throw new Error(`cache directory ${path} is open to other users`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error(`cache directory ${path} belongs to another user`);
    }
    return new PrivateCacheDir(path);
  }

  /** Full path of a cache file. Only plain file names are allowed. */
  file(name: string): string {
    if (!name || name !== basename(name) || name.startsWith('.')) throw new Error(`bad cache file name: ${name}`);
    return join(this.path, name);
  }

  /** Reads a cache file. Returns undefined when it is missing. Refuses symlinks. */
  async read(name: string): Promise<string | undefined> {
    let handle;
    try {
      handle = await open(this.file(name), O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`cache file ${name} is not a regular file`);
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes a cache file atomically. The data goes to a new temp file (O_CREAT | O_EXCL |
   * O_NOFOLLOW, mode 0600), then rename() replaces the target. rename() replaces a symlink
   * itself and never writes through it.
   */
  async write(name: string, data: string): Promise<void> {
    const target = this.file(name);
    const temp = join(this.path, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } catch (err) {
      await handle.close();
      await unlink(temp).catch(() => undefined);
      throw err;
    }
    await handle.close();
    try {
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  async remove(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}
