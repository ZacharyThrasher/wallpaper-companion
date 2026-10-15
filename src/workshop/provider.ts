import { normalizeDetail, record, validCursor, validId } from './normalize.js';
import { cancelled, SteamTransport, systemClock, type WorkshopClock } from './transport.js';
import { WALLPAPER_ENGINE_APP_ID, WorkshopError, type WorkshopCapabilities, type WorkshopDetail,
  type WorkshopProvider, type WorkshopSearchQuery, type WorkshopSearchResult } from './types.js';

export interface SteamWorkshopOptions {
  /** Inject a personal Steam Web API key. Never persisted; do not log transport inputs. */
  apiKey?: string;
  fetch?: typeof fetch;
  clock?: WorkshopClock;
  timeoutMs?: number;
  searchTtlMs?: number;
  detailsTtlMs?: number;
  cacheMaxEntries?: number;
}
interface SearchInput { text: string; requiredTags: string[]; excludedTags: string[]; matchAllTags: boolean; limit: number; cursor: string }
type SearchPage = Omit<Extract<WorkshopSearchResult, { status: 'ok' }>, 'searchUrl'>;
function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new WorkshopError('invalid_input');
  return value;
}
function tags(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some(tag => typeof tag !== 'string' || tag.length === 0 || tag.length > 128 || /[\x00-\x1f\x7f]/.test(tag))) throw new WorkshopError('invalid_input');
  return [...new Set(value)].sort();
}
function input(query: WorkshopSearchQuery): SearchInput {
  const text = query.text ?? '';
  if (typeof text !== 'string' || text.length > 512 || /[\x00-\x1f\x7f]/.test(text) ||
    (query.matchAllTags !== undefined && typeof query.matchAllTags !== 'boolean')) throw new WorkshopError('invalid_input');
  const cursor = query.cursor ?? '*';
  if (!validCursor(cursor)) throw new WorkshopError('invalid_input');
  return { text: text.trim(), requiredTags: tags(query.requiredTags), excludedTags: tags(query.excludedTags),
    matchAllTags: query.matchAllTags ?? true, cursor, limit: boundedInteger(query.limit ?? 20, 1, 50) };
}
function searchUrl(query: SearchInput): string {
  const params = new URLSearchParams({ appid: String(WALLPAPER_ENGINE_APP_ID), searchtext: query.text,
    browsesort: query.text ? 'textsearch' : 'mostrecent', section: 'readytouse',
    match_all_tags: String(query.matchAllTags) });
  for (const tag of query.requiredTags) params.append('requiredtags[]', tag);
  for (const tag of query.excludedTags) params.append('excludedtags[]', tag);
  return `https://steamcommunity.com/workshop/browse/?${params}`;
}
export function workshopSearchUrl(query: WorkshopSearchQuery = {}): string { return searchUrl(input(query)); }
function exclusions(query: WorkshopSearchQuery): Set<string> {
  const ids = new Set<string>();
  for (const source of [query.installedIds, query.dismissedIds]) {
    if (source === undefined) continue;
    if (!(source instanceof Set) || source.size > 10_000) throw new WorkshopError('invalid_input');
    for (const id of source) { if (!validId(id)) throw new WorkshopError('invalid_input'); ids.add(id); }
  }
  return ids;
}

/** Independent metadata backend: no local catalog, configuration, download, or subscription side effects. */
export class SteamWorkshopProvider implements WorkshopProvider {
  #key: string | undefined;
  #transport: SteamTransport;
  #clock: WorkshopClock;
  #searchTtl: number;
  #detailsTtl: number;
  #maxEntries: number;
  #cache = new Map<string, { expires: number; value: SearchPage | WorkshopDetail }>();
  constructor(options: SteamWorkshopOptions = {}) {
    const key = options.apiKey?.trim();
    if (key && !/^[a-f0-9]{32}$/i.test(key)) throw new WorkshopError('invalid_input');
    this.#key = key || undefined;
    this.#clock = options.clock ?? systemClock;
    this.#searchTtl = boundedInteger(options.searchTtlMs ?? 900_000, 0, 900_000);
    this.#detailsTtl = boundedInteger(options.detailsTtlMs ?? 86_400_000, 0, 86_400_000);
    this.#maxEntries = boundedInteger(options.cacheMaxEntries ?? 200, 0, 1000);
    this.#transport = new SteamTransport(options.fetch ?? globalThis.fetch, this.#clock,
      boundedInteger(options.timeoutMs ?? 15_000, 1, 60_000));
  }
  capabilities(): WorkshopCapabilities {
    return { provider: 'steam-workshop', appId: WALLPAPER_ENGINE_APP_ID,
      search: this.#key ? 'available' : 'credentials_required', details: 'anonymous', subscribe: false, download: false };
  }
  toJSON(): WorkshopCapabilities { return this.capabilities(); }
  #scrub = (value: string): string => this.#key ? value.replace(new RegExp(this.#key, 'gi'), '[redacted]') : value;
  #get<T extends SearchPage | WorkshopDetail>(key: string): T | undefined {
    const entry = this.#cache.get(key);
    if (!entry) return;
    this.#cache.delete(key);
    if (entry.expires <= this.#clock.now()) return;
    this.#cache.set(key, entry);
    return structuredClone(entry.value) as T;
  }
  #put(key: string, value: SearchPage | WorkshopDetail, ttl: number): void {
    if (!ttl || !this.#maxEntries) return;
    for (const [id, entry] of this.#cache) if (entry.expires <= this.#clock.now()) this.#cache.delete(id);
    this.#cache.delete(key);
    while (this.#cache.size >= this.#maxEntries) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(key, { expires: this.#clock.now() + ttl, value: structuredClone(value) });
  }
  clearCache(): void { this.#cache.clear(); }
  async search(query: WorkshopSearchQuery = {}, signal?: AbortSignal): Promise<WorkshopSearchResult> {
    cancelled(signal);
    const normalized = input(query); const excluded = exclusions(query);
    // Do not accept the configured secret as user text/cursor or serialize it into a fallback URL/cache key.
    if (this.#scrub(JSON.stringify(normalized)) !== JSON.stringify(normalized)) throw new WorkshopError('invalid_input');
    const link = searchUrl(normalized);
    if (!this.#key) return { status: 'credentials_required', candidates: [], searchUrl: link };
    const cacheKey = `s:${JSON.stringify(normalized)}`;
    let page = this.#get<SearchPage>(cacheKey);
    if (!page) {
      const params = new URLSearchParams({ key: this.#key, input_json: JSON.stringify({
        appid: WALLPAPER_ENGINE_APP_ID, filetype: 0, query_type: normalized.text ? 12 : 1,
        search_text: normalized.text, cursor: normalized.cursor, numperpage: normalized.limit,
        requiredtags: normalized.requiredTags, excludedtags: normalized.excludedTags,
        match_all_tags: normalized.matchAllTags, return_tags: true, return_previews: true, return_short_description: true,
      }) });
      const raw = await this.#transport.request('search', params, signal);
      if (!record(raw) || !record(raw.response) || (raw.response.result !== undefined && raw.response.result !== 1)) throw new WorkshopError('invalid_response');
      const response = raw.response;
      // Steam's protobuf JSON can omit an empty repeated field. Only accept that
      // shape when the response explicitly establishes that there are no results.
      const entries = response.publishedfiledetails === undefined && response.total === 0 ? [] : response.publishedfiledetails;
      if (!Array.isArray(entries) || entries.length > normalized.limit) throw new WorkshopError('invalid_response');
      if (response.next_cursor !== undefined && (!validCursor(response.next_cursor) || this.#scrub(response.next_cursor) !== response.next_cursor)) throw new WorkshopError('invalid_response');
      const candidates: SearchPage['candidates'] = []; const seen = new Set<string>();
      for (const entry of entries as unknown[]) {
        if (!record(entry) || !validId(entry.publishedfileid) || seen.has(entry.publishedfileid)) continue;
        seen.add(entry.publishedfileid);
        const detail = normalizeDetail(entry.publishedfileid, entry, this.#scrub, true);
        if (detail.status === 'available') candidates.push(detail.candidate);
      }
      page = { status: 'ok', candidates };
      if (typeof response.next_cursor === 'string' && response.next_cursor !== normalized.cursor) page.nextCursor = response.next_cursor;
      if (typeof response.total === 'number' && Number.isSafeInteger(response.total) && response.total >= 0) page.total = response.total;
      this.#put(cacheKey, page, this.#searchTtl);
    }
    cancelled(signal);
    return { ...page, candidates: page.candidates.filter(candidate => !excluded.has(candidate.id)), searchUrl: link };
  }
  async details(ids: readonly string[], signal?: AbortSignal): Promise<WorkshopDetail[]> {
    cancelled(signal);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || ids.some(id => !validId(id))) throw new WorkshopError('invalid_input');
    // Snapshot caller inputs before awaiting transport. Preserve caller order and duplicate positions.
    const requested = [...ids]; const results = new Map<string, WorkshopDetail>();
    const missing: string[] = [];
    for (const id of new Set(requested)) {
      const cached = this.#get<WorkshopDetail>(`d:${id}`);
      if (cached) results.set(id, cached); else missing.push(id);
    }
    if (missing.length) {
      const params = new URLSearchParams({ itemcount: String(missing.length) });
      missing.forEach((id, index) => params.set(`publishedfileids[${index}]`, id));
      const raw = await this.#transport.request('details', params, signal);
      if (!record(raw) || !record(raw.response) || (raw.response.result !== undefined && raw.response.result !== 1) || !Array.isArray(raw.response.publishedfiledetails) ||
        raw.response.publishedfiledetails.length > missing.length) throw new WorkshopError('invalid_response');
      const rows = new Map<string, unknown>(); const duplicates = new Set<string>();
      for (const row of raw.response.publishedfiledetails as unknown[]) {
        if (!record(row) || !validId(row.publishedfileid) || !missing.includes(row.publishedfileid)) continue;
        if (rows.has(row.publishedfileid)) duplicates.add(row.publishedfileid);
        rows.set(row.publishedfileid, row);
      }
      for (const id of missing) {
        const detail = normalizeDetail(id, duplicates.has(id) ? null : rows.get(id), this.#scrub);
        results.set(id, detail);
        this.#put(`d:${id}`, detail, detail.status === 'available' ? this.#detailsTtl : Math.min(this.#detailsTtl, 60_000));
      }
    }
    cancelled(signal);
    return requested.map(id => structuredClone(results.get(id)!));
  }
}
