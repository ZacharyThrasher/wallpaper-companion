export type PlaybackErrorCode = 'INVALID_REQUEST' | 'INVALID_MONITOR' | 'INVALID_ID' | 'NOT_FOUND' |
  'CATALOG_UNAVAILABLE' | 'DISCOVERY_FAILED' | 'UNSUPPORTED_PLATFORM' | 'INSTALL_INVALID' |
  'NOT_RUNNING' | 'PROCESS_CHECK_FAILED' | 'TARGET_INVALID' | 'TARGET_MISSING' |
  'PLAYLIST_STALE' | 'PLAYLIST_AMBIGUOUS' | 'COMMAND_FAILED' | 'COMMAND_TIMEOUT' |
  'OUTPUT_LIMIT' | 'CURRENT_INVALID';

/** Messages and codes never contain process output, playlist names, or local paths. */
export class PlaybackError extends Error {
  constructor(public readonly code: PlaybackErrorCode, message: string,
    /** A failed/timed-out mutation may still have reached Wallpaper Engine. */
    public readonly mayHaveApplied = false) { super(message); this.name = 'PlaybackError'; }
}
export interface MonitorRequest { monitor?: number }
export interface WallpaperRequest extends MonitorRequest { wallpaperId: string }
export interface PlaylistRequest extends MonitorRequest { playlistId: string }
export interface CurrentWallpaper {
  state: 'known' | 'unindexed' | 'none' | 'unavailable';
  wallpaperId: string | null;
  monitor: number | null;
  observedAt: string;
  errorCode?: PlaybackErrorCode;
}
export interface WallpaperResult {
  action: 'applyWallpaper';
  accepted: true;
  wallpaperId: string;
  monitor: number | null;
  previous: CurrentWallpaper;
  current: CurrentWallpaper;
  verification: 'target-observed' | 'not-observed' | 'unavailable';
  /** False when the requested wallpaper was already current; null if either observation was unavailable. */
  changeObserved: boolean | null;
}
export interface AcceptedResult {
  action: 'activatePlaylist' | 'pause' | 'play' | 'nextWallpaper';
  accepted: true;
  verification: 'not-supported';
  monitor: number | null;
  playlistId?: string;
  previous?: CurrentWallpaper;
}
export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  shell: false;
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: number }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
/** Trusted infrastructure dependency, never a GUI/MCP request field. */
export type ProcessInspector = () => Promise<readonly string[]>;
