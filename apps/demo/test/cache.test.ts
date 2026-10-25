import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Catalog, Directory } from '@agent-pay/spybot';
import { PrivateCacheDir } from '../src/cache';
import { CATALOG_FILE, DIRECTORY_FILE, loadSpyInputs } from '../src/spy-inputs';

let scratch: string;
let cache: PrivateCacheDir;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wraps-demo-test-'));
  cache = await PrivateCacheDir.create(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('PrivateCacheDir', () => {
  it('makes a fresh directory with mode 0700 and an unpredictable name', async () => {
    const other = await PrivateCacheDir.create(scratch);
    expect(other.path).not.toBe(cache.path);
    const info = await lstat(cache.path);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
    expect(cache.path.startsWith(join(scratch, 'wraps-demo-'))).toBe(true);
  });

  it('writes a 0600 file and reads it back, leaving no temp files', async () => {
    await cache.write('a.json', '{"x":1}');
    await cache.write('a.json', '{"x":2}');
    expect(await cache.read('a.json')).toBe('{"x":2}');
    expect((await stat(cache.file('a.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(cache.path)).toEqual(['a.json']);
  });

  it('returns undefined for a missing file', async () => {
    expect(await cache.read('missing.json')).toBeUndefined();
  });

  it('replaces a planted symlink instead of writing through it', async () => {
    const victim = join(scratch, 'victim.txt');
    await writeFile(victim, 'do not touch');
    await symlink(victim, cache.file('a.json'));
    await cache.write('a.json', 'cache data');
    expect(await readFile(victim, 'utf8')).toBe('do not touch');
    const info = await lstat(cache.file('a.json'));
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isFile()).toBe(true);
    expect(await cache.read('a.json')).toBe('cache data');
  });

  it('refuses to read through a symlink', async () => {
    const secret = join(scratch, 'secret.txt');
    await writeFile(secret, 'secret');
    await symlink(secret, cache.file('a.json'));
    await expect(cache.read('a.json')).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('refuses names that leave the directory or hide as temp files', () => {
    for (const name of ['../x.json', 'a/b.json', '', '.hidden', '..']) expect(() => cache.file(name)).toThrow(/bad cache file name/);
  });
});

describe('loadSpyInputs', () => {
  const merchant = 'rMerchant';
  const directory: Directory = { source: 'test', fetchedAt: '2026-10-24T00:00:00.000Z', entries: [] };
  const catalog: Catalog = { address: merchant, total: 1, entries: [], complete: true, fetchedAt: new Date().toISOString() };
  const missing = (name: string) => join(scratch, `no-${name}.json`);

  it('caches fresh data in the private directory only', async () => {
    const inputs = await loadSpyInputs(cache, [merchant], {
      fetchDirectory: async () => directory,
      fetchCatalog: async () => catalog,
      shippedDirectoryPath: missing('dir'),
      shippedCatalogPath: missing('cat'),
    });
    expect(inputs.directory.fromCache).toBe(false);
    expect(inputs.catalogCachePath).toBe(cache.file(CATALOG_FILE));
    expect(JSON.parse((await cache.read(DIRECTORY_FILE))!)).toEqual(directory);
    expect(JSON.parse((await cache.read(CATALOG_FILE))!)[merchant]).toEqual(catalog);
    expect((await readdir(cache.path)).sort()).toEqual([CATALOG_FILE, DIRECTORY_FILE].sort());
  });

  it('falls back to the private cache, then to the shipped cache, when the network fails', async () => {
    await cache.write(DIRECTORY_FILE, JSON.stringify(directory));
    const down = {
      fetchDirectory: async (): Promise<Directory> => { throw new Error('offline'); },
      fetchCatalog: async () => null,
    };
    const fromPrivate = await loadSpyInputs(cache, [merchant], { ...down, shippedDirectoryPath: missing('dir'), shippedCatalogPath: missing('cat') });
    expect(fromPrivate.directory).toMatchObject({ fromCache: true, source: 'test' });
    expect(fromPrivate.catalogCachePath).toBeUndefined();

    const shippedDir = join(scratch, 'shipped-dir.json');
    const shippedCat = join(scratch, 'shipped-cat.json');
    await writeFile(shippedDir, JSON.stringify({ ...directory, source: 'shipped' }));
    await writeFile(shippedCat, JSON.stringify({ [merchant]: catalog }));
    const empty = await PrivateCacheDir.create(scratch);
    const fromShipped = await loadSpyInputs(empty, [merchant], { ...down, shippedDirectoryPath: shippedDir, shippedCatalogPath: shippedCat });
    expect(fromShipped.directory).toMatchObject({ fromCache: true, source: 'shipped' });
    expect(fromShipped.catalogCachePath).toBe(empty.file(CATALOG_FILE));
    // The shipped files are only read.
    expect(JSON.parse(await readFile(shippedDir, 'utf8')).source).toBe('shipped');
  });

  it('fails clearly when there is no directory anywhere', async () => {
    await expect(
      loadSpyInputs(cache, [merchant], {
        fetchDirectory: async () => { throw new Error('offline'); },
        fetchCatalog: async () => null,
        shippedDirectoryPath: missing('dir'),
        shippedCatalogPath: missing('cat'),
      }),
    ).rejects.toThrow(/no cache/);
  });
});
