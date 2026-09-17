import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const settings = { extensionEnabled: true, optimizationStrength: 80, excludedHosts: [] };

function createPopup() {
  const errors = [], requests = [], createdTabs = [];
  const timers = new Map();
  let nextTimerId = 1;
  const elements = new Map([...html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([, , attrs, id]) => {
    const classes = new Set();
    const listeners = new Map();
    return [id, { value: attrs.match(/\bvalue="([^"]*)"/)?.[1] || "", textContent: "",
      disabled: /\bdisabled\b/.test(attrs), hidden: /\bhidden\b/.test(attrs),
      style: { setProperty() {} }, attributes: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        has: name => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      emit(type) {
        const fns = listeners.get(type);
        assert.ok(fns?.length, `No ${type} listener on ${id}`);
        for (const fn of fns) {
          Promise.resolve(fn({ preventDefault() {} })).catch(error => errors.push(error));
        }
      } }];
  }));
  vm.runInNewContext(source, {
    document: { querySelector: selector => elements.get(selector.slice(1)) },
    chrome: {
      runtime: { sendMessage: (message, callback) => requests.push({ message: structuredClone(message), callback }),
        getURL: path => `chrome-extension://test/${path}` },
      tabs: { create: async properties => createdTabs.push(properties) },
    },
    setTimeout: (fn) => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  async function flush() {
    await new Promise(resolve => setImmediate(resolve));
    if (errors.length) throw new AggregateError(errors, "Popup listener failed");
  }
  async function respond(index, nextSettings = settings, error) {
    requests[index].callback(error ? { ok: false, error } : { ok: true, data: { settings: nextSettings } });
    await flush();
  }
  async function advanceTimers() {
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    await flush();
  }
  return { elements, requests, respond, flush, createdTabs, timers, advanceTimers };
}

test("controls wait for initial settings and show the effective idle duration", async () => {
  const h = createPopup();
  assert.equal(h.elements.get("optimization-strength").disabled, true);
  await h.respond(0);
  assert.equal(h.elements.get("optimization-strength").disabled, false);
  assert.match(h.elements.get("idle-timeout").textContent, /1 min 24 sec/);
  assert.equal(h.elements.get("excluded-hosts").disabled, false);
});

test("moving the slider previews its idle duration and sends only sensitivity", async () => {
  const h = createPopup();
  await h.respond(0, { ...settings, extensionEnabled: false });
  const slider = h.elements.get("optimization-strength");
  slider.value = "100";
  slider.emit("input");
  assert.match(h.elements.get("idle-timeout").textContent, /30 sec/);
  slider.emit("change");
  assert.deepEqual(h.requests[1].message, { type: "updateSettings", settings: { optimizationStrength: "100" } });
  assert.equal(h.elements.get("disabled-notice").hidden, false);
});

test("an older settings response cannot overwrite the latest slider position", async () => {
  const h = createPopup();
  await h.respond(0);
  const slider = h.elements.get("optimization-strength");
  slider.value = "60";
  slider.emit("input"); slider.emit("change");
  slider.value = "20";
  slider.emit("input"); slider.emit("change");
  await h.respond(2, { ...settings, optimizationStrength: 20 });
  await h.respond(1, { ...settings, optimizationStrength: 60 });
  assert.equal(Number(slider.value), 20);
});

test("saving exclusions trims blank lines and preserves other settings", async () => {
  const h = createPopup();
  await h.respond(0);
  const hosts = h.elements.get("excluded-hosts");
  assert.ok(hosts, "Site exclusions control is present");
  hosts.value = " EXample.com \n\n docs.other.test \n";
  hosts.emit("input");
  h.elements.get("exclusions-form").emit("submit");
  assert.deepEqual(h.requests[1].message, { type: "updateSettings",
    settings: { excludedHosts: ["EXample.com", "docs.other.test"] } });
  await h.respond(1, { ...settings, excludedHosts: ["example.com", "docs.other.test"] });
  assert.equal(hosts.value, "example.com\ndocs.other.test");
  assert.equal(h.elements.get("save-exclusions").disabled, false);
});

test("a sensitivity save cannot erase an exclusion draft", async () => {
  const h = createPopup();
  await h.respond(0);
  const hosts = h.elements.get("excluded-hosts");
  assert.ok(hosts, "Site exclusions control is present");
  hosts.value = "draft.example";
  hosts.emit("input");
  const slider = h.elements.get("optimization-strength");
  slider.value = "60";
  slider.emit("input"); slider.emit("change");
  await h.respond(1, { ...settings, optimizationStrength: 60 });
  assert.equal(hosts.value, "draft.example");
});

test("an invalid exclusion leaves the draft editable and displays the error", async () => {
  const h = createPopup();
  await h.respond(0);
  const hosts = h.elements.get("excluded-hosts");
  assert.ok(hosts, "Site exclusions control is present");
  hosts.value = "https://example.com/private";
  hosts.emit("input");
  h.elements.get("exclusions-form").emit("submit");
  await h.respond(1, undefined, "Use a hostname without a path.");
  assert.equal(hosts.value, "https://example.com/private");
  assert.equal(hosts.disabled, false);
  assert.equal(h.elements.get("save-exclusions").disabled, false);
  assert.match(h.elements.get("toast").textContent, /hostname/);
});

test("Activity opens only the extension dashboard", async () => {
  const h = createPopup();
  await h.respond(0);
  h.elements.get("activity-button").emit("click");
  await h.flush();
  assert.equal(h.createdTabs.length, 1);
  assert.equal(h.createdTabs[0].url, "chrome-extension://test/activity.html");
});

test("a transient getState failure retries automatically and renders on success", async () => {
  const h = createPopup();
  // First getState rejects.
  await h.respond(0, undefined, "Service worker not ready");
  // Controls must still be disabled after the first failure.
  assert.equal(h.elements.get("optimization-strength").disabled, true);
  // Fire the backoff timer to let the automatic retry proceed.
  await h.advanceTimers();
  // The popup should have retried getState.
  assert.ok(h.requests.length >= 2, "popup retried getState");
  assert.deepEqual(h.requests[1].message, { type: "getState" });
  // Respond successfully to the retry.
  await h.respond(1);
  // Controls are now enabled and populated.
  assert.equal(h.elements.get("optimization-strength").disabled, false);
  assert.equal(h.elements.get("excluded-hosts").disabled, false);
});

test("all getState retries exhausted shows an in-flow error block with a Retry button", async () => {
  const h = createPopup();
  // Reject all automatic attempts (initial + 2 retries = 3 total).
  await h.respond(0, undefined, "No response");
  await h.advanceTimers();
  await h.respond(1, undefined, "No response");
  await h.advanceTimers();
  await h.respond(2, undefined, "No response");
  // Controls must remain disabled.
  assert.equal(h.elements.get("optimization-strength").disabled, true);
  assert.equal(h.elements.get("excluded-hosts").disabled, true);
  // The error message renders in the in-flow error block, not in the toast.
  const errorBlock = h.elements.get("load-error");
  assert.equal(errorBlock.hidden, false, "error block is visible after failure");
  assert.match(h.elements.get("load-error-message").textContent, /No response/);
  assert.equal(h.elements.get("toast").classList.has("visible"), false, "toast is not showing the error");
  // Clicking Retry fires a fresh getState.
  const beforeCount = h.requests.length;
  h.elements.get("retry-button").emit("click");
  await h.flush();
  assert.ok(h.requests.length > beforeCount, "retry issued a fresh getState");
  assert.deepEqual(h.requests[h.requests.length - 1].message, { type: "getState" });
  // Respond successfully - controls should now be enabled and error block hidden.
  await h.respond(h.requests.length - 1);
  assert.equal(h.elements.get("optimization-strength").disabled, false);
  assert.equal(h.elements.get("excluded-hosts").disabled, false);
  assert.equal(errorBlock.hidden, true, "error block hidden after success");
});

test("submit handler tolerates a response without excludedHosts", async () => {
  const h = createPopup();
  await h.respond(0);
  const hosts = h.elements.get("excluded-hosts");
  hosts.value = "example.com";
  hosts.emit("input");
  h.elements.get("exclusions-form").emit("submit");
  // The background responds with settings that omit excludedHosts entirely.
  await h.respond(1, { ...settings, excludedHosts: undefined });
  // Should not throw - submit completes, shows success toast, clears dirty flag.
  assert.match(h.elements.get("toast").textContent, /Saved/);
  assert.equal(hosts.disabled, false);
  assert.equal(h.elements.get("save-exclusions").disabled, false);
});

test("final getState failure renders the error in the in-flow error block, not in the toast", async () => {
  const h = createPopup();
  // Reject all automatic attempts (initial + 2 retries = 3 total).
  await h.respond(0, undefined, "No response");
  await h.advanceTimers();
  await h.respond(1, undefined, "No response");
  await h.advanceTimers();
  await h.respond(2, undefined, "No response");
  // The error message and retry button must be inside the in-flow error block.
  const errorBlock = h.elements.get("load-error");
  assert.ok(errorBlock, "in-flow error block exists");
  assert.equal(errorBlock.hidden, false, "error block is visible after failure");
  // The toast must not be carrying the error message.
  assert.equal(h.elements.get("toast").classList.has("visible"), false, "toast is not visible");
  assert.equal(h.elements.get("toast").classList.has("error"), false, "toast has no error class");
});

test("popup.css declares a hidden-attribute rule to prevent display overrides", () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none/);
});
