import assert from "node:assert/strict";
import test from "node:test";
import { NOW, backgroundSource, collapsedGroup, createHarness, idleTab, pauseCall } from "./chrome-harness.mjs";

const settings = { extensionEnabled: true, optimizationStrength: 80 };
function managed(overrides = {}) {
  return createHarness({ groups: [collapsedGroup], tabs: [idleTab()], stored: { settings },
    session: { collapsedSince: [[7, NOW - 60_000]] }, ...overrides });
}
async function review(harness) { await harness.fire("tabGroupUpdated", collapsedGroup); }

test("installation uses the default sensitivity and preserves an explicit zero", async () => {
  const fresh = createHarness();
  await fresh.fire("installed", { reason: "install" });
  assert.equal((await fresh.message({ type: "getState" })).settings.optimizationStrength, 80);
  const zero = createHarness({ stored: { settings: { ...settings, optimizationStrength: 0 } } });
  await zero.fire("installed", { reason: "update" });
  assert.equal((await zero.message({ type: "getState" })).settings.optimizationStrength, 0);
});

test("collapsing an old group waits for grace then unloads without changing placement", async () => {
  const h = managed({ groups: [{ ...collapsedGroup, collapsed: false }], session: {},
    tabs: [idleTab({ index: 4 }), idleTab({ id: 2, index: 5 })] });
  await h.flush();
  h.state.groups.get(7).collapsed = true;
  await review(h);
  assert.deepEqual(h.state.discardCalls, []);
  await h.advance(29_999);
  assert.deepEqual(h.state.discardCalls, []);
  await h.advance(1);
  assert.deepEqual(h.state.discardCalls, [1, 2]);
  assert.deepEqual([...h.state.tabs.values()].map(({ id, index, groupId }) => ({ id, index, groupId })),
    [{ id: 1, index: 4, groupId: 7 }, { id: 2, index: 5, groupId: 7 }]);
  assert.equal(h.state.groups.size, 1);
  assert.equal(h.state.alarms.size, 0);
});

test("expanded groups are never optimized", async () => {
  const h = managed({ groups: [{ ...collapsedGroup, collapsed: false }] });
  await review(h);
  assert.deepEqual(h.state.discardCalls, []);
});

test("active, audible, loading, opted-out, private, and discarded tabs are protected", async () => {
  const h = managed({ tabs: [idleTab({ active: true }), idleTab({ id: 2, audible: true }),
    idleTab({ id: 3, status: "loading" }), idleTab({ id: 4, autoDiscardable: false }),
    idleTab({ id: 5, incognito: true, title: "Private draft" }), idleTab({ id: 6, discarded: true })] });
  await review(h);
  assert.deepEqual(h.state.discardCalls, []);
  assert.equal(JSON.stringify(h.state.storage).includes("Private draft"), false);
  assert.equal(JSON.stringify(h.state.logs).includes("Private draft"), false);
});

test("an audible-only group stays quiescent and resumes when audio stops", async () => {
  const h = managed({ tabs: [idleTab({ audible: true })] });
  await review(h);
  assert.equal(h.state.alarms.size, 0);
  h.state.tabs.get(1).audible = false;
  await h.fire("tabUpdated", 1, { audible: false }, h.state.tabs.get(1));
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("loading completion and discard opt-in trigger eligibility checks", async () => {
  const h = managed({ tabs: [idleTab({ status: "loading" }), idleTab({ id: 2, autoDiscardable: false })] });
  await review(h);
  h.state.tabs.get(1).status = "complete";
  await h.fire("tabUpdated", 1, { status: "complete" }, h.state.tabs.get(1));
  assert.deepEqual(h.state.discardCalls, [1]);
  h.state.tabs.get(2).autoDiscardable = true;
  await h.fire("tabUpdated", 2, { autoDiscardable: true }, h.state.tabs.get(2));
  assert.deepEqual(h.state.discardCalls, [1, 2]);
});

test("maximum sensitivity still gives a newly used tab 30 seconds idle", async () => {
  const h = managed({ stored: { settings: { ...settings, optimizationStrength: 100 } },
    tabs: [idleTab({ lastAccessed: NOW })] });
  await review(h);
  assert.deepEqual(h.state.discardCalls, []);
  await h.advance(30_000);
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("gentle sensitivity eventually unloads frequently used tabs", async () => {
  const h = managed({ stored: { settings: { ...settings, optimizationStrength: 0 } },
    tabs: [idleTab({ lastAccessed: NOW })], session: { collapsedSince: [[7, NOW - 60_000]],
      tabUsageData: [[1, { activationCount: 50, lastActivatedAt: NOW }]] } });
  await review(h);
  await h.advance(299_999);
  assert.deepEqual(h.state.discardCalls, []);
  await h.advance(1);
  assert.deepEqual(h.state.discardCalls, [1]);
  assert.equal(h.state.sessionStorage.tabUsageData, undefined);
});

test("default sensitivity applies an 84 second idle timeout", async () => {
  const h = managed({ tabs: [idleTab({ lastAccessed: NOW })] });
  await review(h);
  await h.advance(83_999);
  assert.deepEqual(h.state.discardCalls, []);
  await h.advance(1);
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("several collapsed groups share one alarm", async () => {
  const h = managed({ groups: [collapsedGroup, { ...collapsedGroup, id: 8 }],
    tabs: [idleTab({ lastAccessed: NOW }), idleTab({ id: 2, groupId: 8, lastAccessed: NOW })] });
  await review(h);
  assert.equal(h.state.alarms.size, 1);
  await h.advance(84_000);
  assert.deepEqual(h.state.discardCalls, [1, 2]);
});

test("a worker wake restores an alarm without resetting activity history", async () => {
  const h = managed({ tabs: [idleTab({ lastAccessed: NOW })],
    stored: { settings, activityStats: { totalDiscardActions: 9, managedTabIds: [42] },
      activityLog: [{ timestamp: NOW - 1, message: "Existing history" }] } });
  await h.flush();
  assert.equal(h.state.alarms.size, 1);
  h.state.alarms.clear();
  const wake = h.restart();
  await wake.flush();
  assert.equal(wake.state.alarms.size, 1);
  assert.equal(wake.state.storage.activityStats.totalDiscardActions, 9);
  assert.deepEqual(wake.state.storage.activityStats.managedTabIds, [42]);
  assert.equal(wake.state.storage.activityLog[0].message, "Existing history");
});

test("collapse grace survives worker restart", async () => {
  const h = managed({ session: {} });
  await review(h);
  await h.advance(20_000);
  const wake = h.restart();
  await wake.flush();
  assert.deepEqual(wake.state.discardCalls, []);
  await wake.advance(10_000);
  assert.deepEqual(wake.state.discardCalls, [1]);
});

test("expanding or removing the last managed group clears its pending alarm", async () => {
  for (const remove of [false, true]) {
    const h = managed({ tabs: [idleTab({ lastAccessed: NOW })] });
    await review(h);
    assert.equal(h.state.alarms.size, 1);
    if (remove) h.state.groups.delete(7);
    else h.state.groups.get(7).collapsed = false;
    await h.fire(remove ? "tabGroupRemoved" : "tabGroupUpdated", { ...collapsedGroup, collapsed: false });
    assert.equal(h.state.alarms.size, 0);
    assert.deepEqual(h.state.sessionStorage.collapsedSince, []);
  }
});

test("disabling clears existing review alarms", async () => {
  const h = managed({ tabs: [idleTab({ lastAccessed: NOW })] });
  await review(h);
  assert.equal(h.state.alarms.size, 1);
  await h.message({ type: "updateSettings", settings: { extensionEnabled: false } });
  await h.flush();
  assert.equal(h.state.alarms.size, 0);
  await h.advance(300_000);
  assert.deepEqual(h.state.discardCalls, []);
});

test("groups collapsed while paused receive fresh grace after restart and enabling", async () => {
  const h = managed({ stored: { settings: { ...settings, extensionEnabled: false } } });
  await h.flush();
  h.state.groups.get(7).collapsed = false;
  await h.fire("tabGroupUpdated", { ...collapsedGroup, collapsed: false });
  const wake = h.restart();
  await wake.flush();
  wake.state.groups.get(7).collapsed = true;
  await review(wake);
  await wake.message({ type: "updateSettings", settings: { extensionEnabled: true } });
  await wake.flush();
  assert.deepEqual(wake.state.discardCalls, []);
  await wake.advance(30_000);
  assert.deepEqual(wake.state.discardCalls, [1]);
});

test("disabling during a pending query cancels later discards", { timeout: 2000 }, async () => {
  const h = managed();
  const gate = pauseCall(h.chrome.tabs, "query");
  h.events.tabGroupUpdated.emit(collapsedGroup);
  await gate.started;
  await h.message({ type: "updateSettings", settings: { extensionEnabled: false } });
  gate.release();
  await h.flush();
  assert.deepEqual(h.state.discardCalls, []);
  assert.equal(h.state.alarms.size, 0);
});

test("expanding during a pending query cancels later discards", { timeout: 2000 }, async () => {
  const h = managed();
  const gate = pauseCall(h.chrome.tabs, "query");
  h.events.tabGroupUpdated.emit(collapsedGroup);
  await gate.started;
  h.state.groups.get(7).collapsed = false;
  h.events.tabGroupUpdated.emit({ ...collapsedGroup, collapsed: false });
  gate.release();
  await h.flush();
  assert.deepEqual(h.state.discardCalls, []);
});

test("a tab moved out of its group is rechecked before discard", { timeout: 2000 }, async () => {
  const h = managed();
  const gate = pauseCall(h.chrome.tabs, "query");
  h.events.tabGroupUpdated.emit(collapsedGroup);
  await gate.started;
  h.state.tabs.get(1).groupId = -1;
  // Protect the tab even before its event reaches the worker.
  gate.release();
  await h.flush();
  assert.deepEqual(h.state.discardCalls, []);
});

test("audio stopping during the final query is not lost by coalescing", { timeout: 2000 }, async () => {
  const h = managed({ tabs: [idleTab({ audible: true })] });
  const gate = pauseCall(h.chrome.tabs, "query", 2);
  h.events.tabGroupUpdated.emit(collapsedGroup);
  await gate.started;
  h.state.tabs.get(1).audible = false;
  h.events.tabUpdated.emit(1, { audible: false }, h.state.tabs.get(1));
  await h.flush();
  gate.release();
  await h.flush();
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("switching active tabs after restart revisits all collapsed groups", async () => {
  const h = managed({ tabs: [idleTab({ active: true }), idleTab({ id: 2, groupId: -1 })] });
  await review(h);
  assert.equal(h.state.alarms.size, 0);
  const wake = h.restart();
  wake.state.tabs.get(1).active = false;
  wake.state.tabs.get(2).active = true;
  await wake.fire("tabActivated", { tabId: 2, windowId: 1 });
  assert.deepEqual(wake.state.discardCalls, [1]);
});

test("interleaved activations across windows do not strand a group", async () => {
  const h = managed({ tabs: [idleTab({ active: true }), idleTab({ id: 2, groupId: -1 }),
    idleTab({ id: 3, groupId: -1, windowId: 2, active: true })] });
  await h.fire("tabActivated", { tabId: 1, windowId: 1 });
  await h.fire("tabActivated", { tabId: 3, windowId: 2 });
  h.state.tabs.get(1).active = false;
  h.state.tabs.get(2).active = true;
  await h.fire("tabActivated", { tabId: 2, windowId: 1 });
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("closed tabs leave neither obsolete usage nor tracking on cold wake", async () => {
  const h = managed({ tabs: [], session: { tabUsageData: [[1, { activationCount: 5 }]] },
    stored: { settings, activityStats: { totalDiscardActions: 4, managedTabIds: [1] } } });
  await h.fire("tabRemoved", 1);
  assert.equal(h.state.sessionStorage.tabUsageData, undefined);
  assert.deepEqual(h.state.storage.activityStats.managedTabIds, []);
  assert.equal(h.state.storage.activityStats.totalDiscardActions, 4);
});

test("concurrent review requests record one discard action", async () => {
  const h = managed();
  h.events.tabGroupUpdated.emit(collapsedGroup);
  h.events.tabGroupUpdated.emit(collapsedGroup);
  await h.flush();
  assert.deepEqual(h.state.discardCalls, [1]);
  const result = await h.message({ type: "getActivityState" });
  assert.equal(result.metrics.totalDiscardActions, 1);
  assert.equal(result.metrics.discardedTabCount, 1);
});

test("native discard failure retains a retry and counts only successes", async () => {
  const h = managed();
  const discard = h.chrome.tabs.discard;
  h.chrome.tabs.discard = async () => { throw new Error("Temporary discard failure"); };
  await review(h);
  assert.equal((await h.message({ type: "getActivityState" })).metrics.totalDiscardActions, 0);
  assert.equal(h.state.alarms.size, 1);
  h.chrome.tabs.discard = discard;
  await h.advance(30_000);
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("a query failure retains an alarm that recovers automatically", async () => {
  const h = managed();
  const query = h.chrome.tabs.query;
  h.chrome.tabs.query = async () => { throw new Error("Temporary query failure"); };
  await review(h);
  assert.equal(h.state.alarms.size, 1);
  h.chrome.tabs.query = query;
  await h.advance(30_000);
  assert.deepEqual(h.state.discardCalls, [1]);
});

test("a failed collapse-state write is persisted on retry before worker restart", async () => {
  const h = managed({ tabs: [idleTab({ audible: true })] });
  await h.flush();
  const set = h.chrome.storage.session.set;
  let failed = false;
  h.chrome.storage.session.set = async values => {
    if (!failed) { failed = true; throw new Error("Temporary session write failure"); }
    return set(values);
  };
  h.state.groups.get(7).collapsed = false;
  await h.fire("tabGroupUpdated", { ...collapsedGroup, collapsed: false });
  await h.advance(30_000);
  assert.deepEqual(h.state.sessionStorage.collapsedSince, []);
  h.state.groups.get(7).collapsed = true;
  h.state.tabs.get(1).audible = false;
  const wake = h.restart();
  await review(wake);
  assert.deepEqual(wake.state.discardCalls, []);
  await wake.advance(30_000);
  assert.deepEqual(wake.state.discardCalls, [1]);
});

test("settings patches preserve concurrent changes", async () => {
  const h = createHarness({ stored: { settings } });
  await Promise.all([h.message({ type: "updateSettings", settings: { extensionEnabled: false } }),
    h.message({ type: "updateSettings", settings: { optimizationStrength: 20 } })]);
  const result = await h.message({ type: "getState" });
  assert.equal(result.settings.extensionEnabled, false);
  assert.equal(result.settings.optimizationStrength, 20);
});

test("exclusions match hosts and subdomains but not unrelated suffixes", async () => {
  const h = managed({ stored: { settings: { ...settings, excludedHosts: ["example.com"] } },
    tabs: [idleTab(), idleTab({ id: 2, url: "https://docs.example.com/edit" }),
      idleTab({ id: 3, url: "https://notexample.com/" })] });
  await review(h);
  assert.deepEqual(h.state.discardCalls, [3]);
});

test("invalid exclusion input preserves previous settings", async () => {
  const h = createHarness({ stored: { settings } });
  await assert.rejects(h.message({ type: "updateSettings", settings: { excludedHosts: ["https://example.com/private"] } }), /hostname/i);
  assert.equal((await h.message({ type: "getState" })).settings.optimizationStrength, 80);
});

test("clearing activity resets history and counts", async () => {
  const h = managed();
  await review(h);
  const state = await h.message({ type: "clearActivity" });
  assert.equal(state.metrics.totalDiscardActions, 0);
  assert.equal(state.metrics.discardedTabCount, 0);
  assert.deepEqual(state.activityLog, []);
});

test("unknown messages return an error", async () => {
  const h = createHarness();
  await assert.rejects(h.message({ type: "bogus" }), /Unknown request/);
});

test("background never moves, closes, groups, or recreates tabs", () => {
  assert.doesNotMatch(backgroundSource,
    /chrome\.(?:tabs\.(?:create|duplicate|group|move|remove|ungroup)|tabGroups\.move)\s*\(/);
});
