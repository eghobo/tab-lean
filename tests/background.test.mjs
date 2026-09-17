import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = await readFile(new URL("../background.js", import.meta.url), "utf8");

const TAB_ORDER_MUTATING_API =
  /chrome\.(?:tabs\.(?:create|duplicate|group|move|remove|ungroup)|tabGroups\.move)\s*\(/;

class ChromeEvent {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...arguments_) {
    for (const listener of this.listeners) listener(...arguments_);
  }

  async emitAsync(...arguments_) {
    await Promise.all(this.listeners.map((listener) => listener(...arguments_)));
  }
}

function createHarness({ groups = [], tabs = [], stored = {} } = {}) {
  const state = {
    alarms: new Map(),
    discardCalls: [],
    groups: new Map(groups.map((group) => [group.id, { ...group }])),
    sessionStorage: {},
    storage: structuredClone(stored),
    tabs: new Map(tabs.map((tab) => [tab.id, { ...tab }])),
  };

  const events = {
    alarm: new ChromeEvent(),
    installed: new ChromeEvent(),
    message: new ChromeEvent(),
    startup: new ChromeEvent(),
    tabActivated: new ChromeEvent(),
    tabCreated: new ChromeEvent(),
    tabGroupCreated: new ChromeEvent(),
    tabGroupRemoved: new ChromeEvent(),
    tabGroupUpdated: new ChromeEvent(),
    tabRemoved: new ChromeEvent(),
    tabUpdated: new ChromeEvent(),
  };

  const chrome = {
    alarms: {
      clear: async (name) => state.alarms.delete(name),
      create: async (name, alarm) =>
        state.alarms.set(name, { ...alarm, scheduledTime: alarm.when }),
      getAll: async () =>
        [...state.alarms.entries()].map(([name, alarm]) => ({ name, ...alarm })),
      onAlarm: events.alarm,
    },
    runtime: {
      onInstalled: events.installed,
      onMessage: events.message,
      onStartup: events.startup,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") {
            return { [keys]: structuredClone(state.storage[keys]) };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(
              keys.map((key) => [key, structuredClone(state.storage[key])]),
            );
          }
          return structuredClone(state.storage);
        },
        set: async (values) => Object.assign(state.storage, structuredClone(values)),
      },
      session: {
        get: async (keys) => {
          if (typeof keys === "string") {
            return { [keys]: structuredClone(state.sessionStorage[keys]) };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(
              keys.map((key) => [key, structuredClone(state.sessionStorage[key])]),
            );
          }
          return structuredClone(state.sessionStorage);
        },
        set: async (values) =>
          Object.assign(state.sessionStorage, structuredClone(values)),
      },
    },
    tabGroups: {
      get: async (id) => {
        if (!state.groups.has(id)) throw new Error("No group");
        return structuredClone(state.groups.get(id));
      },
      onCreated: events.tabGroupCreated,
      onRemoved: events.tabGroupRemoved,
      onUpdated: events.tabGroupUpdated,
      query: async (query = {}) =>
        [...state.groups.values()]
          .filter(
            (group) => query.collapsed === undefined || group.collapsed === query.collapsed,
          )
          .map((group) => structuredClone(group)),
    },
    tabs: {
      discard: async (id) => {
        if (!state.tabs.has(id)) throw new Error("No tab");
        state.tabs.get(id).discarded = true;
        state.discardCalls.push(id);
        return structuredClone(state.tabs.get(id));
      },
      get: async (id) => {
        if (!state.tabs.has(id)) throw new Error("No tab");
        return structuredClone(state.tabs.get(id));
      },
      onActivated: events.tabActivated,
      onCreated: events.tabCreated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
      query: async ({ groupId } = {}) =>
        [...state.tabs.values()]
          .filter((tab) => groupId === undefined || tab.groupId === groupId)
          .map((tab) => structuredClone(tab)),
    },
  };

  vm.runInContext(backgroundSource, vm.createContext({ chrome, console }));

  async function message(payload) {
    const listener = events.message.listeners[0];
    return new Promise((resolve, reject) => {
      const keptOpen = listener(payload, {}, (response) => {
        if (response.ok) resolve(response.data);
        else reject(new Error(response.error));
      });
      assert.equal(keptOpen, true);
    });
  }

  return { events, message, state };
}

const collapsedGroup = {
  collapsed: true,
  color: "blue",
  id: 7,
  title: "Research",
  windowId: 1,
};

function idleTab(overrides = {}) {
  return {
    active: false,
    audible: false,
    discarded: false,
    groupId: 7,
    id: 1,
    index: 0,
    lastAccessed: Date.now() - 3_600_000,
    status: "complete",
    title: "Reference",
    url: "https://example.com/reference",
    ...overrides,
  };
}

test("installation automatically discards idle tabs in collapsed groups", async () => {
  const harness = createHarness({ groups: [collapsedGroup], tabs: [idleTab()] });

  await harness.events.installed.emitAsync();

  assert.equal(harness.state.tabs.get(1).discarded, true);
  assert.deepEqual(harness.state.discardCalls, [1]);
  assert.equal(harness.state.tabs.size, 1);
  assert.equal(harness.state.groups.size, 1);
  assert.equal(harness.state.storage.activityStats.totalDiscardActions, 1);
  assert.deepEqual(harness.state.storage.activityLog[0].tabTitles, ["Reference"]);
});

test("expanded groups are never optimized", async () => {
  const expandedGroup = { ...collapsedGroup, collapsed: false };
  const harness = createHarness({ groups: [expandedGroup], tabs: [idleTab()] });

  await harness.events.installed.emitAsync();

  assert.equal(harness.state.tabs.get(1).discarded, false);
  assert.equal(harness.state.discardCalls.length, 0);
});

test("collapsing a group automatically starts background optimization", async () => {
  const expandedGroup = { ...collapsedGroup, collapsed: false };
  const harness = createHarness({ groups: [expandedGroup], tabs: [idleTab()] });
  await harness.events.installed.emitAsync();

  harness.state.groups.get(7).collapsed = true;
  await harness.events.tabGroupUpdated.emitAsync({ ...collapsedGroup });

  assert.equal(harness.state.tabs.get(1).discarded, true);
});

test("active and audible tabs are never discarded", async () => {
  const tabs = [
    idleTab({ active: true, id: 1 }),
    idleTab({ audible: true, id: 2 }),
  ];
  const harness = createHarness({ groups: [collapsedGroup], tabs });

  await harness.events.installed.emitAsync();

  assert.equal(harness.state.discardCalls.length, 0);
  assert.equal(harness.state.tabs.get(1).discarded, false);
  assert.equal(harness.state.tabs.get(2).discarded, false);
});

test("optimization preserves tab order and group membership", async () => {
  const tabs = [
    idleTab({ id: 11, index: 4, title: "First" }),
    idleTab({ id: 12, index: 5, title: "Second" }),
    idleTab({ id: 13, index: 6, title: "Third" }),
  ];
  const harness = createHarness({ groups: [collapsedGroup], tabs });
  const placementBefore = tabs.map(({ id, index, groupId }) => ({ id, index, groupId }));

  await harness.events.installed.emitAsync();

  const placementAfter = [...harness.state.tabs.values()].map(
    ({ id, index, groupId }) => ({ id, index, groupId }),
  );
  assert.deepEqual(placementAfter, placementBefore);
  assert.deepEqual(harness.state.discardCalls, [11, 12, 13]);
});

test("background does not use APIs that can reorder or rebuild grouped tabs", () => {
  assert.doesNotMatch(backgroundSource, TAB_ORDER_MUTATING_API);
});

test("sensitivity controls whether a recent background tab is discarded", async () => {
  const recentTab = () => idleTab({ lastAccessed: Date.now() });
  const gentle = createHarness({ groups: [collapsedGroup], tabs: [recentTab()] });
  const maximum = createHarness({ groups: [collapsedGroup], tabs: [recentTab()] });

  await gentle.message({
    type: "updateSettings",
    settings: { extensionEnabled: true, optimizationStrength: 0 },
  });
  await maximum.message({
    type: "updateSettings",
    settings: { extensionEnabled: true, optimizationStrength: 100 },
  });

  assert.equal(gentle.state.tabs.get(1).discarded, false);
  assert.equal(maximum.state.tabs.get(1).discarded, true);
});

test("disabling stops background optimization and clears review alarms", async () => {
  const harness = createHarness({ groups: [collapsedGroup], tabs: [idleTab()] });

  const state = await harness.message({
    type: "updateSettings",
    settings: { extensionEnabled: false, optimizationStrength: 100 },
  });

  assert.equal(state.settings.extensionEnabled, false);
  assert.equal(harness.state.tabs.get(1).discarded, false);
  assert.equal(harness.state.alarms.size, 0);
});

test("audible-only group does not reschedule alarms indefinitely", async () => {
  const tabs = [idleTab({ audible: true, id: 1 })];
  const harness = createHarness({ groups: [collapsedGroup], tabs });

  await harness.events.installed.emitAsync();

  assert.equal(harness.state.discardCalls.length, 0);
  assert.equal(harness.state.alarms.size, 0);
});

test("expanding a group clears its review alarm", async () => {
  const tabs = [idleTab({ id: 1 }), idleTab({ id: 2, audible: true })];
  const harness = createHarness({ groups: [collapsedGroup], tabs });
  await harness.events.installed.emitAsync();

  assert.equal(harness.state.tabs.get(1).discarded, true);

  harness.state.groups.get(7).collapsed = false;
  await harness.events.tabGroupUpdated.emitAsync({ ...collapsedGroup, collapsed: false });

  assert.equal(harness.state.alarms.size, 0);
});

test("alarm fires and triggers optimization for the group", async () => {
  const tabs = [idleTab({ id: 1, audible: true }), idleTab({ id: 2 })];
  const harness = createHarness({ groups: [collapsedGroup], tabs });
  await harness.events.installed.emitAsync();

  assert.equal(harness.state.tabs.get(2).discarded, true);
  harness.state.tabs.get(2).discarded = false;
  harness.state.discardCalls.length = 0;

  harness.events.alarm.emit({ name: "review-group:7" });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(harness.state.tabs.get(2).discarded, true);
  assert.deepEqual(harness.state.discardCalls, [2]);
});

test("removing a group clears its review alarm", async () => {
  const tabs = [idleTab({ id: 1, audible: true }), idleTab({ id: 2 })];
  const harness = createHarness({ groups: [collapsedGroup], tabs });
  await harness.events.installed.emitAsync();

  await harness.events.tabGroupRemoved.emitAsync(collapsedGroup);

  assert.equal(harness.state.alarms.size, 0);
});

test("tab activation counts persist and reload on alarm wake (simulated SW restart)", async () => {
  const recentTab = idleTab({ id: 1, lastAccessed: Date.now() - 45_000 });
  const harness1 = createHarness({ groups: [collapsedGroup], tabs: [recentTab] });
  await harness1.events.installed.emitAsync();

  for (let i = 0; i < 7; i++) {
    harness1.events.tabActivated.emit({ tabId: 1 });
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(harness1.state.sessionStorage.tabUsageData);
  const saved = harness1.state.sessionStorage.tabUsageData;
  const entry = saved.find(([id]) => id === 1);
  assert.equal(entry[1].activationCount, 7);

  const harness2 = createHarness({
    groups: [collapsedGroup],
    tabs: [{ ...recentTab, discarded: false }],
  });
  harness2.state.sessionStorage = harness1.state.sessionStorage;

  harness2.events.alarm.emit({ name: "review-group:7" });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(
    harness2.state.tabs.get(1).discarded,
    false,
    "tab with 7 activations should be kept by repeat-use scoring after SW restart",
  );
});

test("tab removal on cold wake does not wipe persisted activation history", async () => {
  const harness1 = createHarness({
    groups: [collapsedGroup],
    tabs: [idleTab({ id: 1 }), idleTab({ id: 2 })],
  });
  await harness1.events.installed.emitAsync();

  for (let i = 0; i < 5; i++) {
    harness1.events.tabActivated.emit({ tabId: 2 });
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 50));

  const saved = harness1.state.sessionStorage.tabUsageData;
  const tab2 = saved.find(([id]) => id === 2);
  assert.equal(tab2[1].activationCount, 5);

  const harness2 = createHarness({
    groups: [collapsedGroup],
    tabs: [idleTab({ id: 1 }), idleTab({ id: 2 }), idleTab({ id: 3 })],
  });
  harness2.state.sessionStorage = harness1.state.sessionStorage;

  harness2.events.tabRemoved.emit(3);
  await new Promise((r) => setTimeout(r, 50));

  const afterRemove = harness2.state.sessionStorage.tabUsageData;
  const tab2After = afterRemove.find(([id]) => id === 2);
  assert.ok(tab2After, "tab 2 activation data must survive removal of unrelated tab 3");
  assert.equal(tab2After[1].activationCount, 5);
});

test("switching away from active tab in collapsed group triggers optimization", async () => {
  const activeTab = idleTab({ id: 1, active: true });
  const otherTab = idleTab({ id: 2, groupId: -1 });
  const harness = createHarness({
    groups: [collapsedGroup],
    tabs: [activeTab, otherTab],
  });
  await harness.events.installed.emitAsync();

  assert.equal(harness.state.tabs.get(1).discarded, false);
  assert.equal(harness.state.alarms.size, 0, "no alarm since only tab was active");

  harness.events.tabActivated.emit({ tabId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  harness.state.tabs.get(1).active = false;
  harness.events.tabActivated.emit({ tabId: 2 });
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(
    harness.state.tabs.get(1).discarded || harness.state.alarms.size > 0,
    "switching away must either discard the tab or schedule a review alarm",
  );
});

test("disabling clears alarms that were previously scheduled", async () => {
  const tabs = [idleTab({ id: 1, audible: true }), idleTab({ id: 2 })];
  const harness = createHarness({ groups: [collapsedGroup], tabs });
  await harness.events.installed.emitAsync();

  assert.ok(harness.state.alarms.size > 0 || harness.state.tabs.get(2).discarded);

  await harness.message({
    type: "updateSettings",
    settings: { extensionEnabled: false, optimizationStrength: 80 },
  });

  assert.equal(harness.state.alarms.size, 0);
});

test("audio stop on a tab re-triggers optimization for its collapsed group", async () => {
  const tabs = [idleTab({ id: 1, audible: true })];
  const harness = createHarness({ groups: [collapsedGroup], tabs });
  await harness.events.installed.emitAsync();

  assert.equal(harness.state.tabs.get(1).discarded, false);
  assert.equal(harness.state.alarms.size, 0);

  harness.state.tabs.get(1).audible = false;
  harness.events.tabUpdated.emit(1, { audible: false }, harness.state.tabs.get(1));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(harness.state.tabs.get(1).discarded, true);
});

test("unknown message type returns an error", async () => {
  const harness = createHarness();
  await assert.rejects(() => harness.message({ type: "bogus" }), /Unknown request/);
});

test("activity state reports exact discard counts and can be cleared", async () => {
  const harness = createHarness({ groups: [collapsedGroup], tabs: [idleTab()] });
  await harness.events.installed.emitAsync();

  const activity = await harness.message({ type: "getActivityState" });
  assert.equal(activity.metrics.collapsedGroupCount, 1);
  assert.equal(activity.metrics.collapsedTabCount, 1);
  assert.equal(activity.metrics.discardedTabCount, 1);
  assert.equal(activity.metrics.totalDiscardActions, 1);
  assert.equal(activity.activityLog[0].groupTitle, "Research");

  const cleared = await harness.message({ type: "clearActivity" });
  assert.equal(cleared.metrics.totalDiscardActions, 0);
  assert.equal(cleared.activityLog.length, 0);
  assert.equal(cleared.metrics.discardedTabCount, 0);
});
