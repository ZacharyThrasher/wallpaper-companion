import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Catalog } from './catalog.js';
import { CatalogError, schemaVersion, type CatalogRepository } from './domain.js';
import { canonicalDestination, inside, missing } from './adapters/files.js';
import { discover } from './adapters/steam.js';
import { scan } from './adapters/scanner.js';
import { SqliteCatalogRepository } from './adapters/sqlite.js';
import { defaultDatabasePath } from './adapters/database-path.js';
export { defaultDatabasePath } from './adapters/database-path.js';

const help = `Wallpaper Companion: read-only library and saved playlist catalog
Usage: node dist/src/cli.js <command> [id] [options]
Commands: scan, status, list-wallpapers, get-wallpaper <id>, list-playlists, get-playlist <id>
Options: --json --db <file> --help
Scan: --steam-path <dir> --install-dir <dir> --workshop-dir <dir> --profile <name>
Lists: --search <text> --limit <1..500> --offset <n> --revision <n>
Wallpapers: --type <type> --tag <tag> --availability <available|missing|unsupported>
Only scan writes, and only to a companion-owned SQLite database.
Node 24.11.1+ (24.x) required; node:sqlite is experimental.`;

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CatalogError('INVALID_ARGUMENT', `${name} must be a nonnegative integer.`);
  return Number(value);
}
export async function assertSafeDatabasePath(filename: string, protectedRoots: string[]) {
  const output = await canonicalDestination(path.resolve(filename));
  for (const root of protectedRoots) {
    const source = await canonicalDestination(path.resolve(root));
    if (inside(source, output)) throw new CatalogError('UNSAFE_DATABASE_PATH', 'The catalog database must be outside Steam and Wallpaper Engine source directories.');
  }
}
const emptyRepository: CatalogRepository = {
  read: () => null, close: () => {}, replace: () => { throw new CatalogError('INDEX_EMPTY', 'No index is open.'); }
};
export async function run(argv: string[], write: (text: string) => void = text => process.stdout.write(text)): Promise<number> {
  let repository: CatalogRepository | undefined;
  const json = argv.includes('--json');
  try {
    const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean' }, db: { type: 'string' },
      'steam-path': { type: 'string' }, 'install-dir': { type: 'string' }, 'workshop-dir': { type: 'string' }, profile: { type: 'string' },
      search: { type: 'string' }, type: { type: 'string' }, tag: { type: 'string' }, availability: { type: 'string' },
      limit: { type: 'string' }, offset: { type: 'string' }, revision: { type: 'string' }
    } });
    if (v.help || positionals.length === 0) { write(`${help}\n`); return 0; }
    const [command, itemId] = positionals;
    const commands = ['scan', 'status', 'list-wallpapers', 'get-wallpaper', 'list-playlists', 'get-playlist'];
    if (!commands.includes(command!)) throw new CatalogError('INVALID_ARGUMENT', 'Unknown command. Use --help.');
    const isGet = command!.startsWith('get-');
    if (positionals.length !== (isGet ? 2 : 1)) throw new CatalogError('INVALID_ARGUMENT', isGet ? 'Provide exactly one catalog ID.' : 'Unexpected positional arguments.');
    const scanOptions = ['steam-path', 'install-dir', 'workshop-dir', 'profile'];
    const listOptions = ['search', 'limit', 'offset', 'revision'];
    const wallpaperOptions = ['type', 'tag', 'availability'];
    for (const key of Object.keys(v)) {
      if ((scanOptions.includes(key) && command !== 'scan') || (listOptions.includes(key) && !command!.startsWith('list-')) ||
          (wallpaperOptions.includes(key) && command !== 'list-wallpapers')) throw new CatalogError('INVALID_ARGUMENT', `--${key} does not apply to ${command}.`);
    }
    const db = path.resolve(v.db ?? defaultDatabasePath());
    let result: unknown;
    if (command === 'scan') {
      const locations = await discover({ ...(v['steam-path'] ? { steamPath: v['steam-path'] } : {}),
        ...(v['install-dir'] ? { installDir: v['install-dir'] } : {}), ...(v['workshop-dir'] ? { workshopDir: v['workshop-dir'] } : {}) });
      await assertSafeDatabasePath(db, locations.protectedRoots);
      const snapshot = await scan(locations, v.profile === undefined ? {} : { profile: v.profile });
      await fs.mkdir(path.dirname(db), { recursive: true });
      repository = new SqliteCatalogRepository(db);
      const catalog = new Catalog(repository); catalog.commit(snapshot);
      result = catalog.status();
    } else {
      try { await fs.stat(db); repository = new SqliteCatalogRepository(db, true); }
      catch (error) { if (missing(error)) repository = emptyRepository; else throw error; }
      const catalog = new Catalog(repository);
      const query = { ...(v.search === undefined ? {} : { search: v.search }), ...(v.type === undefined ? {} : { type: v.type }),
        ...(v.tag === undefined ? {} : { tag: v.tag }), ...(v.availability === undefined ? {} : { availability: v.availability }),
        ...(v.limit === undefined ? {} : { limit: integer(v.limit, 'limit')! }), ...(v.offset === undefined ? {} : { offset: integer(v.offset, 'offset')! }),
        ...(v.revision === undefined ? {} : { revision: integer(v.revision, 'revision')! }) };
      if (command === 'status') result = catalog.status();
      else if (command === 'list-wallpapers') result = catalog.listWallpapers(query);
      else if (command === 'list-playlists') result = catalog.listPlaylists(query);
      else if (command === 'get-wallpaper') result = catalog.getWallpaper(itemId!);
      else result = catalog.getPlaylist(itemId!);
    }
    if (v.json) write(`${JSON.stringify(result)}\n`);
    else {
      const envelope = result as { indexRevision: number; observedAt: string | null; data: unknown; diagnostics: unknown[] };
      write(`Index revision ${envelope.indexRevision}; observed ${envelope.observedAt ?? 'never'}; diagnostics ${envelope.diagnostics.length}\n${JSON.stringify(envelope.data, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    const argumentError = error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS');
    const code = error instanceof CatalogError ? error.code : argumentError ? 'INVALID_ARGUMENT' : 'OPERATION_FAILED';
    // Node filesystem errors often include personal source paths. Keep CLI failures concise.
    const message = error instanceof CatalogError || argumentError ? (error as Error).message : 'Operation failed. Check source access, input format, and database permissions.';
    const response = { schemaVersion, indexRevision: null, observedAt: null, diagnostics: [{ severity: 'error', code, message }], error: { code, message } };
    write(json ? `${JSON.stringify(response)}\n` : `${code}: ${message}\n`);
    return 1;
  } finally { repository?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await run(process.argv.slice(2));
