import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const settings = { extensionEnabled: true, optimizationStrength: 80, excludedHosts: [] };

function createPopup() {
  const errors = [], requests = [], createdTabs = [];
  const elements = new Map([...html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([, , attrs, id]) => {
    const classes = new Set();
    const listeners = new Map();
    return [id, { value: attrs.match(/\bvalue="([^"]*)"/)?.[1] || "", textContent: "",
      disabled: /\bdisabled\b/.test(attrs), hidden: /\bhidden\b/.test(attrs),
      style: { setProperty() {} }, attributes: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      emit(type) {
        const listener = listeners.get(type);
        assert.ok(listener, `No ${type} listener on ${id}`);
        Promise.resolve(listener({ preventDefault() {} })).catch(error => errors.push(error));
      } }];
  }));
  vm.runInNewContext(source, {
    document: { querySelector: selector => elements.get(selector.slice(1)) },
    chrome: {
      runtime: { sendMessage: (message, callback) => requests.push({ message: structuredClone(message), callback }),
        getURL: path => `chrome-extension://test/${path}` },
      tabs: { create: async properties => createdTabs.push(properties) },
    },
    setTimeout: () => 1, clearTimeout() {},
  });
  async function flush() {
    await new Promise(resolve => setImmediate(resolve));
    if (errors.length) throw new AggregateError(errors, "Popup listener failed");
  }
  async function respond(index, nextSettings = settings, error) {
    requests[index].callback(error ? { ok: false, error } : { ok: true, data: { settings: nextSettings } });
    await flush();
  }
  return { elements, requests, respond, flush, createdTabs };
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
