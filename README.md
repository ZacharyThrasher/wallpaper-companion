# Wallpaper Companion

A Windows companion for finding and organizing Wallpaper Engine wallpapers using your existing playlists and guidance.

## Local visual gallery

The gallery shows the saved catalog as an image-led library with title search, type/tag/availability filters, saved playlists in their original order, and a focused wallpaper detail view. Duplicate and unresolved playlist entries remain visible. Nothing in the gallery applies wallpapers or changes Wallpaper Engine configuration.

```powershell
npm ci
npm run gallery:build
node dist/src/cli.js scan --json
npm run gallery
```

Open [the local gallery](http://127.0.0.1:4318). Stop it with Ctrl+C. Use `npm run gallery -- --port 4320 --db <file>` for another port or companion index. Run commands from this repository's root. A missing index shows the exact scan command in the UI; after scanning, choose **Reload view**. This reads the latest saved snapshot and does not initiate a scan. Filters apply to the current library or playlist, and **Clear filters** restores its entries.

Choose a wallpaper to focus its image and details. **Escape** while in the detail panel, or **Close details**, returns keyboard focus to that wallpaper. On narrow windows, the playlist rail becomes a native view selector and details appear above the image grid. Source paths and index diagnostics are disclosed only when requested.

The server binds only to `127.0.0.1`, requires that exact Host/port, rejects other origins and cross-site browser requests, and provides no CORS access. Use the printed IP address rather than `localhost`. It shares one read-only SQLite connection across requests. A database created after launch becomes available when you choose Reload view. If the database file is manually replaced, restart the gallery to open the replacement. Normal CLI scans update the same database transactionally.

Previews accept a catalog wallpaper ID only. Each read rechecks the registered project and preview paths, canonical containment, regular-file identity, and stable bounded bytes. PNG, JPEG, GIF, and WebP signatures are supported up to 16 MiB; SVG and other active formats are refused. Moved files, root aliases/junctions, and project-root paths whose canonical spelling differs from the index are refused conservatively, with an unavailable-preview state. No images are copied to the repository or an upload service. The API includes personal local metadata; any process running as your OS user can access loopback, so keep the index and machine private.

For a synthetic preview that never scans your real library:

```powershell
npm run gallery:build
npm run gallery:demo
npm run gallery -- --db .local/gallery-demo/catalog.sqlite
```

This creates only generated sample imagery and sample playlists under ignored `.local/gallery-demo/`. It uses the real SQLite adapter and HTTP server. Start it while the regular gallery is stopped, or choose another `--port`.

Checks: `npm test` runs the catalog and gallery HTTP tests, UI type checks, frontend state/keyboard/pagination tests, and production UI build. `npm run test:gallery` runs only gallery-related tests. For optional local screenshot review, install Microsoft Edge and run `node ui/review-capture.mjs` while the synthetic gallery runs on port 4318. This writes ignored private captures; it is never part of `npm test` or CI. See [the gallery handoff](docs/gallery-handoff.md) for verification and limits.

An independent [Steam Workshop provider](docs/workshop.md) adds anonymous public
item metadata and optional personal-key search for future interfaces. Search
without a key returns a Steam handoff link and `credentials_required`.
Credentialed search is not yet live-verified; subscription/download and credential
setup UI are outside this feature.

The first feature is a read-only local catalog and CLI. An explicit scan reads Steam/Wallpaper Engine metadata and replaces a companion-owned SQLite snapshot. Query commands use the snapshot without rescanning. No wallpaper controls, installation, or source configuration writes are implemented.

Requires Node **24.11.1 or newer in the 24.x line**. The built-in `node:sqlite` module is experimental and emits a warning to stderr; JSON output remains on stdout. The catalog needs no native SQLite addon.

```powershell
npm ci
npm run build
node dist/src/cli.js scan --json
node dist/src/cli.js status --json
node dist/src/cli.js list-wallpapers --type scene --limit 10 --json
node dist/src/cli.js list-playlists --json
node dist/src/cli.js get-wallpaper <id> --json
node dist/src/cli.js get-playlist <id> --json
```

Use `--profile <name>` if your OS username does not uniquely match a config profile. No first-profile fallback is used. Only saved `general.playlists` are cataloged; active monitor playlists are separate and excluded.

By default, discovery reads `HKCU\Software\Valve\Steam\SteamPath`, Steam's `libraryfolders.vdf`, and `appmanifest_431960.acf`. Multiple installs require selection. Workshop content from all discovered libraries and the install's `projects/defaultprojects` and `projects/myprojects` directories are scanned. Options:

| Option | Scope | Behavior |
| --- | --- | --- |
| `--steam-path <dir>` | scan | Override Steam root; discover libraries and install manifests |
| `--install-dir <dir>` | scan | Select an install directly; infer its Steam library from `steamapps/common`, otherwise try registered Steam |
| `--workshop-dir <dir>` | scan | Override Workshop content root; direct install plus Workshop overrides skip Steam discovery |
| `--profile <name>` | scan | Select an exact config profile key |
| `--db <file>` | all | Dedicated companion index; default `%LOCALAPPDATA%\WallpaperCompanion\catalog.sqlite` |
| `--json` | all | One JSON response on stdout; runtime warnings remain on stderr |
| `--search <text>` | lists | Case-insensitive title/name substring |
| `--type <type>`, `--tag <tag>` | list-wallpapers | Case-insensitive exact type/tag match |
| `--availability <value>` | list-wallpapers | `available`, `missing`, or `unsupported` |
| `--limit <n>`, `--offset <n>` | lists | Limit 1–500 (default 50), nonnegative offset (default 0) |
| `--revision <n>` | lists | Fail with `REVISION_CHANGED` if a scan occurred between pages |

```powershell
# Workshop root can be supplied explicitly, or inferred from a standard install path.
node dist/src/cli.js scan --install-dir 'D:\SteamLibrary\steamapps\common\wallpaper_engine' --workshop-dir 'D:\SteamLibrary\steamapps\workshop\content\431960' --profile Example --db .local/catalog.sqlite --json
node dist/src/cli.js list-wallpapers --tag nature --availability available --offset 10 --limit 10 --revision 1 --json
```

JSON responses contain `schemaVersion: 1`, `indexRevision`, `observedAt` (UTC ISO timestamp), `diagnostics`, and `data`. List responses add `pagination: { offset, limit, total, nextOffset }` and sort by opaque ID, independent of title changes. `status` returns aggregate counts and succeeds with revision 0 before the first scan. Other queries need an index. Errors exit 1 and include an error code; failed operations use null revision/timestamp because no response snapshot was read. Success exits 0. Unsupported flags and out-of-range pagination fail explicitly.

Wallpapers include optional `workshopId`, title, lowercase type, tags, `projectPath`, `playableTarget`, preview path or null, availability, provenance, timestamp, and original project/cache metadata. Numeric Workshop folders establish identity even when `project.json` omits `workshopid`. IDs hash Workshop identity or normalized local project path; relocating a local project changes its ID. Duplicate copies prefer an available copy in deterministic traversal order and emit a diagnostic. Cached metadata never establishes subscription state: provenance always reports subscription as `unknown`. Cache-only records remain `missing` with no playable target.

Packed Scenes launch `project.json` and are available when their declared scene file or `scene.pkg` exists. Other supported types (Video, Web, Application) resolve their declared file relative to the project. Availability means required files exist at observation time; it does not mean Wallpaper Engine accepted or played them. Playlist aliases match normalized case/separators against project launch paths, playable paths, and validated cache aliases. Missing files can still resolve to known wallpaper identities. Unknown members stay in their original position with `resolution: unresolved`; original item values, presets, `daytimeend`, settings, and unknown playlist fields are preserved. Playlist IDs hash exact profile/name/duplicate occurrence; renaming a list changes its ID. Duplicate names emit a diagnostic.

Scans are bounded and complete before the index is opened for writing. File reads are limited to 32 MiB and three attempts; malformed JSON gets bounded retries for concurrent writers. Metadata fingerprints record SHA-256 of exact UTF-8 source bytes, including any BOM. Every observed metadata file is reread before returning the snapshot; a detected change aborts the scan. VDF nesting is limited to 32 levels; project traversal is limited to five directory levels and 100,000 directories. Directory access errors and disappearing entries abort the scan. Optional absent roots, config, or cache emit diagnostics. Invalid config/cache container schemas abort; malformed individual projects emit diagnostics and are skipped. Unknown project types remain cataloged as `unsupported`. Project-relative traversal, absolute paths, alternate streams, and symlink/junction escapes never become playable or preview targets.

The completed snapshot is stored in one SQLite transaction. A failed scan or transaction preserves the last complete snapshot; every successful commit advances the revision, including an unchanged rescan. Source fingerprints and unknown metadata are retained inside the snapshot. The fingerprint check is a best-effort view of a running application's files, not a filesystem-wide transaction: inventory or media may change after observation. Queries deliberately do not refresh availability. Concurrent scans serialize at commit, with the last successful commit winning.

The index must live outside the selected Steam/Wallpaper Engine source roots (including junction aliases and effective default/local project roots). A nonstandard direct install with no registered Steam has no inferred Workshop root; supply `--workshop-dir` in that case. Existing databases need the companion application ID and supported schema version. Query commands open the index read-only and never create a missing file. Indexes contain local paths, saved playlist contents, and metadata; keep them private. Do not commit indexes, live configuration, or personal fixtures.

Developer interfaces are stable for the first adapters:

| Module | Exports |
| --- | --- |
| `src/domain.ts` | Versioned `Wallpaper`, `Playlist`, `Snapshot`, `IndexedSnapshot`, `CatalogRepository`, `CatalogError` |
| `src/catalog.ts` | `Catalog(repository)`: `status`, `listWallpapers`, `getWallpaper`, `listPlaylists`, `getPlaylist`, `getPreview`, `commit` |
| `src/adapters/steam.ts` | `discover(options): Promise<SourceLocations>`, `parseVdf` |
| `src/adapters/scanner.ts` | `scan(locations, options): Promise<Snapshot>`, `selectProfile` |
| `src/adapters/sqlite.ts` | `SqliteCatalogRepository(filename, readOnly?)` implementing `read`, `replace`, `close` |
| `src/cli.ts` | `run(argv, write?): Promise<number>`, path/default-index helpers |

Preview-serving adapters call `Catalog.getPreview(wallpaperId)` and revalidate its registered project-relative path against disk before opening. The gallery implements this without an arbitrary-file serving endpoint. The catalog service has no filesystem dependencies. The SQLite adapter reads and filters a complete snapshot in memory; this is suitable for the current local library size but needs reconsideration for very large catalogs.

Run `npm run check` and `npm test`. Tests use synthetic files with the built-in Node test runner and Vitest/Testing Library for the gallery. CI covers Windows and Linux, Node 24.11.1 and current 24.x. Node 24.11.1 was verified locally, including its experimental SQLite API. The local GUI is described above. No MCP, taste inference, remote bridge, wallpaper control, automatic subscription, or external-client compatibility is included in this feature.

Brief: The CLI safely catalogs the local library and saved playlists; the gallery makes their imagery and order easy to inspect. Both preserve unresolved entries, and a failed scan keeps the previous index. Local browser access is restricted to the loopback origin, and source configuration stays untouched. SQLite remains experimental; live files can change after a scan, so availability is an observation rather than a playback guarantee.
