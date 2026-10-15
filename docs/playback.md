# Wallpaper Engine playback adapter

The shared TypeScript service lives in `src/playback/index.ts`. It is independent of the catalog CLI, GUI, and MCP transport. The catalog public contract and existing CLI remain unchanged. This feature does not edit live configuration, native playlists, subscriptions, or Steam state.

The command syntax and scope follow [Wallpaper Engine's official command-line documentation](https://help.wallpaperengine.io/en/functionality/cli.html). Wallpaper Engine must already be running. The adapter never intentionally starts it.

## Integration contract

```ts
import { PlaybackService, PlaybackError } from './playback/index.js';

// catalog is the existing Catalog instance. Default discovery uses Steam.
const playback = new PlaybackService({ catalog });
const current = await playback.readCurrent({ monitor: 0 });

// Call only after the host has obtained the user's authorization to change playback.
const result = await playback.applyWallpaper({ wallpaperId: selectedId, monitor: 0 });
```

The service exposes:

| Method | Request | Command scope | Evidence returned |
| --- | --- | --- | --- |
| `readCurrent` | Optional `monitor` | Explicit first monitor (0) by default | Current catalog ID, unindexed, or none |
| `applyWallpaper` | `wallpaperId`, optional `monitor` | Explicit first monitor (0) by default | Accepted command, previous/current observations, bounded target verification |
| `activatePlaylist` | `playlistId`, optional `monitor` | Explicit first monitor (0) by default | Accepted command and previous observation; playlist verification unavailable |
| `nextWallpaper` | Optional `monitor` | All monitors by default | Accepted command and previous primary/specified-monitor observation |
| `pause` / `play` | No fields | All wallpapers | Accepted command; playback state verification unavailable |

Monitor values must be safe integers from 0 through 63. This conservative request bound does not enumerate or establish which displays exist. Read, apply, and playlist activation always send an explicit monitor, defaulting to 0, so pre-observation and verification address the same display. The CLI's omitted-monitor defaults differ: open commands use the first monitor while getWallpaper uses the primary monitor. Pause and play reject a monitor field because the documented commands are global. Unknown fields, raw paths, executable overrides, and raw argument arrays are rejected. IDs must be opaque catalog IDs with the expected namespace, and must exist in the current catalog.

`PlaybackDependencies` is trusted application configuration, not a request schema. It accepts the existing catalog, optional discovery provider, process runner, and process inspector. The wait and username dependencies support deterministic synthetic tests. Never populate these dependencies from GUI/MCP request values. The default playlist profile must match the current OS username. A host using an explicit discovery provider is responsible for selecting the correct installation, as it is for catalog discovery.

All calls on a service instance are serialized. Separate instances and external Wallpaper Engine actions are not locked. Host applications must provide their own mutation authorization and session/access policy. There is no new CLI wrapper or externally accessible server in this change.

## Validation and execution

- Each operation discovers the installation again. Only regular `wallpaper64.exe` or `wallpaper32.exe` files directly in its canonical directory qualify. Executable links that resolve elsewhere are rejected. A fixed Windows PowerShell CIM query finds engine executable paths in the current Windows session; the service selects the matching installed, running architecture. It checks again immediately before each command. No executable path is accepted in an action request.
- Explicit install-root junctions and Windows short-path aliases are canonicalized. This is a location/identity check, not Authenticode verification or protection from a hostile local process replacing files. There is an unavoidable race between inspecting the process and invoking the installed executable: if the engine exits in that interval, its documented CLI offers no atomic send-only guarantee. The adapter does not implement auto-start or retry mutations.
- Wallpaper launch targets must be under current discovered Workshop, default-project, or local-project roots, both lexically and canonically. Project metadata is re-read; its type and canonical target must agree with the indexed record. Files must still exist and be regular files. Scene projects launch `project.json` and require their declared source or `scene.pkg`; other catalog-supported types use the declared media/application target. Internal project paths cannot escape through traversal or links. Assets may still change after validation.
- Saved playlist activation re-reads the current installed `config.json`, requires its provenance/position/name to agree with the catalog, and requires the selected profile to match the current OS username. Duplicate names, including case variants, fail rather than guessing. Empty names, leading whitespace/hyphens, quotes, control characters, and names over 256 characters fail conservatively. Other punctuation is passed as one literal argument. A renamed/reordered/deleted playlist requires a rescan. The CLI does not expose active profile identity; acceptance cannot establish that the desired playlist is active.
- Production execution uses `execFile` with argument arrays, `shell: false`, hidden windows, a 3-second command timeout, and a 64 KiB output limit. Process inspection has a 5-second timeout and the same output bound. These are per-process bounds, not a single end-to-end deadline. Injected runners must honor timeout/cancellation and output bounds; the service also checks returned output length and exit status. Raw stdout/stderr and filesystem exceptions are never returned to callers.

## Acceptance, observation, and potential undo

`accepted: true` means the CLI invocation completed with exit code zero. It is not an acknowledgement from the renderer. After applying a wallpaper, the adapter polls `getWallpaper` up to four times, 150 ms apart. `verification` is `target-observed`, `not-observed`, or `unavailable`. `changeObserved` is false when the target was already current, and null if either observation failed. Target-observed describes identity at that moment; it does not prove a new transition, rendering health, settings, or continued playback.

Current output accepts one bare or double-quoted absolute path, trims outer whitespace/BOM, and normalizes separators, case, canonical/short-path aliases, and Windows extended-path prefixes. Scene project and packed-scene paths map to the same catalog ID. Empty output means no reported wallpaper; unrecognized text fails rather than being presented as a path. Unindexed or ambiguous targets return no path and no ID. Public results contain only IDs, state, monitor, observation times, and stable error codes.

Playlist activation, pause, play, and next return `verification: 'not-supported'`. `getWallpaper` alone cannot establish active playlist identity/order, pause state, or successful advancement. An unscoped next action affects all monitors; its previous observation covers only the primary monitor.

Previous observations are retained in action results so a future host can offer a deliberate best-effort reapply by known wallpaper ID and monitor. There is no undo method or success claim. Unindexed targets cannot be restored by this ID-only API. Reapplying a known ID cannot restore playlist state, properties/presets, timing, or every display. No automatic rollback occurs. A pre-observation failure does not block an otherwise valid mutation; its state is `unavailable` with a redacted error code.

`PlaybackError` exposes `code`, safe `message`, and `mayHaveApplied`. Mutation subprocess timeouts, nonzero exits, and output failures set `mayHaveApplied: true`: the effect may have reached the engine despite the failed invocation. Read current state before deciding whether to retry. Preflight errors leave it false. Poll failures after a zero exit return an accepted result with unavailable verification instead of disguising the completed invocation as a rejected command.

## Validation and handoff

The adapter-level checks below record its original validation. The [guided workflow](discovery.md) now connects this service to explicit gallery and opt-in stdio MCP actions, with synthetic integration tests; live engine behavior remains unverified.

- Local Windows Node v24.11.1: `npm ci --ignore-scripts`, `npm run check`, and `npm test` pass. The suite has 27 groups: 12 existing catalog and 15 playback groups. Playback uses synthetic files and injected command/process inspection responses. Tests cover malicious arguments/IDs, monitor boundaries and differing first/primary displays, missing/stale/escaped paths, installation/process matching, immediate pre-command revalidation, literal argument transport, runner timeout/output/nonzero failures, output normalization, delayed/failed verification, already-current behavior, playlist ambiguity, unchanged fixture config, and serialized calls.
- The real `execFile` runner is tested only with Node subprocesses. No live Wallpaper Engine command, including apply, pause, play, or next, was run. No live wallpaper or configuration was changed. Real engine argument parsing and getWallpaper output, rendering success, multi-monitor behavior, other OS execution, and rollback remain unverified. Gallery/stdio integration is tested synthetically; actual third-party client presentation remains unverified.
- Earlier private-repository GitHub Actions runs were blocked by the account Actions budget. The coordinator subsequently made the repository public at the user's request to enable standard CI. Fresh branch/PR results are recorded in the PR; no billing or runner workarounds are part of this feature.
- Adapter implementation: `src/playback/` and `test/playback.test.ts`. Integrated actions and their limits are documented in [discovery](discovery.md). Coordinator review and any controlled live verification remain separate release decisions.

Brief: Explicit gallery and opt-in stdio actions use the validated playback backend. It checks installed/running identity and catalog targets, and reports acceptance separately from observed state. Tests do not change the live desktop. Active playlist identity, undo, real engine compatibility and third-party client presentation remain unverified; controlled live testing is a separate decision.
