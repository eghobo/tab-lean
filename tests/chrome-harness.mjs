import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export const NOW = Date.UTC(2026, 8, 17, 12);
export const backgroundSource = await readFile(new URL("../background.js", import.meta.url), "utf8");
export const collapsedGroup = { id: 7, collapsed: true, color: "blue", title: "Research", windowId: 1 };
export function idleTab(overrides = {}) {
  return { id: 1, groupId: 7, windowId: 1, index: 0, active: false, audible: false,
    discarded: false, autoDiscardable: true, incognito: false, status: "complete",
    lastAccessed: NOW - 3_600_000, title: "Reference", url: "https://example.com/reference", ...overrides };
}

class ChromeEvent {
  listeners = [];
  constructor(errors) { this.errors = errors; }
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) {
    for (const listener of this.listeners) {
      try {
        Promise.resolve(listener(...args)).catch(error => this.errors.push(error));
      } catch (error) { this.errors.push(error); }
    }
  }
}

export function createHarness({ groups = [], tabs = [], stored = {}, session = {}, sharedState } = {}) {
  const state = sharedState || {
    now: NOW, alarms: new Map(), discardCalls: [], errors: [], logs: [],
    groups: new Map(groups.map(group => [group.id, structuredClone(group)])),
    tabs: new Map(tabs.map(tab => [tab.id, structuredClone(tab)])),
    storage: structuredClone(stored), sessionStorage: structuredClone(session),
  };
  const listenerErrors = [];
  const events = Object.fromEntries(["alarm", "installed", "startup", "message", "tabActivated",
    "tabCreated", "tabRemoved", "tabUpdated", "tabGroupCreated", "tabGroupUpdated", "tabGroupRemoved"]
    .map(name => [name, new ChromeEvent(listenerErrors)]));
  function storageArea(key) {
    return {
      get: async keys => {
        if (typeof keys === "string") return { [keys]: structuredClone(state[key][keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, structuredClone(state[key][k])]));
        return structuredClone(state[key]);
      },
      set: async values => { Object.assign(state[key], structuredClone(values)); },
      remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete state[key][k]; },
    };
  }
  const chrome = {
    alarms: {
      get: async name => structuredClone(state.alarms.get(name)),
      getAll: async () => [...state.alarms.values()].map(alarm => structuredClone(alarm)),
      create: async (name, alarm) => {
        state.alarms.set(name, { name, ...alarm,
          scheduledTime: Math.max(state.now + 30_000,
            alarm.when ?? state.now + (alarm.delayInMinutes ?? alarm.periodInMinutes) * 60_000) });
      },
      clear: async name => state.alarms.delete(name), onAlarm: events.alarm,
    },
    storage: { local: storageArea("storage"), session: storageArea("sessionStorage") },
    runtime: { onInstalled: events.installed, onStartup: events.startup, onMessage: events.message },
    tabGroups: {
      get: async id => {
        if (!state.groups.has(id)) throw new Error("No group");
        return structuredClone(state.groups.get(id));
      },
      query: async (query = {}) => [...state.groups.values()]
        .filter(group => query.collapsed === undefined || group.collapsed === query.collapsed)
        .map(group => structuredClone(group)),
      onCreated: events.tabGroupCreated, onUpdated: events.tabGroupUpdated, onRemoved: events.tabGroupRemoved,
    },
    tabs: {
      get: async id => {
        if (!state.tabs.has(id)) throw new Error("No tab");
        return structuredClone(state.tabs.get(id));
      },
      query: async (query = {}) => [...state.tabs.values()]
        .filter(tab => (query.groupId === undefined || tab.groupId === query.groupId) &&
          (query.active === undefined || tab.active === query.active) &&
          (query.windowId === undefined || tab.windowId === query.windowId))
        .map(tab => structuredClone(tab)),
      discard: async id => {
        const tab = state.tabs.get(id);
        if (!tab || tab.active || tab.discarded) throw new Error("Cannot discard tab");
        tab.discarded = true;
        state.discardCalls.push(id);
        events.tabUpdated.emit(id, { discarded: true }, structuredClone(tab));
        return structuredClone(tab);
      },
      onActivated: events.tabActivated, onCreated: events.tabCreated, onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
    },
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  vm.runInContext(backgroundSource, vm.createContext({ chrome, Date: ClockDate, URL,
    console: { info: (...args) => state.logs.push(args), error: (...args) => state.errors.push(args) } }));

  async function flush() {
    // Drain actual promise work without sleeping or advancing the policy clock.
    await new Promise(resolve => setImmediate(resolve));
    if (listenerErrors.length) throw new AggregateError(listenerErrors.splice(0), "Event handler failed");
  }
  async function fire(name, ...args) { events[name].emit(...args); await flush(); }
  async function advance(milliseconds) {
    const target = state.now + milliseconds;
    // Deliver alarms in order while the browser is awake, including alarms
    // created by an earlier callback during this same clock advancement.
    while (true) {
      const alarm = [...state.alarms.values()].sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
      if (!alarm || alarm.scheduledTime > target) break;
      state.now = Math.max(state.now, alarm.scheduledTime);
      if (alarm.periodInMinutes) alarm.scheduledTime = state.now + alarm.periodInMinutes * 60_000;
      else state.alarms.delete(alarm.name);
      events.alarm.emit(structuredClone(alarm));
      await flush();
    }
    state.now = target;
    await flush();
  }
  async function message(payload) {
    return new Promise((resolve, reject) => {
      const keptOpen = events.message.listeners[0](payload, {}, response => {
        if (response.ok) resolve(structuredClone(response.data));
        else reject(new Error(response.error));
      });
      assert.equal(keptOpen, true);
    });
  }
  return { state, events, chrome, flush, fire, advance, message,
    restart: () => createHarness({ sharedState: state }) };
}

export function pauseCall(object, method, callNumber = 1) {
  const original = object[method];
  let entered, release, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  object[method] = async (...args) => {
    const result = await original(...args);
    if (++calls === callNumber) { entered(); await gate; }
    return result;
  };
  return { started, release };
}
