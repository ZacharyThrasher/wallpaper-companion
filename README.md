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

Use `--profile <name>` if your OS username does not uniquely match a config profile. Use `--help` for scan overrides and filters. The default index is `%LOCALAPPDATA%\WallpaperCompanion\catalog.sqlite`; `--db <file>` selects a dedicated companion database outside source directories. Indexes contain local paths and metadata; keep them private.

Developer interfaces: `src/domain.ts` defines the versioned read models and repository boundary; `src/catalog.ts` exports the `Catalog` service; adapters implement Steam discovery, bounded filesystem scanning, and SQLite persistence. More verification and detailed contract notes are being added in the draft PR.
