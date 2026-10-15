import { WALLPAPER_ENGINE_APP_ID, WorkshopError, type WorkshopDetail } from './types.js';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
export function itemUrl(id: string): string {
  if (!validId(id)) throw new WorkshopError('invalid_input');
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
}
export function validCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
}
/** A display convenience, never an HTML sanitizer or a trust boundary for instructions. */
export function plainText(value: string, max: number): string {
  const decoded = value.slice(0, 32_768).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? all;
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
  return decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/\[\/?[a-z][^\]]*\]/gi, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Exact CDN hostnames only; the provider never fetches previews or follows their URLs.
const previewHosts = new Set(['steamuserimages-a.akamaihd.net', 'images.steamusercontent.com',
  'shared.fastly.steamstatic.com', 'shared.akamai.steamstatic.com', 'shared.steamstatic.com']);
function preview(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && previewHosts.has(url.hostname)) return url.href;
  } catch { /* Omit unsafe or invalid URLs. */ }
}
function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799) return new Date(value * 1000).toISOString();
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function normalizeDetail(id: string, raw: unknown, scrub: (value: string) => string, search = false): WorkshopDetail {
  const unavailable = (reason: Extract<WorkshopDetail, { status: 'unavailable' }>['reason']): WorkshopDetail =>
    ({ id, status: 'unavailable', reason, steamUrl: itemUrl(id) });
  if (raw === undefined) return unavailable('missing');
  if (!record(raw) || raw.publishedfileid !== id) return unavailable('malformed');
  if (raw.result !== 1 && !(search && raw.result === undefined)) return unavailable('missing');
  // QueryFiles uses consumer_appid; GetPublishedFileDetails uses consumer_app_id.
  if (raw.consumer_appid !== undefined && raw.consumer_app_id !== undefined && raw.consumer_appid !== raw.consumer_app_id) return unavailable('malformed');
  const appId = raw.consumer_appid ?? raw.consumer_app_id;
  if (typeof appId !== 'number' || !Number.isSafeInteger(appId) || appId <= 0) return unavailable('malformed');
  if (appId !== WALLPAPER_ENGINE_APP_ID) return unavailable('wrong_app');
  if (raw.visibility !== 0) return unavailable(typeof raw.visibility === 'number' ? 'private' : 'malformed');
  if (raw.banned === true || raw.banned === 1) return unavailable('banned');
  if (raw.banned !== false && raw.banned !== 0) return unavailable('malformed');
  if (typeof raw.title !== 'string') return unavailable('malformed');
  const title = scrub(plainText(scrub(raw.title), 256));
  if (!title) return unavailable('malformed');
  const description = raw.description ?? raw.file_description ?? raw.short_description;
  const candidate: Extract<WorkshopDetail, { status: 'available' }>['candidate'] = {
    id, appId: WALLPAPER_ENGINE_APP_ID, title,
    summary: typeof description === 'string' ? scrub(plainText(scrub(description), 2000)) : '',
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 100).flatMap(tag =>
      record(tag) && typeof tag.tag === 'string' ? [scrub(tag.tag.slice(0, 128))] : []) : [],
    steamUrl: itemUrl(id), source: 'steam-workshop',
  };
  const previewUrl = preview(raw.preview_url);
  if (previewUrl && scrub(previewUrl) === previewUrl) candidate.previewUrl = previewUrl;
  const createdAt = timestamp(raw.time_created); const updatedAt = timestamp(raw.time_updated);
  if (createdAt) candidate.createdAt = createdAt;
  if (updatedAt) candidate.updatedAt = updatedAt;
  if (typeof raw.file_size === 'string' && /^(0|[1-9]\d{0,19})$/.test(raw.file_size)) candidate.fileSizeBytes = raw.file_size;
  const subscriptions = count(raw.subscriptions); const favorites = count(raw.favorited);
  const lifetimeSubscriptions = count(raw.lifetime_subscriptions);
  if (subscriptions !== undefined || favorites !== undefined || lifetimeSubscriptions !== undefined) {
    candidate.popularity = {
      ...(subscriptions === undefined ? {} : { subscriptions }), ...(favorites === undefined ? {} : { favorites }),
      ...(lifetimeSubscriptions === undefined ? {} : { lifetimeSubscriptions }),
    };
  }
  return { id, status: 'available', candidate };
}
