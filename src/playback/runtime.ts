import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathKey } from '../adapters/files.js';
import type { SourceLocations } from '../adapters/steam.js';
import { runBounded } from './runner.js';
import { PlaybackError, type ProcessInspector, type ProcessRunner } from './types.js';

/** Fixed query for engines in this Windows session. Executable paths stay internal. */
export function windowsProcessInspector(runner: ProcessRunner): ProcessInspector {
  return async () => {
    if (process.platform !== 'win32') throw new PlaybackError('UNSUPPORTED_PLATFORM', 'Playback requires Windows.');
    const script = "$ErrorActionPreference='Stop'; $session=(Get-Process -Id $PID).SessionId; " +
      "@(Get-CimInstance Win32_Process -Filter \"Name = 'wallpaper32.exe' OR Name = 'wallpaper64.exe'\" | " +
      "Where-Object { $_.SessionId -eq $session } | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress";
    try {
      const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const output = await runBounded(runner, executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 5000);
      const value: unknown = output.trim() ? JSON.parse(output) : [];
      const paths = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string')) throw new Error();
      return paths;
    } catch { throw new PlaybackError('PROCESS_CHECK_FAILED', 'Cannot inspect the running Wallpaper Engine process.'); }
  };
}

/** Match the running architecture and reject executable links outside the discovered installation. */
export async function runningExecutable(locations: SourceLocations, inspect: ProcessInspector) {
  let install: string;
  const installed: string[] = [];
  try {
    if (!path.isAbsolute(locations.installDir)) throw new Error();
    install = await fs.realpath(locations.installDir);
    if (!(await fs.stat(install)).isDirectory()) throw new Error();
    for (const name of ['wallpaper64.exe', 'wallpaper32.exe']) {
      const candidate = path.join(install, name);
      try {
        const real = await fs.realpath(candidate);
        if (pathKey(real) !== pathKey(candidate) || !(await fs.stat(real)).isFile()) throw new Error();
        installed.push(real);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!installed.length) throw new Error();
  } catch { throw new PlaybackError('INSTALL_INVALID', 'The discovered installation has no safe Wallpaper Engine executable.'); }
  let processes: readonly string[];
  try { processes = await inspect(); }
  catch (error) {
    if (error instanceof PlaybackError && error.code === 'UNSUPPORTED_PLATFORM') throw error;
    throw new PlaybackError('PROCESS_CHECK_FAILED', 'Cannot inspect the running Wallpaper Engine process.');
  }
  for (const candidate of installed) {
    for (const processPath of processes) {
      try { if (pathKey(await fs.realpath(processPath)) === pathKey(candidate)) return candidate; }
      catch { /* A process may have exited during inspection. */ }
    }
  }
  throw new PlaybackError('NOT_RUNNING', 'Start Wallpaper Engine from the discovered installation, then retry.');
}
