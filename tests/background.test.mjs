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
