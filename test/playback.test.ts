import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Catalog } from '../src/catalog.js';
import { scan } from '../src/adapters/scanner.js';
import { SqliteCatalogRepository } from '../src/adapters/sqlite.js';
import { PlaybackService, PlaybackError, execFileRunner, type ProcessRequest, type ProcessResult } from '../src/playback/index.js';
import { normalizeCurrentOutput } from '../src/playback/targets.js';
import { runningExecutable, windowsProcessInspector } from '../src/playback/runtime.js';
import type { SourceLocations } from '../src/adapters/steam.js';

async function write(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallpaper-playback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const install = path.join(dir, 'engine'); const workshop = path.join(dir, 'workshop');
  const scene = path.join(workshop, '100'); const video = path.join(workshop, '200');
  const exe = path.join(install, 'wallpaper64.exe');
  await write(exe, 'synthetic executable; never executed');
  await write(path.join(scene, 'project.json'), { title: 'Synthetic scene', type: 'scene', file: 'scene.json' });
  await write(path.join(scene, 'scene.pkg'), 'synthetic scene');
  await write(path.join(video, 'project.json'), { title: 'Synthetic video', type: 'video', file: 'a & b; $(ignored).mp4' });
  await write(path.join(video, 'a & b; $(ignored).mp4'), 'synthetic video');
  const config = { Tester: { general: { playlists: [{ name: 'Synthetic & mix; $(ignored)', items: [path.join(scene, 'scene.pkg')] }] } } };
  await write(path.join(install, 'config.json'), config);
  const locations: SourceLocations = { installDir: install, workshopDirs: [workshop], protectedRoots: [install, workshop] };
  const repo = new SqliteCatalogRepository(':memory:'); t.after(() => repo.close());
  const catalog = new Catalog(repo); const snapshot = await scan(locations, { username: 'Tester' }); catalog.commit(snapshot);
  const sceneRow = snapshot.wallpapers.find(w => w.type === 'scene')!;
  const videoRow = snapshot.wallpapers.find(w => w.type === 'video')!;
  const playlist = snapshot.playlists[0]!;
  const calls: ProcessRequest[] = [];
  let current = path.join(scene, 'scene.pkg');
  let running: readonly string[] = [exe];
  let handler: ((r: ProcessRequest) => Promise<ProcessResult>) | undefined;
  const runner = async (r: ProcessRequest) => {
    calls.push(r);
    if (handler) return handler(r);
    if (r.args[1] === 'getWallpaper') return { stdout: current, stderr: '', exitCode: 0 };
    if (r.args[1] === 'openWallpaper') current = r.args[3]!;
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const service = new PlaybackService({ catalog, discover: async () => locations, runner,
    inspectProcesses: async () => running, wait: async () => {}, username: 'Tester' });
  return { dir, install, workshop, scene, video, exe, config, locations, catalog, snapshot, sceneRow, videoRow, playlist, calls, service,
    setCurrent: (value: string) => { current = value; }, setRunning: (value: readonly string[]) => { running = value; },
    setHandler: (value: typeof handler) => { handler = value; } };
}
const ok = (stdout = ''): ProcessResult => ({ stdout, stderr: '', exitCode: 0 });

test('readCurrent normalizes path output without disclosing paths, including packed Scene aliases', async t => {
  const f = await fixture(t);
  f.setCurrent(`\uFEFF "${path.join(f.scene, 'scene.pkg').replaceAll('\\', '/').toUpperCase()}"\r\n`);
  const result = await f.service.readCurrent({ monitor: 0 });
  assert.equal(result.state, 'known'); assert.equal(result.wallpaperId, f.sceneRow.id); assert.equal(result.monitor, 0);
  assert.equal(JSON.stringify(result).includes(f.dir), false);
  assert.deepEqual(f.calls[0]?.args, ['-control', 'getWallpaper', '-monitor', '0']);
  f.setCurrent(path.join(f.dir, 'private-unindexed.mp4'));
  assert.equal((await f.service.readCurrent()).state, 'unindexed');
  f.setCurrent(''); assert.equal((await f.service.readCurrent()).state, 'none');
  for (const output of ['Error: private file missing', 'C:\\private.mp4\nwarning', 'relative.mp4', '"C:\\private.mp4']) {
    f.setCurrent(output); await assert.rejects(f.service.readCurrent(), { code: 'CURRENT_INVALID' });
  }
  assert.equal(normalizeCurrentOutput('"C:/Synthetic/PROJECT.JSON"\r\n'), 'c:\\synthetic\\project.json');
  assert.equal(normalizeCurrentOutput('\\\\?\\C:\\Synthetic\\PROJECT.JSON'), 'c:\\synthetic\\project.json');
});

test('wallpaper actions use fixed executable, argument arrays, monitor bounds, and canonical catalog media', async t => {
  const f = await fixture(t);
  const result = await f.service.applyWallpaper({ wallpaperId: f.videoRow.id, monitor: 63 });
  assert.equal(result.accepted, true); assert.equal(result.verification, 'target-observed'); assert.equal(result.changeObserved, true);
  assert.equal(result.previous.wallpaperId, f.sceneRow.id); assert.equal(result.current.wallpaperId, f.videoRow.id);
  const command = f.calls.find(c => c.args[1] === 'openWallpaper')!;
  assert.equal(command.executable, await fs.realpath(f.exe));
  assert.deepEqual(command.args, ['-control', 'openWallpaper', '-file', await fs.realpath(f.videoRow.playableTarget!), '-monitor', '63']);
  for (const call of f.calls) { assert.equal(call.shell, false); assert.equal(call.timeoutMs, 3000); assert.equal(call.maxOutputBytes, 65536); }
  assert.equal(JSON.stringify(result).includes(f.dir), false);
  const same = await f.service.applyWallpaper({ wallpaperId: f.videoRow.id });
  assert.equal(same.verification, 'target-observed'); assert.equal(same.changeObserved, false);
  const scene = await f.service.applyWallpaper({ wallpaperId: f.sceneRow.id });
  assert.equal(scene.verification, 'target-observed');
  assert.equal(f.calls.filter(c => c.args[1] === 'openWallpaper').at(-1)?.args[3], await fs.realpath(f.sceneRow.projectPath));
});

test('invalid IDs, unknown fields, raw path injection, and invalid monitors fail before invoking any process', async t => {
  const f = await fixture(t);
  for (const id of ['', '-control pause', 'wp_' + 'a'.repeat(31), 'C:\\private.mp4']) {
    await assert.rejects(f.service.applyWallpaper({ wallpaperId: id }), { code: 'INVALID_ID' });
  }
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: 'wp_' + 'f'.repeat(32) }), { code: 'NOT_FOUND' });
  await assert.rejects(f.service.activatePlaylist({ playlistId: 'wp_' + 'f'.repeat(32) }), { code: 'INVALID_ID' });
  for (const monitor of [-1, 64, 1.5, NaN, Infinity, '0', null]) {
    await assert.rejects(f.service.readCurrent({ monitor } as never), { code: 'INVALID_MONITOR' });
  }
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.sceneRow.id, executable: 'cmd.exe' } as never), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.service.nextWallpaper({ args: ['-control', 'stop'] } as never), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.service.pause({ monitor: 0 } as never), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.service.readCurrent(null as never), { code: 'INVALID_REQUEST' });
  assert.equal(f.calls.length, 0);
});

test('default read/apply/playlist share explicit first monitor when the primary monitor differs', async t => {
  const f = await fixture(t);
  let first = path.join(f.scene, 'scene.pkg');
  const primary = f.videoRow.playableTarget!;
  f.setHandler(async r => {
    const monitorFlag = r.args.indexOf('-monitor');
    const monitor = monitorFlag === -1 ? undefined : Number(r.args[monitorFlag + 1]);
    if (r.args[1] === 'getWallpaper') return ok(monitor === 0 ? first : primary);
    if (r.args[1] === 'openWallpaper') { assert.equal(monitor, 0); first = r.args[3]!; }
    if (r.args[1] === 'openPlaylist') assert.equal(monitor, 0);
    return ok();
  });
  const read = await f.service.readCurrent();
  assert.equal(read.wallpaperId, f.sceneRow.id); assert.equal(read.monitor, 0);
  const same = await f.service.applyWallpaper({ wallpaperId: f.sceneRow.id });
  assert.equal(same.previous.wallpaperId, f.sceneRow.id); assert.equal(same.previous.monitor, 0);
  assert.equal(same.verification, 'target-observed'); assert.equal(same.changeObserved, false); assert.equal(same.monitor, 0);
  const changed = await f.service.applyWallpaper({ wallpaperId: f.videoRow.id });
  assert.equal(changed.previous.wallpaperId, f.sceneRow.id); assert.equal(changed.verification, 'target-observed'); assert.equal(changed.changeObserved, true);
  const playlist = await f.service.activatePlaylist({ playlistId: f.playlist.id });
  assert.equal(playlist.monitor, 0); assert.equal(playlist.previous?.monitor, 0);
  const global = await f.service.nextWallpaper();
  assert.equal(global.monitor, null); assert.equal(global.previous?.monitor, null);
  assert.deepEqual(f.calls.at(-1)?.args, ['-control', 'nextWallpaper']);
});

test('missing files, stale metadata, fabricated paths, and canonical escapes cannot launch', async t => {
  const f = await fixture(t);
  await fs.unlink(f.videoRow.playableTarget!);
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.videoRow.id }), { code: 'TARGET_MISSING' });
  await write(f.videoRow.playableTarget!, 'synthetic');
  await write(f.videoRow.projectPath, { title: 'Changed', type: 'video', file: '..\\escape.mp4' });
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.videoRow.id }), { code: 'TARGET_INVALID' });
  await write(f.videoRow.projectPath, { title: 'Changed', type: 'video', file: 'changed.mp4' });
  await write(path.join(f.video, 'changed.mp4'), 'synthetic');
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.videoRow.id }), { code: 'TARGET_INVALID' });
  const original = f.sceneRow.playableTarget;
  f.sceneRow.playableTarget = path.join(f.dir, 'elsewhere.mp4'); f.catalog.commit(f.snapshot);
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.sceneRow.id }), { code: 'TARGET_INVALID' });
  f.sceneRow.playableTarget = original; f.catalog.commit(f.snapshot);
  await fs.unlink(path.join(f.scene, 'scene.pkg'));
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.sceneRow.id }), { code: 'TARGET_MISSING' });
  assert.equal(f.calls.length, 0);
  // Directory junctions are available without symlink privileges on Windows.
  const outside = path.join(f.dir, 'outside'); await write(path.join(outside, 'project.json'), { title: 'Escape', type: 'scene', file: 'scene.pkg' });
  await write(path.join(outside, 'scene.pkg'), 'synthetic');
  const link = path.join(f.workshop, 'redirect'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.sceneRow.projectPath = path.join(link, 'project.json'); f.sceneRow.playableTarget = f.sceneRow.projectPath; f.catalog.commit(f.snapshot);
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.sceneRow.id }), { code: 'TARGET_INVALID' });
});

test('only an existing executable from the discovered installation and matching running architecture is used', async t => {
  const f = await fixture(t);
  f.setRunning([]); await assert.rejects(f.service.pause(), { code: 'NOT_RUNNING' });
  f.setRunning([path.join(f.dir, 'unexpected', 'wallpaper64.exe')]);
  await write(path.join(f.dir, 'unexpected', 'wallpaper64.exe'), 'synthetic other installation');
  await assert.rejects(f.service.play(), { code: 'NOT_RUNNING' });
  const exe32 = path.join(f.install, 'wallpaper32.exe'); await write(exe32, 'synthetic');
  f.setRunning([exe32]); await f.service.pause(); assert.equal(f.calls.at(-1)?.executable, await fs.realpath(exe32));
  await fs.unlink(f.exe); await fs.unlink(exe32);
  await assert.rejects(f.service.pause(), { code: 'INSTALL_INVALID' });
  await fs.mkdir(f.exe); await assert.rejects(f.service.pause(), { code: 'INSTALL_INVALID' });
  assert.equal(f.calls.length, 1);
});

test('targets and the running process are rechecked after pre-observation and before sending commands', async t => {
  const f = await fixture(t);
  f.setHandler(async r => {
    if (r.args[1] === 'getWallpaper') { await fs.unlink(f.videoRow.playableTarget!); return ok(path.join(f.scene, 'scene.pkg')); }
    return ok();
  });
  await assert.rejects(f.service.applyWallpaper({ wallpaperId: f.videoRow.id }), { code: 'TARGET_MISSING', mayHaveApplied: false });
  assert.deepEqual(f.calls.map(c => c.args[1]), ['getWallpaper']);
  let inspections = 0;
  const service = new PlaybackService({ catalog: f.catalog, discover: async () => f.locations,
    inspectProcesses: async () => ++inspections === 1 ? [f.exe] : [],
    runner: async () => { assert.fail('An exited engine must not be invoked'); } });
  await assert.rejects(service.pause(), { code: 'NOT_RUNNING', mayHaveApplied: false });
});

test('discovery/process errors and executable junction escapes are redacted', async t => {
  const f = await fixture(t);
  const service = new PlaybackService({ catalog: f.catalog, discover: async () => { throw new Error(f.dir); } });
  await assert.rejects(service.readCurrent(), error => error instanceof PlaybackError && error.code === 'DISCOVERY_FAILED' && !String(error).includes(f.dir));
  await assert.rejects(runningExecutable(f.locations, async () => { throw new Error(f.dir); }), { code: 'PROCESS_CHECK_FAILED' });
  // A linked installation directory is accepted, while a linked executable directory entry outside it is rejected.
  const outside = path.join(f.dir, 'outside-executables'); await write(path.join(outside, 'wallpaper64.exe'), 'synthetic');
  const installLink = path.join(f.dir, 'install-link'); await fs.symlink(outside, installLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await runningExecutable({ ...f.locations, installDir: installLink }, async () => [path.join(outside, 'wallpaper64.exe')]), await fs.realpath(path.join(outside, 'wallpaper64.exe')));
  await fs.unlink(f.exe); await fs.mkdir(f.exe);
  await assert.rejects(runningExecutable(f.locations, async () => [f.exe]), { code: 'INSTALL_INVALID' });
});

test('acceptance is distinct from bounded delayed observation and failed verification', async t => {
  const f = await fixture(t); let reads = 0;
  f.setHandler(async r => r.args[1] === 'getWallpaper' ? ok(++reads < 4 ? path.join(f.scene, 'scene.pkg') : f.videoRow.playableTarget!) : ok());
  const delayed = await f.service.applyWallpaper({ wallpaperId: f.videoRow.id });
  assert.equal(delayed.verification, 'target-observed'); assert.equal(reads, 4);
  f.calls.length = 0;
  f.setHandler(async r => ok(r.args[1] === 'getWallpaper' ? path.join(f.scene, 'scene.pkg') : ''));
  const unobserved = await f.service.applyWallpaper({ wallpaperId: f.videoRow.id });
  assert.equal(unobserved.accepted, true); assert.equal(unobserved.verification, 'not-observed'); assert.equal(unobserved.changeObserved, false);
  assert.equal(f.calls.filter(c => c.args[1] === 'getWallpaper').length, 5);
  let accepted = false;
  f.setHandler(async r => {
    if (r.args[1] === 'openWallpaper') { accepted = true; return ok(); }
    if (accepted) throw new Error(f.dir);
    return ok(path.join(f.scene, 'scene.pkg'));
  });
  const unavailable = await f.service.applyWallpaper({ wallpaperId: f.videoRow.id });
  assert.equal(unavailable.accepted, true); assert.equal(unavailable.verification, 'unavailable'); assert.equal(unavailable.changeObserved, null);
  assert.equal(unavailable.current.errorCode, 'COMMAND_FAILED'); assert.equal(JSON.stringify(unavailable).includes(f.dir), false);
});

test('playlist activation uses exact current known name, preserves previous ID, and never claims verification', async t => {
  const f = await fixture(t); const before = await fs.readFile(path.join(f.install, 'config.json'));
  const result = await f.service.activatePlaylist({ playlistId: f.playlist.id, monitor: 2 });
  assert.equal(result.verification, 'not-supported'); assert.equal(result.previous?.wallpaperId, f.sceneRow.id);
  assert.deepEqual(f.calls.at(-1)?.args, ['-control', 'openPlaylist', '-playlist', f.playlist.name, '-monitor', '2']);
  assert.equal(JSON.stringify(result).includes(f.playlist.name), false);
  assert.deepEqual(await fs.readFile(path.join(f.install, 'config.json')), before);
  f.config.Tester.general.playlists.push({ name: f.playlist.name.toUpperCase(), items: [] });
  await write(path.join(f.install, 'config.json'), f.config);
  await assert.rejects(f.service.activatePlaylist({ playlistId: f.playlist.id }), { code: 'PLAYLIST_AMBIGUOUS' });
  f.config.Tester.general.playlists = [{ name: 'renamed', items: [] }];
  await write(path.join(f.install, 'config.json'), f.config);
  await assert.rejects(f.service.activatePlaylist({ playlistId: f.playlist.id }), { code: 'PLAYLIST_STALE' });
  f.playlist.name = '-monitor 9'; f.catalog.commit(f.snapshot);
  await assert.rejects(f.service.activatePlaylist({ playlistId: f.playlist.id }), { code: 'PLAYLIST_STALE' });
  f.playlist.profile = 'Other'; f.catalog.commit(f.snapshot);
  await assert.rejects(f.service.activatePlaylist({ playlistId: f.playlist.id }), { code: 'PLAYLIST_STALE' });
});

test('pause/play are global and nextWallpaper is accepted without inferring playlist state', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.pause(), { action: 'pause', accepted: true, verification: 'not-supported', monitor: null });
  await f.service.play(); await f.service.nextWallpaper({ monitor: 1 }); await f.service.nextWallpaper();
  const mutations = f.calls.filter(c => c.args[1] !== 'getWallpaper').map(c => c.args);
  assert.deepEqual(mutations, [['-control', 'pause'], ['-control', 'play'], ['-control', 'nextWallpaper', '-monitor', '1'], ['-control', 'nextWallpaper']]);
});

test('timeouts, nonzero exits, oversized output, and private raw errors stay bounded and redacted', async t => {
  const f = await fixture(t);
  for (const [handler, code] of [
    [async () => { throw new PlaybackError('COMMAND_TIMEOUT', f.dir); }, 'COMMAND_TIMEOUT'],
    [async () => ({ stdout: f.dir, stderr: f.dir, exitCode: 7 }), 'COMMAND_FAILED'],
    [async () => ({ stdout: 'x'.repeat(65537), stderr: '', exitCode: 0 }), 'OUTPUT_LIMIT'],
    [async () => { throw new Error(f.dir); }, 'COMMAND_FAILED'],
  ] as const) {
    f.setHandler(handler);
    await assert.rejects(f.service.pause(), error => error instanceof PlaybackError && error.code === code && error.mayHaveApplied && !String(error).includes(f.dir));
    await assert.rejects(f.service.readCurrent(), error => error instanceof PlaybackError && error.code === code && !error.mayHaveApplied && !String(error).includes(f.dir));
  }
});

test('the actual execFile runner enforces timeout/output/exit boundaries without a shell', async () => {
  const run = (code: string, timeoutMs = 2000, maxOutputBytes = 1024) => execFileRunner({ executable: process.execPath,
    args: ['-e', code], timeoutMs, maxOutputBytes, shell: false });
  const literal = await execFileRunner({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '& echo injected; $(ignored)'], timeoutMs: 2000, maxOutputBytes: 1024, shell: false });
  assert.equal(literal.stdout, '& echo injected; $(ignored)');
  await assert.rejects(run('setInterval(() => {}, 1000)', 50), { code: 'COMMAND_TIMEOUT' });
  await assert.rejects(run('process.stdout.write("x".repeat(5000))'), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(run('process.stderr.write("private"); process.exit(9)'), error => error instanceof PlaybackError && error.code === 'COMMAND_FAILED' && !String(error).includes('private'));
});

test('Windows inspector uses a fixed bounded process query and handles empty, inaccessible, or malformed output', async () => {
  const requests: ProcessRequest[] = [];
  const inspect = windowsProcessInspector(async r => { requests.push(r); return ok('[]'); });
  if (process.platform !== 'win32') { await assert.rejects(inspect(), { code: 'UNSUPPORTED_PLATFORM' }); return; }
  assert.deepEqual(await inspect(), []);
  assert.equal(requests[0]?.shell, false); assert.equal(requests[0]?.timeoutMs, 5000);
  assert.ok(requests[0]?.args.includes('-NonInteractive')); assert.match(requests[0]!.args.at(-1)!, /SessionId/);
  const bad = windowsProcessInspector(async () => ok('{"private":"malformed"}'));
  await assert.rejects(bad(), { code: 'PROCESS_CHECK_FAILED' });
});

test('concurrent service calls serialize pre-observation/mutation/verification and recover after failure', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.service.applyWallpaper({ wallpaperId: f.videoRow.id }), f.service.applyWallpaper({ wallpaperId: f.sceneRow.id })]);
  assert.deepEqual(results.map(r => r.previous.wallpaperId), [f.sceneRow.id, f.videoRow.id]);
  assert.deepEqual(f.calls.map(c => c.args[1]), ['getWallpaper', 'openWallpaper', 'getWallpaper', 'getWallpaper', 'openWallpaper', 'getWallpaper']);
  await assert.rejects(f.service.readCurrent({ monitor: -1 }));
  assert.equal((await f.service.readCurrent()).wallpaperId, f.sceneRow.id);
});
