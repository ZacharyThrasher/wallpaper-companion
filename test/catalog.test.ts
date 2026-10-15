import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../src/catalog.js';
import { scan, selectProfile } from '../src/adapters/scanner.js';
import { discover, parseVdf, type SourceLocations } from '../src/adapters/steam.js';
import { SqliteCatalogRepository } from '../src/adapters/sqlite.js';
import { projectTarget, readJson, relativeTarget } from '../src/adapters/files.js';
import { assertSafeDatabasePath, run } from '../src/cli.js';

async function write(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallpaper-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const install = path.join(dir, 'engine'); const workshop = path.join(dir, 'workshop');
  const scene = path.join(workshop, '100'); const video = path.join(workshop, '200');
  const web = path.join(install, 'projects', 'myprojects', 'sample');
  await write(path.join(scene, 'project.json'), { title: 'Synthetic Scene', type: 'Scene', file: 'scene.json', preview: 'preview.png', tags: ['Quiet', 'Blue'], custom: { enabled: true } });
  await write(path.join(scene, 'scene.pkg'), 'packed synthetic scene');
  await write(path.join(scene, 'preview.png'), 'synthetic preview');
  await write(path.join(video, 'project.json'), { title: 'Synthetic Video', type: 'Video', file: 'clip.mp4', tags: 'Blue, Motion' });
  await write(path.join(video, 'clip.mp4'), 'synthetic video');
  await write(path.join(web, 'project.json'), { title: 'Synthetic Web', type: 'Web', file: 'index.html' });
  await write(path.join(web, 'index.html'), '<html></html>');
  const staleProject = path.join(workshop, '300', 'project.json');
  const cache = { user: 'synthetic', version: 1, wallpapers: [
    { workshopid: '100', title: 'Cached Scene', type: 'Scene', project: path.join(scene, 'project.json'), file: path.join(scene, 'scene.pkg'), favorite: true, unknown: 42 },
    { workshopid: '300', title: 'Synthetic stale cache', type: 'Video', project: staleProject, file: path.join(workshop, '300', 'missing.mp4') }
  ] };
  const config = {
    '?installdirectory': install,
    Other: { general: { playlists: [{ name: 'Other synthetic list', items: [] }] } },
    Tester: { general: { playlists: [{ name: 'Synthetic Mix', items: [
      path.join(scene, 'scene.pkg').replaceAll(path.sep, '/').toUpperCase(),
      { file: path.join(video, 'clip.mp4'), preset: { hue: 0.5 }, daytimeend: '18:30', extra: ['keep'] },
      { file: path.join(workshop, '999', 'missing.mp4'), preset: 'missing preset' },
      { futureFormat: 5 }, 17, path.join(scene, 'project.json')
    ], settings: { order: 'random', future: true }, futurePlaylist: { retain: true } }],
    wallpaperconfig: { selectedwallpapers: { monitorA: { playlist: { name: 'Active only', items: [] } } } } } }
  };
  await write(path.join(install, 'config.json'), config);
  await write(path.join(install, 'bin', 'workshopcache.json'), cache);
  const locations: SourceLocations = { installDir: install, workshopDirs: [workshop], protectedRoots: [install, workshop] };
  return { dir, install, workshop, scene, video, web, config, cache, locations };
}
const options = { username: 'Tester', now: () => new Date('2026-01-01T00:00:00Z') };
async function treeHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else hashes[path.relative(root, filename)] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    }
  }
  await walk(root); return hashes;
}
async function cli(args: string[]) {
  let output = ''; const code = await run([...args, '--json'], text => { output += text; });
  return { code, body: JSON.parse(output) };
}

test('mixed playlists, packed scenes, cache reconciliation, unknown metadata, and exact source hashes', async t => {
  const f = await fixture(t); const before = await treeHashes(f.dir);
  const s = await scan(f.locations, options);
  assert.equal(s.wallpapers.length, 4);
  const scene = s.wallpapers.find(w => w.workshopId === '100')!;
  assert.equal(scene.availability, 'available');
  assert.equal(scene.playableTarget, path.join(f.scene, 'project.json'));
  assert.equal(scene.preview, path.join(f.scene, 'preview.png'));
  assert.deepEqual(scene.metadata.project?.custom, { enabled: true });
  assert.equal(scene.metadata.cache[0]?.unknown, 42);
  assert.equal(scene.provenance.length, 2);
  assert.ok(scene.provenance.every(p => p.subscription === 'unknown'));
  const stale = s.wallpapers.find(w => w.workshopId === '300')!;
  assert.equal(stale.availability, 'missing'); assert.equal(stale.playableTarget, null);
  assert.equal(s.playlists.length, 1); // Active and other-user lists must not leak in.
  const p = s.playlists[0]!;
  assert.equal(p.items.length, 6);
  assert.deepEqual(p.items.map(i => i.position), [0, 1, 2, 3, 4, 5]);
  assert.equal(p.items[0]?.wallpaperId, scene.id); assert.equal(p.items[5]?.wallpaperId, scene.id);
  assert.deepEqual(p.items[1]?.preset, { hue: 0.5 }); assert.equal(p.items[1]?.daytimeend, '18:30');
  assert.deepEqual((p.items[1]?.raw as { extra: string[] }).extra, ['keep']);
  assert.deepEqual(p.settings, { order: 'random', future: true });
  assert.deepEqual(p.raw.futurePlaylist, { retain: true });
  assert.equal(p.items[2]?.resolution, 'unresolved'); assert.equal(p.items[4]?.raw, 17);
  assert.deepEqual(await treeHashes(f.dir), before);
  for (const source of s.sourceFiles) assert.equal(source.sha256, before[path.relative(f.dir, source.path)]);
});

test('profile selection never guesses the first object, and rejects ambiguous usernames', () => {
  const config = { '?installdirectory': 'synthetic', Other: {}, Tester: {} };
  assert.equal(selectProfile(config, undefined, 'tester'), 'Tester');
  assert.equal(selectProfile(config, 'Other', 'Tester'), 'Other');
  assert.throws(() => selectProfile(config, undefined, 'Unknown'), { code: 'PROFILE_REQUIRED' });
  assert.throws(() => selectProfile({ Tester: {}, TESTER: {} }, undefined, 'tester'), { code: 'PROFILE_REQUIRED' });
  assert.throws(() => selectProfile(config, 'Missing', 'Tester'), { code: 'PROFILE_NOT_FOUND' });
});

test('stable opaque identities, filters, deterministic pagination, preview by ID, and revision guard', async t => {
  const f = await fixture(t); const repo = new SqliteCatalogRepository(':memory:'); t.after(() => repo.close());
  const s = await scan(f.locations, options); const c = new Catalog(repo); c.commit(s);
  const all = c.listWallpapers({ limit: 500 });
  const first = c.listWallpapers({ limit: 2 }); const rest = c.listWallpapers({ offset: 2, limit: 2, revision: 1 });
  assert.deepEqual([...first.data, ...rest.data].map(w => w.id), all.data.map(w => w.id));
  assert.equal(first.pagination.nextOffset, 2); assert.equal(rest.pagination.nextOffset, null);
  assert.equal(c.listWallpapers({ type: 'SCENE', tag: 'blue', search: 'synthetic', availability: 'available' }).data.length, 1);
  assert.equal(c.listPlaylists({ search: 'mix' }).data.length, 1);
  assert.equal(c.getPlaylist(s.playlists[0]!.id).data.name, 'Synthetic Mix');
  const scene = s.wallpapers.find(w => w.type === 'scene')!;
  assert.equal(c.getPreview(scene.id).data.path, scene.preview);
  assert.throws(() => c.getPreview('invalid'), { code: 'NOT_FOUND' });
  assert.throws(() => c.listWallpapers({ limit: 0 }), { code: 'INVALID_PAGINATION' });
  assert.throws(() => c.listWallpapers({ offset: -1 }), { code: 'INVALID_PAGINATION' });
  assert.throws(() => c.listWallpapers({ availability: 'maybe' }), { code: 'INVALID_FILTER' });
  // Renaming metadata does not change identities or ordering.
  await write(path.join(f.video, 'project.json'), { title: 'Renamed synthetic video', type: 'video', file: 'clip.mp4' });
  const next = await scan(f.locations, options); c.commit(next);
  assert.deepEqual(next.wallpapers.map(w => w.id), s.wallpapers.map(w => w.id));
  assert.throws(() => c.listWallpapers({ revision: 1 }), { code: 'REVISION_CHANGED' });
  assert.equal(c.status().indexRevision, 2);
});

test('malformed projects, unsupported types, missing media, and path traversal are explicit diagnostics', async t => {
  const f = await fixture(t);
  await write(path.join(f.workshop, '400', 'project.json'), '{broken');
  await write(path.join(f.workshop, '500', 'project.json'), { title: 'Unsafe', type: 'video', file: '..\\secret.mp4' });
  await write(path.join(f.workshop, '600', 'project.json'), { title: 'Unknown', type: 'future', file: 'future.bin' });
  await write(path.join(f.workshop, '700', 'project.json'), { title: 'Incomplete', type: 'video' });
  await fs.unlink(path.join(f.video, 'clip.mp4'));
  const s = await scan(f.locations, options);
  assert.equal(s.wallpapers.find(w => w.workshopId === '200')?.availability, 'missing');
  assert.equal(s.wallpapers.find(w => w.workshopId === '500')?.playableTarget, null);
  assert.equal(s.wallpapers.find(w => w.workshopId === '600')?.availability, 'unsupported');
  for (const code of ['PATH_ESCAPE', 'PROJECT_MALFORMED', 'PROJECT_SCHEMA', 'PROJECT_TYPE_UNKNOWN']) assert.ok(s.diagnostics.some(d => d.code === code));
  for (const value of ['../outside', '..\\outside', 'C:\\outside', '/outside', 'C:outside', 'file:stream', '\\outside']) {
    assert.throws(() => relativeTarget(f.scene, value), { code: 'PATH_ESCAPE' });
  }
  assert.equal(relativeTarget(f.scene, 'sub\\file.txt'), path.join(f.scene, 'sub', 'file.txt'));
});

test('fatal config/cache schemas and scan errors preserve the last committed snapshot and DB bytes', async t => {
  const f = await fixture(t); const db = path.join(f.dir, 'index.sqlite');
  // Explicit profile avoids reliance on the test machine username in CLI integration.
  const args = ['scan', '--install-dir', f.install, '--workshop-dir', f.workshop, '--profile', 'Tester', '--db', db];
  assert.equal((await cli(args)).code, 0);
  const before = await fs.readFile(db);
  for (const invalid of ['{', { Tester: { general: { playlists: {} } } }, { Tester: { general: { playlists: [{ name: 'bad' }] } } }, { Unknown: {} }]) {
    await write(path.join(f.install, 'config.json'), invalid);
    const failed = await cli(args); assert.equal(failed.code, 1);
    assert.deepEqual(await fs.readFile(db), before);
    assert.equal((await cli(['status', '--db', db])).body.indexRevision, 1);
  }
  await write(path.join(f.install, 'config.json'), f.config);
  await write(path.join(f.install, 'bin', 'workshopcache.json'), { futureCache: [] });
  assert.equal((await cli(args)).body.error.code, 'CACHE_SCHEMA');
  assert.deepEqual(await fs.readFile(db), before);
});

test('SQLite rollback leaves old data readable and unrelated databases are rejected', async t => {
  const f = await fixture(t); const db = path.join(f.dir, 'catalog.sqlite');
  const repo = new SqliteCatalogRepository(db);
  try {
  const s = await scan(f.locations, options); repo.replace(s);
  const control = new DatabaseSync(db);
  control.exec(`CREATE TRIGGER fail_snapshot BEFORE UPDATE ON catalog_snapshot BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
  control.close();
  assert.throws(() => repo.replace({ ...s, wallpapers: [] }), /synthetic failure/);
  assert.equal(repo.read()?.indexRevision, 1); assert.equal(repo.read()?.wallpapers.length, 4);
  const unrelated = path.join(f.dir, 'unrelated.sqlite');
  const other = new DatabaseSync(unrelated); other.exec('CREATE TABLE unrelated (id INTEGER)'); other.close();
  const before = await fs.readFile(unrelated);
  assert.throws(() => new SqliteCatalogRepository(unrelated), { code: 'INDEX_SCHEMA' });
  assert.deepEqual(await fs.readFile(unrelated), before);
  } finally { repo.close(); }
});

test('database source-tree and junction guards, and project symlink escapes', async t => {
  const f = await fixture(t);
  await assert.rejects(assertSafeDatabasePath(path.join(f.scene, 'catalog.sqlite'), [f.workshop]), { code: 'UNSAFE_DATABASE_PATH' });
  await fs.mkdir(path.join(f.dir, 'outside'));
  // Windows junctions do not require developer-mode symlink privileges.
  await fs.symlink(path.join(f.dir, 'outside'), path.join(f.scene, 'link'), 'junction');
  await assert.rejects(projectTarget(f.scene, 'link/missing.png'), { code: 'PATH_ESCAPE' });
  await fs.symlink(f.workshop, path.join(f.dir, 'workshop-alias'), 'junction');
  await assert.rejects(assertSafeDatabasePath(path.join(f.dir, 'workshop-alias', 'catalog.sqlite'), [f.workshop]), { code: 'UNSAFE_DATABASE_PATH' });
});

test('discovery reads modern and legacy Steam libraries and validates manifests', async t => {
  const f = await fixture(t); const steam = path.join(f.dir, 'steam'); const library = path.join(f.dir, 'library');
  // JSON.stringify provides the same backslash escaping used by quoted VDF strings.
  await write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" ${JSON.stringify(steam)} } "1" ${JSON.stringify(library)} }`);
  await write(path.join(library, 'steamapps', 'appmanifest_431960.acf'), '"AppState" { "appid" "431960" "installdir" "wallpaper_engine" }');
  const locations = await discover({ steamPath: steam });
  assert.equal(locations.installDir, path.join(library, 'steamapps', 'common', 'wallpaper_engine'));
  assert.equal(locations.workshopDirs.length, 2);
  await write(path.join(steam, 'steamapps', 'appmanifest_431960.acf'), '"AppState" { "appid" "431960" "installdir" "wallpaper_engine" }');
  await assert.rejects(discover({ steamPath: steam }), { code: 'INSTALL_AMBIGUOUS' });
  await write(path.join(library, 'steamapps', 'appmanifest_431960.acf'), '"AppState" { "appid" "431960" "installdir" "../escape" }');
  await assert.rejects(discover({ steamPath: steam }), { code: 'PATH_ESCAPE' });
  for (const bad of ['"x" {', '"x" "unclosed', '}', '"x" "a" "x" "b"', '"x"', '{ "x" "y" }']) assert.throws(() => parseVdf(bad), { code: 'MALFORMED_VDF' });
  assert.deepEqual(JSON.parse(JSON.stringify(parseVdf('// comment\n"x" { "quoted" "}" }'))), { x: { quoted: '}' } });
});

test('direct install override discovers its Workshop library without a Steam override', async t => {
  const f = await fixture(t); const library = path.join(f.dir, 'separate-library');
  const installDir = path.join(library, 'steamapps', 'common', 'wallpaper_engine');
  await fs.mkdir(installDir, { recursive: true });
  const locations = await discover({ installDir });
  assert.equal(locations.installDir, installDir);
  assert.deepEqual(locations.workshopDirs, [path.join(library, 'steamapps', 'workshop', 'content', '431960')]);
  // A real scan must see content there rather than downgrade everything to cache-only.
  const project = path.join(locations.workshopDirs[0]!, '800');
  await write(path.join(project, 'project.json'), { title: 'Synthetic inferred Workshop', type: 'video', file: 'clip.mp4' });
  await write(path.join(project, 'clip.mp4'), 'synthetic');
  const snapshot = await scan(locations, options);
  assert.equal(snapshot.wallpapers.length, 1);
  assert.equal(snapshot.wallpapers[0]?.availability, 'available');
});

test('effective project-root junctions are protected from database writes', async t => {
  const f = await fixture(t); const external = path.join(f.dir, 'external-projects');
  await fs.mkdir(external);
  await fs.symlink(external, path.join(f.install, 'projects', 'defaultprojects'), 'junction');
  const locations = await discover({ installDir: f.install, workshopDir: f.workshop });
  const db = path.join(external, 'catalog.sqlite');
  await assert.rejects(assertSafeDatabasePath(db, locations.protectedRoots), { code: 'UNSAFE_DATABASE_PATH' });
  const result = await cli(['scan', '--install-dir', f.install, '--workshop-dir', f.workshop, '--profile', 'Tester', '--db', db]);
  assert.equal(result.body.error.code, 'UNSAFE_DATABASE_PATH');
  await assert.rejects(fs.stat(db), { code: 'ENOENT' });
});

test('CLI JSON envelopes, strict arguments, empty status, process smoke test, and query read-only hashes', async t => {
  const f = await fixture(t); const db = path.join(f.dir, 'index.sqlite');
  const empty = await cli(['status', '--db', db]);
  assert.equal(empty.body.data.indexed, false); await assert.rejects(fs.stat(db), { code: 'ENOENT' });
  const args = ['scan', '--db', db, '--install-dir', f.install, '--workshop-dir', f.workshop, '--profile', 'Tester'];
  const scanned = await cli(args); assert.equal(scanned.code, 0); assert.equal(scanned.body.schemaVersion, 1);
  const hashes = await treeHashes(f.dir);
  const listed = await cli(['list-wallpapers', '--db', db, '--limit', '2']);
  assert.equal(listed.body.data.length, 2); assert.equal(listed.body.pagination.total, 4);
  const found = await cli(['get-wallpaper', listed.body.data[0].id, '--db', db]); assert.equal(found.code, 0);
  assert.equal((await cli(['list-playlists', '--db', db])).body.data.length, 1);
  assert.equal((await cli(['get-playlist', scanned.body.data.id ?? 'unknown', '--db', db])).body.error.code, 'NOT_FOUND');
  for (const invalid of [['status', '--type', 'scene'], ['get-wallpaper'], ['status', '--unknown'], ['list-wallpapers', '--limit', '1.2'], ['list-wallpapers', '--offset', '-1']]) {
    assert.equal((await cli([...invalid, '--db', db])).code, 1);
  }
  assert.deepEqual(await treeHashes(f.dir), hashes);
  const child = spawnSync(process.execPath, [path.resolve('dist/src/cli.js'), 'status', '--db', db, '--json'], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).data.wallpapers, 4);
  assert.equal((await cli(['scan', '--install-dir', f.install, '--db', path.join(f.install, 'bad.sqlite')])).body.error.code, 'UNSAFE_DATABASE_PATH');
});

test('bounded JSON reads, BOM fingerprints, optional sources, and new scans with no config', async t => {
  const f = await fixture(t);
  const huge = path.join(f.dir, 'huge.json'); const h = await fs.open(huge, 'w'); await h.truncate(32 * 1024 * 1024 + 1); await h.close();
  await assert.rejects(readJson(huge), { code: 'SOURCE_TOO_LARGE' });
  await fs.writeFile(path.join(f.install, 'config.json'), '\uFEFF' + JSON.stringify(f.config));
  const s = await scan(f.locations, options);
  const source = s.sourceFiles.find(s => s.path.endsWith('config.json'))!;
  assert.equal(source.sha256, createHash('sha256').update(await fs.readFile(source.path)).digest('hex'));
  await fs.unlink(path.join(f.install, 'config.json')); await fs.unlink(path.join(f.install, 'bin', 'workshopcache.json'));
  const noConfig = await scan(f.locations, options);
  assert.equal(noConfig.playlists.length, 0); assert.equal(noConfig.wallpapers.length, 3);
  assert.ok(noConfig.diagnostics.some(d => d.code === 'CONFIG_MISSING'));
  await assert.rejects(scan({ ...f.locations, installDir: path.join(f.dir, 'absent') }, options));
});
