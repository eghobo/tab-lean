# CLAUDE.md

This file provides guidance to agents working in this repository.

## What This Is

TabLean is a Chrome extension (Manifest V3) that discards idle tabs inside collapsed tab groups to free memory. Background management never closes, moves, regroups, or recreates tabs; it only calls Chrome's native discard API. No network requests, remote code, content scripts, or external dependencies.

## Commands

```sh
npm test              # run core and popup tests (node:test)
npm run icons         # regenerate PNG icons from the procedural generator
```

There is no linter or build step. The extension loads directly from the repository root as an unpacked extension. Use Node syntax checks for modified JavaScript files.

## Architecture

All source files live at the repository root, with no bundler.

- **background.js** - Service worker. Idle timeout based on Chrome's lastAccessed; no frequency scoring or activation history. requestReview() coalesces requests into a serial sweep with cancellation via reviewRevision. One review-tabs alarm schedules the next pass and recovery after failures. Collapse timestamps persist in chrome.storage.session via ensureReviewState(). Activity and settings use local storage.
- **popup.html/js/css** - Sensitivity slider (optimizationStrength 0-100), effective timeout, hostname exclusions, and Activity link. Sends partial settings updates and ignores stale responses so saves do not overwrite newer edits.
- **activity.html/js/css** - Dashboard with metrics, history, enable/disable toggle, and Clear button. Refreshes on storage.onChanged, visibilitychange, and a 15s visible-page fallback interval.
- **manifest.json** - MV3. Permissions: alarms, storage, tabGroups, tabs. Minimum Chrome 121.
- **tests/chrome-harness.mjs** - Mock Chrome APIs, deterministic clock, worker restarts, and controlled API-response races.
- **tests/background.test.mjs**, **tests/popup.test.mjs** - Core and popup behavior tests.

## Behavioral Constraints

- Background management must never call tabs.create/move/remove/group/ungroup or tabGroups.move. A source check enforces this. The popup can open its own Activity page on a user click.
- Activity history is capped at 200 entries. Do not invent per-tab memory savings.
- queueActivity() serializes history/statistics writes, including initialization, clear, and removal. settingsQueue serializes partial settings changes.
- A review request invalidates stale candidates and marks the sweep dirty. An event during a sweep must cause another pass. Fresh tab/group reads precede each serial discard. Already-issued Chrome operations cannot be recalled.
- Collapse grace is 30 seconds. Preserve timestamps across worker wakes, prune expanded/removed groups, and clear observation while disabled. Keep reviewStateDirty set until persistence succeeds.
- tabs.onUpdated covers group, audio, loading, auto-discardability, reload, and URL transitions. Already-discarded tabs do not trigger another sweep. New eligibility rules need matching events.
- Packed Chrome enforces a 30s minimum alarm delay. Preserve earlier alarms; recreating an imminent alarm can postpone it. Normal worker startup reconciles without resetting history. Legacy per-group/closing alarms and tabUsageData are removed.
- isEligible() skips active, audible, loading, private, opted-out, and discarded tabs, plus excluded hostnames and subdomains. Metadata cannot detect all unsaved work. Do not claim full Memory Saver protections.

## Idle Policy

idleDelay() returns 30-300 seconds from sensitivity 100-0, respectively; the default 80 yields 84 seconds. A tab must meet both lastAccessed + idleDelay and collapsedSince + 30 seconds. The popup mirrors this formula for its preview; policy/display tests cover it.

Settings use extensionEnabled, optimizationStrength, and excludedHosts. Exclusions are hostnames, matching the exact host and its subdomains. Popup and Activity must send only changed fields.

## Testing

Tests use Node's built-in node:test and node:vm. The Chrome harness models native discard rejection for active/already-discarded tabs, API-generated discard events, one-shot alarm consumption, and Chrome's alarm floor.

Use harness.restart() to create a fresh VM sharing Chrome state, then await wake.flush(). Normal worker wakes do not emit installation/startup events; the module itself requests reconciliation.

Use harness.fire(eventName, ...args), or emit then await harness.flush(), to drain promise work. Use advance(milliseconds) for chronological alarm delivery and pauseCall() for controlled response races. Avoid wall-clock sleeps.

Popup tests execute the real script with small DOM/API doubles. They do not replace live layout or accessibility testing. Load unpacked at chrome://extensions and reload after edits for live Chrome checks.

## Data and Privacy

- Settings and activity stay in chrome.storage.local.
- Collapse timestamps use chrome.storage.session. It survives worker restarts and clears on extension disable, reload, update, or browser restart.
- Activation counts are no longer collected. Legacy tabUsageData is removed on wake.
- Incognito tabs are excluded from optimization and new history.
- Legacy savedGroups recovery data is preserved; Clear Activity does not delete it.
- No analytics, advertising, trackers, external services, or runtime dependencies.
