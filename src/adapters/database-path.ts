import path from 'node:path';
import os from 'node:os';

/** Shared by local entry points; does not create the index or its directory. */
export function defaultDatabasePath() {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'WallpaperCompanion', 'catalog.sqlite');
}
