# Library catalog implementation handoff

Branch: `feature/library-catalog`. Draft PR: https://github.com/ZacharyThrasher/wallpaper-companion/pull/1. Worktree: `wallpaper-companion-worktrees/catalog` adjacent to the base checkout. Coordinator owns review and merge. Do not merge this PR from the implementation chat.

## Decisions and files

- Node 24.11.1+ within 24.x; TypeScript build, built-in test runner, no native addons. `node:sqlite` is experimental and its warning stays on stderr.
- `src/domain.ts` owns schema version 1 read models and the repository interface. Raw source metadata and exact-byte UTF-8 SHA-256 fingerprints are retained in snapshots. No live config is committed.
- `src/catalog.ts` owns query/filter/pagination/preview-ID lookup. Responses carry schema/revision/time/diagnostics. Ordering is by opaque ID; callers can require a revision for later pages. List filtering creates new arrays; production SQLite reads deserialize independent snapshots.
- `src/adapters/files.ts` handles bounded reads, stable-file checks, IDs, and lexical/canonical path guards. `steam.ts` handles registry/VDF/manifest discovery. `scanner.ts` reads projects, cache, and saved playlists without writes.
- Direct install selection infers Workshop roots from its Steam library (or registered Steam for nonstandard paths). Database guards include effective default/local project roots, so external root junctions stay protected. Both coordinator review findings have targeted regression tests.
- `src/adapters/sqlite.ts` commits one snapshot row transactionally and validates database ownership/schema. `src/cli.ts` provides scan/query commands and rejects database paths under source roots. A failed scan never opens the output for writing.
- `test/catalog.test.ts` uses temporary synthetic fixtures; `.github/workflows/ci.yml` checks Windows/Linux with exact minimum and current 24.x. Root package scripts are `build`, `check`, `test`, and `start`.

## Contract notes for subsequent adapters

Use `Catalog.getPreview(wallpaperId)` rather than accepting filesystem paths from callers. A serving adapter must revalidate the registered preview's project containment and allowed content type immediately before reading; an indexed file can change. No HTTP/media server is part of this PR.

Wallpapers distinguish available/missing/unsupported and retain provenance with unknown subscription state. Packed Scenes use project.json as launch target. Playlists preserve raw values and ordering, including unresolved and future-format members; active monitor playlists are excluded. No default-first profile selection exists.

Every successful commit advances indexRevision. Source fingerprints remain internal to Snapshot, while status returns counts. Per-file checks and final metadata rereads detect edits during scans; there is no filesystem-wide atomicity or media content verification. Queries intentionally describe the last complete observation. Concurrent scans use last-commit-wins behavior.

The single-row JSON snapshot keeps persistence and atomic replacement simple. It loads the entire snapshot per operation and is intentionally bounded to the first small local-catalog feature. Local path-derived IDs change when local projects move; playlist name-derived IDs change on rename. Duplicate names use occurrence order with diagnostics.

## Verification and limitations

- Local `npm ci --ignore-scripts`, `npm run check`, and all 12 `npm test` groups pass on Node v24.11.1; synthetic coverage includes packed Scenes, mixed playlists/presets, profile ambiguity, malformed sources, path/junction escapes, stable IDs/pagination, immutable input hashes, failed-scan preservation, and forced SQLite rollback. Both coordinator review regressions have targeted tests.
- Optional read-only live check: 44 accepted wallpaper projects (25 Scene, 17 Video, 2 Web), 2 saved playlists, all 21 saved members resolved, all 44 accepted wallpapers available. Workshop inventory from completed research was 28; this scan also includes bundled/local projects. Three project schema diagnostics and four absent optional project roots were reported. These are aggregate observations only.
- SHA-256 input comparison confirmed all 49 inventoried metadata files unchanged. No titles, playlist contents, personal media paths, config files, or assets were committed. The optional live index and checker stay under ignored `.local/`.
- Actual playback, wallpaper controls, external clients, MCP, gallery, remote access, subscriptions, and taste inference were not tested or implemented. SQLite is experimental.
- GitHub Actions did not start any test steps: the check annotation states, "The job was not started because an Actions budget is preventing further use." Remote validation is blocked by account infrastructure; this is not a remote test result. No retries, billing changes, or account-setting workarounds were attempted. The Windows/Linux and current-24.x matrix remains unverified remotely.

Next: coordinator reviews the draft and selects integration order; subsequent feature chats should branch after the reviewed catalog API is accepted.

Brief: The first shared backend and CLI are implemented and locally validated, including a read-only live check. The coordinator still owns review, merge, and subsequent interface work. Remote CI cannot run because of the Actions budget. Main implementation limits are experimental SQLite, stale observations between scans, and in-memory snapshot scaling.
