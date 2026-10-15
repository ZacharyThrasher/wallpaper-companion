import path from 'node:path';
import { openReadOnlyCatalog } from '../mcp/index.js';
import { PlaybackService } from '../playback/service.js';
import { SteamWorkshopProvider } from '../workshop/provider.js';
import { run } from '../cli.js';
import { PreferenceStore, defaultPreferencesPath, WorkflowError } from './preferences.js';
import { WorkflowService } from './service.js';

export interface RefreshConfiguration { steamPath?: string; installDir?: string; workshopDir?: string; profile?: string }
export function createCompanionRuntime(database: string, preferencesFile = defaultPreferencesPath(), refreshConfiguration?: RefreshConfiguration) {
  if (path.resolve(database).toLowerCase() === path.resolve(preferencesFile).toLowerCase())
    throw new WorkflowError('PREFERENCES_SCHEMA', 'Catalog and preference stores must be separate files.');
  const catalog = openReadOnlyCatalog(database);
  const workshop = new SteamWorkshopProvider(process.env.STEAM_WEB_API_KEY ? { apiKey: process.env.STEAM_WEB_API_KEY } : {});
  const preferences = new PreferenceStore(preferencesFile);
  const workflow = new WorkflowService(catalog, preferences, workshop);
  const playback = new PlaybackService({ catalog });
  const refresh = createLibraryRefresher(database, refreshConfiguration);
  let closed = false;
  return { catalog, preferences, workflow, playback,
    async refreshLibrary() { await refresh(); return catalog.status(); },
    close() { if (!closed) { closed = true; preferences.close(); } }
  };
}
/** Trusted runner injection is for tests; browser requests never supply argv, paths or source roots. */
export function createLibraryRefresher(database: string, configuration: RefreshConfiguration | undefined, scanCommand: typeof run = run) {
  let refreshing = false;
  return async () => {
      if (refreshing) throw new WorkflowError('REFRESH_BUSY', 'A library refresh is already running.');
      if (configuration === undefined) throw new WorkflowError('REFRESH_CONFIGURATION_REQUIRED', 'Refresh sources are not configured. Restart the gallery with the scan options used for this index, or --refresh-defaults to explicitly select default Steam sources and the OS profile. See discovery setup documentation.');
      refreshing = true;
      try {
        let output = '';
        // Fixed server-owned database, default discovery only. CLI owns source/destination safety checks.
        const args = ['scan', '--db', database, '--json'];
        for (const [key, flag] of [['steamPath', '--steam-path'], ['installDir', '--install-dir'], ['workshopDir', '--workshop-dir'], ['profile', '--profile']] as const) {
          if (configuration[key] !== undefined) args.push(flag, configuration[key]);
        }
        const code = await scanCommand(args, text => { output += text; });
        const result = JSON.parse(output) as { error?: { code: string; message: string } };
        if (code) throw new WorkflowError(result.error?.code ?? 'REFRESH_FAILED', result.error?.message ?? 'Cannot refresh the library.');
        return result;
      } finally { refreshing = false; }
  };
}
