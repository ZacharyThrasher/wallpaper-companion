import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inside, pathKey, projectTarget, readJson } from '../adapters/files.js';
import type { SourceLocations } from '../adapters/steam.js';
import { object, type Playlist, type Wallpaper } from '../domain.js';
import { PlaybackError } from './types.js';

async function regular(filename: string) {
  try { return (await fs.stat(filename)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Re-read current metadata and reject stale, redirected, or invented catalog launch targets. */
export async function wallpaperTarget(w: Wallpaper, locations: SourceLocations): Promise<string> {
  try {
    if (w.availability !== 'available' || !w.playableTarget || !path.isAbsolute(w.projectPath) ||
      !path.isAbsolute(w.playableTarget) || path.basename(w.projectPath).toLowerCase() !== 'project.json') throw new Error();
    const roots = [...locations.workshopDirs, path.join(locations.installDir, 'projects', 'defaultprojects'),
      path.join(locations.installDir, 'projects', 'myprojects')];
    const realProject = await fs.realpath(w.projectPath);
    let contained = false;
    for (const root of roots) {
      if (!inside(path.resolve(root), w.projectPath)) continue;
      try { if (inside(await fs.realpath(root), realProject)) contained = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!contained) throw new Error();
    const projectDir = path.dirname(w.projectPath);
    const raw = await readJson(realProject);
    if (!object(raw) || typeof raw.type !== 'string' || typeof raw.file !== 'string' ||
      raw.type.toLowerCase() !== w.type || !['scene', 'video', 'web', 'application'].includes(w.type)) throw new Error();
    const file = await projectTarget(projectDir, raw.file);
    const target = w.type === 'scene' ? w.projectPath : file;
    if (pathKey(target) !== pathKey(w.playableTarget)) throw new Error();
    if (w.type === 'scene' && !await regular(file) && !await regular(await projectTarget(projectDir, 'scene.pkg'))) {
      throw new PlaybackError('TARGET_MISSING', 'The wallpaper media is no longer present; rescan the catalog.');
    }
    const real = await fs.realpath(target);
    if (!inside(await fs.realpath(projectDir), real) || !await regular(real)) throw new Error();
    return real;
  } catch (error) {
    if (error instanceof PlaybackError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PlaybackError('TARGET_MISSING', 'The wallpaper files are no longer present; rescan the catalog.');
    }
    throw new PlaybackError('TARGET_INVALID', 'The wallpaper target is unsafe, unsupported, or stale; rescan the catalog.');
  }
}

export async function playlistName(p: Playlist, locations: SourceLocations, username = os.userInfo().username) {
  try {
    // The CLI has no profile argument. Do not activate a playlist indexed from another OS profile.
    if (p.profile.toLowerCase() !== username.toLowerCase() || !p.name || p.name.length > 256 ||
      /^[\s-]/.test(p.name) || /[\x00-\x1f\x7f"]/.test(p.name)) throw new Error();
    const config = path.join(locations.installDir, 'config.json');
    const real = await fs.realpath(config);
    if (pathKey(real) !== pathKey(path.join(await fs.realpath(locations.installDir), 'config.json')) ||
      pathKey(p.provenance.path) !== pathKey(config)) throw new Error();
    const raw = await readJson(real);
    if (!object(raw)) throw new Error();
    const profile = raw[p.profile];
    if (!object(profile) || !object(profile.general) || !Array.isArray(profile.general.playlists)) throw new Error();
    const lists = profile.general.playlists;
    const selected = lists[p.provenance.position];
    if (!object(selected) || selected.name !== p.name || !Array.isArray(selected.items)) throw new Error();
    // Reject case variants too: Wallpaper Engine's name lookup case rules are not documented.
    if (lists.filter(v => object(v) && typeof v.name === 'string' && v.name.toLowerCase() === p.name.toLowerCase()).length !== 1) {
      throw new PlaybackError('PLAYLIST_AMBIGUOUS', 'The saved playlist name is ambiguous. Rename it in Wallpaper Engine and rescan.');
    }
    return selected.name as string;
  } catch (error) {
    if (error instanceof PlaybackError) throw error;
    throw new PlaybackError('PLAYLIST_STALE', 'The saved playlist is stale, unsafe, or belongs to another profile; rescan for the current user.');
  }
}

/** A single bare or quoted absolute path only. Never interpret diagnostics as a wallpaper. */
export function currentPath(output: string): string | null {
  let value = output.replace(/^\uFEFF/, '').trim();
  if (!value) return null;
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (/[\x00-\x1f\x7f"]/.test(value) || value.length > 32767 ||
    !(path.win32.isAbsolute(value) || path.posix.isAbsolute(value))) {
    throw new PlaybackError('CURRENT_INVALID', 'Wallpaper Engine returned an unrecognized current-wallpaper response.');
  }
  return value.replace(/^\\\\\?\\/, '');
}
export function normalizeCurrentOutput(output: string): string | null {
  const value = currentPath(output);
  return value === null ? null : pathKey(value);
}
