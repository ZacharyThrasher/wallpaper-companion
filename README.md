# Wallpaper Companion

Find Wallpaper Engine wallpapers using saved playlists and explicit guidance, browse your installed library, and use the same catalog and preferences from a local AI host.

Requires Node **24.11.1+ in the 24.x line**, Windows for Steam discovery/playback, and Wallpaper Engine for playback. SQLite uses Node’s built-in experimental module; no native addon is required.

```powershell
npm ci
npm run gallery:build
node dist/src/cli.js scan --json
npm run gallery -- --refresh-defaults
```

Open [the local gallery](http://127.0.0.1:4318). Stop it with Ctrl+C. Run commands from the repository root. `--refresh-defaults` explicitly chooses default Steam sources and the OS profile for future refreshes. If your scan used custom paths or `--profile`, pass those same options to `gallery` instead. Without configured sources, Refresh library explains how to configure them and leaves the index intact.

## Discover

Choose **Discover**, select a saved playlist as a reference (or none), and describe what you want. Edit the suggested search query and required tags, add exclusions, then choose **Find wallpapers**. **Save guidance** stores your prose and controls for that reference; UI and opt-in stdio MCP share the same preferences.

Suggestions count existing title words and tags. They do not analyze artwork, movement, or semantic intent. An AI host can interpret richer guidance and request actual registered preview images. Match explanations distinguish query overlap from reference tags.

Without a Steam API key, search provides a working **Open Steam search** link. Paste a public Workshop item URL or positive ID into **Inspect item** for anonymous metadata. With an optional environment-only Steam Web API key, search returns real candidates with previews and excludes installed/dismissed IDs. See [discovery setup and limits](docs/discovery.md).

Shortlist or dismiss items per reference. A **companion shortlist** is a local collection, separate from Wallpaper Engine playlists. Subscribe in Steam, wait for download, and add wallpapers to native playlists in Wallpaper Engine. Opening a link does not prove subscription or installation. This app does not subscribe, download, or edit native playlists.

## Library and playback

Browse installed wallpapers, filter by title/type/tag/availability, and inspect saved playlists in exact order, including duplicate and unresolved entries. Select a wallpaper for image and details; Escape or Close details returns focus to its tile. Narrow windows use a native View selector.

**Apply wallpaper** and **Play playlist** use validated catalog IDs and explicitly target **monitor 0**. Wallpaper Engine must be running. A wallpaper command reports acceptance and whether the target was observed separately. Playlist commands report acceptance; active playlist identity cannot be verified. **Read current state** checks the default display. Browsing, discovery and shortlists remain available when Wallpaper Engine is stopped.

**Refresh library** explicitly scans configured sources into the companion index. **Reload view** only rereads that snapshot. Failed scans preserve the last complete index; source files are never rewritten by scanning. Timestamp, unavailable files, and diagnostics remain visible.

## AI and CLI

The default [stdio MCP server](docs/local-mcp.md) keeps its six read-only catalog tools. Add `--companion` to opt into discovery, shared preferences, actual preview-image reads, and explicit playback tools:

```powershell
node dist/src/mcp-cli.js --companion
```

Only ask playback tools to run when you intend a wallpaper or playlist change. Gallery and MCP can run as separate processes; optimistic revisions reject conflicting preference edits instead of silently overwriting them. On conflict, reload preferences and reconcile your changes.

The separately configured [Streamable HTTP MCP bridge](docs/http-mcp.md) remains read-only with its six catalog tools. Named third-party clients are documented; SDK tests do not establish their actual presentation or visual-tool support.

See [catalog/CLI reference](docs/catalog.md), [Workshop provider](docs/workshop.md), [playback contract](docs/playback.md), and [guided workflow contract](docs/discovery.md) for technical limits.

## Local data and checks

By default the companion owns `%LOCALAPPDATA%\WallpaperCompanion\catalog.sqlite` and a separate `preferences.sqlite`. The catalog contains private local paths and saved playlist metadata; preferences contain your guidance and item choices. Keep both private. Steam keys are read only from the server environment and are never copied into preferences.

The gallery binds to `127.0.0.1`, validates Host and Origin, and requires same-origin CSRF-protected JSON for actions. It provides no permissive CORS. Preview reads accept registered catalog IDs, recheck containment/content, and reject arbitrary files. Remote thumbnails are limited to exact HTTPS Steam CDN hosts and are fetched directly by the browser.

For a synthetic review that does not read your library:

```powershell
npm run gallery:demo
npm run gallery -- --db .local/gallery-demo/catalog.sqlite --preferences .local/gallery-demo/preferences.sqlite --port 4328
```

`npm run check` and `npm test` cover catalog, Workshop, playback, gallery, both MCP interfaces, guided workflow, UI states/keyboard behavior, and the production UI build. CI covers Windows/Linux on Node 24.11.1 and current 24.x. Optional local synthetic screenshots use `node ui/review-discovery.mjs` with Edge installed; no screenshots or personal assets enter Git.

Brief: Discovery connects saved playlist evidence, explicit guidance, Steam inspection, and local shortlists in one workspace. Steam owns subscription/download and native playlist changes. Playback is explicit, preference conflicts are visible, and no-key discovery remains usable. Credentialed search and individual AI client presentation still need live validation.
