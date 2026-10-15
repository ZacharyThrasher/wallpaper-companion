export const WALLPAPER_ENGINE_APP_ID = 431960 as const;

/** Creator-controlled text is untrusted data, including after plain-text conversion. */
export interface WorkshopCandidate {
  id: string;
  appId: typeof WALLPAPER_ENGINE_APP_ID;
  title: string;
  summary: string;
  tags: string[];
  previewUrl?: string;
  steamUrl: string;
  createdAt?: string;
  updatedAt?: string;
  fileSizeBytes?: string;
  popularity?: { subscriptions?: number; favorites?: number; lifetimeSubscriptions?: number };
  source: 'steam-workshop';
}
export type UnavailableReason = 'missing' | 'private' | 'banned' | 'wrong_app' | 'malformed';
export type WorkshopDetail =
  | { id: string; status: 'available'; candidate: WorkshopCandidate }
  | { id: string; status: 'unavailable'; reason: UnavailableReason; steamUrl: string };
export interface WorkshopSearchQuery {
  text?: string;
  requiredTags?: readonly string[];
  excludedTags?: readonly string[];
  matchAllTags?: boolean;
  limit?: number;
  /** Opaque Steam cursor. Omit for the first page. One call fetches at most one page. */
  cursor?: string;
  installedIds?: ReadonlySet<string>;
  dismissedIds?: ReadonlySet<string>;
}
export type WorkshopSearchResult =
  | { status: 'credentials_required'; candidates: []; searchUrl: string }
  | { status: 'ok'; candidates: WorkshopCandidate[]; searchUrl: string; nextCursor?: string; total?: number };
export interface WorkshopCapabilities {
  provider: 'steam-workshop';
  appId: typeof WALLPAPER_ENGINE_APP_ID;
  search: 'available' | 'credentials_required';
  details: 'anonymous';
  subscribe: false;
  download: false;
}
export interface WorkshopProvider {
  capabilities(): WorkshopCapabilities;
  search(query?: WorkshopSearchQuery, signal?: AbortSignal): Promise<WorkshopSearchResult>;
  details(ids: readonly string[], signal?: AbortSignal): Promise<WorkshopDetail[]>;
}
export type WorkshopErrorCode = 'invalid_input' | 'cancelled' | 'timeout' | 'network' |
  'credentials_rejected' | 'rate_limited' | 'service_unavailable' | 'http_error' | 'invalid_response' | 'busy';
const messages: Record<WorkshopErrorCode, string> = {
  invalid_input: 'Invalid Workshop input. See the provider limits.',
  cancelled: 'Workshop request cancelled.', timeout: 'Workshop request timed out.',
  network: 'Steam could not be reached.', credentials_rejected: 'Steam rejected the Web API credentials.',
  rate_limited: 'Steam rate limit reached. Retry later.', service_unavailable: 'Steam is temporarily unavailable.',
  http_error: 'Steam returned an unsuccessful HTTP response.', invalid_response: 'Steam returned invalid metadata.',
  busy: 'Workshop request queue is full.',
};
/** Never attach response bodies, URLs, abort reasons, or upstream error causes. */
export class WorkshopError extends Error {
  constructor(public readonly code: WorkshopErrorCode) { super(messages[code]); this.name = 'WorkshopError'; }
}
