# Steam Workshop metadata provider

`src/workshop/index.ts` exports an independent backend contract for future gallery,
MCP, and CLI adapters. It does not depend on catalog internals or change companion,
Steam, or Wallpaper Engine configuration. No UI, MCP tool, automatic subscription,
wallpaper download, or preview download is included.

## Use

```ts
import { SteamWorkshopProvider, WorkshopError } from './workshop/index.js';

// Supply a personal Steam Web API key through your application's configuration.
// Do not serialize it, include it in query text, or log HTTP request URLs.
const provider = new SteamWorkshopProvider({ apiKey: configuredPersonalKey });
const capabilities = provider.capabilities();
const result = await provider.search({
  text: 'forest snow', requiredTags: ['Scene'], excludedTags: ['Mature'],
  matchAllTags: true, limit: 20,
  installedIds: new Set(knownInstalledWorkshopIds),
  dismissedIds: new Set(explicitlyDismissedWorkshopIds),
}, abortSignal);

if (result.status === 'credentials_required') {
  // Display result.searchUrl for a manual Steam handoff. candidates is empty.
} else {
  // Display result.candidates as untrusted text. Request result.nextCursor
  // explicitly for another page. Each call fetches at most one page.
}

// Public item metadata works without a key. IDs always remain decimal strings.
const anonymous = new SteamWorkshopProvider();
const details = await anonymous.details(['1214148605'], abortSignal);
```

`WorkshopProvider` exposes `capabilities()`, `search(query, signal?)`, and
`details(ids, signal?)`. `SteamWorkshopProvider` additionally provides
`clearCache()`. `workshopItemUrl(id)` and `workshopSearchUrl(query)` generate
canonical HTTPS Steam handoff links without API credentials. The search link
preserves text and required/excluded tags, rather than an API pagination cursor.
`capabilities().search === 'available'` means a key is configured; it does not
prove that Steam accepts it. Storage and UI setup for credentials are deferred.

After `npm ci` and `npm run build`, the standalone example supports:

```powershell
node dist/src/workshop/example.js details 1214148605
node dist/src/workshop/example.js search forest snow
```

The example reads an optional `STEAM_WEB_API_KEY` from the process environment.
Set it through your normal private environment configuration; do not commit it or
paste it into command arguments. Without it, search returns `credentials_required`
and a Steam search URL. It never substitutes installed/local results as external
candidates. The example has a 60-second overall cancellation signal and emits
structured JSON errors to stderr with a nonzero exit code.

## API choice and verification

- [Official QueryFiles documentation](https://partner.steamgames.com/doc/webapi/IPublishedFileService?l=english)
  documents `GET https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/`,
  its user Web API key, `input_json`, cursors, filters, and projections.
  The provider fixes `appid` to **431960**, `filetype` to items (**0**), text search
  ranking to **12**, and empty-text ranking to newest publication (**1**).
  It requests tags, previews, and short descriptions. Required/excluded tags are
  JSON arrays, and the initial cursor is `*`.
- [Official GetPublishedFileDetails documentation](https://partner.steamgames.com/doc/webapi/ISteamRemoteStorage?l=english)
  documents an anonymous **POST**, form-encoded `itemcount` and indexed
  `publishedfileids[n]`. This is used for batch details; GET is not used.
- Local live anonymous verification on **October 14, 2026** returned HTTP 200 and
  normalized public item `1214148605` as app **431960**, title **Animated Forest
  Snow 4k**, with an accepted HTTPS preview URL. The smoke check exposed and
  corrected the metadata response's `consumer_app_id` spelling; QueryFiles uses
  `consumer_appid`. Conflicting ownership fields fail closed.
- **Credentialed QueryFiles success remains unverified.** No personal key was
  available. Search serialization and response/error behavior have deterministic
  transport tests. Prior research observed unauthenticated QueryFiles HTTP 403;
  the implementation deliberately avoids making that request without a key.
- No preview or wallpaper content was downloaded, no subscription was inferred
  or changed, and no external GUI/MCP client integration was exercised.

## Result and trust boundaries

Candidates contain string ID, fixed app ID, title, plain-text summary, raw tag
strings, canonical Steam URL, source, and optional validated preview URL, ISO
timestamps, decimal-string file size, and popularity counts. Creator account
data, raw response payloads, file download URLs, and arbitrary metadata are not
retained. `consumer_app_id`/`consumer_appid` must identify Wallpaper Engine;
only explicitly public, non-banned items become candidates. Search skips invalid
or unavailable rows. Details preserves requested order, including duplicate
positions, and returns per-ID `available` or `unavailable` with one of:
`missing`, `private`, `banned`, `wrong_app`, `malformed`. Steam's non-success
item result codes can conflate deleted/private/inaccessible items; those become
`missing`, rather than an unsupported assertion about their visibility.

Plain-text conversion removes common HTML/BBCode markup, decodes common entities,
and bounds text. It does **not** make creator text trustworthy. Render titles,
summaries, and raw tags through text-only UI APIs, never `innerHTML`; AI consumers
must treat all metadata as data, never instructions. No full creator payload is
stored. Normalized output and errors redact the configured secret if echoed.

Preview URLs must be HTTPS without credentials or a nondefault port, and match an
exact allowlisted hostname: `steamuserimages-a.akamaihd.net`,
`images.steamusercontent.com`, `shared.fastly.steamstatic.com`,
`shared.akamai.steamstatic.com`, or `shared.steamstatic.com`. Others are omitted.
The provider does not fetch these URLs. A future preview fetcher must apply its
own redirect/network policy; this metadata allowlist does not authorize following
redirects or fetching arbitrary URLs. API requests use two fixed Steam endpoints
and reject redirects, including when a key is present.

Exclusions use explicit native `Set<string>` values from callers and filter after
cache lookup. They do not establish Steam subscription state. Filtering can leave
an empty page even when `nextCursor` exists; the provider never fetches more pages
implicitly. `total` is Steam's unfiltered query total, not the displayed count.

## Bounds, cache, and failures

| Boundary | Policy |
| --- | --- |
| IDs | Positive decimal strings, no leading zeros, at most uint64; 1–50 IDs per details call |
| Search | 1–50 rows (default 20), text at most 512 characters, at most 20 tags per list, each 1–128 characters |
| Cursor | Opaque nonempty string, at most 2,048 characters, no control characters; one page per call |
| Projection | Title 256 characters, summary 2,000, at most 100 raw tags of 128 characters |
| Transport | Serial per provider instance; at least 1 second between attempt starts; at most 100 active/queued calls |
| Timeout | Default 15 seconds per network attempt, including body read/cancel; configurable 1–60,000 ms |
| Response | At most 2 MiB; JSON only; unexpected envelopes reject the call |
| Retry | At most 3 total attempts, only HTTP 429/503; 1/2-second fallback backoff; honor numeric/date Retry-After |
| Long cooldown | No sleep beyond 30 seconds; return an error and preserve the cooldown for later calls |
| Cache | Memory-only LRU, 200 entries shared across search/details by default, configurable 0–1,000 |
| TTL | Search 15 minutes; available details 24 hours; unavailable details at most 60 seconds; configurable downward or disabled |
| Exclusions | At most 10,000 entries in each supplied installed/dismissed set |

The rate policy is an application choice, not a claim about Steam's official
quota. Share one provider instance within a backend to share its queue/cache.
No retries occur for auth HTTP 401/403, other HTTP failures, network failures,
timeouts, malformed responses, or cancellation. Cancellation covers queued calls,
rate waits, retry backoff, fetches, and response reads. It does not leak caller
abort reasons. `WorkshopError.code` is one of `invalid_input`, `cancelled`,
`timeout`, `network`, `credentials_rejected`, `rate_limited`,
`service_unavailable`, `http_error`, `invalid_response`, or `busy`. Messages are
fixed and never include an upstream body, request URL, or error cause. Calls that
fail at transport level reject as a whole; successful partial batches retain
per-ID unavailable outcomes. Errors are not cached.

No disk cache or persistent key storage exists. Private fields keep credentials
out of provider serialization and ordinary object inspection; the key is sent in
the documented GET query only to Steam. Injected fetch implementations must not
log their input URLs. Cached data can be stale until expiry; consumers can clear
the cache or disable it. Returned objects are copies and cannot mutate the cache.

## Review handoff

- Files: `src/workshop/` contract, normalization, transport, provider, exports,
  standalone example; `test/workshop.test.ts`; this document; README link.
- Local checks: `npm run check`, `npm run build`, and `npm test` pass on Node
  **24.11.1**; **30 tests** total, including **18 Workshop tests** and 12 catalog
  regressions. Coverage exercises real form/JSON serialization, missing
  credentials, secret redaction, ownership, opaque pagination, malformed/private
  metadata, partial/duplicate batches, input limits, safe previews, TTL/eviction,
  exclusion changes on cached pages, bounded retry/cooldown, cancellation,
  serialization, and network/body/cancel timeouts.
- CI limitation reported by the coordinator: GitHub Actions cannot start because
  the account's Actions budget is exhausted. No retries, bypass, or billing
  changes were attempted. Local checks are the available verification evidence.
- Next: coordinator reviews this draft, then performs a credentialed official
  search smoke test when a personal key is available. Future GUI/MCP adapters can
  consume this interface. Subscription/download and credential setup remain
  separate product work; no compatibility guarantees are implied.

CEO brief: The backend can retrieve public Wallpaper Engine item metadata now and
is prepared for official keyed search. It adds no installation/configuration side
effects. Local checks pass; a personal-key search test and coordinator review are
the remaining gates. CI availability depends on the existing Actions budget.
