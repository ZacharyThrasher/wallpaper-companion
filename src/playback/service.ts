import path from 'node:path';
import * as fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Catalog } from '../catalog.js';
import { pathKey } from '../adapters/files.js';
import { discover, type SourceLocations } from '../adapters/steam.js';
import { CatalogError, type Wallpaper } from '../domain.js';
import { execFileRunner, runBounded } from './runner.js';
import { runningExecutable, windowsProcessInspector } from './runtime.js';
import { currentPath, playlistName, wallpaperTarget } from './targets.js';
import { PlaybackError, type AcceptedResult, type CurrentWallpaper, type MonitorRequest,
  type PlaylistRequest, type ProcessInspector, type ProcessRunner, type WallpaperRequest, type WallpaperResult } from './types.js';

export interface PlaybackDependencies {
  catalog: Catalog;
  /** Trusted application configuration; never forward request fields here. Defaults to current Steam discovery. */
  discover?: () => Promise<SourceLocations>;
  runner?: ProcessRunner;
  inspectProcesses?: ProcessInspector;
  /** Trusted test dependencies, not action options. */
  wait?: (ms: number) => Promise<void>;
  username?: string;
}
interface Context { locations: SourceLocations; executable: string; monitor: number | undefined }
interface Observation { public: CurrentWallpaper; key: string | null }

function validate(request: unknown, id?: 'wallpaperId' | 'playlistId', global = false): number | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
    Object.keys(request).some(k => !(!global && k === 'monitor') && k !== id)) {
    throw new PlaybackError('INVALID_REQUEST', 'Only the documented ID and monitor fields are accepted.');
  }
  const r = request as Record<string, unknown>;
  if (id && (typeof r[id] !== 'string' || !new RegExp(`^${id === 'wallpaperId' ? 'wp' : 'pl'}_[a-f0-9]{32}$`).test(r[id]))) {
    throw new PlaybackError('INVALID_ID', 'A valid catalog ID is required.');
  }
  const monitor = r.monitor;
  if (monitor !== undefined && (!Number.isSafeInteger(monitor) || (monitor as number) < 0 || (monitor as number) > 63)) {
    throw new PlaybackError('INVALID_MONITOR', 'monitor must be an integer between 0 and 63.');
  }
  return monitor as number | undefined;
}

/** Shared GUI/MCP service. Mutating calls require the host's user authorization policy. */
export class PlaybackService {
  private readonly runner: ProcessRunner;
  private readonly inspector: ProcessInspector;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: PlaybackDependencies) {
    this.runner = deps.runner ?? execFileRunner;
    this.inspector = deps.inspectProcesses ?? windowsProcessInspector(this.runner);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private catalog<T>(read: () => T): T {
    try { return read(); }
    catch (error) {
      if (error instanceof CatalogError && error.code === 'NOT_FOUND') throw new PlaybackError('NOT_FOUND', 'No catalog item has that ID.');
      throw new PlaybackError('CATALOG_UNAVAILABLE', 'The catalog is unavailable; complete a scan before retrying.');
    }
  }
  private async context(monitor: number | undefined): Promise<Context> {
    let locations: SourceLocations;
    try { locations = await (this.deps.discover ?? (() => discover({})))(); }
    catch { throw new PlaybackError('DISCOVERY_FAILED', 'Cannot discover Wallpaper Engine; check the installation configuration.'); }
    return { locations, executable: await runningExecutable(locations, this.inspector), monitor };
  }
  private async command(ctx: Context, action: string, values: string[] = [], mutation = false) {
    const args = ['-control', action, ...values, ...(ctx.monitor === undefined ? [] : ['-monitor', String(ctx.monitor)])];
    // Recheck immediately before invocation. A simultaneous external exit can still race this check.
    if (pathKey(await runningExecutable(ctx.locations, this.inspector)) !== pathKey(ctx.executable)) {
      throw new PlaybackError('NOT_RUNNING', 'The running Wallpaper Engine instance changed; retry.');
    }
    try { return await runBounded(this.runner, ctx.executable, args); }
    catch (error) {
      const safe = error as PlaybackError;
      throw new PlaybackError(safe.code, mutation ? 'The command did not complete; playback may have changed. Read current state before retrying.' : safe.message, mutation);
    }
  }
  private wallpapers(): Wallpaper[] {
    return this.catalog(() => {
      const first = this.deps.catalog.listWallpapers({ limit: 500 });
      const rows = [...first.data];
      for (let offset = first.pagination.nextOffset; offset !== null;) {
        if (rows.length >= 100_000) throw new Error();
        const page = this.deps.catalog.listWallpapers({ limit: 500, offset, revision: first.indexRevision });
        rows.push(...page.data); offset = page.pagination.nextOffset;
      }
      return rows;
    });
  }
  private async observe(ctx: Context): Promise<Observation> {
    const filename = currentPath(await this.command(ctx, 'getWallpaper'));
    let key = filename === null ? null : pathKey(filename);
    if (filename !== null) {
      try { key = pathKey(await fs.realpath(filename)); } catch { /* A current wallpaper may have been deleted. */ }
    }
    const matches: Wallpaper[] = [];
    for (const w of key === null ? [] : this.wallpapers()) {
      const aliases = [w.projectPath, w.playableTarget,
        ...(w.type === 'scene' ? [path.join(path.dirname(w.projectPath), 'scene.pkg')] : [])];
      for (const alias of aliases) {
        if (alias === null) continue;
        let candidate = pathKey(alias);
        try { candidate = pathKey(await fs.realpath(alias)); } catch { /* Keep the indexed alias for a deleted file. */ }
        if (candidate === key || (filename !== null && pathKey(alias) === pathKey(filename))) { matches.push(w); break; }
      }
    }
    return { key, public: { state: key === null ? 'none' : matches.length === 1 ? 'known' : 'unindexed',
      wallpaperId: matches.length === 1 ? matches[0]!.id : null, monitor: ctx.monitor ?? null, observedAt: new Date().toISOString() } };
  }
  private async attemptObservation(ctx: Context): Promise<Observation> {
    try { return await this.observe(ctx); }
    catch (error) {
      return { key: null, public: { state: 'unavailable', wallpaperId: null, monitor: ctx.monitor ?? null,
        observedAt: new Date().toISOString(), errorCode: error instanceof PlaybackError ? error.code : 'CURRENT_INVALID' } };
    }
  }
  readCurrent(request: MonitorRequest = {}): Promise<CurrentWallpaper> {
    return this.serial(async () => (await this.observe(await this.context(validate(request)))).public);
  }
  applyWallpaper(request: WallpaperRequest): Promise<WallpaperResult> {
    return this.serial(async () => {
      const monitor = validate(request, 'wallpaperId');
      const w = this.catalog(() => this.deps.catalog.getWallpaper(request.wallpaperId).data);
      const ctx = await this.context(monitor);
      await wallpaperTarget(w, ctx.locations);
      const previous = await this.attemptObservation(ctx);
      // Revalidate after the pre-observation, immediately before the mutating command.
      const target = await wallpaperTarget(w, ctx.locations);
      await this.command(ctx, 'openWallpaper', ['-file', target], true);
      let current: Observation = previous;
      let verified = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await (this.deps.wait ?? setTimeout)(150);
        current = await this.attemptObservation(ctx);
        if (current.public.wallpaperId === w.id && current.public.state === 'known') { verified = true; break; }
      }
      return { action: 'applyWallpaper', accepted: true, wallpaperId: w.id, monitor: monitor ?? null,
        previous: previous.public, current: current.public,
        verification: verified ? 'target-observed' : current.public.state === 'unavailable' ? 'unavailable' : 'not-observed',
        changeObserved: previous.public.state === 'unavailable' || current.public.state === 'unavailable' ? null :
          previous.public.wallpaperId !== null && previous.public.wallpaperId === current.public.wallpaperId ? false : previous.key !== current.key };
    });
  }
  activatePlaylist(request: PlaylistRequest): Promise<AcceptedResult> {
    return this.serial(async () => {
      const monitor = validate(request, 'playlistId');
      const p = this.catalog(() => this.deps.catalog.getPlaylist(request.playlistId).data);
      const ctx = await this.context(monitor);
      await playlistName(p, ctx.locations, this.deps.username);
      const previous = await this.attemptObservation(ctx);
      const name = await playlistName(p, ctx.locations, this.deps.username);
      await this.command(ctx, 'openPlaylist', ['-playlist', name], true);
      return { action: 'activatePlaylist', playlistId: p.id, accepted: true, verification: 'not-supported', monitor: monitor ?? null, previous: previous.public };
    });
  }
  pause(request: Record<string, never> = {}): Promise<AcceptedResult> { return this.global('pause', request); }
  play(request: Record<string, never> = {}): Promise<AcceptedResult> { return this.global('play', request); }
  private global(action: 'pause' | 'play', request: unknown): Promise<AcceptedResult> {
    return this.serial(async () => {
      validate(request, undefined, true);
      const ctx = await this.context(undefined);
      await this.command(ctx, action, [], true);
      return { action, accepted: true, verification: 'not-supported', monitor: null };
    });
  }
  nextWallpaper(request: MonitorRequest = {}): Promise<AcceptedResult> {
    return this.serial(async () => {
      const ctx = await this.context(validate(request));
      const previous = await this.attemptObservation(ctx);
      await this.command(ctx, 'nextWallpaper', [], true);
      return { action: 'nextWallpaper', accepted: true, verification: 'not-supported', monitor: ctx.monitor ?? null, previous: previous.public };
    });
  }
}
