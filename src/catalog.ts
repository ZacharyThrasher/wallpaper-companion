import { CatalogError, schemaVersion, type CatalogRepository, type IndexedSnapshot, type Playlist, type Snapshot, type Wallpaper } from './domain.js';

export interface Query {
  search?: string;
  type?: string;
  tag?: string;
  availability?: string;
  offset?: number;
  limit?: number;
  revision?: number;
}
/** No filesystem or SQLite dependencies: reusable by later interfaces. */
export class Catalog {
  constructor(private readonly repository: CatalogRepository) {}
  commit(snapshot: Snapshot) { return this.repository.replace(snapshot); }
  private current(revision?: number): IndexedSnapshot {
    const snapshot = this.repository.read();
    if (!snapshot) throw new CatalogError('INDEX_EMPTY', 'Run scan before querying the catalog.');
    if (revision !== undefined && revision !== snapshot.indexRevision) {
      throw new CatalogError('REVISION_CHANGED', 'The index changed; restart pagination at the current revision.');
    }
    return snapshot;
  }
  private envelope(snapshot: IndexedSnapshot) {
    return { schemaVersion, indexRevision: snapshot.indexRevision, observedAt: snapshot.observedAt, diagnostics: snapshot.diagnostics };
  }
  status() {
    const s = this.repository.read();
    return { schemaVersion, indexRevision: s?.indexRevision ?? 0, observedAt: s?.observedAt ?? null,
      diagnostics: s?.diagnostics ?? [], data: { indexed: s !== null, wallpapers: s?.wallpapers.length ?? 0,
        playlists: s?.playlists.length ?? 0, availableWallpapers: s?.wallpapers.filter(w => w.availability === 'available').length ?? 0 } };
  }
  private page<T extends { id: string }>(snapshot: IndexedSnapshot, rows: T[], q: Query) {
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new CatalogError('INVALID_PAGINATION', 'offset must be a nonnegative integer and limit must be between 1 and 500.');
    }
    rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { ...this.envelope(snapshot), data: rows.slice(offset, offset + limit),
      pagination: { offset, limit, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null } };
  }
  listWallpapers(q: Query = {}) {
    const s = this.current(q.revision);
    if (q.availability && !['available', 'missing', 'unsupported'].includes(q.availability)) throw new CatalogError('INVALID_FILTER', 'Unknown availability.');
    const fold = (s: string) => s.toLowerCase();
    return this.page(s, s.wallpapers.filter(w => (!q.search || fold(w.title).includes(fold(q.search))) &&
      (!q.type || fold(w.type) === fold(q.type)) && (!q.tag || w.tags.some(t => fold(t) === fold(q.tag!))) &&
      (!q.availability || w.availability === q.availability)), q);
  }
  listPlaylists(q: Query = {}) {
    const s = this.current(q.revision);
    return this.page(s, s.playlists.filter(p => !q.search || p.name.toLowerCase().includes(q.search.toLowerCase())), q);
  }
  private get<T extends Wallpaper | Playlist>(s: IndexedSnapshot, rows: T[], id: string) {
    const item = rows.find(row => row.id === id);
    if (!item) throw new CatalogError('NOT_FOUND', 'No catalog item has that ID.');
    return { ...this.envelope(s), data: item };
  }
  getWallpaper(id: string) { const s = this.current(); return this.get(s, s.wallpapers, id); }
  getPlaylist(id: string) { const s = this.current(); return this.get(s, s.playlists, id); }
  /** Resolve registered previews by wallpaper ID. A serving adapter must revalidate disk containment before opening. */
  getPreview(id: string) {
    const s = this.current(); const item = this.get(s, s.wallpapers, id).data;
    return { ...this.envelope(s), data: { wallpaperId: item.id, path: item.preview, projectPath: item.projectPath } };
  }
}
