import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../activity.js", import.meta.url), "utf8");

function createActivity(now) {
  const requests = [];
  const storageListeners = [];

  function createElement() {
    const el = {
      className: "", textContent: "", title: "", dateTime: "",
      disabled: false, hidden: false, _children: [],
      classList: { add() {}, remove() {}, toggle() {}, has: () => false },
      setAttribute() {},
      addEventListener() {},
      append(...nodes) { el._children.push(...nodes); },
      replaceChildren(...nodes) { el._children = [...nodes]; },
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

  vm.runInNewContext(source, {
    document: {
      querySelector: sel => elements.get(sel.slice(1)),
      createElement,
      hidden: false,
      addEventListener() {},
    },
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
    setInterval: () => 0,
    requestAnimationFrame: fn => fn(),
  });

  async function flush() { await new Promise(resolve => setImmediate(resolve)); }
  async function respond(index, data) {
    requests[index].callback(data);
    await flush();
  }
  return { elements, requests, respond };
}

function makeState(activityLog) {
  return {
    ok: true,
    data: {
      settings: { extensionEnabled: true, optimizationStrength: 80 },
      metrics: { discardedTabCount: 0, totalDiscardActions: 0, collapsedGroupCount: 0, collapsedTabCount: 0 },
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
