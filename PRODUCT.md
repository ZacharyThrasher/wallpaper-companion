# Wallpaper Companion

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user through the coordinator: TypeScript, Node 24, SQLite catalog, React and Vite. A single loopback process serves the built gallery and catalog API. Code-first execution was explicitly selected for this feature.

## Users

A Windows Wallpaper Engine user exploring installed wallpapers and existing saved playlists. The user requests focused, scannable interactions with progressive disclosure for ADHD-friendly use.

## Product Purpose

Make the existing local wallpaper library visible and understandable. The shared catalog also supports CLI and MCP consumers; gallery behavior follows that catalog's actual contents.

## Operating Context

An explicit CLI scan creates a companion-owned snapshot. The gallery reads that snapshot and registered local preview images. The index timestamp and unavailable entries must remain visible. Refresh reloads the snapshot; it does not scan or mutate Wallpaper Engine.

## Capabilities and Constraints

This feature covers library filters, saved playlist selection, ordered membership including unresolved entries, image previews, and diagnostics. No wallpaper application controls, playlist editing, inferred taste profile, remote authentication, Workshop search, or startup changes are authorized here. Personal media and real playlist contents never enter Git.

## Brand Commitments

No emojis. The coordinator approved a quiet charcoal workspace, imagery as the main content, playlist rail, focused optional details, one restrained accent, and generous but useful density. No decorative gradients or nested cards.

## Accessibility & Inclusion

Keyboard access, visible focus, native form controls, meaningful loading/error/empty states, responsive narrow layout, and reduced-motion support. Avoid turning all available metadata into competing interface elements.

## Evidence on Hand

The versioned Catalog API and local scanner are the source of truth. Synthetic fixtures can validate behavior and appearance. User-owned previews are used only at runtime, without copying them into the repository.
