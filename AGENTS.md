# Wallpaper Companion

## Working agreement
- No emojis in code-facing prose, UI, docs, commits, PRs, or chat.
- Present dense information in scannable blocks with a concise brief.
- Coordinator owns architecture, product taste, integration, review, and release decisions.
- Use GPT-6.1 Sol implementation/research agents with appropriate reasoning effort.
- Research agents research only. Coordinator starts a separate implementation chat after findings.
- One feature per implementation chat, isolated branch, and draft PR. Do not merge your own PR; hand it to the coordinator.
- Maintain concise handoff notes with decisions, files, tests, blockers, and next actions before context exhaustion and at feature boundaries.
- Never commit real user wallpaper configuration, playlist contents, absolute personal media paths, credentials, or downloaded Workshop assets.
- Do not mutate live Wallpaper Engine configuration for experiments. Use fixtures and copies; changes to live data need a validated backup/restore strategy.
- Do not claim external client compatibility without recording what was actually tested.

## Product
Windows companion for discovering Wallpaper Engine wallpapers from existing playlist taste and explicit guidance. One shared backend supports a visual gallery, MCP tools for regular AI chat apps and coding tools, and an optional CLI.

## Verification
Test real parsing and boundary failures, protocol behavior, and mutation recovery. Do not add tests that merely mirror implementation. Record checks and their limits in each PR.
