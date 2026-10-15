# Guided discovery contract

The gallery, optional stdio MCP tools and `src/workflow/` share preferences and discovery behavior. Catalog APIs and their snapshot schema remain stable. HTTP MCP remains on its original read-only factory; enabling companion reads/actions there is a separate integration decision.

## Setup

Run `npm run gallery:build`, scan using the CLI, and launch `npm run gallery -- --refresh-defaults` for default Steam sources/profile. For a custom index, pass its matching trusted `--steam-path`, `--install-dir`, `--workshop-dir`, and/or `--profile` options to the gallery. These configure future Refresh library actions; browser payloads cannot supply paths, roots, or profile names. If no refresh configuration is provided, refresh fails with actionable `REFRESH_CONFIGURATION_REQUIRED` and preserves the index. This avoids silently switching a custom scan to OS/default discovery.

`--db` selects the catalog snapshot. `--preferences` selects a separate companion-owned preference database. Both gallery and `mcp-cli --companion` must use the same preferences path to share choices. Defaults are `%LOCALAPPDATA%\WallpaperCompanion\catalog.sqlite` and `preferences.sqlite`. On non-Windows systems the existing per-user fallback applies; Windows is required for default Steam discovery and actual playback.

Set a personal Steam Web API key only in the server process environment as `STEAM_WEB_API_KEY` before launching gallery or MCP. Never put it into guidance, source files, CLI arguments, or AI client prompts. Search without the key returns `credentials_required`, no candidates, and a prepared official Steam search URL. Anonymous item inspection needs no key. Credentialed search is covered with mocked transport and has not been live-verified in this feature. No paid model API is used.

## Preferences and evidence

`PreferenceStore` owns application ID `0x57435046`, schema/user version 1. A profile key is a catalog playlist ID or `global`. Each record has `schemaVersion`, `reference`, `revision` and strict `preferences`: guidance (2,000 chars), query (512), up to 20 tags/exclusions (128 chars each), and up to 1,000 positive uint64 IDs each for dismissed and shortlist. Unknown fields are rejected; credentials have no storage field. At most 1,000 profiles are created.

Writes require `expectedRevision`. A `BEGIN IMMEDIATE` transaction checks the current per-profile revision and writes the next revision atomically. Independent handles cannot overwrite the same revision: one succeeds and the other receives `PREFERENCE_CONFLICT`. Reload and reconcile before retrying; the UI preserves unsaved edits until Reload preferences is selected. Invalid payloads, foreign databases and future schema versions are refused without replacing them. Failed transactions roll back. Initial file reservation is exclusive, with ownership checked again after acquiring the SQLite write lock. Keep a damaged file before manual recovery; no automatic reset is attempted.

`WorkflowService.context(reference)` returns explicit saved preferences separately from `evidence` and editable suggestions. Evidence counts unique resolved wallpapers, lowercase existing tags, and title words of at least three characters, omitting common stop words. Ties sort deterministically. It returns at most eight tags/words with bounded lengths. Duplicate playlist entries do not weight the same wallpaper twice. Unresolved count stays visible. It never reads artwork or infers movement/mood. The host can use `get_wallpaper_image` for its own visual interpretation.

Search uses submitted query/required tags, not an automatic interpretation of guidance. Exclusions are sent as excluded tags to Steam and checked as case-insensitive title/tag substrings in returned candidates. Installed Workshop IDs, dismissed IDs and duplicate candidates are filtered. A search fetches one page of at most 20 upstream results; a fully filtered page may be empty. Next page stays tied to the original query/tags. Match evidence reports query-word/tag overlap separately from reference-tag overlap; no overlap remains honest. The host should translate richer user guidance into edited query/tags, or explain that search controls are narrower than the request.

Discovery supports at most 10,000 indexed wallpapers. The existing catalog adapter parses a complete snapshot per query/page; the workflow loads pages once per request and computes reference evidence once, rather than per candidate. This remains a bounded local-library design, not a large-scale search index.

Anonymous inspection accepts a positive uint64 ID or exactly `https://steamcommunity.com/sharedfiles/filedetails/?id=ID`. Alternate hosts, protocols, credentials, ports, fragments, extra/duplicate parameters and arbitrary paths are rejected before network access. The provider requests only official Steam API endpoints; it never fetches caller URLs or scrapes pages. Public app/visibility/banned checks and unavailable reasons remain in the Workshop provider.

Shortlists persist IDs, not downloaded artwork. `shortlist(reference, offset)` returns all saved IDs, one page of up to 50 anonymous metadata records, and `pagination.nextOffset`. The UI shows displayed/total counts and previous/next controls. It does not create native playlists or prove Steam subscription/download state. The UI uses explicit Steam handoff; refresh after download to check local presence.

## Gallery boundaries

Only the exact `127.0.0.1:port` authority is accepted. Mutations require `POST`, the exact same Origin, JSON content type, and a random process CSRF token supplied in `X-Companion-CSRF`. No permissive CORS. Payloads are strict and limited to 100,000 bytes. `GET /api/session` returns the token to same-origin callers; it changes after restart. Foreign origins, absent origin for writes and wrong tokens fail. This is a local browser boundary, not authentication against other processes running as the same OS user.

Read routes: `/api/discovery-context?reference=...`, `/api/shortlist?reference=...&offset=...`, `/api/current` (monitor 0). Action routes: `/api/preferences`, `/api/discover`, `/api/inspect`, `/api/apply`, `/api/play-playlist`, `/api/refresh`. Unknown fields/routes fail. Apply/play accept only validated catalog IDs and monitor 0–63 (UI explicitly uses 0). All playback goes through `PlaybackService`, which rechecks actual source targets and the running installation. Concurrent gallery playback requests are rejected as busy instead of accumulating a queue. Engine failures leave browsing/discovery available. A failed/timed-out mutation can report `mayHaveApplied`; check current state before retry.

Refresh invokes the existing CLI/domain scan with server-owned destination/configuration; it reuses source/destination protection and transactional catalog commit. Refresh requests accept only `{}`. Reload view remains a read. Default stdio MCP has no scan tool.

Local previews reuse `readPreview` validation, accepting only registered catalog IDs and stable contained raster bytes. External thumbnails are browser-fetched HTTPS from exact provider-validated Steam CDN hosts; the CSP names those same hosts. There is no remote-image proxy or arbitrary server fetch.

## Optional stdio MCP

`createCatalogMcpServer(catalog)` still exposes exactly six read-only tools. `createCompanionMcpServer(catalog, workflow, playback?)` adds the following, with compact structured content and usable JSON text fallback:

| Tool | Behavior / annotations |
| --- | --- |
| `discovery_context` | Local preference/style evidence read; read-only, closed world |
| `get_shortlist` | Companion collection + up to 50 anonymous metadata records; read-only, open world |
| `inspect_workshop_item` | Validated ID/URL metadata; read-only, open world |
| `get_wallpaper_image` | Actual MCP image + compact ID/MIME/byte metadata, registered ID only; read-only, closed world |
| `save_discovery_preferences` | Explicit revision-checked companion write; not read-only/idempotent/destructive |
| `discover_wallpapers` | Explicit deterministic controls over read-only Steam search; open world |
| `read_current_wallpaper` | With playback dependency: explicit monitor-0 observation, read-only |
| `apply_wallpaper` | With playback: explicit validated action; not read-only/idempotent/destructive |
| `play_saved_playlist` | With playback: explicit saved playlist action; not read-only/idempotent/destructive |

`registerCompanionReadTools` and `registerCompanionActionTools` are exported separately. The read registrar includes actual images. Playback registration is optional and stays outside the HTTP bridge in this feature. Image results reuse gallery containment/file-change/content checks, enforce a 2 MiB reply limit (no resizing), and support PNG/JPEG/GIF/WebP. Too-large, unavailable or unsafe images return actionable errors with no arbitrary path tool. Hosts decide whether they can consume each image format; actual third-party visual presentation is unverified.

All user/creator text is untrusted data, not tool instructions. Preference mutations and playback require explicit user intent. Command acceptance does not imply verified current wallpaper; playlists cannot verify active identity. No tool subscribes/downloads or edits native playlists. Stdio `--companion` is explicit opt-in and does not edit client configuration.

Brief: The shared workflow offers deterministic, explainable discovery controls and conflict-safe private choices. AI hosts supply richer interpretation, Steam handles installation/native playlists, and validated playback stays explicit. Existing six-tool and HTTP read-only contracts remain intact. Live credentialed search and third-party image presentation remain unverified.
