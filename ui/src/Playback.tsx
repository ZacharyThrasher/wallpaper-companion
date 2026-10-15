import { useState } from 'react';
import { action, request } from './api';
import type { AcceptedResult, CurrentWallpaper, WallpaperResult } from '../../src/playback/types';

export function Playback({ id, playlist = false }: { id: string; playlist?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  async function perform(read = false) {
    setBusy(true); setError(''); setStatus('');
    try {
      if (read) {
        const current = await request<CurrentWallpaper>('/api/current', new AbortController().signal);
        setStatus(`Monitor 0: ${current.state}${current.wallpaperId ? ` (${current.wallpaperId === id ? 'selected wallpaper' : 'another indexed wallpaper'})` : ''}.`);
      } else {
        const result = await action<WallpaperResult | AcceptedResult>(playlist ? '/api/play-playlist' : '/api/apply', playlist ? { playlistId: id, monitor: 0 } : { wallpaperId: id, monitor: 0 });
        setStatus(result.verification === 'target-observed' ? 'Accepted. Selected wallpaper verified on monitor 0.' : result.verification === 'not-supported' ? 'Accepted for monitor 0. Active playlist identity cannot be verified.' : 'Accepted for monitor 0. Selected wallpaper has not been verified; read current state before retrying.');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Playback failed. Start Wallpaper Engine and retry.'); }
    finally { setBusy(false); }
  }
  return <section className="playback-controls" aria-label="Playback controls"><div className="action-row"><button disabled={busy} onClick={() => void perform()}>{busy ? 'Working…' : playlist ? 'Play playlist' : 'Apply wallpaper'}</button><button className="quiet-button" disabled={busy} onClick={() => void perform(true)}>Read current state</button></div><p className="field-note">Monitor 0 (default display). Wallpaper Engine must be running.</p>{status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}</section>;
}
