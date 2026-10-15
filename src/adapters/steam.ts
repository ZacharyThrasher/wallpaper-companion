import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CatalogError } from '../domain.js';
import { missing, pathKey, readText, relativeTarget } from './files.js';

export interface Vdf { [key: string]: string | Vdf }
/** Small strict KeyValues reader: quoted/bare tokens, braces, escapes, line comments. */
export function parseVdf(text: string): Vdf {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue; }
    if (text.slice(i, i + 2) === '//') { while (i < text.length && text[i] !== '\n') i++; continue; }
    const char = text[i++]!;
    if (char === '{' || char === '}') tokens.push(char);
    else if (char === '"') {
      let value = ''; let closed = false;
      while (i < text.length) {
        const next = text[i++]!;
        if (next === '"') { closed = true; break; }
        if (next === '\\' && (text[i] === '\\' || text[i] === '"')) value += text[i++]!;
        else value += next;
      }
      if (!closed) throw new CatalogError('MALFORMED_VDF', 'Unclosed VDF string.');
      // Prefix string tokens so quoted braces are never parsed as syntax.
      tokens.push(`s${value}`);
    } else {
      let value = char;
      while (i < text.length && !/[\s{}]/.test(text[i]!)) value += text[i++]!;
      tokens.push(`s${value}`);
    }
    if (tokens.length > 500_000) throw new CatalogError('MALFORMED_VDF', 'Too many VDF tokens.');
  }
  let cursor = 0;
  function parse(depth: number): Vdf {
    if (depth > 32) throw new CatalogError('MALFORMED_VDF', 'VDF nesting exceeds 32 levels.');
    const out: Vdf = Object.create(null) as Vdf;
    while (cursor < tokens.length) {
      if (tokens[cursor] === '}') {
        if (depth === 0) throw new CatalogError('MALFORMED_VDF', 'Unexpected closing brace.');
        cursor++; return out;
      }
      const key = tokens[cursor++]; const value = tokens[cursor++];
      if (!key?.startsWith('s') || !value || value === '}' || Object.hasOwn(out, key.slice(1))) throw new CatalogError('MALFORMED_VDF', 'Invalid or duplicate VDF property.');
      out[key.slice(1)] = value === '{' ? parse(depth + 1) : value.slice(1);
    }
    if (depth > 0) throw new CatalogError('MALFORMED_VDF', 'Unclosed VDF object.');
    return out;
  }
  return parse(0);
}
export interface SourceLocations { installDir: string; workshopDirs: string[]; protectedRoots: string[] }
export interface DiscoveryOptions { steamPath?: string; installDir?: string; workshopDir?: string }
function sourceLocations(installDir: string, workshopDirs: string[], libraries: string[] = []): SourceLocations {
  // Effective roots can be junctions to directories outside the installation.
  // Output guards canonicalize each root rather than protecting only the install ancestor.
  return { installDir, workshopDirs, protectedRoots: [...libraries, installDir, ...workshopDirs,
    path.join(installDir, 'projects', 'defaultprojects'), path.join(installDir, 'projects', 'myprojects')] };
}
async function registrySteamPath() {
  if (process.platform !== 'win32') throw new CatalogError('STEAM_NOT_FOUND', 'Use --steam-path or --install-dir outside Windows.');
  try {
    const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { timeout: 5000, windowsHide: true });
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match) return match[1]!.trim();
  } catch { /* Give a stable actionable error below. */ }
  throw new CatalogError('STEAM_NOT_FOUND', 'Cannot discover SteamPath; pass --steam-path or --install-dir.');
}
export async function discover(options: DiscoveryOptions): Promise<SourceLocations> {
  if (options.installDir && !options.steamPath) {
    const installDir = path.resolve(options.installDir);
    if (options.workshopDir) return sourceLocations(installDir, [path.resolve(options.workshopDir)]);
    const common = path.dirname(installDir); const steamapps = path.dirname(common);
    if (path.basename(common).toLowerCase() === 'common' && path.basename(steamapps).toLowerCase() === 'steamapps') {
      return discover({ ...options, steamPath: path.dirname(steamapps) });
    }
    // Nonstandard install locations still use discovered Steam libraries when available.
    let registered: string;
    try { registered = await registrySteamPath(); }
    catch (error) {
      if (error instanceof CatalogError && error.code === 'STEAM_NOT_FOUND') return sourceLocations(installDir, []);
      throw error;
    }
    return discover({ ...options, steamPath: registered });
  }
  const steamPath = path.resolve(options.steamPath ?? await registrySteamPath());
  const libraries = [steamPath];
  try {
    const vdf = parseVdf(await readText(path.join(steamPath, 'steamapps', 'libraryfolders.vdf')));
    const folders = vdf.libraryfolders;
    if (!folders || typeof folders === 'string') throw new CatalogError('STEAM_SCHEMA', 'Expected libraryfolders object.');
    for (const [key, value] of Object.entries(folders)) {
      if (!/^\d+$/.test(key)) continue;
      const entry = typeof value === 'string' ? value : value.path;
      if (typeof entry !== 'string' || !path.isAbsolute(entry)) throw new CatalogError('STEAM_SCHEMA', 'Steam library path must be absolute.');
      if (!libraries.some(p => pathKey(p) === pathKey(entry))) libraries.push(path.resolve(entry));
    }
  } catch (error) { if (!missing(error)) throw error; }
  const installs: string[] = [];
  for (const library of libraries) {
    try {
      const manifest = parseVdf(await readText(path.join(library, 'steamapps', 'appmanifest_431960.acf'))).AppState;
      if (!manifest || typeof manifest === 'string' || manifest.appid !== '431960' || typeof manifest.installdir !== 'string') {
        throw new CatalogError('STEAM_SCHEMA', 'Invalid Wallpaper Engine app manifest.');
      }
      installs.push(relativeTarget(path.join(library, 'steamapps', 'common'), manifest.installdir));
    } catch (error) { if (!missing(error)) throw error; }
  }
  if (!options.installDir && installs.length !== 1) throw new CatalogError('INSTALL_AMBIGUOUS', 'Expected one Wallpaper Engine install; use --install-dir to select it.');
  const installDir = path.resolve(options.installDir ?? installs[0]!);
  const workshopDirs = options.workshopDir ? [path.resolve(options.workshopDir)] : libraries.map(p => path.join(p, 'steamapps', 'workshop', 'content', '431960'));
  return sourceLocations(installDir, workshopDirs, libraries);
}
