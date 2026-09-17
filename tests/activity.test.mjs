import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../activity.js", import.meta.url), "utf8");

function createActivity(now) {
  const requests = [];
  const storageListeners = [];
  const docEventListeners = new Map();
  const rafQueue = [];
  const errors = [];
  let intervalFn = null;

  function createElement() {
    const classes = new Set();
    const attrs = {};
    const listeners = new Map();
    const el = {
      className: "", textContent: "", title: "", dateTime: "",
      disabled: false, hidden: false, _children: [],
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) {
          if (force !== undefined) {
            if (force) classes.add(name); else classes.delete(name);
          } else {
            if (classes.has(name)) classes.delete(name); else classes.add(name);
          }
        },
        has(name) { return classes.has(name); },
      },
      setAttribute(name, value) { attrs[name] = value; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      append(...nodes) { el._children.push(...nodes); },
      replaceChildren(...nodes) { el._children = [...nodes]; },
      _attrs: attrs,
      emit(type) {
        const fns = listeners.get(type);
        if (fns) for (const fn of fns) {
          Promise.resolve(fn()).catch(e => errors.push(e));
        }
      },
    };
    return el;
  }

  const elements = new Map();
  for (const id of ["activity-announce", "activity-list", "clear-button", "collapsed-groups",
    "collapsed-tabs", "discarded-now", "status-button", "status-label", "toast", "total-actions"]) {
    elements.set(id, createElement());
  }

  class ControlledDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
  }

  const documentObj = {
    hidden: false,
    querySelector: sel => elements.get(sel.slice(1)),
    createElement,
    addEventListener(type, fn) {
      if (!docEventListeners.has(type)) docEventListeners.set(type, []);
      docEventListeners.get(type).push(fn);
    },
  };

  vm.runInNewContext(source, {
    document: documentObj,
    chrome: {
      runtime: {
        sendMessage(msg, cb) { requests.push({ message: structuredClone(msg), callback: cb }); },
        lastError: null,
      },
      storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } } },
    },
    Date: ControlledDate,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn) => { intervalFn = fn; return 0; },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); },
  });

  async function flush() { await new Promise(resolve => setImmediate(resolve)); }
  async function respond(index, data) {
    requests[index].callback(data);
    await flush();
  }
  function drainRAF() {
    const cbs = rafQueue.splice(0);
    for (const fn of cbs) fn();
  }
  function fireStorage(changes, area) {
    for (const fn of storageListeners) fn(changes, area);
  }
  function fireVisibility() {
    const fns = docEventListeners.get("visibilitychange") || [];
    for (const fn of fns) fn();
  }
  function fireInterval() {
    if (intervalFn) intervalFn();
  }

  return {
    elements, requests, respond, flush, drainRAF,
    fireStorage, fireVisibility, fireInterval,
    document: documentObj, errors, rafQueue,
  };
}

function makeState(activityLog, overrides) {
  return {
    ok: true,
    data: {
      settings: { extensionEnabled: true, optimizationStrength: 80, ...overrides?.settings },
      metrics: { discardedTabCount: 0, totalDiscardActions: 0, collapsedGroupCount: 0, collapsedTabCount: 0, ...overrides?.metrics },
      activityLog,
    },
  };
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function dateTimeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
    + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function entry(ts) {
  return { type: "discard", message: "Unloaded 1 tab", timestamp: ts };
}

test("today entry shows time only, older entry shows short date prefix", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const todayTs = new Date(2026, 8, 17, 14, 14, 39).getTime();
  const yesterdayTs = new Date(2026, 8, 16, 14, 14, 39).getTime();
  const h = createActivity(now);

  await h.respond(0, makeState([entry(todayTs), entry(yesterdayTs)]));

  const rows = h.elements.get("activity-list")._children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._children[2].textContent, timeStr(todayTs),
    "today entry should show time only");
  assert.equal(rows[1]._children[2].textContent, dateTimeStr(yesterdayTs),
    "older entry should show date prefix");
});

test("entry just before midnight yesterday is not treated as today", async () => {
  const now = new Date(2026, 8, 17, 0, 5, 0).getTime();
  const justBeforeMidnight = new Date(2026, 8, 16, 23, 59, 59).getTime();
  const h = createActivity(now);

  await h.respond(0, makeState([entry(justBeforeMidnight)]));

  const rows = h.elements.get("activity-list")._children;
  assert.equal(rows[0]._children[2].textContent, dateTimeStr(justBeforeMidnight),
    "11:59:59 PM yesterday is not today");
});

// --- New coverage ---

test("renderState maps each metric to its own element", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);
  await h.respond(0, makeState([], {
    metrics: { discardedTabCount: 3, totalDiscardActions: 17, collapsedGroupCount: 5, collapsedTabCount: 42 },
  }));
  assert.equal(h.elements.get("discarded-now").textContent, 3);
  assert.equal(h.elements.get("total-actions").textContent, 17);
  assert.equal(h.elements.get("collapsed-groups").textContent, 5);
  assert.equal(h.elements.get("collapsed-tabs").textContent, 42);
});

test("status toggle synchronizes off class, aria-pressed, and label text", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();

  // Enabled state
  const h1 = createActivity(now);
  await h1.respond(0, makeState([]));
  const btn1 = h1.elements.get("status-button");
  assert.equal(btn1.classList.has("off"), false, "enabled: no off class");
  assert.equal(btn1._attrs["aria-pressed"], "true", "enabled: aria-pressed true");
  assert.equal(h1.elements.get("status-label").textContent, "Enabled");

  // Disabled state
  const h2 = createActivity(now);
  await h2.respond(0, makeState([], { settings: { extensionEnabled: false } }));
  const btn2 = h2.elements.get("status-button");
  assert.equal(btn2.classList.has("off"), true, "disabled: has off class");
  assert.equal(btn2._attrs["aria-pressed"], "false", "disabled: aria-pressed false");
  assert.equal(h2.elements.get("status-label").textContent, "Disabled");
});

test("empty activity log renders the empty-state placeholder, replacing prior content", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);
  // Pre-populate to verify replaceChildren, not append
  h.elements.get("activity-list")._children.push({}, {});

  await h.respond(0, makeState([]));

  const children = h.elements.get("activity-list")._children;
  assert.equal(children.length, 1, "replaces prior content with one child");
  assert.equal(children[0].className, "empty-state");
  assert.equal(children[0].textContent, "No activity yet. Collapse a tab group to begin.");
});

test("renderLog renders badge, message, tab titles, and time for each entry type", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const ts = new Date(2026, 8, 17, 14, 30, 0).getTime();
  const h = createActivity(now);

  const log = [
    { type: "discard", message: "Unloaded 2 tabs", timestamp: ts, tabTitles: ["Tab A", "Tab B"] },
    { type: "status", message: "Optimization enabled", timestamp: ts - 1000 },
    { type: "other", message: "Something else", timestamp: ts - 2000, tabTitles: [] },
  ];
  await h.respond(0, makeState(log));

  const rows = h.elements.get("activity-list")._children;
  assert.equal(rows.length, 3);

  // Discard entry: badge, message, tab titles, time
  const r0 = rows[0];
  assert.equal(r0.className, "activity-row");
  assert.equal(r0._children[0].textContent, "↓", "discard badge");
  assert.equal(r0._children[1]._children[0].textContent, "Unloaded 2 tabs");
  assert.equal(r0._children[1]._children[1].textContent, "Tab A · Tab B");
  assert.equal(r0._children[1]._children[1].title, "Tab A\nTab B");
  assert.equal(r0._children[2].dateTime, new Date(ts).toISOString());
  assert.equal(r0._children[2].textContent, timeStr(ts));

  // Status entry: badge, no tab titles (tabTitles absent)
  const r1 = rows[1];
  assert.equal(r1._children[0].textContent, "●", "status badge");
  assert.equal(r1._children[1]._children[0].textContent, "Optimization enabled");
  assert.equal(r1._children[1]._children.length, 1, "no small when tabTitles absent");

  // Other entry: fallback badge, no tab titles (empty array)
  const r2 = rows[2];
  assert.equal(r2._children[0].textContent, "↔", "other badge");
  assert.equal(r2._children[1]._children.length, 1, "no small when tabTitles empty");
});

test("announce region: silent on first render, announces only new entries via rAF", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);
  const announce = h.elements.get("activity-announce");

  // First render: lastNewestTimestamp = 0, so nothing is announced
  await h.respond(0, makeState([entry(1000)]));
  assert.equal(h.rafQueue.length, 0, "no rAF queued on first render");
  assert.equal(announce.textContent, "", "first render does not announce");

  // Second render with a newer entry: only ts 2000 > 1000 is announced
  h.fireStorage({ activityLog: {} }, "local");
  await h.respond(1, makeState([
    { type: "discard", message: "Unloaded 2 tabs", timestamp: 2000 },
    entry(1000),
  ]));
  assert.equal(announce.textContent, "", "announce cleared before rAF runs");
  h.drainRAF();
  assert.equal(announce.textContent, "Unloaded 2 tabs", "only new entry announced");

  // Third render with no newer entries: announce unchanged
  h.fireStorage({ activityLog: {} }, "local");
  await h.respond(2, makeState([
    { type: "discard", message: "Unloaded 2 tabs", timestamp: 2000 },
    entry(1000),
  ]));
  assert.equal(h.rafQueue.length, 0, "no rAF when no new entries");
  assert.equal(announce.textContent, "Unloaded 2 tabs", "old entries not re-announced");

  // Fourth render with two new entries: both announced, joined with ". "
  h.fireStorage({ activityLog: {} }, "local");
  await h.respond(3, makeState([
    { type: "discard", message: "Unloaded 4 tabs", timestamp: 3000 },
    { type: "status", message: "Optimization disabled", timestamp: 2500 },
    { type: "discard", message: "Unloaded 2 tabs", timestamp: 2000 },
    entry(1000),
  ]));
  h.drainRAF();
  assert.equal(announce.textContent, "Unloaded 4 tabs. Optimization disabled",
    "multiple new entries joined with period-space");
});

test("clear button resets the announce cursor and re-renders on success", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);
  const announce = h.elements.get("activity-announce");

  // First render sets cursor
  await h.respond(0, makeState([entry(1000)]));

  // Second render to produce an announcement
  h.fireStorage({ activityLog: {} }, "local");
  await h.respond(1, makeState([
    { type: "discard", message: "Unloaded 2 tabs", timestamp: 2000 },
    entry(1000),
  ]));
  h.drainRAF();
  assert.equal(announce.textContent, "Unloaded 2 tabs", "pre-clear: announced");

  // Click clear: resets cursor to 0
  h.elements.get("clear-button").emit("click");
  await h.flush();

  // Respond with a new entry - should NOT be announced because cursor was reset to 0
  await h.respond(2, makeState([
    { type: "discard", message: "Unloaded 5 tabs", timestamp: 3000 },
  ]));
  h.drainRAF();
  assert.equal(announce.textContent, "Unloaded 2 tabs",
    "cursor reset: no new announcement despite newer entry");

  assert.equal(h.elements.get("clear-button").disabled, false, "button re-enabled");
});

test("clear button rejection shows error toast and re-enables button", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);
  await h.respond(0, makeState([entry(1000)]));

  h.elements.get("clear-button").emit("click");
  await h.flush();

  // Reject the clearActivity request
  await h.respond(1, { ok: false, error: "Storage full" });

  const toast = h.elements.get("toast");
  assert.equal(toast.textContent, "Storage full");
  assert.equal(toast.classList.has("error"), true, "toast has error class");
  assert.equal(toast.classList.has("visible"), true, "toast is visible");
  assert.equal(h.elements.get("clear-button").disabled, false, "button re-enabled after error");
});

test("toggle sends only extensionEnabled in the settings payload", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);

  // Initial render with extensionEnabled: true
  await h.respond(0, makeState([]));

  // Click the toggle
  h.elements.get("status-button").emit("click");
  await h.flush();

  assert.deepEqual(h.requests[1].message, {
    type: "updateSettings",
    settings: { extensionEnabled: false },
  });
});

test("refresh gates on document.hidden, storage area, and relevant keys", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);
  await h.respond(0, makeState([]));
  const base = h.requests.length;

  // Storage: each relevant key triggers refresh when visible
  h.fireStorage({ activityLog: {} }, "local");
  assert.equal(h.requests.length, base + 1, "activityLog key triggers refresh");
  h.fireStorage({ activityStats: {} }, "local");
  assert.equal(h.requests.length, base + 2, "activityStats key triggers refresh");
  h.fireStorage({ settings: {} }, "local");
  assert.equal(h.requests.length, base + 3, "settings key triggers refresh");

  // Storage: hidden suppresses refresh
  h.document.hidden = true;
  h.fireStorage({ activityLog: {} }, "local");
  assert.equal(h.requests.length, base + 3, "hidden: no refresh");

  // Storage: wrong area suppresses refresh
  h.document.hidden = false;
  h.fireStorage({ activityLog: {} }, "session");
  assert.equal(h.requests.length, base + 3, "session area: no refresh");

  // Storage: unrelated key suppresses refresh
  h.fireStorage({ someOtherKey: {} }, "local");
  assert.equal(h.requests.length, base + 3, "unrelated key: no refresh");

  // visibilitychange: visible triggers, hidden does not
  h.fireVisibility();
  assert.equal(h.requests.length, base + 4, "visibilitychange visible: refresh");
  h.document.hidden = true;
  h.fireVisibility();
  assert.equal(h.requests.length, base + 4, "visibilitychange hidden: no refresh");

  // Interval: visible triggers, hidden does not
  h.document.hidden = false;
  h.fireInterval();
  assert.equal(h.requests.length, base + 5, "interval visible: refresh");
  h.document.hidden = true;
  h.fireInterval();
  assert.equal(h.requests.length, base + 5, "interval hidden: no refresh");
});

test("initial getActivityState rejection shows error toast", async () => {
  const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
  const h = createActivity(now);

  // Reject the initial refresh
  await h.respond(0, { ok: false, error: "Service worker not ready" });

  const toast = h.elements.get("toast");
  assert.equal(toast.textContent, "Service worker not ready");
  assert.equal(toast.classList.has("error"), true);
  assert.equal(toast.classList.has("visible"), true);
});
