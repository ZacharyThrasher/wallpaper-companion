# Local gallery handoff

One feature, branch `feature/local-gallery`, based on merged catalog commit `8814e6e`. Draft PR targets `main`. Coordinator owns review, integration, and merge. No MCP or catalog internals changed.

## Behavior and files

- `src/gallery/server.ts`: read-only loopback API adapter and static UI server. Shared Catalog responses for status, paginated wallpapers/playlists, and individual resources. Wallpaper previews use opaque IDs only; no arbitrary path, URL, or remote fetch input. Errors do not include filesystem exception stacks.
- `src/gallery/main.ts`: port 4318 by default, strict override parsing, one lazily opened read-only SQLite repository, graceful stop. A nonexistent index remains uncreated until a separate CLI scan. Start via `npm run gallery` after `npm run gallery:build`.
- `ui/src/App.tsx`: title search, optional type/tag/availability filters, desktop playlist rail and narrow native selector, saved-order membership with duplicates/unresolved rows, focused image details, explicit unavailable state, index timestamp, and disclosed diagnostics/source details. Index refresh reloads data and images without writing source configuration.
- `ui/src/api.ts`: loads all pages at the status revision. A revision conflict fails visibly rather than mixing snapshots. This first local-library implementation loads the complete small catalog client-side; it does not virtualize very large collections.
- `src/gallery/demo.ts`: local synthetic review fixture generator. It writes only `.local/gallery-demo`, uses the real SQLite adapter, and never reads user media or config. All screenshots stay ignored under `.impeccable/review`.
- Product and visual constraints: `PRODUCT.md`, `DESIGN.md`, `.impeccable/surfaces/gallery.md`, `.impeccable/design.json`. The human delegated stack/taste/reversible decisions; the coordinator pinned the charcoal, image-led Operate direction and code-first execution. No interview or concept tournament was required.

## Boundary decisions

Exact `127.0.0.1:<port>` Host, same Origin when supplied, and same-origin/none Fetch Metadata are required. Remote Origin, opaque Origin, cross-site embeds, alternate Host values, and writes fail before returning catalog data. No permissive CORS. CSP confines scripts, styles, images, and requests to the gallery; embedding is forbidden. The service is a local-user boundary, not OS-user authentication.

Preview reads validate the indexed project file, lexical/canonical containment, file identity and stability, a 16 MiB byte limit, and PNG/JPEG/GIF/WebP signatures. Root aliases/junctions and short-name paths whose canonical spelling differs are conservatively refused. The original index does not store a separate canonical-root approval receipt, so this feature chooses refusal over silently following a changed root. Exact-byte image decoding/pixel-count limits and filesystem-wide atomicity are not claimed. A same-user process able to modify the library and race filesystem checks is outside this local browser-origin boundary. No native configuration mutations or controls exist.

The gallery does not scan automatically, infer preferences, verify subscription status, search Workshop, edit playlists, apply wallpapers, change startup, or claim compatibility with external clients. Preview images describe static registered artwork, including video/web projects; they are not wallpaper playback.

## Verification

- Node 24.11.1, Windows, real built-in `node:sqlite`; experimental warning is expected.
- HTTP tests: API parity, ordered playlist response, Host/Origin/Fetch Metadata denials, no CORS, read-only methods, ID-only previews, HEAD, traversal, symlink/junction escapes, changed root, missing files, SVG refusal, oversized previews, invalid filters/revisions, and static-resource boundaries.
- Ten frontend tests: loading, missing index/setup command, read failure/retry, title and availability filtering/reset, saved order/duplicates/unresolved rows, empty playlists, focus/Enter/Escape/return focus, broken-image fallback, multi-page loads at a consistent revision, empty-catalog short-circuit, and revision failure.
- Existing 12 catalog test groups continue to pass. Root `npm test` includes all gallery checks and production UI build, so the existing CI definition will cover them when available.
- Bounded Playwright review used installed Microsoft Edge, synthetic SQLite fixtures, 1440px desktop and 390px narrow screenshots of the library and selected playlist/details. Images decoded, no page errors, no horizontal overflow, detail focus confirmed. Captures were inspected locally and never uploaded or committed. The manual Impeccable detector ran once and returned no findings.
- Independent Impeccable finish review returned `ship` with no material fixes across all four captures. The documented pinned direction superseded a concept roll; all requested interaction and responsive states were inspected against it.
- Clean `npm ci --ignore-scripts`, root `npm test` (20 Node test groups and 10 frontend tests, UI type check/build), and production dependency audit pass locally. No personal imagery, indexes, paths, or real playlist metadata is committed.
- A historical GitHub Actions budget block occurred while the repository was private. The user then explicitly requested public visibility, and the coordinator changed it and restarted standard CI. Check the draft PR's fresh matrix run for current execution status; no billing change or workaround was used by this feature.

## Remaining integration

Coordinator integrates root dependency/script changes with the MCP feature. Review and merge this draft only after independent code review. No system startup changes were made. The local preview is optional and read-only.

Brief: the real local catalog now has an image-led browser for wallpapers and saved playlist order. Source files stay untouched. Local correctness checks cover the important data and browser-access boundaries; fresh cloud CI is available after the user's public-repository decision. This version keeps scans in the CLI and controls in Wallpaper Engine. The coordinator's next decision is review and integration, then merge.
