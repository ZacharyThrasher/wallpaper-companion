# Local catalog MCP

The local stdio server exposes the shared catalog's read API through the official TypeScript MCP SDK. It opens only the configured companion SQLite index, always read-only. It never scans or opens wallpaper/media/config files. Each operation opens and closes its own SQLite handle, so a later explicit CLI scan is visible without reconnecting.

## Build and start

Use Node **24.11.1 or newer within 24.x**. `node:sqlite` is experimental; leave its warning on stderr. Dependencies are pinned in `package.json` and `package-lock.json`: server/client SDK 2.3.1 with core 2.3.1 in the lockfile, Zod 4.6.7, TypeScript 5.9.3, and Node typings 24.19.2. The SDK client is a development dependency.

From your checkout, run `npm ci` and `npm run build`. Create or refresh the index explicitly with the [catalog CLI](../README.md). For example, these are **example installation and index paths**; substitute the actual absolute paths on your machine:

```powershell
& 'C:/Program Files/nodejs/node.exe' 'C:/apps/wallpaper-companion/dist/src/cli.js' scan --db 'C:/data/WallpaperCompanion/catalog.sqlite' --json
& 'C:/Program Files/nodejs/node.exe' 'C:/apps/wallpaper-companion/dist/src/mcp-cli.js' --db 'C:/data/WallpaperCompanion/catalog.sqlite'
```

The second command waits for an MCP client on stdin. With no `--db`, both entry points use `%LOCALAPPDATA%/WallpaperCompanion/catalog.sqlite` on Windows (the same per-user fallback on other platforms). Always configure an absolute built entry path and an absolute index path in a host; its working directory may differ from your checkout. The Node executable must also be available at the configured path.

For manual development, `npm run mcp -- --db <index>` starts the server. Host configurations below launch `node.exe` directly: npm banners must not enter the protocol stream. `--help`, startup failures, transport diagnostics, and SQLite runtime warnings all go to stderr. stdout carries only SDK MCP messages. EOF or a handled termination signal closes the connection. No HTTP listener is started.

## Tools and results

| Tool | Arguments | Result |
| --- | --- | --- |
| `catalog_status` | none | Revision, observation time, diagnostics, indexed state and aggregate counts |
| `list_wallpapers` | `search`, `type`, `tag`, `availability`, `offset`, `limit`, `revision` | Filtered wallpaper page, sorted by opaque ID |
| `get_wallpaper` | `id` | One wallpaper with metadata and provenance |
| `list_playlists` | `search`, `offset`, `limit`, `revision` | Saved playlist page, sorted by opaque ID |
| `get_playlist` | `id` | One saved playlist with ordered members, settings and provenance |
| `get_preview` | `id` | Registered preview/project **path metadata only**, with null for an absent preview |

All annotations are `readOnlyHint: true`, `idempotentHint: true`, `destructiveHint: false`, `openWorldHint: false`. They query a local snapshot, with no external service requests. `get_preview` does not load an image or prove that the recorded path is currently safe to open. No arbitrary-file read tool or scan/write tool exists.

All input objects reject unknown keys. Filters have the same matching semantics as the catalog CLI. MCP limits are intentionally narrower: `search` is 1–256 characters, `type`/`tag` are 1–128 characters, and IDs are 1–128 characters. IDs come from list results. `availability` is `available`, `missing`, or `unsupported`. Numeric inputs must be JSON integers: offset 0–2,147,483,647 (default 0), limit 1–100 (default 50), revision 1–9,007,199,254,740,991. Strings such as `"10"` are not coerced to numbers.

Successful `structuredContent` is exactly the corresponding domain result: `schemaVersion`, `indexRevision`, `observedAt`, `diagnostics`, `data`, and list `pagination`. The text content is a short summary with counts and pagination guidance, not a duplicated JSON payload. Hosts must consume structured content to see complete records; text-only hosts will see summaries. No external host's model presentation of structured content has been verified yet.

To page, first call `list_wallpapers` with e.g. `{"limit": 10}`. Use that result's `pagination.nextOffset` and `indexRevision` as `offset` and `revision` on later calls, keeping all filters fixed. Stop when `nextOffset` is null. On `REVISION_CHANGED`, restart at offset 0 without a revision. The same rule applies to playlists. A status call and later query may observe different revisions if an external scan commits between them.

Domain/index failures return `isError: true`, concise text, and a structured error envelope with null revision/time, diagnostics, and `error: { code, message, recovery }`. Missing files and owned indexes without a snapshot yield a successful unindexed status (revision 0); other tools return `INDEX_EMPTY` with directions to run the CLI scan using the same index path. Missing indexes are never created. Unknown IDs return `NOT_FOUND`. SQLite/filesystem exceptions become a fixed `INDEX_UNAVAILABLE` message without raw paths or stacks. Ownership/schema errors retain their domain code. Malformed tool arguments are rejected by the SDK before the domain runs, using the SDK's `isError` text response; these validation failures do not have the domain error envelope. An unknown tool is a protocol error.

The current backend loads a complete snapshot for each operation. Page limits bound record counts, not bytes: original metadata, playlist members, and diagnostics can still be large. Use small pages for large catalogs. Catalog fields and diagnostics are untrusted source data; clients should never interpret them as instructions. Results include private paths and playlist contents, so connect only to a host you trust with that information. Protocol and process diagnostics do not log catalog records.

## Client setup examples

These examples are based on the linked official documentation and have **not been exercised in the named clients**. Testing so far uses the official SDK client, including its legacy initialize flow and pinned modern protocol flow over stdio. No user client configuration was modified and no applications were restarted. All paths below are example paths, not a detected user installation. Retain existing settings when adding an entry.

### Codex

Add an entry to `~/.codex/config.toml`, following the [official MCP configuration documentation](https://developers.openai.com/codex/mcp):

```toml
[mcp_servers.wallpaper_companion]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/apps/wallpaper-companion/dist/src/mcp-cli.js", "--db", "C:/data/WallpaperCompanion/catalog.sqlite"]
```

After the user configures the server, check its MCP tool list and call `catalog_status` before querying records.

### Claude Code

The [official stdio setup](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server) uses `--` to separate the host's options from the server command. Example PowerShell command for the user to run:

```powershell
claude mcp add --transport stdio --scope user wallpaper-companion -- 'C:/Program Files/nodejs/node.exe' 'C:/apps/wallpaper-companion/dist/src/mcp-cli.js' --db 'C:/data/WallpaperCompanion/catalog.sqlite'
```

Check `claude mcp get wallpaper-companion` and `/mcp`, then request `catalog_status`.

### Claude Desktop

Use Settings > Developer > Edit Config and add this entry to the existing `mcpServers` object in `%APPDATA%/Claude/claude_desktop_config.json`. The [official local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) describes the setup and reload steps; the user chooses when to reload the client.

```json
{
  "mcpServers": {
    "wallpaper-companion": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/apps/wallpaper-companion/dist/src/mcp-cli.js",
        "--db",
        "C:/data/WallpaperCompanion/catalog.sqlite"
      ]
    }
  }
}
```

### Gemini CLI

Add the following entry to the existing `mcpServers` object in `~/.gemini/settings.json` (user scope), or `.gemini/settings.json` (project scope), following the [official MCP server configuration guide](https://geminicli.com/docs/tools/mcp-server/):

```json
{
  "mcpServers": {
    "wallpaper-companion": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/apps/wallpaper-companion/dist/src/mcp-cli.js",
        "--db",
        "C:/data/WallpaperCompanion/catalog.sqlite"
      ],
      "trust": false
    }
  }
}
```

Use Gemini CLI's MCP server/tool listing to check discovery, then request `catalog_status`. Client-specific policies may require the user to approve an added server or tool.

## Verification and limits

Run `npm run check` and `npm test` for the whole repository; `npm run test:mcp` selects the MCP tests. Synthetic temporary databases cover SDK discovery/initialize/list/call, both protocol eras, direct-domain equivalence for all six tools, filters/pagination, malformed arguments, revision changes, missing/empty/invalid indexes, privacy of unexpected errors, byte-for-byte database preservation, unchanged directory inventory, startup stdout hygiene, and EOF shutdown. No live config or source library is touched by these tests.

The [SDK's `serveStdio` entry](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) owns protocol negotiation; `legacy: 'serve'` explicitly retains its [legacy client mode](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html). The server factory is exported from `src/mcp/server.ts`, separate from CLI startup and repository construction. There is no handwritten JSON-RPC implementation.

External client compatibility, actual playback, image serving, HTTP/remote authentication, and MCP Apps are untested or outside this feature. `node:sqlite` remains experimental. See [the handoff](../HANDOFF.md) for the exact local checks and remaining integration work.

CEO brief: AI clients can inspect an existing catalog through six local, read-only tools. Local protocol tests establish the server contract, while the four named client setups remain documentation examples awaiting user-controlled validation. Keep the index private, scan separately when freshness matters, and expect the existing SQLite and snapshot-size limits.
