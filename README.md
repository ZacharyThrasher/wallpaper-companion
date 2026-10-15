# Wallpaper Companion

A Windows companion for finding and organizing Wallpaper Engine wallpapers using your existing playlists and guidance.

The first feature is a read-only local catalog and CLI. An explicit scan reads Steam/Wallpaper Engine metadata and replaces a companion-owned SQLite snapshot. Query commands use the snapshot without rescanning. No wallpaper controls, installation, or source configuration writes are implemented.

Requires Node **24.11.1 or newer in the 24.x line**. The built-in `node:sqlite` module is experimental and emits a warning to stderr; JSON output remains on stdout. No native compiled dependencies are installed.

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

Future preview-serving adapters should call `Catalog.getPreview(wallpaperId)` and revalidate its registered project-relative path against disk before opening. This feature exposes no arbitrary-file serving endpoint. The service has no filesystem dependencies. The SQLite adapter reads and filters a complete snapshot in memory; this is suitable for the current local library size but needs reconsideration for very large catalogs.

Run `npm run check` and `npm test`. Tests use only temporary synthetic files and the built-in Node test runner. CI covers Windows and Linux, Node 24.11.1 and current 24.x. Node 24.11.1 was verified locally, including its experimental SQLite API. No MCP, GUI, taste inference, remote bridge, wallpaper control, automatic subscription, or client compatibility is included in this feature.

CEO brief: The CLI safely catalogs the local library and saved playlists, preserves unresolved entries, and keeps the previous index after failures. It supplies the shared backend for future interfaces. SQLite remains experimental; live files can change after a scan, so availability is an observation rather than a playback guarantee.
