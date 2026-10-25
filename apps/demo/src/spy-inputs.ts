// Loads the spy bot's directory and catalog through the demo's private cache.
// The spy bot gets the directory as data and the catalog as a fresh cache file inside the
// private directory, so it has no reason to write a cache file of its own.
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CACHE_PATH,
  DEFAULT_CATALOG_CACHE_PATH,
  loadCatalog,
  loadDirectory,
  type Catalog,
  type Directory,
} from '@agent-pay/spybot';
import type { PrivateCacheDir } from './cache';

export const DIRECTORY_FILE = 'directory-cache.json';
export const CATALOG_FILE = 'catalog-cache.json';

export interface SpyInputs {
  directory: Directory & { fromCache: boolean };
  /** Path of a catalog cache with an entry for every merchant, or undefined when one is missing. */
  catalogCachePath?: string;
  catalogs: Catalog[];
}

export interface SpyInputDeps {
  fetchDirectory?: () => Promise<Directory>;
  fetchCatalog?: (address: string) => Promise<Catalog | null>;
  /** Read-only caches shipped with the spy bot. Used only when the network and private cache fail. */
  shippedDirectoryPath?: string;
  shippedCatalogPath?: string;
}

async function readJson<T>(text: Promise<string | undefined>): Promise<T | undefined> {
  try {
    const raw = await text;
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export async function loadSpyInputs(cache: PrivateCacheDir, merchants: string[], deps: SpyInputDeps = {}): Promise<SpyInputs> {
  const fetchDirectory = deps.fetchDirectory ?? (() => loadDirectory({}));
  const fetchCatalog = deps.fetchCatalog ?? ((address: string) => loadCatalog(address, {}));
  const shippedDirectory = deps.shippedDirectoryPath ?? DEFAULT_CACHE_PATH;
  const shippedCatalog = deps.shippedCatalogPath ?? DEFAULT_CATALOG_CACHE_PATH;

  let directory: SpyInputs['directory'];
  try {
    const fresh = await fetchDirectory();
    directory = { ...fresh, fromCache: false };
    await cache.write(DIRECTORY_FILE, JSON.stringify(fresh, null, 2) + '\n');
  } catch (fetchError) {
    const cached =
      (await readJson<Directory>(cache.read(DIRECTORY_FILE))) ??
      (await readJson<Directory>(readFile(shippedDirectory, 'utf8')));
    if (!cached?.entries) throw new Error(`directory fetch failed and no cache: ${String(fetchError)}`);
    directory = { ...cached, fromCache: true };
  }

  const privateCatalogs = (await readJson<Record<string, Catalog>>(cache.read(CATALOG_FILE))) ?? {};
  let shippedCatalogs: Record<string, Catalog> | undefined;
  const catalogs: Catalog[] = [];
  for (const address of merchants) {
    let catalog = await fetchCatalog(address).catch(() => null);
    if (!catalog) catalog = privateCatalogs[address] ?? null;
    if (!catalog) {
      shippedCatalogs ??= (await readJson<Record<string, Catalog>>(readFile(shippedCatalog, 'utf8'))) ?? {};
      catalog = shippedCatalogs[address] ?? null;
    }
    if (catalog) {
      privateCatalogs[address] = catalog;
      catalogs.push(catalog);
    }
  }
  await cache.write(CATALOG_FILE, JSON.stringify(privateCatalogs, null, 1) + '\n');
  const haveAll = catalogs.length === merchants.length;
  return { directory, catalogs, catalogCachePath: haveAll ? cache.file(CATALOG_FILE) : undefined };
}
