import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { CatalogError } from '../domain.js';

const MAX_BYTES = 32 * 1024 * 1024;
export function id(namespace: string, key: string) {
  return `${namespace}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}
/** Windows matching rules also make synthetic paths portable in tests. */
export function pathKey(filename: string) {
  return path.win32.normalize(filename.replaceAll('/', '\\')).toLowerCase();
}
export function inside(root: string, filename: string) {
  const rel = path.relative(root, filename);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function relativeTarget(root: string, value: string) {
  if (!value || value.includes('\0') || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || value.includes(':')) {
    throw new CatalogError('PATH_ESCAPE', 'Project paths must be relative to their project directory.');
  }
  const target = path.resolve(root, ...value.split(/[\\/]/));
  if (!inside(path.resolve(root), target)) throw new CatalogError('PATH_ESCAPE', 'Project path escapes its project directory.');
  return target;
}
export function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
export async function exists(filename: string) {
  try { return (await fs.stat(filename)).isFile(); }
  catch (error) { if (missing(error)) return false; throw error; }
}
/** Reject symlink/junction escapes as well as lexical traversal. */
export async function projectTarget(root: string, value: string) {
  const target = relativeTarget(root, value);
  const realRoot = await fs.realpath(root);
  let probe = target;
  for (;;) {
    try {
      if (!inside(realRoot, await fs.realpath(probe))) throw new CatalogError('PATH_ESCAPE', 'Project path resolves outside its project directory.');
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  return target;
}
/** Reads only, bounded in size/retries; verify the file did not change during reading. */
export async function readText(filename: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await fs.open(filename, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_BYTES) throw new CatalogError('SOURCE_TOO_LARGE', 'Source must be a regular file of at most 32 MiB.');
      const buffer = Buffer.alloc(Math.min(before.size + 1, MAX_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const current = await fs.stat(filename);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
        throw new CatalogError('SOURCE_CHANGED', 'Source changed during scan; retry when Wallpaper Engine is idle.');
      }
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { throw new CatalogError('SOURCE_ENCODING', 'Source is not valid UTF-8.'); }
    } catch (error) {
      if (!(error instanceof CatalogError && error.code === 'SOURCE_CHANGED') || attempt === 2) throw error;
    } finally { await handle?.close(); }
    await setTimeout(25 * (attempt + 1));
  }
  throw new CatalogError('SOURCE_CHANGED', 'Source did not stabilize.');
}
export async function readJson(filename: string, observe?: (text: string) => void): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await readText(filename);
    observe?.(text);
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch {
      if (attempt === 2) throw new CatalogError('MALFORMED_JSON', 'Source is not valid JSON after three read attempts.');
      await setTimeout(25 * (attempt + 1));
    }
  }
  throw new CatalogError('MALFORMED_JSON', 'Invalid JSON.');
}
export async function optionalJson(filename: string, observe?: (text: string) => void) {
  try { return await readJson(filename, observe); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
/** Canonicalize even a not-yet-created output path to detect source-tree aliases. */
export async function canonicalDestination(filename: string): Promise<string> {
  try { return await fs.realpath(filename); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(await canonicalDestination(parent), path.basename(filename));
  }
}
