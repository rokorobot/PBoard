---
name: focus-board
description: What the Focus Board plugin shows and how it classifies threads.
---

# Focus Board

Shows every open (non-archived, non-hidden) thread across all projects as tiles, on the
compose homepage and in the "Focus" nav panel (`/plugins/<id>/focus`).

- **Passive — waiting on you** (amber): thread idle, errored, never started, or blocked on an
  approval/question (`hasPendingInteraction`). Sorted longest-waiting first.
- **Active — agent working** (blue): status starting/active/stopping, or provisioning/waiting
  for host.

Data: `experimental_useSidebarThreads()` (live via the host's realtime feed) and
`sdk.threads.output()` for each tile's last-message line. No settings, no backend state.
