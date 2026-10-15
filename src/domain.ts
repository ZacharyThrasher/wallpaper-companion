/** Public, versioned catalog contract. Source paths are local data, never telemetry. */
export const schemaVersion = 1 as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export interface Diagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  source?: string;
}
export type Availability = 'available' | 'missing' | 'unsupported';
export interface Provenance {
  source: 'project' | 'workshop-cache';
  path: string;
  /** Disk presence does not establish Steam subscription state. */
  subscription: 'unknown';
}
export interface Wallpaper {
  id: string;
  workshopId?: string;
  title: string;
  type: string;
  tags: string[];
  projectPath: string;
  playableTarget: string | null;
  preview: string | null;
  availability: Availability;
  provenance: Provenance[];
  metadata: { project?: ObjectValue; cache: ObjectValue[] };
  observedAt: string;
}
export interface PlaylistMember {
  position: number;
  file: string | null;
  wallpaperId: string | null;
  resolution: 'resolved' | 'unresolved';
  preset?: Json;
  daytimeend?: Json;
  /** Original string/object, including unrecognized fields. */
  raw: Json;
}
export interface Playlist {
  id: string;
  name: string;
  profile: string;
  items: PlaylistMember[];
  settings: Json;
  raw: ObjectValue;
  provenance: { source: 'saved-playlist'; path: string; position: number };
  observedAt: string;
}
export interface Snapshot {
  wallpapers: Wallpaper[];
  playlists: Playlist[];
  diagnostics: Diagnostic[];
  observedAt: string;
  sourceFiles: { path: string; sha256: string }[];
}
export interface IndexedSnapshot extends Snapshot { indexRevision: number }
export interface CatalogRepository {
  read(): IndexedSnapshot | null;
  replace(snapshot: Snapshot): IndexedSnapshot;
  close(): void;
}
export class CatalogError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
