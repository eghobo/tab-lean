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

- **background.js** - Service worker. Idle timeout based on Chrome's lastAccessed; no frequency scoring or activation history. scheduleReview() coalesces requests into a serial sweep; requestReview() also bumps reviewRevision to cancel an in-flight sweep whose snapshot went stale. One review-tabs alarm schedules the next pass and recovery after failures. Collapse timestamps and pending grace resets persist in chrome.storage.session via ensureReviewState(). Activity and settings use local storage.
- **popup.html/js/css** - Sensitivity slider (optimizationStrength 0-100), effective timeout, hostname exclusions, and Activity link. Sends partial settings updates and ignores stale responses so saves do not overwrite newer edits. The initial getState retries with backoff, then shows an in-flow error block with a Retry button rather than leaving the controls dead.
- **activity.html/js/css** - Dashboard with metrics, history, enable/disable toggle, and Clear button. Refreshes on storage.onChanged, visibilitychange, and a 15s visible-page fallback interval.
- **manifest.json** - MV3. Permissions: alarms, storage, tabGroups, tabs. Minimum Chrome 121.
- **tests/chrome-harness.mjs** - Mock Chrome APIs, deterministic clock, worker restarts, and controlled API-response races.
- **tests/background.test.mjs**, **tests/popup.test.mjs** - Core and popup behavior tests.

## Behavioral Constraints

- Background management must never call tabs.create/move/remove/group/ungroup or tabGroups.move. A source check enforces this. The popup can open its own Activity page on a user click.
- Activity history is capped at 200 entries. Do not invent per-tab memory savings.
- queueActivity() serializes history/statistics writes, including initialization, clear, and removal. settingsQueue serializes partial settings changes.
- An event during a sweep must cause another pass. Only a trigger that makes the current snapshot stale may invalidate it: the review alarm means time passed, not that candidates changed, so it and tabs.onRemoved use scheduleReview(). Invalidating on either would let a sweep longer than the alarm delay cancel itself and never reach its scheduling tail. Fresh tab/group reads precede each serial discard. Already-issued Chrome operations cannot be recalled.
- Collapse grace is 30 seconds. Persist pending resets alongside collapsedSince so an expand followed by a re-collapse across a worker restart cannot skip the grace window. Prune expanded/removed groups, and clear observation while disabled. Keep reviewStateDirty set until persistence succeeds, including when clearing a non-empty reset set.
- tabs.onUpdated covers group, audio, loading, auto-discardability, reload, and URL transitions, but skips ungrouped tabs unless changeInfo.groupId is set; tabs.onCreated skips them outright. Without that filter every tab event in the browser aborts the in-flight sweep. Already-discarded tabs do not trigger another sweep. New eligibility rules need matching events.
- Read settings before arming the recovery alarm so a paused extension does no alarm or storage work per event. A failed settings read still arms a retry.
- Packed Chrome enforces a 30s minimum alarm delay. Preserve earlier alarms; recreating an imminent alarm can postpone it. Normal worker startup reconciles without resetting history. Legacy per-group/closing alarms and tabUsageData are removed.
- chrome.tabs.discard() reassigns the tab's id. The returned tab carries the new id; the old id ceases to exist. Chrome fires tabs.onReplaced(newId, oldId) then tabs.onUpdated(newId, {discarded: true, status: "unloaded"}, tab). The onUpdated guard (`if (tab.discarded) return`) prevents discard events from aborting in-flight sweeps via requestReview(). Any post-discard tracking (managedTabIds, onRemoved pruning) must use the post-discard id from the return value, not the pre-discard id. Do not read title from the returned object since it may be unpopulated. managedTabIds is reconciled against live tabs at the tail of each completed sweep to clear stale entries.
- isEligible() skips active, audible, loading, private, opted-out, and discarded tabs, plus excluded hostnames and subdomains. Metadata cannot detect all unsaved work. Do not claim full Memory Saver protections.

## Idle Policy

idleDelay() returns 30-300 seconds from sensitivity 100-0, respectively; the default 80 yields 84 seconds. A tab must meet both lastAccessed + idleDelay and collapsedSince + 30 seconds. The popup mirrors this formula for its preview; policy/display tests cover it.

Settings use extensionEnabled, optimizationStrength, and excludedHosts. Exclusions are hostnames, matching the exact host and its subdomains. canonicalHost() is the single normalization used by both the stored and the matching side; they must not drift. Popup and Activity must send only changed fields.

Stored settings normalize leniently and user patches strictly. A corrupt stored value self-heals, because throwing on every read leaves the extension unrepairable: updateSettings is the only repair path and it reads first. A malformed entry is skipped individually so the remaining exclusions survive. A patch key holding undefined is ignored, never treated as a request to clear.

## Testing

Tests use Node's built-in node:test and node:vm. The Chrome harness models native discard rejection for active/already-discarded tabs, discard id reassignment with onReplaced and the subsequent onUpdated, one-shot alarm consumption, and Chrome's alarm floor.

Use harness.restart() to create a fresh VM sharing Chrome state, then await wake.flush(). Normal worker wakes do not emit installation/startup events; the module itself requests reconciliation.

Use harness.fire(eventName, ...args), or emit then await harness.flush(), to drain promise work. Use advance(milliseconds) for chronological alarm delivery and pauseCall() for controlled response races. Avoid wall-clock sleeps. restart() builds a new chrome object, so a pauseCall gate installed beforehand is orphaned; call its restore() to put the method back and reject a gate that can no longer open instead of hanging.

Popup tests execute the real script with small DOM/API doubles. They do not replace live layout or accessibility testing. Load unpacked at chrome://extensions and reload after edits for live Chrome checks.

The DOM double tracks a hidden property and never computes style, so it cannot see CSS that defeats the hidden attribute. An author display rule beats the user-agent [hidden] rule regardless of specificity, which is why popup.css declares [hidden] { display: none !important; } and a source-level test asserts it stays.

## Data and Privacy

- Settings and activity stay in chrome.storage.local.
- Collapse timestamps and pending grace resets use chrome.storage.session. It survives worker restarts and clears on extension disable, reload, update, or browser restart.
- Activation counts are no longer collected. Legacy tabUsageData is removed on wake.
- Incognito tabs are excluded from optimization and new history.
- Legacy savedGroups recovery data is preserved; Clear Activity does not delete it.
- No analytics, advertising, trackers, external services, or runtime dependencies.
