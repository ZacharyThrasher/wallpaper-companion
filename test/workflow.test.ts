import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { SqliteCatalogRepository } from '../src/adapters/sqlite.js';
import { Catalog } from '../src/catalog.js';
import type { IndexedSnapshot, Wallpaper } from '../src/domain.js';
import { PreferenceStore, emptyPreferences } from '../src/workflow/preferences.js';
import { WorkflowService, workshopItemId } from '../src/workflow/service.js';
import { createLibraryRefresher } from '../src/workflow/runtime.js';
import { SteamWorkshopProvider } from '../src/workshop/provider.js';
import type { WorkshopCandidate, WorkshopProvider, WorkshopSearchQuery } from '../src/workshop/types.js';
import { createGalleryServer } from '../src/gallery/server.js';
import { createCompanionMcpServer } from '../src/mcp/companion.js';
import { PlaybackError } from '../src/playback/types.js';

const wp = 'wp_' + 'a'.repeat(32), pl = 'pl_' + 'b'.repeat(32);
const candidate = (id: string, title = 'Quiet forest', tags = ['Nature']): WorkshopCandidate => ({ id, title, tags, summary: '', appId: 431960,
  steamUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`, source: 'steam-workshop' });
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'companion-workflow-')));
  const file = path.join(root, 'preferences.sqlite');
  const store = new PreferenceStore(file);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const wallpaper: Wallpaper = { id: wp, workshopId: '11', title: 'Quiet forest', tags: ['Nature', 'Green'], type: 'scene',
    projectPath: path.join(root, 'project', 'project.json'), preview: path.join(root, 'project', 'preview.png'), playableTarget: null,
    availability: 'available', metadata: { cache: [] }, provenance: [], observedAt: '2026-01-01T00:00:00Z' };
  const snapshot: IndexedSnapshot = { indexRevision: 1, wallpapers: [wallpaper], playlists: [{ id: pl, name: 'Reference', profile: 'Synthetic',
    items: [{ position: 0, file: null, wallpaperId: wp, resolution: 'resolved', raw: null },
      { position: 1, file: null, wallpaperId: wp, resolution: 'resolved', raw: null },
      { position: 2, file: null, wallpaperId: null, resolution: 'unresolved', raw: null }], settings: null, raw: {},
    provenance: { source: 'saved-playlist', path: '', position: 0 }, observedAt: wallpaper.observedAt }], observedAt: wallpaper.observedAt,
    sourceFiles: [], diagnostics: [] };
  const catalog = new Catalog({ read: () => structuredClone(snapshot), replace() { throw new Error('No catalog writes'); }, close() {} });
  const workflow = new WorkflowService(catalog, store, new SteamWorkshopProvider());
  return { root, file, store, workflow, catalog, snapshot, wallpaper };
}
test('preferences persist across independent handles; stale revision conflicts without lost updates', async t => {
  const f = await fixture(t); const second = new PreferenceStore(f.file);
  try {
    assert.equal(second.read(pl).revision, 0);
    const saved = f.store.write({ reference: pl, expectedRevision: 0, preferences: { ...emptyPreferences(), guidance: 'quiet', shortlist: ['22', '22'] } });
    assert.deepEqual(second.read(pl), saved); assert.deepEqual(saved.preferences.shortlist, ['22']);
    assert.throws(() => second.write({ reference: pl, expectedRevision: 0, preferences: emptyPreferences() }), /another window/);
    assert.deepEqual(f.store.read(pl), saved);
    second.write({ reference: pl, expectedRevision: 1, preferences: { ...saved.preferences, exclusions: ['Anime'] } });
    assert.equal(f.store.read(pl).revision, 2);
  } finally { second.close(); }
});
test('failed SQLite commit is atomic; foreign, invalid and future preference files are preserved', async t => {
  const f = await fixture(t);
  const saved = f.store.write({ reference: pl, expectedRevision: 0, preferences: emptyPreferences() });
  const db = new DatabaseSync(f.file);
  db.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON preferences BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
  assert.throws(() => f.store.write({ reference: pl, expectedRevision: 1, preferences: { ...emptyPreferences(), guidance: 'new' } }));
  assert.deepEqual(f.store.read(pl), saved);
  db.exec('DROP TRIGGER fail_save');
  db.prepare('UPDATE preferences SET payload = ?').run('{broken');
  assert.throws(() => f.store.read(pl), /invalid/); db.close();
  for (const [name, content] of [['invalid.sqlite', 'not sqlite'], ['foreign.sqlite', '']] as const) {
    const file = path.join(f.root, name);
    if (content) await writeFile(file, content); else { const foreign = new DatabaseSync(file); foreign.exec('CREATE TABLE private_data (x TEXT)'); foreign.close(); }
    const before = await readFile(file); assert.throws(() => new PreferenceStore(file)); assert.deepEqual(await readFile(file), before);
  }
  const futureFile = path.join(f.root, 'future.sqlite'); const future = new PreferenceStore(futureFile); future.close();
  const newer = new DatabaseSync(futureFile); newer.exec('PRAGMA user_version=2'); newer.close();
  const before = await readFile(futureFile); assert.throws(() => new PreferenceStore(futureFile), /unsupported/); assert.deepEqual(await readFile(futureFile), before);
  assert.throws(() => f.store.write({ reference: 'global', expectedRevision: 0, preferences: { ...emptyPreferences(), apiKey: 'forbidden' } }));
});
test('simultaneous separate processes yield one success and one revision conflict', async t => {
  const f = await fixture(t);
  const script = `import { PreferenceStore, emptyPreferences } from ${JSON.stringify(new URL('../src/workflow/preferences.js', import.meta.url).href)};
    const store = new PreferenceStore(process.argv[1]); process.stdout.write('ready\\n');
    process.stdin.once('data', () => { try { store.write({reference:'global',expectedRevision:0,preferences:emptyPreferences()}); process.stdout.write('saved\\n'); }
    catch(error) { process.stdout.write(error.code+'\\n'); } finally {store.close();process.stdin.destroy();} });`;
  async function child() {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, f.file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    process.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready')) ready(); });
    const finished = new Promise<string>((resolve, reject) => { process.on('error', reject); process.on('close', code => code === 0 ? resolve(output) : reject(new Error('Synthetic child failed.'))); });
    await Promise.race([started, finished.then(() => { throw new Error('Child exited before ready.'); })]);
    return { process, finished };
  }
  const children = await Promise.all([child(), child()]);
  children.forEach(child => child.process.stdin.end('go'));
  const outcomes = await Promise.all(children.map(child => child.finished));
  assert.equal(outcomes.filter(s => s.includes('saved')).length, 1); assert.equal(outcomes.filter(s => s.includes('PREFERENCE_CONFLICT')).length, 1);
  assert.equal(f.store.read('global').revision, 1);
});
test('playlist evidence is deterministic and honest, counts unique members and separates user guidance', async t => {
  const f = await fixture(t);
  f.workflow.save({ reference: pl, expectedRevision: 0, preferences: { ...emptyPreferences(), guidance: 'very little movement' } });
  const context = f.workflow.context(pl);
  assert.equal(context.evidence.analyzedImages, false); assert.equal(context.evidence.method, 'title-tag-heuristic');
  assert.deepEqual(context.evidence.tags, [{ value: 'green', count: 1 }, { value: 'nature', count: 1 }]);
  assert.equal(context.evidence.resolvedMembers, 1); assert.equal(context.evidence.unresolvedMembers, 1);
  assert.deepEqual(f.workflow.context(pl), context); assert.equal(context.preferences.guidance, 'very little movement');
  assert.deepEqual(f.workflow.context('global').suggestions, { query: '', tags: [] });
  assert.throws(() => f.workflow.context('pl_unknown'), /No catalog item/);
});
test('no-key discovery returns a real Steam search link and anonymous metadata without fake local candidates', async t => {
  const f = await fixture(t);
  const result = await f.workflow.discover({ reference: pl, query: 'quiet forest', tags: ['Nature'] });
  assert.equal(result.status, 'credentials_required'); assert.deepEqual(result.candidates, []);
  const link = new URL(result.searchUrl); assert.equal(link.hostname, 'steamcommunity.com'); assert.equal(link.searchParams.get('searchtext'), 'quiet forest');
  let requests = 0;
  const provider = new SteamWorkshopProvider({ fetch: async (_url, init) => {
    requests++; assert.ok(String(init?.body).includes('publishedfileids'));
    return new Response(JSON.stringify({ response: { publishedfiledetails: [{ publishedfileid: '22', result: 1, consumer_app_id: 431960,
      visibility: 0, banned: false, title: 'Quiet forest', tags: [{ tag: 'Nature' }], preview_url: 'http://127.0.0.1/private' }] } }));
  } });
  const workflow = new WorkflowService(f.catalog, f.store, provider);
  const detail = await workflow.inspect({ reference: pl, item: 'https://steamcommunity.com/sharedfiles/filedetails/?id=22' });
  assert.equal(detail.status, 'available'); if (detail.status !== 'available') return;
  assert.equal(detail.candidate.previewUrl, undefined); assert.equal(detail.candidate.installation, 'not-established');
  assert.equal(detail.installed, false); assert.equal(requests, 1);
});
test('malicious Workshop URLs and invalid IDs never reach metadata transport', async t => {
  const f = await fixture(t); let calls = 0;
  const provider: WorkshopProvider = { capabilities: () => f.workflow.workshop.capabilities(), search: async () => { throw new Error(); }, details: async () => { calls++; return []; } };
  const workflow = new WorkflowService(f.catalog, f.store, provider);
  for (const item of ['0', '-1', '18446744073709551616', 'https://evil.test/?id=22', 'http://steamcommunity.com/sharedfiles/filedetails/?id=22',
    'https://steamcommunity.com@127.0.0.1/sharedfiles/filedetails/?id=22', 'https://steamcommunity.com/sharedfiles/filedetails/?id=22&id=23',
    'https://steamcommunity.com/sharedfiles/filedetails/?id=22#x', 'file:///private', 'https://steamcommunity.com:443/sharedfiles/filedetails/?id=22'])
    await assert.rejects(workflow.inspect({ reference: pl, item }));
  assert.equal(calls, 0); assert.equal(workshopItemId('18446744073709551615'), '18446744073709551615');
});
test('API search applies installed/dismissed exclusions, dedup and phrase filters with explicit match evidence', async t => {
  const f = await fixture(t); let query: WorkshopSearchQuery | undefined;
  f.workflow.save({ reference: pl, expectedRevision: 0, preferences: { ...emptyPreferences(), guidance: 'no flashy motion', exclusions: ['neon'], dismissed: ['22'] } });
  const provider: WorkshopProvider = { capabilities: () => ({ ...f.workflow.workshop.capabilities(), search: 'available' }), details: async () => [],
    search: async input => { query = input; return { status: 'ok', searchUrl: 'https://steamcommunity.com/workshop/browse/?appid=431960', candidates: [candidate('11'), candidate('22'), candidate('33'), candidate('33'), candidate('44', 'Neon city')] }; } };
  const workflow = new WorkflowService(f.catalog, f.store, provider);
  const result = await workflow.discover({ reference: pl, query: 'forest', tags: ['Nature'] });
  assert.deepEqual(result.candidates.map(c => c.id), ['33']); assert.deepEqual([...query!.installedIds!], ['11']); assert.deepEqual([...query!.dismissedIds!], ['22']);
  assert.deepEqual(result.candidates[0]!.match.referenceTags, ['nature']); assert.equal(result.guidanceInterpreted, false);
  assert.equal(f.catalog.getWallpaper(wp).data.workshopId, '11'); assert.equal(f.store.read(pl).revision, 1);
});
test('shortlist metadata pages expose later saved IDs without truncating the collection', async t => {
  const f = await fixture(t); const ids = Array.from({ length: 51 }, (_, i) => String(i + 100));
  f.workflow.save({ reference: pl, expectedRevision: 0, preferences: { ...emptyPreferences(), shortlist: ids } });
  const provider: WorkshopProvider = { capabilities: () => f.workflow.workshop.capabilities(), search: async () => { throw new Error(); },
    details: async requested => requested.map(id => ({ id, status: 'available', candidate: candidate(id) })) };
  const workflow = new WorkflowService(f.catalog, f.store, provider);
  const first = await workflow.shortlist(pl); assert.equal(first.details.length, 50); assert.equal(first.pagination.nextOffset, 50);
  const second = await workflow.shortlist(pl, 50); assert.deepEqual(second.details.map(d => d.id), ['150']); assert.equal(second.pagination.nextOffset, null);
  assert.equal(second.ids.length, 51); await assert.rejects(workflow.shortlist(pl, -1));
});
test('refresh passes fixed owned destination only, rejects overlapping calls and preserves failure recovery', async () => {
  let release!: () => void; let count = 0;
  const refresh = createLibraryRefresher('synthetic-owned.sqlite', {}, async (args, write) => {
    assert.deepEqual(args, ['scan', '--db', 'synthetic-owned.sqlite', '--json']); count++;
    if (count === 1) await new Promise<void>(resolve => { release = resolve; });
    write!(JSON.stringify(count === 1 ? { error: { code: 'UNSAFE_DATABASE_PATH', message: 'Unsafe destination.' } } : { data: { indexed: true } }));
    return count === 1 ? 1 : 0;
  });
  const first = refresh(); await assert.rejects(refresh(), /already running/); release(); await assert.rejects(first, /Unsafe destination/);
  await refresh(); assert.equal(count, 2);
  await assert.rejects(createLibraryRefresher('synthetic-owned.sqlite', undefined), /Refresh sources are not configured/);
  const configured = createLibraryRefresher('synthetic-owned.sqlite', { profile: 'Alternate', installDir: 'synthetic-install', workshopDir: 'synthetic-workshop' }, async (args, write) => {
    assert.deepEqual(args, ['scan', '--db', 'synthetic-owned.sqlite', '--json', '--install-dir', 'synthetic-install', '--workshop-dir', 'synthetic-workshop', '--profile', 'Alternate']);
    write!('{}'); return 0;
  });
  await configured();
});
test('gallery mutations require exact origin and CSRF, bound JSON, deny arbitrary refresh roots and preserve playback verification/errors', async t => {
  const f = await fixture(t); let refreshes = 0, applied = 0;
  const server = createGalleryServer({ catalog: () => f.catalog, uiDirectory: f.root, companion: { workflow: f.workflow,
    refreshLibrary: async () => { refreshes++; return { refreshed: true }; }, playback: {
      applyWallpaper: async args => { applied++; assert.equal(args.monitor, 0); throw new PlaybackError('COMMAND_TIMEOUT', 'Playback timed out.', true); },
      activatePlaylist: async () => ({ action: 'activatePlaylist', accepted: true, verification: 'not-supported', monitor: 0 }),
      readCurrent: async () => ({ state: 'none', wallpaperId: null, monitor: 0, observedAt: 'now' })
    } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = await (await fetch(base + '/api/session')).json() as { csrf: string };
  const send = (route: string, input: unknown, headers = {}) => fetch(base + '/api/' + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': base, 'X-Companion-CSRF': session.csrf, ...headers }, body: JSON.stringify(input) });
  assert.equal((await send('refresh', {}, { Origin: '' })).status, 403);
  assert.equal((await send('refresh', {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send('refresh', {}, { 'X-Companion-CSRF': 'f'.repeat(64) })).status, 403);
  assert.equal((await send('refresh', {}, { 'X-Companion-CSRF': 'ü'.repeat(64) })).status, 403);
  assert.equal((await send('refresh', { roots: ['C:/private'] })).status, 400);
  assert.equal((await send('refresh', {}, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await send('refresh', { padding: 'x'.repeat(100001) })).status, 400);
  assert.equal(refreshes, 0); assert.equal((await send('refresh', {})).status, 200); assert.equal(refreshes, 1);
  const save = { reference: pl, expectedRevision: 0, preferences: emptyPreferences() };
  assert.equal((await send('preferences', save)).status, 200); assert.equal((await send('preferences', save)).status, 409);
  assert.equal((await send('apply', { wallpaperId: 'C:/anything' })).status, 400); assert.equal(applied, 0);
  const failure = await send('apply', { wallpaperId: wp }); assert.equal(failure.status, 503);
  assert.equal(((await failure.json()) as any).error.mayHaveApplied, true); assert.equal(applied, 1);
  const playlist = await (await send('play-playlist', { playlistId: pl })).json() as any; assert.equal(playlist.accepted, true); assert.equal(playlist.verification, 'not-supported');
  assert.equal((await fetch(base + '/api/current')).status, 200);
});
test('optional MCP exposes compact workflow reads/actions and safe actual images while preserving text fallback', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.wallpaper.projectPath)); await writeFile(f.wallpaper.projectPath, '{}');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  await writeFile(f.wallpaper.preview!, png);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createCompanionMcpServer(f.catalog, f.workflow), { transport: serverTransport });
  const client = new Client({ name: 'workflow-test', version: '1' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await handle.close(); });
  const tools = await client.listTools();
  assert.ok(tools.tools.find(t => t.name === 'save_discovery_preferences')?.annotations?.readOnlyHint === false);
  assert.ok(tools.tools.find(t => t.name === 'inspect_workshop_item')?.annotations?.openWorldHint === true);
  const context = await client.callTool({ name: 'discovery_context', arguments: { reference: pl } });
  assert.deepEqual(JSON.parse((context.content[0] as { text: string }).text), context.structuredContent);
  const image = await client.callTool({ name: 'get_wallpaper_image', arguments: { id: wp } });
  assert.equal(image.content[1]?.type, 'image'); assert.equal((image.content[1] as { data: string }).data, png.toString('base64'));
  const bad = await client.callTool({ name: 'get_wallpaper_image', arguments: { id: '../private' } }); assert.equal(bad.isError, true);
  await writeFile(f.wallpaper.preview!, Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
  const large = await client.callTool({ name: 'get_wallpaper_image', arguments: { id: wp } }); assert.equal((large.structuredContent as any).error.code, 'PREVIEW_TOO_LARGE');
  const save = { reference: pl, expectedRevision: 0, preferences: { ...emptyPreferences(), shortlist: ['22'] } };
  assert.equal((await client.callTool({ name: 'save_discovery_preferences', arguments: save })).isError, undefined);
  assert.equal(((await client.callTool({ name: 'save_discovery_preferences', arguments: save })).structuredContent as any).error.code, 'PREFERENCE_CONFLICT');
});
test('built opt-in stdio connects to the same preference store and advertises explicit playback separately', async t => {
  const f = await fixture(t); const dbFile = path.join(f.root, 'catalog.sqlite');
  const repo = new SqliteCatalogRepository(dbFile); repo.replace(f.snapshot); repo.close();
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp-cli.js', import.meta.url)), '--companion', '--db', dbFile, '--preferences', f.file],
    env: { ...getDefaultEnvironment(), STEAM_WEB_API_KEY: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'workflow-stdio-test', version: '1' }); await client.connect(transport);
  try {
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 15);
  assert.equal(tools.find(t => t.name === 'apply_wallpaper')?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'get_wallpaper_image')?.annotations?.readOnlyHint, true);
  const save = await client.callTool({ name: 'save_discovery_preferences', arguments: { reference: pl, expectedRevision: 0, preferences: { ...emptyPreferences(), guidance: 'Shared across processes' } } });
  assert.equal(save.isError, undefined); assert.equal(f.store.read(pl).preferences.guidance, 'Shared across processes');
  const result = await client.callTool({ name: 'discover_wallpapers', arguments: { reference: pl, query: 'forest', tags: [] } });
  assert.equal((result.structuredContent as any).status, 'credentials_required');
  // Playback tools are discovered but never executed against the desktop.
  } finally { await client.close(); }
});
