import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Catalog } from '../src/catalog.js';
import { SqliteCatalogRepository } from '../src/adapters/sqlite.js';
import type { IndexedSnapshot, Snapshot, Wallpaper } from '../src/domain.js';
import { createCatalogMcpServer } from '../src/mcp/server.js';
import { openReadOnlyCatalog } from '../src/mcp/index.js';

const entry = fileURLToPath(new URL('../src/mcp-cli.js', import.meta.url));
const toolNames = ['catalog_status', 'get_playlist', 'get_preview', 'get_wallpaper', 'list_playlists', 'list_wallpapers'];
const observedAt = '2026-01-01T00:00:00.000Z';
function wallpaper(id: string, title: string, availability: Wallpaper['availability'], preview: string | null): Wallpaper {
  return { id, title, type: 'scene', tags: ['Nature'], projectPath: `C:/synthetic/projects/${id}/project.json`,
    playableTarget: null, preview, availability, provenance: [], metadata: { cache: [] }, observedAt };
}
function snapshot(): Snapshot {
  return {
    wallpapers: [wallpaper('wp_b', 'Mountain Lake', 'missing', null), wallpaper('wp_a', 'Forest', 'available', 'C:/synthetic/preview.png')],
    playlists: [{ id: 'pl_a', name: 'Evening', profile: 'fixture', items: [
      { position: 0, file: null, wallpaperId: 'wp_a', resolution: 'resolved', raw: { file: 'synthetic' } },
      { position: 1, file: null, wallpaperId: null, resolution: 'unresolved', raw: 'missing fixture' }
    ], settings: { shuffle: true }, raw: { name: 'Evening' },
      provenance: { source: 'saved-playlist', path: 'C:/synthetic/config.json', position: 0 }, observedAt }],
    diagnostics: [{ severity: 'warning', code: 'FIXTURE', message: 'Synthetic fixture diagnostic.' }],
    observedAt, sourceFiles: []
  };
}

function memoryCatalog() {
  let state: IndexedSnapshot = { ...snapshot(), indexRevision: 1 };
  const catalog = new Catalog({ read: () => structuredClone(state), close() {},
    replace: s => (state = { ...s, indexRevision: state.indexRevision + 1 }) });
  return catalog;
}
async function inMemory(catalog: Catalog, modern = false) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createCatalogMcpServer(catalog), { transport: serverTransport });
  const client = new Client({ name: 'catalog-protocol-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await handle.close(); } };
}
function structured(value: CallToolResult): Record<string, any> {
  assert.ok(value.structuredContent && typeof value.structuredContent === 'object');
  return value.structuredContent as Record<string, any>;
}
function assertError(value: CallToolResult, code: string) {
  assert.equal(value.isError, true);
  assert.equal(structured(value).error.code, code);
  assert.equal(value.content[0]?.type, 'text');
  assertTextFallback(value);
}
function assertTextFallback(value: CallToolResult) {
  const json = value.content[1];
  assert.equal(json?.type, 'text');
  assert.deepEqual(JSON.parse((json as { text: string }).text), value.structuredContent);
}
/** Independent public-field contract checks against the domain, not production mappers. */
function assertCatalogView(response: CallToolResult, domain: Record<string, any>, tool: string) {
  const actual = structured(response);
  const { data, ...envelope } = actual;
  const { data: original, ...domainEnvelope } = domain;
  assert.deepEqual(envelope, domainEnvelope);
  const pick = (row: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
  const wallpaperKeys = ['id', 'title', 'type', 'tags', 'availability', 'workshopId'];
  const expectedWallpaper = (row: Record<string, any>, detail: boolean) => ({
    ...pick(row, detail ? [...wallpaperKeys, 'projectPath', 'playableTarget', 'preview', 'provenance', 'observedAt'] : wallpaperKeys),
    hasPreview: row.preview !== null
  });
  const expectedPlaylist = (row: Record<string, any>, detail: boolean) => ({
    ...pick(row, detail ? ['id', 'name', 'profile', 'provenance', 'observedAt'] : ['id', 'name']),
    memberCount: row.items.length,
    unresolvedCount: row.items.filter((item: Record<string, any>) => item.resolution === 'unresolved').length,
    ...(detail ? { items: row.items.map((item: Record<string, any>) => pick(item, ['position', 'file', 'wallpaperId', 'resolution'])) } : {})
  });
  if (tool === 'list_wallpapers') assert.deepEqual(data, original.map((w: Record<string, any>) => expectedWallpaper(w, false)));
  else if (tool === 'get_wallpaper') assert.deepEqual(data, expectedWallpaper(original, true));
  else if (tool === 'list_playlists') assert.deepEqual(data, original.map((p: Record<string, any>) => expectedPlaylist(p, false)));
  else if (tool === 'get_playlist') assert.deepEqual(data, expectedPlaylist(original, true));
  else assert.deepEqual(data, original);
  assertTextFallback(response);
}

for (const modern of [false, true]) {
  test(`SDK ${modern ? 'modern discovery' : 'legacy initialize'}/list/call preserves projected domain fields and JSON text fallback`, async t => {
    const catalog = memoryCatalog();
    const session = await inMemory(catalog, modern);
    t.after(session.close);
    const { client } = session;
    assert.equal(client.getServerVersion()?.name, 'wallpaper-companion');
    assert.ok(client.getServerCapabilities()?.tools);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(v => v.name).sort(), toolNames);
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const cases = [
      { name: 'catalog_status', args: {}, expected: catalog.status() },
      { name: 'list_wallpapers', args: {}, expected: catalog.listWallpapers() },
      { name: 'list_wallpapers', args: { search: 'FOR', type: 'SCENE', tag: 'nature', availability: 'available', limit: 1 },
        expected: catalog.listWallpapers({ search: 'FOR', type: 'SCENE', tag: 'nature', availability: 'available', limit: 1 }) },
      { name: 'get_wallpaper', args: { id: 'wp_a' }, expected: catalog.getWallpaper('wp_a') },
      { name: 'list_playlists', args: { search: 'even', limit: 1 }, expected: catalog.listPlaylists({ search: 'even', limit: 1 }) },
      { name: 'get_playlist', args: { id: 'pl_a' }, expected: catalog.getPlaylist('pl_a') },
      { name: 'get_preview', args: { id: 'wp_a' }, expected: catalog.getPreview('wp_a') },
      { name: 'get_preview', args: { id: 'wp_b' }, expected: catalog.getPreview('wp_b') }
    ];
    for (const example of cases) {
      const response = await client.callTool({ name: example.name, arguments: example.args });
      assert.notEqual(response.isError, true);
      assertCatalogView(response, example.expected, example.name);
      assert.equal(response.content[0]?.type, 'text');
    }
  });
}

test('MCP projections exclude large preserved source payloads while the catalog retains them', async t => {
  const catalog = memoryCatalog();
  const session = await inMemory(catalog);
  t.after(session.close);
  const calls = [
    { name: 'list_wallpapers', arguments: {} }, { name: 'get_wallpaper', arguments: { id: 'wp_a' } },
    { name: 'list_playlists', arguments: {} }, { name: 'get_playlist', arguments: { id: 'pl_a' } }
  ];
  const baseline = await Promise.all(calls.map(call => session.client.callTool(call)));
  const large = snapshot();
  const payload = 'PRESERVED_SOURCE_SENTINEL'.repeat(24_000);
  large.wallpapers[1]!.workshopId = '123456789';
  large.wallpapers[1]!.metadata = { project: { userproperties: { oversized: payload } }, cache: [{ oversized: payload }] };
  const playlist = large.playlists[0]!;
  playlist.raw = { oversized: payload, items: [{ oversized: payload }] };
  playlist.settings = { oversized: payload };
  playlist.items[0]!.raw = { oversized: payload };
  playlist.items[0]!.preset = { oversized: payload };
  playlist.items[0]!.daytimeend = { oversized: payload };
  catalog.commit(large);
  const direct = [catalog.listWallpapers(), catalog.getWallpaper('wp_a'), catalog.listPlaylists(), catalog.getPlaylist('pl_a')];
  for (const [index, call] of calls.entries()) {
    const response = await session.client.callTool(call);
    assertCatalogView(response, direct[index]!, call.name);
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes('PRESERVED_SOURCE_SENTINEL'));
    assert.ok(serialized.length < JSON.stringify(baseline[index]).length + 256, 'Preserved source size must not grow the projected reply');
  }
  const summaries = structured(await session.client.callTool({ name: 'list_wallpapers' })).data;
  assert.deepEqual(summaries.map((w: Record<string, any>) => [w.id, w.hasPreview, w.workshopId]), [['wp_a', true, '123456789'], ['wp_b', false, undefined]]);
  const summary = structured(await session.client.callTool({ name: 'list_playlists' })).data[0];
  assert.deepEqual(summary, { id: 'pl_a', name: 'Evening', memberCount: 2, unresolvedCount: 1 });
  assert.deepEqual(catalog.getWallpaper('wp_a').data.metadata, large.wallpapers[1]!.metadata);
  assert.deepEqual(catalog.getPlaylist('pl_a').data.raw, playlist.raw);
  assert.deepEqual(catalog.getPlaylist('pl_a').data.items[0]!.preset, { oversized: payload });
});

test('pagination is stable, detects new revisions, and rejects malformed input before the domain runs', async t => {
  const catalog = memoryCatalog();
  let calls = 0;
  const original = catalog.listWallpapers.bind(catalog);
  catalog.listWallpapers = q => { calls++; return original(q); };
  const session = await inMemory(catalog);
  t.after(session.close);
  const { client } = session;
  const first = structured(await client.callTool({ name: 'list_wallpapers', arguments: { limit: 1 } }));
  assert.equal(first.data[0].id, 'wp_a');
  assert.equal(first.pagination.nextOffset, 1);
  const second = structured(await client.callTool({ name: 'list_wallpapers',
    arguments: { offset: first.pagination.nextOffset, limit: 1, revision: first.indexRevision } }));
  assert.equal(second.data[0].id, 'wp_b');
  assert.equal(second.pagination.nextOffset, null);
  catalog.commit(snapshot());
  assertError(await client.callTool({ name: 'list_wallpapers', arguments: { offset: 1, revision: 1 } }), 'REVISION_CHANGED');
  const before = calls;
  for (const args of [
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { offset: -1 }, { offset: 2_147_483_648 },
    { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { availability: 'subscribed' },
    { search: 'x'.repeat(257) }, { type: 'x'.repeat(129) }, { tag: '' }, { path: 'C:/synthetic/secret' }
  ]) {
    const response = await client.callTool({ name: 'list_wallpapers', arguments: args });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.content), /validation|Invalid arguments/i);
  }
  assert.equal(calls, before);
  for (const args of [{}, { id: '' }, { id: 123 }, { id: 'x'.repeat(129) }, { id: 'wp_a', path: 'C:/synthetic' }]) {
    assert.equal((await client.callTool({ name: 'get_wallpaper', arguments: args })).isError, true);
  }
  assert.equal((await client.callTool({ name: 'list_playlists', arguments: { type: 'scene' } })).isError, true);
  assert.equal((await client.callTool({ name: 'catalog_status', arguments: { db: 'other.sqlite' } })).isError, true);
  assertError(await client.callTool({ name: 'get_wallpaper', arguments: { id: 'unknown' } }), 'NOT_FOUND');
  await assert.rejects(client.callTool({ name: 'scan', arguments: {} }), /not found/);
});

async function stdio(db: string, modern = false) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--db', db], cwd: os.tmpdir(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'catalog-stdio-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  const errors: Error[] = [];
  client.onerror = error => errors.push(error);
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw error; }
  return { client, errors, stderr: () => stderr, close: () => client.close() };
}

test('built CLI serves real SQLite read-only over SDK stdio; sees rescans without restart and keeps diagnostics off stdout', async t => {
  // The minimum runtime emits this warning; newer 24.x builds may not.
  // Match the actual Node build rather than treating warning text as a protocol requirement.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', 'import "node:sqlite";'],
    { encoding: 'utf8', windowsHide: true, env: getDefaultEnvironment() });
  assert.equal(probe.status, 0);
  const expectsWarning = /ExperimentalWarning: SQLite/.test(probe.stderr);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wallpaper-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'catalog.sqlite');
  const writer = new SqliteCatalogRepository(db);
  new Catalog(writer).commit(snapshot());
  writer.close();
  const before = await readFile(db);
  for (const modern of [false, true]) {
    const session = await stdio(db, modern);
    try {
      assert.deepEqual((await session.client.listTools()).tools.map(v => v.name).sort(), toolNames);
      const reader = new SqliteCatalogRepository(db, true);
      try {
        const direct = new Catalog(reader);
        assertCatalogView(await session.client.callTool({ name: 'catalog_status' }), direct.status(), 'catalog_status');
        assertCatalogView(await session.client.callTool({ name: 'list_wallpapers' }), direct.listWallpapers(), 'list_wallpapers');
        assertCatalogView(await session.client.callTool({ name: 'get_playlist', arguments: { id: 'pl_a' } }), direct.getPlaylist('pl_a'), 'get_playlist');
      } finally { reader.close(); }
      assert.equal((await session.client.callTool({ name: 'list_wallpapers', arguments: { limit: -1 } })).isError, true);
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
    assert.equal(/ExperimentalWarning: SQLite/.test(session.stderr()), expectsWarning);
    assert.deepEqual(await readFile(db), before);
    assert.deepEqual((await readdir(dir)).sort(), ['catalog.sqlite']);
  }
  const session = await stdio(db);
  try {
    const replacement = new SqliteCatalogRepository(db);
    new Catalog(replacement).commit({ ...snapshot(), wallpapers: [] });
    replacement.close();
    assert.equal(structured(await session.client.callTool({ name: 'catalog_status' })).indexRevision, 2);
    assertError(await session.client.callTool({ name: 'list_wallpapers', arguments: { revision: 1 } }), 'REVISION_CHANGED');
  } finally { await session.close(); }
});

test('missing and empty indexes give actionable errors and never create a file; an explicit later scan is visible', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wallpaper-mcp-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'not-created', 'catalog.sqlite');
  const session = await stdio(db);
  try {
    assert.equal((await session.client.listTools()).tools.length, 6);
    const status = await session.client.callTool({ name: 'catalog_status' });
    assert.deepEqual(status.structuredContent, openReadOnlyCatalog(db).status());
    assert.equal(structured(status).data.indexed, false);
    const missing = await session.client.callTool({ name: 'list_wallpapers' });
    assertError(missing, 'INDEX_EMPTY');
    assert.match(structured(missing).error.recovery, /CLI scan.*same --db/);
    assert.deepEqual(await readdir(dir), []);
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }

  const emptyDb = path.join(dir, 'empty.sqlite');
  const emptyWriter = new SqliteCatalogRepository(emptyDb);
  emptyWriter.close();
  const empty = await stdio(emptyDb);
  try {
    assert.equal(structured(await empty.client.callTool({ name: 'catalog_status' })).data.indexed, false);
    assertError(await empty.client.callTool({ name: 'get_playlist', arguments: { id: 'pl_a' } }), 'INDEX_EMPTY');
    const writer = new SqliteCatalogRepository(emptyDb);
    new Catalog(writer).commit(snapshot());
    writer.close();
    assert.equal(structured(await empty.client.callTool({ name: 'catalog_status' })).data.indexed, true);
  } finally { await empty.close(); }
});

test('invalid databases and unexpected domain errors do not leak raw exceptions or damage the file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wallpaper-mcp-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'invalid.sqlite');
  await writeFile(db, 'synthetic invalid SQLite');
  const session = await stdio(db);
  try {
    const response = await session.client.callTool({ name: 'catalog_status' });
    assertError(response, 'INDEX_UNAVAILABLE');
    assert.ok(!JSON.stringify(response).includes(dir));
    assert.equal(await readFile(db, 'utf8'), 'synthetic invalid SQLite');
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  const broken = memoryCatalog();
  broken.status = () => { throw new Error('private raw path and database exception'); };
  const memory = await inMemory(broken);
  try {
    const response = await memory.client.callTool({ name: 'catalog_status' });
    assertError(response, 'INDEX_UNAVAILABLE');
    assert.ok(!JSON.stringify(response).includes('private raw path'));
  } finally { await memory.close(); }
});

test('help and invalid startup arguments leave stdout empty; EOF exits promptly', async () => {
  for (const [args, code] of [[['--help'], 0], [['--unknown-private-argument'], 1], [['--db', ''], 1], [['unexpected'], 1], [[], 0]] as const) {
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, stdio: 'pipe' });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdin.end();
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI failed to exit after stdin EOF')); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(exit, code);
    assert.equal(stdout, '');
    if (args.length) assert.ok(stderr.length > 0);
    assert.ok(!stderr.includes('--unknown-private-argument'));
  }
});
