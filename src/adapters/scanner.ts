import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CatalogError, object, type Diagnostic, type Json, type ObjectValue, type Playlist, type Snapshot, type Wallpaper } from '../domain.js';
import { exists, id, inside, missing, optionalJson, pathKey, projectTarget, readJson, readText } from './files.js';
import type { SourceLocations } from './steam.js';

export interface ScanOptions { profile?: string; username?: string; now?: () => Date }
interface CacheEntry { raw: ObjectValue; workshopId: string; projectPath: string | null }
const knownTypes = new Set(['scene', 'video', 'web', 'application']);
function tags(value: Json | undefined): string[] {
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return [...new Set(raw.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean))].sort();
}
function workshopId(value: Json | undefined): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}
export function selectProfile(config: ObjectValue, explicit: string | undefined, username: string): string {
  if (explicit !== undefined) {
    if (!object(config[explicit]) || explicit.startsWith('?')) throw new CatalogError('PROFILE_NOT_FOUND', 'The requested profile is absent or invalid.');
    return explicit;
  }
  const matches = Object.keys(config).filter(k => !k.startsWith('?') && k.toLowerCase() === username.toLowerCase() && object(config[k]));
  if (matches.length !== 1) throw new CatalogError('PROFILE_REQUIRED', 'Cannot select a unique OS username profile; pass --profile explicitly.');
  return matches[0]!;
}
/** Scan has no output path and performs no writes. Fatal failures return no snapshot. */
export async function scan(locations: SourceLocations, options: ScanOptions = {}): Promise<Snapshot> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const diagnostics: Diagnostic[] = [];
  const fingerprints = new Map<string, string>();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const observe = (filename: string) => (text: string) => fingerprints.set(filename, hash(text));
  const warn = (code: string, message: string, source?: string) => diagnostics.push({ severity: 'warning', code, message, ...(source ? { source } : {}) });
  const installDir = path.resolve(locations.installDir);
  // An absent/unreadable install is fatal, never an apparently successful empty scan.
  if (!(await fs.stat(installDir)).isDirectory()) throw new CatalogError('INSTALL_MISSING', 'Installation path must be a directory.');
  const cachePath = path.join(installDir, 'bin', 'workshopcache.json');
  const cacheRaw = await optionalJson(cachePath, observe(cachePath));
  const cache: CacheEntry[] = [];
  if (cacheRaw === undefined) warn('CACHE_MISSING', 'Workshop cache absent; using project metadata.');
  else {
    if (!object(cacheRaw) || !Array.isArray(cacheRaw.wallpapers)) throw new CatalogError('CACHE_SCHEMA', 'Expected workshop cache object with wallpapers array.');
    for (const raw of cacheRaw.wallpapers) {
      if (!object(raw) || !workshopId(raw.workshopid)) { warn('CACHE_ENTRY_SCHEMA', 'Skipped cache record without a valid Workshop ID.', cachePath); continue; }
      cache.push({ raw, workshopId: workshopId(raw.workshopid)!, projectPath: typeof raw.project === 'string' && path.isAbsolute(raw.project) ? raw.project : null });
    }
  }
  const roots = [...locations.workshopDirs.map(p => ({ path: path.resolve(p), workshop: true })),
    { path: path.join(installDir, 'projects', 'defaultprojects'), workshop: false },
    { path: path.join(installDir, 'projects', 'myprojects'), workshop: false }];
  const projects: { filename: string; workshop: boolean; root: string }[] = [];
  let directories = 0;
  async function walk(folder: string, workshop: boolean, root: string, depth = 0): Promise<void> {
    if (++directories > 100_000) throw new CatalogError('SCAN_LIMIT', 'Project traversal exceeded 100000 directories.');
    const entries = await fs.readdir(folder, { withFileTypes: true });
    if (entries.some(e => e.name.toLowerCase() === 'project.json' && e.isFile())) {
      projects.push({ filename: path.join(folder, entries.find(e => e.name.toLowerCase() === 'project.json' && e.isFile())!.name), workshop, root });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) { warn('SYMLINK_SKIPPED', 'Skipped linked project entry.', path.join(folder, entry.name)); continue; }
      if (!entry.isDirectory()) continue;
      if (depth >= 4) throw new CatalogError('SCAN_LIMIT', 'Project traversal exceeded five directory levels.');
      await walk(path.join(folder, entry.name), workshop, root, depth + 1);
    }
  }
  for (const root of roots) {
    let present = true;
    try {
      await fs.stat(root.path);
    } catch (error) {
      if (missing(error)) { present = false; warn('PROJECT_ROOT_MISSING', 'Optional project root absent.', root.path); }
      else throw error;
    }
    // Only an initially absent root is optional. Any disappearance during walk is fatal.
    // Root junctions are permitted as explicit source locations; descendants are not followed.
    if (present) await walk(root.path, root.workshop, root.path);
  }
  const wallpapers = new Map<string, Wallpaper>();
  const aliases = new Map<string, Set<string>>();
  function alias(value: string, wallpaper: Wallpaper) {
    const key = pathKey(value); const ids = aliases.get(key) ?? new Set<string>();
    ids.add(wallpaper.id); aliases.set(key, ids);
  }
  const seenCache = new Set<CacheEntry>();
  for (const project of projects) {
    const root = path.dirname(project.filename);
    let raw: unknown;
    try { raw = await readJson(await projectTarget(root, path.basename(project.filename)), observe(project.filename)); }
    catch (error) {
      if (error instanceof CatalogError && error.code === 'MALFORMED_JSON') { warn('PROJECT_MALFORMED', 'Skipped malformed project JSON.', project.filename); continue; }
      throw error;
    }
    if (!object(raw) || typeof raw.title !== 'string' || typeof raw.type !== 'string' || typeof raw.file !== 'string') {
      warn('PROJECT_SCHEMA', 'Skipped project: expected string title, type, and file.', project.filename); continue;
    }
    const inferredId = project.workshop && /^\d+$/.test(path.basename(root)) ? path.basename(root) : undefined;
    const wId = inferredId ?? workshopId(raw.workshopid);
    if (inferredId && workshopId(raw.workshopid) && inferredId !== workshopId(raw.workshopid)) warn('WORKSHOP_ID_CONFLICT', 'Using Workshop folder ID instead of conflicting project ID.', project.filename);
    const records = cache.filter(c => (c.projectPath !== null && pathKey(c.projectPath) === pathKey(project.filename)) || (wId && c.workshopId === wId));
    for (const record of records) seenCache.add(record);
    const type = raw.type.toLowerCase();
    let target: string | null = null; let preview: string | null = null;
    let availability: Wallpaper['availability'] = 'missing';
    try {
      // Validate even Scene's unused file field. Packed scenes launch project.json.
      const file = await projectTarget(root, raw.file);
      if (typeof raw.preview === 'string' && raw.preview) {
        const candidate = await projectTarget(root, raw.preview);
        if (await exists(candidate)) preview = candidate;
        else warn('PREVIEW_MISSING', 'Project preview is absent.', project.filename);
      }
      else if (raw.preview !== undefined && typeof raw.preview !== 'string') warn('PREVIEW_SCHEMA', 'Ignored non-string project preview.', project.filename);
      target = type === 'scene' ? project.filename : file;
      if (!knownTypes.has(type)) { availability = 'unsupported'; target = null; warn('PROJECT_TYPE_UNKNOWN', 'Unknown project type; no playable target exposed.', project.filename); }
      else if (type === 'scene') {
        availability = await exists(file) || await exists(await projectTarget(root, 'scene.pkg')) ? 'available' : 'missing';
      } else availability = await exists(file) ? 'available' : 'missing';
    } catch (error) {
      if (!(error instanceof CatalogError && error.code === 'PATH_ESCAPE')) throw error;
      warn('PATH_ESCAPE', 'Rejected unsafe project file or preview path.', project.filename);
      target = null; preview = null; availability = 'unsupported';
    }
    const wallpaper: Wallpaper = {
      id: id('wp', wId ? `workshop:${wId}` : `project:${pathKey(project.filename)}`), ...(wId ? { workshopId: wId } : {}),
      title: raw.title, type, tags: tags(raw.tags ?? records[0]?.raw.tags), projectPath: project.filename,
      playableTarget: target, preview, availability, observedAt,
      metadata: { project: raw, cache: records.map(c => c.raw) },
      provenance: [{ source: 'project', path: project.filename, subscription: 'unknown' }, ...records.map(() => ({ source: 'workshop-cache' as const, path: cachePath, subscription: 'unknown' as const }))]
    };
    const duplicate = wallpapers.get(wallpaper.id);
    if (duplicate) warn('DUPLICATE_PROJECT', 'Multiple project copies share an ID; prefer an available copy, then traversal order.', project.filename);
    if (!duplicate || (duplicate.availability !== 'available' && availability === 'available')) wallpapers.set(wallpaper.id, wallpaper);
    alias(project.filename, wallpaper);
    if (target) alias(target, wallpaper);
    // Cache file paths are aliases only within a discovered, validated project directory.
    if (availability !== 'unsupported') {
      for (const record of records) {
        if (typeof record.raw.file !== 'string' || !path.isAbsolute(record.raw.file)) continue;
        if (inside(root, path.resolve(record.raw.file))) alias(record.raw.file, wallpaper);
        else warn('CACHE_PATH_OUTSIDE_PROJECT', 'Ignored cache playable alias outside its project.', cachePath);
      }
    }
    // A playlist may refer directly to scene.pkg without a cache entry.
    if (type === 'scene' && availability !== 'unsupported') alias(path.join(root, 'scene.pkg'), wallpaper);
  }
  for (const record of cache) {
    if (seenCache.has(record)) continue;
    const projectPath = record.projectPath;
    if (!projectPath) { warn('CACHE_PROJECT_MISSING', 'Stale cache entry lacks an absolute project path.', cachePath); continue; }
    const wallpaper: Wallpaper = {
      id: id('wp', `workshop:${record.workshopId}`), workshopId: record.workshopId,
      title: typeof record.raw.title === 'string' ? record.raw.title : record.workshopId,
      type: typeof record.raw.type === 'string' ? record.raw.type.toLowerCase() : 'unknown', tags: tags(record.raw.tags),
      projectPath, playableTarget: null, preview: null, availability: 'missing', observedAt,
      metadata: { cache: [record.raw] },
      provenance: [{ source: 'workshop-cache', path: cachePath, subscription: 'unknown' }]
    };
    if (!wallpapers.has(wallpaper.id)) wallpapers.set(wallpaper.id, wallpaper);
    alias(projectPath, wallpaper);
    if (typeof record.raw.file === 'string' && path.isAbsolute(record.raw.file)) alias(record.raw.file, wallpaper);
    warn('CACHE_ONLY', 'Cache entry has no valid discovered project; subscription and playable availability are unverified.', cachePath);
  }
  const configPath = path.join(installDir, 'config.json');
  const config = await optionalJson(configPath, observe(configPath));
  const playlists: Playlist[] = [];
  if (config === undefined) warn('CONFIG_MISSING', 'No config.json; saved playlists are unavailable.');
  else {
    if (!object(config)) throw new CatalogError('CONFIG_SCHEMA', 'Expected config object keyed by username.');
    const profile = selectProfile(config, options.profile, options.username ?? os.userInfo().username);
    const selected = config[profile];
    if (!object(selected) || !object(selected.general)) throw new CatalogError('CONFIG_SCHEMA', 'Selected profile must contain a general object.');
    const saved = selected.general.playlists;
    if (saved !== undefined && !Array.isArray(saved)) throw new CatalogError('PLAYLIST_SCHEMA', 'Expected saved playlists array.');
    const names = new Map<string, number>();
    for (const [position, raw] of (saved ?? []).entries()) {
      if (!object(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.items)) throw new CatalogError('PLAYLIST_SCHEMA', 'Saved playlist requires name and items array.');
      const occurrence = names.get(raw.name) ?? 0; names.set(raw.name, occurrence + 1);
      if (occurrence) warn('DUPLICATE_PLAYLIST_NAME', 'Duplicate playlist name uses occurrence number for identity.', configPath);
      const items = raw.items.map((item, index) => {
        const file = typeof item === 'string' ? item : object(item) && typeof item.file === 'string' ? item.file : null;
        const ids = file && path.isAbsolute(file.replaceAll('\\', path.sep)) ? aliases.get(pathKey(file)) : undefined;
        const wallpaperId = ids?.size === 1 ? [...ids][0]! : null;
        if (!wallpaperId) warn(ids && ids.size > 1 ? 'MEMBER_AMBIGUOUS' : 'MEMBER_UNRESOLVED', 'Saved playlist member could not be resolved uniquely.', configPath);
        return { position: index, file, wallpaperId, resolution: wallpaperId ? 'resolved' as const : 'unresolved' as const,
          ...(object(item) && item.preset !== undefined ? { preset: item.preset } : {}),
          ...(object(item) && item.daytimeend !== undefined ? { daytimeend: item.daytimeend } : {}), raw: item };
      });
      playlists.push({ id: id('pl', JSON.stringify([profile, raw.name, occurrence])), name: raw.name, profile, items,
        settings: raw.settings ?? null, raw, provenance: { source: 'saved-playlist', path: configPath, position }, observedAt });
    }
  }
  // Detect metadata edits across the scan, beyond each reader's per-file checks.
  for (const [filename, fingerprint] of fingerprints) {
    if (hash(await readText(filename)) !== fingerprint) throw new CatalogError('SOURCE_CHANGED', 'Metadata changed across the scan; the previous index is preserved.');
  }
  return { wallpapers: [...wallpapers.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), playlists, diagnostics, observedAt,
    sourceFiles: [...fingerprints].map(([path, sha256]) => ({ path, sha256 })) };
}
