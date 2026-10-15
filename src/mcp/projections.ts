import type { Playlist, Wallpaper } from '../domain.js';

/** Explicit allowlists prevent preserved source copies from growing MCP replies. */
export function wallpaperSummary(w: Wallpaper) {
  return { id: w.id, title: w.title, type: w.type, tags: w.tags, availability: w.availability,
    ...(w.workshopId === undefined ? {} : { workshopId: w.workshopId }), hasPreview: w.preview !== null };
}

export function playlistSummary(p: Playlist) {
  return { id: p.id, name: p.name, memberCount: p.items.length,
    unresolvedCount: p.items.filter(item => item.resolution === 'unresolved').length };
}

export function wallpaperDetail(w: Wallpaper) {
  return { ...wallpaperSummary(w), projectPath: w.projectPath, playableTarget: w.playableTarget,
    preview: w.preview, provenance: w.provenance, observedAt: w.observedAt };
}

export function playlistDetail(p: Playlist) {
  return { ...playlistSummary(p), profile: p.profile,
    items: p.items.map(item => ({ position: item.position, file: item.file,
      wallpaperId: item.wallpaperId, resolution: item.resolution })),
    provenance: p.provenance, observedAt: p.observedAt };
}
