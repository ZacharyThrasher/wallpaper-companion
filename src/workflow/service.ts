import * as z from 'zod/v4';
import type { Catalog } from '../catalog.js';
import type { Wallpaper } from '../domain.js';
import { itemUrl, validId } from '../workshop/normalize.js';
import type { WorkshopCandidate, WorkshopProvider } from '../workshop/types.js';
import { PreferenceStore, preferenceWriteSchema, referenceSchema, workshopIdSchema, WorkflowError } from './preferences.js';

export const discoverySchema = z.strictObject({ reference: referenceSchema, query: z.string().max(512),
  tags: z.array(z.string().min(1).max(128)).max(20), cursor: z.string().min(1).max(2048).optional() });
export const inspectSchema = z.strictObject({ reference: referenceSchema, item: z.string().min(1).max(256) });
/** Accept only an exact public Workshop item URL or positive uint64 ID; never fetch caller URLs. */
export function workshopItemId(value: string): string {
  if (validId(value)) return value;
  if (!/^https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=[1-9][0-9]{0,19}$/.test(value))
    throw new WorkflowError('INVALID_WORKSHOP_URL', 'Paste a positive Workshop ID or https://steamcommunity.com/sharedfiles/filedetails/?id=ID.');
  const id = new URL(value).searchParams.get('id')!;
  if (!validId(id)) throw new WorkflowError('INVALID_WORKSHOP_URL', 'Workshop ID is outside the supported range.');
  return id;
}
const fold = (s: string) => s.toLowerCase();
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const stop = new Set(['the', 'and', 'with', 'wallpaper', 'wallpapers', 'for', 'from']);
export class WorkflowService {
  constructor(readonly catalog: Catalog, readonly preferences: PreferenceStore, readonly workshop: WorkshopProvider) {}
  private reference(reference: string) {
    referenceSchema.parse(reference);
    return reference === 'global' ? undefined : this.catalog.getPlaylist(reference).data;
  }
  private wallpapers(): Wallpaper[] {
    if (!this.catalog.status().data.indexed) return [];
    const first = this.catalog.listWallpapers({ limit: 500 });
    const rows = [...first.data];
    for (let offset = first.pagination.nextOffset; offset !== null;) {
      if (rows.length >= 10_000) throw new WorkflowError('LIBRARY_LIMIT', 'Discovery supports at most 10,000 indexed wallpapers.');
      const page = this.catalog.listWallpapers({ offset, limit: 500, revision: first.indexRevision });
      rows.push(...page.data); offset = page.pagination.nextOffset;
    }
    return rows;
  }
  context(reference: string) { return this.buildContext(reference, this.wallpapers()); }
  private buildContext(reference: string, wallpapers: Wallpaper[]) {
    const playlist = this.reference(reference);
    const record = this.preferences.read(reference);
    const ids = new Set(playlist?.items.map(i => i.wallpaperId).filter(Boolean));
    const members = wallpapers.filter(w => ids.has(w.id));
    const rank = (values: string[]) => {
      const counts = new Map<string, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 8).map(([value, count]) => ({ value, count }));
    };
    const tags = rank(members.flatMap(w => [...new Set(w.tags.map(t => fold(t.slice(0, 128))))]));
    const titleWords = rank(members.flatMap(w => [...new Set(words(w.title.slice(0, 2000)).filter(w => !stop.has(w) && w.length <= 80))]));
    return { ...record, referenceName: playlist?.name.slice(0, 256) ?? 'No playlist reference', capabilities: this.workshop.capabilities(),
      evidence: { method: 'title-tag-heuristic' as const, analyzedImages: false, resolvedMembers: members.length,
        unresolvedMembers: playlist?.items.filter(i => !i.wallpaperId).length ?? 0, tags, titleWords },
      suggestions: { query: titleWords.slice(0, 3).map(t => t.value).join(' '), tags: tags.slice(0, 3).map(t => t.value) } };
  }
  save(input: unknown) {
    const args = preferenceWriteSchema.parse(input); this.reference(args.reference);
    return this.preferences.write(args);
  }
  private decorate(candidate: WorkshopCandidate, context: ReturnType<WorkflowService['context']>, query: string, tags: string[]) {
    const haystack = fold(candidate.title + ' ' + candidate.tags.join(' '));
    const explicit = [...new Set([...words(query), ...tags])].filter(t => haystack.includes(fold(t))).slice(0, 8);
    const referenceTags = context.evidence.tags.filter(t => candidate.tags.some(tag => fold(tag) === t.value)).slice(0, 5).map(t => t.value);
    return { ...candidate, match: { explicitQueryTerms: explicit, referenceTags,
      explanation: explicit.length || referenceTags.length ? 'Shared title words or tags; no image or semantic analysis.' : 'Steam result or pasted item; no title/tag overlap established.',
      guidanceInterpreted: false }, installation: 'not-established' as const };
  }
  async discover(input: unknown) {
    const args = discoverySchema.parse(input);
    const wallpapers = this.wallpapers(); const context = this.buildContext(args.reference, wallpapers);
    const prefs = context.preferences;
    const installedIds = new Set(wallpapers.flatMap(w => w.workshopId && validId(w.workshopId) ? [w.workshopId] : []));
    const result = await this.workshop.search({ text: args.query, requiredTags: args.tags,
      excludedTags: prefs.exclusions, installedIds, dismissedIds: new Set(prefs.dismissed), limit: 20,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }) });
    const seen = new Set<string>();
    return { ...result, candidates: result.candidates.filter(c => {
      if (seen.has(c.id) || installedIds.has(c.id) || prefs.dismissed.includes(c.id) ||
        prefs.exclusions.some(e => fold(c.title).includes(fold(e)) || c.tags.some(t => fold(t).includes(fold(e))))) return false;
      seen.add(c.id); return true;
    }).map(c => this.decorate(c, context, args.query, args.tags)),
    guidance: prefs.guidance, guidanceInterpreted: false, subscription: 'Use Steam to subscribe, then refresh the local library after download.' };
  }
  async inspect(input: unknown) {
    const args = inspectSchema.parse(input); const wallpapers = this.wallpapers(); const context = this.buildContext(args.reference, wallpapers);
    const id = workshopItemId(args.item);
    const [detail] = await this.workshop.details([id]);
    if (!detail) throw new WorkflowError('WORKSHOP_UNAVAILABLE', 'Steam returned no item metadata.');
    const prefs = context.preferences;
    return detail.status === 'available' ? { ...detail, candidate: this.decorate(detail.candidate, context, prefs.query, prefs.tags),
      installed: wallpapers.some(w => w.workshopId === id), dismissed: prefs.dismissed.includes(id) } : detail;
  }
  async shortlist(reference: string, offset = 0) {
    this.reference(reference);
    z.number().int().min(0).max(1000).parse(offset);
    const record = this.preferences.read(reference);
    // Bound network/output; callers can inspect further saved IDs individually.
    const ids = record.preferences.shortlist.slice(offset, offset + 50);
    const details = ids.length ? await this.workshop.details(ids) : [];
    return { reference, revision: record.revision, ids: record.preferences.shortlist, details,
      pagination: { offset, total: record.preferences.shortlist.length, nextOffset: offset + 50 < record.preferences.shortlist.length ? offset + 50 : null },
      collection: 'Companion shortlist; this does not create or edit a Wallpaper Engine playlist.' };
  }
}
export { itemUrl, workshopIdSchema };
