import { execFile } from 'node:child_process';
import { PlaybackError, type ProcessRunner } from './types.js';

/** No shell, inherited interactive window, raw error, or unlimited output. */
export const execFileRunner: ProcessRunner = request => new Promise((resolve, reject) => {
  execFile(request.executable, [...request.args], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: request.timeoutMs,
    maxBuffer: request.maxOutputBytes,
  }, (error, stdout, stderr) => {
    if (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new PlaybackError('OUTPUT_LIMIT', 'Playback process output exceeded its limit.'));
      } else if ('killed' in error && error.killed) {
        reject(new PlaybackError('COMMAND_TIMEOUT', 'Playback process exceeded its time limit.'));
      } else reject(new PlaybackError('COMMAND_FAILED', 'Playback process did not complete successfully.'));
    } else resolve({ stdout, stderr, exitCode: 0 });
  });
});

/** Also enforces the runner contract when a custom implementation is injected. */
export async function runBounded(runner: ProcessRunner, executable: string, args: readonly string[],
  timeoutMs = 3000, maxOutputBytes = 64 * 1024) {
  try {
    const result = await runner({ executable, args, timeoutMs, maxOutputBytes, shell: false });
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes) {
      throw new PlaybackError('OUTPUT_LIMIT', 'Playback process output exceeded its limit.');
    }
    if (result.exitCode !== 0) throw new PlaybackError('COMMAND_FAILED', 'Playback command failed.');
    return result.stdout;
  } catch (error) {
    if (error instanceof PlaybackError) {
      // Preserve only known codes, never an injected runner's potentially private message.
      if (error.code === 'COMMAND_TIMEOUT') throw new PlaybackError(error.code, 'Playback process exceeded its time limit.');
      if (error.code === 'OUTPUT_LIMIT') throw new PlaybackError(error.code, 'Playback process output exceeded its limit.');
    }
    throw new PlaybackError('COMMAND_FAILED', 'Playback process did not complete successfully.');
  }
}
