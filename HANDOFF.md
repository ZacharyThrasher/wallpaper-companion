# Local MCP implementation handoff

Branch: `feature/local-mcp`. Draft PR targets `main`; coordinator owns review and merge. Catalog PR #1 merged at `8814e6e`, and this branch includes `origin/main`. Worktree: `C:/AI/lora/tools/wallpaper-companion-worktrees/mcp`. No other worktree was modified.

## Decisions and files

- `src/mcp/server.ts` exports `createCatalogMcpServer(readOnlyCatalog)`. Its dependency type excludes catalog commits. Six tools expose status, wallpaper/playlist list/get, and preview path metadata. Strict Zod input objects reject unknown keys; page size is capped at 100, with bounded strings/integers and revision-aware pagination. All tools advertise read-only/idempotent/non-destructive/closed-world hints. Successful structured content equals the domain envelope, accompanied by concise summary text. Domain/index failures add an actionable structured error; SDK validation failures retain the SDK text error format.
- `src/mcp/index.ts` constructs the catalog with a read-only repository adapter. Each query opens `SqliteCatalogRepository(filename, true)` and closes it in `finally`. Missing files return an empty status without creating files/directories. No scan or filesystem media read is performed, and the repository's replace operation always fails. This permits separate CLI scans to become visible on subsequent calls.
- `src/mcp-cli.ts` starts official SDK `serveStdio` with explicit legacy-client support. stdout is protocol-only; help and fixed diagnostic messages go to stderr. stdin EOF and termination signals close the connection. It accepts only `--db` and `--help`; tool calls cannot select another database.
- `src/adapters/database-path.ts` extracts the unchanged default-index helper for both entry points. `src/cli.ts` imports and re-exports it to preserve its API; no scan behavior changes. Catalog, scanner, SQLite, and Steam adapter internals were not edited. No upstream fixes were needed for this feature.
- `package.json` / lockfile pin coherent exact dependencies: official server/client 2.3.1, core 2.3.1 transitively, Zod 4.6.7, TypeScript 5.9.3, and Node types 24.19.2. Client SDK is dev-only. Added `mcp` and `test:mcp` scripts. Registry package availability and published exports were verified before implementation.
- `test/mcp.test.ts` adds seven synthetic protocol/integration groups. `docs/local-mcp.md` documents contract, operational limits, and absolute built-command examples for Codex, Claude Code, Claude Desktop, and Gemini CLI, with official sources. README links the local MCP interface.

## Checks completed locally

On Windows with Node **v24.11.1**, after merging `origin/main`:

- `npm ci --ignore-scripts`: clean lockfile install, audit reported zero vulnerabilities.
- `npm run check`: TypeScript passes.
- `npm test`: **19/19 groups pass**, comprising 12 upstream catalog groups plus seven MCP groups. `npm run test:mcp` also passed before integration.
- Official SDK client tests cover legacy initialize/list/call and pinned modern discovery/list/call, in memory and through the actual built CLI/stdin/stdout transport. All six tools match direct domain results, including filters, null previews and preserved playlist members.
- Pagination ordering/end conditions, changed revision, invalid strings/numeric ranges/types/enums/IDs/unknown fields, unsupported tool names, missing/empty/invalid indexes, and generic exception privacy are exercised. Invalid calls are rejected before the catalog runs. Unknown-ID errors provide recovery guidance.
- Real SQLite fixture bytes and containing-directory inventories remain unchanged after MCP queries. Missing-index calls create nothing; a later explicit test-fixture commit becomes visible without reconnecting. SQLite experimental warnings are received on stderr, with no SDK protocol parse errors. Help/bad CLI arguments produce empty stdout; EOF exits within the bounded check.
- Aggregate-only SDK stdio smoke against the coordinator-created default live index passed: **44 wallpapers, 44 available, 2 saved playlists, 21 saved members, six tools**. Status and bounded list results, plus one wallpaper/preview/playlist lookup, matched direct domain calls without printing any titles, filenames, playlist contents or configuration. No scan was run by this implementation chat. Earlier, before the coordinator created it, the default index was absent; missing-index behavior was tested synthetically as well.
- `git diff --check` passes. No personal source/config files, real index, assets, credentials or private fixtures were added. No user AI client configuration was changed and no app was restarted.

## Limitations and next actions

- **External client setups are documented, not tested.** SDK protocol compatibility does not prove how Codex/Claude Code/Claude Desktop/Gemini CLI present structured results to their models. Text-only hosts receive summaries. The coordinator/user chooses the actual client validation sequence.
- `node:sqlite` is experimental; its warning remains visible on stderr. The existing backend deserializes a complete snapshot per operation. Page bounds limit item counts, not the bytes of raw metadata, member lists or diagnostics. Queries reflect the last scan, and consecutive calls can see different revisions. Clients must restart pagination after `REVISION_CHANGED`.
- Preview lookup returns registered path metadata only. Image serving would require fresh disk-containment/content checks and is outside this feature. HTTP/remote authentication, MCP Apps, scanning tools, wallpaper controls and installation are excluded.
- **GitHub Actions infrastructure is blocked by the account Actions budget**, as reported and independently checked by the coordinator on catalog PR #1. No retries, bypasses, billing changes or settings changes were made. The existing Windows/Linux and current-24.x CI matrix remains unverified remotely; local Windows 24.11.1 checks are the evidence here.
- Next: coordinator reviews the draft against `main`, verifies selected client setup when ready, and decides merge. This implementation chat must not merge its own PR.

CEO brief: The local MCP feature is implemented and locally validated, including an aggregate-only check of the real catalog. It exposes six read-only tools without scanning or controlling Wallpaper Engine. Coordinator review and client-specific setup validation remain; remote CI is unavailable because of the Actions budget, and SQLite remains experimental.
