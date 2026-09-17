# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

TabLean is a Chrome extension (Manifest V3) that discards idle tabs inside collapsed tab groups to free memory. It never closes, moves, regroups, or recreates tabs - only calls `chrome.tabs.discard()`. No network requests, no remote code, no external dependencies.

## Commands

```sh
npm test              # run all tests (node:test, no framework)
npm run icons         # regenerate PNG icons from the procedural generator
```

There is no build step. The extension loads directly from the repo root as an unpacked extension.

## Architecture

All source files live at the repo root (no src/ directory, no bundler).

- **background.js** - Service worker. Core logic: importance scoring (`calculateImportance`), discard threshold calculation, alarm-based review scheduling for collapsed groups, activity logging to `chrome.storage.local`, and the message handler (`onMessage`) that popup and activity page use as their API.
- **popup.html/js/css** - Extension popup. Sensitivity slider (`optimizationStrength` 0-100) and link to activity page. Communicates with background via `chrome.runtime.sendMessage`.
- **activity.html/js/css** - Full-page activity dashboard. Shows metrics (collapsed groups/tabs, discards) and a scrollable activity log. Has enable/disable toggle and clear-history button. Auto-refreshes every 2s.
- **manifest.json** - Manifest V3. Permissions: `alarms`, `storage`, `tabGroups`, `tabs`. Minimum Chrome 121.

### Key Behavioral Constraints

These are intentional design decisions, not oversights:

- The extension must never use `chrome.tabs.create`, `chrome.tabs.move`, `chrome.tabs.remove`, `chrome.tabs.group`, `chrome.tabs.ungroup`, or `chrome.tabGroups.move`. The test suite enforces this with a regex check against `background.js` source.
- Activity log is capped at 200 entries. No memory estimates are shown because Chrome doesn't provide reliable per-tab memory figures for discarded tabs.
- `activityQueue` serializes storage writes to avoid races from concurrent discard events.

### Tab Importance Scoring

`calculateImportance()` returns 0-100 based on: recency (exponential decay, 180s time constant), repeat-use frequency (log scale), active tab bonus (+28), audible bonus (+20), loading bonus (+5). The `discardThreshold()` is derived from `optimizationStrength` setting.

## Testing

Tests use Node.js built-in `node:test` runner with `node:vm` to execute `background.js` in a sandboxed context with a mock `chrome` API harness. The harness simulates Chrome's alarms, storage, tabs, and tabGroups APIs.

To test changes to the extension UI, load unpacked at `chrome://extensions` and reload after edits.

## Constraints

- No runtime dependencies (no node_modules in production)
- No analytics, advertising, trackers, or external services
- No remote code execution
- All data stays in `chrome.storage.local`
