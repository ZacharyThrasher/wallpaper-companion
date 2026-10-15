import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { defaultDatabasePath } from '../adapters/database-path.js';

export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export const referenceSchema = z.string().regex(/^(global|pl_[a-zA-Z0-9_-]{1,128})$/);
export const workshopIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(id => BigInt(id) <= 18446744073709551615n);
const text = (max: number) => z.string().max(max).refine(s => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s));
export const preferenceSchema = z.strictObject({
  guidance: text(2000), query: text(512), tags: z.array(text(128).min(1)).max(20),
  exclusions: z.array(text(128).min(1)).max(20),
  dismissed: z.array(workshopIdSchema).max(1000), shortlist: z.array(workshopIdSchema).max(1000),
});
export type Preferences = z.infer<typeof preferenceSchema>;
export interface PreferenceRecord { schemaVersion: 1; reference: string; revision: number; preferences: Preferences }
export const emptyPreferences = (): Preferences => ({ guidance: '', query: '', tags: [], exclusions: [], dismissed: [], shortlist: [] });
export const preferenceWriteSchema = z.strictObject({ reference: referenceSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), preferences: preferenceSchema });
const APP_ID = 0x57435046;
export function defaultPreferencesPath() { return path.join(path.dirname(defaultDatabasePath()), 'preferences.sqlite'); }

/** Separate companion-owned DB. Transactions plus optimistic revisions protect independent UI/MCP processes. */
export class PreferenceStore {
  private db: DatabaseSync;
  constructor(filename: string = defaultPreferencesPath()) {
    const existed = filename !== ':memory:' && existsSync(filename);
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      const app = this.db.prepare('PRAGMA application_id').get() as { application_id: number };
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (existed && (app.application_id !== APP_ID || version.user_version !== 1))
        throw new WorkflowError('PREFERENCES_SCHEMA', 'Preferences file is foreign or uses an unsupported version. Keep it and choose a companion-owned preferences file.');
      if (!existed) this.db.exec(`CREATE TABLE preferences (reference TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);
        PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 1;`);
      this.db.prepare('SELECT reference, revision, payload FROM preferences LIMIT 0').all();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* No active transaction. */ }
      this.db.close();
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('PREFERENCES_INVALID', 'Cannot open preferences. Preserve the file and check its format and permissions.');
    }
  }
  read(reference: string): PreferenceRecord {
    referenceSchema.parse(reference);
    const row = this.db.prepare('SELECT revision, payload FROM preferences WHERE reference = ?').get(reference) as { revision: number; payload: string } | undefined;
    try {
      if (row && (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.payload.length > 100_000)) throw new Error();
      return { schemaVersion: 1, reference, revision: row?.revision ?? 0,
        preferences: row ? preferenceSchema.parse(JSON.parse(row.payload)) : emptyPreferences() };
    } catch { throw new WorkflowError('PREFERENCES_INVALID', 'Saved preferences are invalid. Preserve the file before recovering it.'); }
  }
  write(input: unknown): PreferenceRecord {
    const args = preferenceWriteSchema.parse(input);
    const preferences = { ...args.preferences, tags: [...new Set(args.preferences.tags)],
      exclusions: [...new Set(args.preferences.exclusions)], dismissed: [...new Set(args.preferences.dismissed)], shortlist: [...new Set(args.preferences.shortlist)] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(args.reference);
      if (current.revision !== args.expectedRevision) throw new WorkflowError('PREFERENCE_CONFLICT', 'Preferences changed in another window or AI session. Reload preferences before saving again.');
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM preferences').get() as { count: number };
      if (!current.revision && count.count >= 1000) throw new WorkflowError('PREFERENCE_LIMIT', 'Preference profile limit reached.');
      const revision = current.revision + 1;
      this.db.prepare('INSERT INTO preferences VALUES (?, ?, ?) ON CONFLICT(reference) DO UPDATE SET revision=excluded.revision, payload=excluded.payload')
        .run(args.reference, revision, JSON.stringify(preferences));
      this.db.exec('COMMIT');
      return { schemaVersion: 1, reference: args.reference, revision, preferences };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
