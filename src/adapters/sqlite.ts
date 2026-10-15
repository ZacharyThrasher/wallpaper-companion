import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { CatalogError, type CatalogRepository, type IndexedSnapshot, type Snapshot } from '../domain.js';

/** A single transactional snapshot prevents partially visible scans. No native addon. */
export class SqliteCatalogRepository implements CatalogRepository {
  private db: DatabaseSync;
  constructor(filename: string, readOnly = false) {
    const existed = filename !== ':memory:' && existsSync(filename);
    this.db = new DatabaseSync(filename, { readOnly });
    this.db.exec('PRAGMA busy_timeout = 5000');
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      const application = this.db.prepare('PRAGMA application_id').get() as { application_id: number };
      if (existed && application.application_id !== 0x57435031) throw new CatalogError('INDEX_SCHEMA', 'Refusing a database not owned by Wallpaper Companion.');
      if (version.user_version !== 0 && version.user_version !== 1) throw new CatalogError('INDEX_SCHEMA', 'Unsupported SQLite index schema.');
      if (!readOnly) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS catalog_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL
        ); PRAGMA user_version = 1; PRAGMA application_id = 1464029233;`);
      } else if (version.user_version !== 1) throw new CatalogError('INDEX_SCHEMA', 'Not a companion catalog index.');
    } catch (error) { this.db.close(); throw error; }
  }
  read(): IndexedSnapshot | null {
    const row = this.db.prepare('SELECT revision, payload FROM catalog_snapshot WHERE singleton = 1').get() as { revision: number; payload: string } | undefined;
    if (!row) return null;
    let data: Snapshot;
    try { data = JSON.parse(row.payload) as Snapshot; }
    catch { throw new CatalogError('INDEX_CORRUPT', 'The saved catalog is not valid JSON.'); }
    if (!Array.isArray(data.wallpapers) || !Array.isArray(data.playlists) || !Array.isArray(data.diagnostics) || typeof data.observedAt !== 'string') {
      throw new CatalogError('INDEX_CORRUPT', 'The saved catalog has an invalid snapshot shape.');
    }
    return { ...data, indexRevision: row.revision };
  }
  replace(snapshot: Snapshot): IndexedSnapshot {
    const payload = JSON.stringify(snapshot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT revision FROM catalog_snapshot WHERE singleton = 1').get() as { revision: number } | undefined;
      const revision = (previous?.revision ?? 0) + 1;
      this.db.prepare(`INSERT INTO catalog_snapshot VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, payload = excluded.payload`).run(revision, payload);
      this.db.exec('COMMIT');
      return { ...snapshot, indexRevision: revision };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
