import path from 'node:path';
import { openReadOnlyCatalog } from '../mcp/index.js';
import { PlaybackService } from '../playback/service.js';
import { SteamWorkshopProvider } from '../workshop/provider.js';
import { run } from '../cli.js';
import { PreferenceStore, defaultPreferencesPath, WorkflowError } from './preferences.js';
import { WorkflowService } from './service.js';

export function createCompanionRuntime(database: string, preferencesFile = defaultPreferencesPath()) {
  if (path.resolve(database).toLowerCase() === path.resolve(preferencesFile).toLowerCase())
    throw new WorkflowError('PREFERENCES_SCHEMA', 'Catalog and preference stores must be separate files.');
  const catalog = openReadOnlyCatalog(database);
  const preferences = new PreferenceStore(preferencesFile);
  const workflow = new WorkflowService(catalog, preferences, new SteamWorkshopProvider(
    process.env.STEAM_WEB_API_KEY ? { apiKey: process.env.STEAM_WEB_API_KEY } : {}));
  const playback = new PlaybackService({ catalog });
  let refreshing = false;
  return { catalog, preferences, workflow, playback,
    async refreshLibrary() {
      if (refreshing) throw new WorkflowError('REFRESH_BUSY', 'A library refresh is already running.');
      refreshing = true;
      try {
        let output = '';
        // Fixed server-owned database, default discovery only. CLI owns source/destination safety checks.
        const code = await run(['scan', '--db', database, '--json'], text => { output += text; });
        const result = JSON.parse(output) as { error?: { code: string; message: string } };
        if (code) throw new WorkflowError(result.error?.code ?? 'REFRESH_FAILED', result.error?.message ?? 'Cannot refresh the library.');
        return catalog.status();
      } finally { refreshing = false; }
    },
    close() { preferences.close(); }
  };
}
