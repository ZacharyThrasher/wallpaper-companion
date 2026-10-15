# Wallpaper Companion

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript, Node 24, built-in SQLite, React and Vite. A loopback process serves the gallery and API. CLI and MCP adapters use shared backend services. The interface extends the existing code and design system.

## Users

People using Wallpaper Engine on Windows who want to find wallpapers from existing playlists and explicit guidance. Focused, scannable workflows and progressive disclosure keep the task manageable.

## Product Purpose

Discover suitable wallpapers from saved playlist references and explicit preferences, inspect installed imagery, and explicitly control validated local playback. One backend makes catalog evidence and companion preferences available to the gallery and AI hosts.

## Operating Context

An explicit CLI scan or configured Refresh library action creates a companion-owned snapshot. Gallery and MCP read it without scanning automatically. Reload view only reloads the snapshot. A separate versioned preferences database shares per-reference guidance, exclusions, dismissed IDs and shortlists across processes, with optimistic revision conflicts. Index timestamps and unavailable entries stay visible.

## Capabilities and Constraints

Library filters, saved playlist order including unresolved entries, registered image previews, diagnostics, playlist-guided discovery, anonymous Workshop inspection, companion shortlists and explicit playback are supported. Search needs an optional environment-only Steam key for API candidates; without it, a public Steam search handoff remains useful. Suggestions and explanations use deterministic title/tag evidence, never claim image or semantic analysis. AI hosts interpret richer guidance and can read bounded registered preview images through opt-in stdio tools.

Apply wallpaper and Play playlist validate catalog IDs and default to monitor 0. Acceptance and target observation remain distinct. Refresh requires trusted startup scan settings or explicit default-source selection. Existing read-only MCP tools stay read-only; companion actions are opt-in. The separate HTTP MCP bridge currently exposes only catalog reads.

Native playlist creation/editing, automatic subscription/download, paid model APIs, remote playback activation and startup changes are deferred. Companion shortlists are separate from native playlists. Steam links never establish subscription/installation. Personal media, preferences, credentials and real playlist contents never enter Git.

## Brand Commitments

No emojis. A quiet charcoal workspace, imagery as the main content, playlist rail, focused optional details, one restrained accent, and generous but useful density. No decorative gradients or nested cards.

## Accessibility & Inclusion

Keyboard access, visible focus, native form controls, meaningful loading/error/empty states, responsive narrow layout, and reduced-motion support. Avoid turning all available metadata into competing interface elements.

## Evidence on Hand

The versioned Catalog API and local scanner are the source of truth. Synthetic fixtures can validate behavior and appearance. User-owned previews are used only at runtime, without copying them into the repository.
