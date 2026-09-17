const DEFAULT_SETTINGS = Object.freeze({
  extensionEnabled: true,
  optimizationStrength: 80,
  excludedHosts: [],
});

const REVIEW_ALARM = "review-tabs";
const MIN_REVIEW_DELAY = 30_000;
const COLLAPSE_GRACE = 30_000;
const LEGACY_ALARM_PREFIXES = ["review-group:", "close-group:", "close-tab:"];
let activityQueue = Promise.resolve();
let settingsQueue = Promise.resolve();
let reviewStateLoad;
let collapsedSince = new Map();
let reviewStateDirty = false;
const resetGroups = new Set();
let reviewRevision = 0;
let reviewRequested = false;
let reviewInFlight;

function canonicalHost(value) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeHosts(hosts, { strict = false } = {}) {
  if (!Array.isArray(hosts)) {
    if (strict) throw new Error("Enter one hostname per line.");
    return [];
  }
  const normalized = [];
  for (const value of hosts) {
    if (typeof value !== "string") {
      if (strict) throw new Error("Enter one hostname per line.");
      console.warn("[TabLean] Skipping invalid exclusion entry:", value);
      continue;
    }
    const host = canonicalHost(value);
    if (!host || host.length > 253 || !host.split(".").every(
      label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )) {
      if (strict) throw new Error("Use hostnames such as example.com, without a URL or path.");
      console.warn("[TabLean] Skipping invalid exclusion entry:", value);
      continue;
    }
    normalized.push(host);
  }
  return [...new Set(normalized)];
}

function normalizeSettings(settings = {}, { strict = false } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  const strength = settings.optimizationStrength == null
    ? DEFAULT_SETTINGS.optimizationStrength : Number(settings.optimizationStrength);
  return {
    extensionEnabled: settings.extensionEnabled !== false,
    optimizationStrength: Number.isFinite(strength)
      ? Math.min(100, Math.max(0, strength)) : DEFAULT_SETTINGS.optimizationStrength,
    excludedHosts: normalizeHosts(settings.excludedHosts ?? [], { strict }),
  };
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}

function idleDelay(settings) {
  return Math.round(30_000 + (1 - settings.optimizationStrength / 100) * 270_000);
}

function settingsState(settings) {
  return { settings };
}

function queueActivity(operation) {
  const pending = activityQueue.then(operation);
  activityQueue = pending.catch(() => {});
  return pending;
}

function appendActivity(entry) {
  return queueActivity(async () => {
    const stored = await chrome.storage.local.get(["activityLog", "activityStats"]);
    const activityStats = stored.activityStats || {};
    const managedTabIds = new Set(activityStats.managedTabIds || []);
    for (const tabId of entry.discardedTabIds || []) managedTabIds.add(tabId);
    await chrome.storage.local.set({
      activityLog: [entry, ...(stored.activityLog || [])].slice(0, 200),
      activityStats: {
        totalDiscardActions: (Number(activityStats.totalDiscardActions) || 0) + (entry.discardedCount || 0),
        lastActivityAt: entry.timestamp,
        managedTabIds: [...managedTabIds],
      },
    });
    console.info("[TabLean]", entry.message, entry.tabTitles || "");
  });
}

async function clearManagementAlarms({ includeReview = true } = {}) {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.filter(alarm =>
    (includeReview && alarm.name === REVIEW_ALARM) ||
    LEGACY_ALARM_PREFIXES.some(prefix => alarm.name.startsWith(prefix)))
    .map(alarm => chrome.alarms.clear(alarm.name)));
}

function ensureReviewState() {
  if (!reviewStateLoad) {
    reviewStateLoad = (async () => {
      const stored = await chrome.storage.session.get(["collapsedSince", "pendingResets"]);
      collapsedSince = new Map((Array.isArray(stored.collapsedSince) ? stored.collapsedSince : [])
        .filter(entry => Array.isArray(entry) && Number.isInteger(entry[0]) &&
          Number.isFinite(entry[1]) && entry[1] <= Date.now()));
      for (const id of (Array.isArray(stored.pendingResets) ? stored.pendingResets : [])) {
        if (Number.isInteger(id)) resetGroups.add(id);
      }
      // Frequency scoring is gone; do not retain or keep rewriting its history.
      await chrome.storage.session.remove("tabUsageData");
      await clearManagementAlarms({ includeReview: false });
    })().catch(error => {
      reviewStateLoad = undefined;
      throw error;
    });
  }
  return reviewStateLoad;
}

async function reconcileCollapsedGroups(groups) {
  const ids = new Set(groups.map(group => group.id));
  let changed = false;
  for (const id of collapsedSince.keys()) {
    if (!ids.has(id) || resetGroups.has(id)) {
      collapsedSince.delete(id);
      changed = true;
    }
  }
  if (resetGroups.size) reviewStateDirty = true;
  resetGroups.clear();
  for (const id of ids) {
    if (!collapsedSince.has(id)) {
      collapsedSince.set(id, Date.now());
      changed = true;
    }
  }
  reviewStateDirty ||= changed;
  await persistReviewState();
}

async function persistReviewState() {
  if (!reviewStateDirty) return;
  await chrome.storage.session.set({ collapsedSince: [...collapsedSince], pendingResets: [...resetGroups] });
  reviewStateDirty = false;
}

function isEligible(tab, settings) {
  if (tab.active || tab.audible || tab.discarded || tab.incognito ||
      tab.autoDiscardable === false || tab.status !== "complete") return false;
  try {
    const host = canonicalHost(new URL(tab.url).hostname);
    return !settings.excludedHosts.some(excluded => host === excluded || host.endsWith("." + excluded));
  } catch {
    return false;
  }
}

function eligibleAt(tab, settings) {
  if (!Number.isFinite(tab.lastAccessed) || !collapsedSince.has(tab.groupId)) return Infinity;
  return Math.max(tab.lastAccessed + idleDelay(settings), collapsedSince.get(tab.groupId) + COLLAPSE_GRACE);
}

function invalidateReview() {
  reviewRevision += 1;
  reviewRequested = true;
}

function scheduleReview() {
  reviewRequested = true;
  if (!reviewInFlight) {
    reviewInFlight = (async () => {
      while (reviewRequested) {
        reviewRequested = false;
        try {
          await reviewCollapsedTabs(reviewRevision);
        } catch (error) {
          console.error("[TabLean] Review failed; the alarm will retry.", error);
        }
      }
    })().finally(() => {
      reviewInFlight = undefined;
      // An event can arrive after the loop exits but before this continuation.
      if (reviewRequested) scheduleReview();
    });
  }
  return reviewInFlight;
}

function requestReview() {
  invalidateReview();
  return scheduleReview();
}

async function reviewCollapsedTabs(revision) {
  // Read settings first so a paused extension never arms a recovery alarm.
  let settings;
  try {
    await settingsQueue;
    settings = await getSettings();
  } catch (error) {
    // A transient storage failure still needs a recovery path.
    if (!await chrome.alarms.get(REVIEW_ALARM)) {
      await chrome.alarms.create(REVIEW_ALARM, { when: Date.now() + MIN_REVIEW_DELAY });
    }
    throw error;
  }
  if (revision !== reviewRevision) return;
  if (!settings.extensionEnabled) {
    // Expansion/collapse events while paused must not revive an old grace time
    // after the worker restarts. Enabling starts observation afresh.
    await ensureReviewState();
    if (collapsedSince.size) {
      collapsedSince.clear();
      reviewStateDirty = true;
    }
    if (resetGroups.size) reviewStateDirty = true;
    resetGroups.clear();
    await persistReviewState();
    await clearManagementAlarms();
    return;
  }

  // Keep a recovery alarm before any query/discard work that can fail.
  const previousAlarm = await chrome.alarms.get(REVIEW_ALARM);
  if (!previousAlarm) {
    await chrome.alarms.create(REVIEW_ALARM, { when: Date.now() + MIN_REVIEW_DELAY });
  }
  await ensureReviewState();
  await persistReviewState();
  if (revision !== reviewRevision) return;

  const [groups, tabs] = await Promise.all([
    chrome.tabGroups.query({ collapsed: true }),
    chrome.tabs.query({}),
  ]);
  if (revision !== reviewRevision) return;
  await reconcileCollapsedGroups(groups);
  const groupIds = new Set(groups.map(group => group.id));
  const discardedByGroup = new Map();

  for (const snapshot of tabs) {
    if (revision !== reviewRevision) break;
    if (!groupIds.has(snapshot.groupId) || !isEligible(snapshot, settings) ||
        eligibleAt(snapshot, settings) > Date.now()) continue;

    const tab = await chrome.tabs.get(snapshot.id).catch(() => null);
    const group = tab && await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (revision !== reviewRevision) break;
    if (!tab || !group?.collapsed || tab.groupId !== snapshot.groupId ||
        !isEligible(tab, settings) || eligibleAt(tab, settings) > Date.now()) continue;

    try {
      // Keep optimization discard-only. Moving, regrouping, removing, or
      // recreating tabs would change Chrome's saved tab-group sync data.
      const result = await chrome.tabs.discard(tab.id);
      if (!result) {
        console.error("[TabLean] Discard resolved without a tab for", tab.id);
        continue;
      }
      if (!discardedByGroup.has(group.id)) discardedByGroup.set(group.id, { group, tabs: [] });
      discardedByGroup.get(group.id).tabs.push(tab);
    } catch (error) {
      console.error("[TabLean] Could not discard tab", tab.id, error);
    }
  }

  for (const { group, tabs: discarded } of discardedByGroup.values()) {
    try {
      await appendActivity({
        type: "discard", timestamp: Date.now(), groupId: group.id,
        groupTitle: group.title || "Untitled group", discardedCount: discarded.length,
        discardedTabIds: discarded.map(tab => tab.id),
        tabTitles: discarded.map(tab => tab.title || "Untitled tab"),
        message: `Discarded ${discarded.length} tab${discarded.length === 1 ? "" : "s"} in ${group.title || "Untitled group"}.`,
      });
    } catch (error) {
      // A failed history write must not prevent scheduling the remaining tabs.
      console.error("[TabLean] Could not save activity.", error);
    }
  }

  const currentTabs = await chrome.tabs.query({});
  if (revision !== reviewRevision) return;
  const nextReview = currentTabs.reduce((next, tab) =>
    groupIds.has(tab.groupId) && isEligible(tab, settings)
      ? Math.min(next, eligibleAt(tab, settings)) : next, Infinity);
  if (Number.isFinite(nextReview)) {
    const when = Math.max(Date.now() + MIN_REVIEW_DELAY, nextReview);
    // Recreating an imminent alarm would restart Chrome's 30-second floor.
    // Preserve an existing earlier deadline across worker wakes and tab events.
    if (previousAlarm?.scheduledTime > Date.now() && previousAlarm.scheduledTime <= when) return;
    await chrome.alarms.create(REVIEW_ALARM, { when });
  } else {
    await chrome.alarms.clear(REVIEW_ALARM);
  }
}

async function removeLegacyClosingPlans() {
  const stored = await chrome.storage.local.get(["closingPlans", "savedGroups"]);
  const closingPlans = stored.closingPlans || [];
  if (!closingPlans.length) return;

  // Preserve recovery data from older development builds without closing anything else.
  const recoveredGroups = closingPlans
    .filter((plan) => Array.isArray(plan?.tabs))
    .map((plan) => ({
      id: plan.id,
      title: plan.title,
      color: plan.color,
      collapsed: plan.collapsed,
      savedAt: Date.now(),
      tabs: plan.tabs.map(({ title, url }) => ({ title, url })),
    }));
  const savedGroups = stored.savedGroups || [];
  await chrome.storage.local.set({
    closingPlans: [],
    savedGroups: [
      ...recoveredGroups.filter(
        (group) => !savedGroups.some((saved) => saved.id === group.id),
      ),
      ...savedGroups,
    ],
  });
}

async function initializeBackgroundOptimization() {
  invalidateReview();
  const operation = settingsQueue.then(async () => {
    await chrome.storage.local.set({ settings: await getSettings() });
    await removeLegacyClosingPlans();
    await queueActivity(async () => {
      const { activityStats = {} } = await chrome.storage.local.get("activityStats");
      await chrome.storage.local.set({ activityStats: { ...activityStats, managedTabIds: [] } });
    });
  });
  settingsQueue = operation.catch(() => {});
  await operation;
  return requestReview();
}

async function getActivityState() {
  const [settings, groups, tabs, stored] = await Promise.all([
    getSettings(), chrome.tabGroups.query({ collapsed: true }), chrome.tabs.query({}),
    chrome.storage.local.get(["activityLog", "activityStats"]),
  ]);
  const regularTabs = tabs.filter(tab => !tab.incognito);
  const groupedIds = new Set(regularTabs.map(tab => tab.groupId));
  const collapsedGroupIds = new Set(groups.filter(group => groupedIds.has(group.id)).map(group => group.id));
  const managedTabIds = new Set(stored.activityStats?.managedTabIds || []);
  return {
    ...settingsState(settings), activityLog: stored.activityLog || [],
    metrics: {
      collapsedGroupCount: collapsedGroupIds.size,
      collapsedTabCount: regularTabs.filter(tab => collapsedGroupIds.has(tab.groupId)).length,
      discardedTabCount: regularTabs.filter(tab => tab.discarded && managedTabIds.has(tab.id)).length,
      totalDiscardActions: stored.activityStats?.totalDiscardActions || 0,
    },
  };
}

async function updateSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings.");
  invalidateReview();
  const operation = settingsQueue.then(async () => {
    const previous = await getSettings();
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const settings = normalizeSettings({ ...previous, ...defined }, { strict: true });
    await chrome.storage.local.set({ settings });
    invalidateReview();
    if (!settings.extensionEnabled) await clearManagementAlarms();
    if (previous.extensionEnabled !== settings.extensionEnabled) {
      await appendActivity({ type: "status", timestamp: Date.now(),
        message: settings.extensionEnabled ? "Background optimization enabled." : "Background optimization disabled." });
    }
    if (previous.optimizationStrength !== settings.optimizationStrength) {
      await appendActivity({ type: "sensitivity", timestamp: Date.now(), value: settings.optimizationStrength,
        message: `Sensitivity changed to ${settings.optimizationStrength}%.` });
    }
    return settings;
  });
  settingsQueue = operation.catch(() => {});
  try {
    return settingsState(await operation);
  } finally {
    // Respond to controls without waiting for a slow or obsolete browser query.
    requestReview();
  }
}

chrome.runtime.onInstalled.addListener(() => initializeBackgroundOptimization().catch(console.error));
chrome.runtime.onStartup.addListener(() => initializeBackgroundOptimization().catch(console.error));
chrome.tabGroups.onCreated.addListener(() => requestReview());
chrome.tabGroups.onUpdated.addListener(group => {
  if (!group.collapsed) {
    resetGroups.add(group.id);
    reviewStateDirty = true;
  }
  return requestReview();
});
chrome.tabGroups.onRemoved.addListener(group => {
  resetGroups.add(group.id);
  reviewStateDirty = true;
  return requestReview();
});
chrome.tabs.onActivated.addListener(() => requestReview());
chrome.tabs.onCreated.addListener(tab => {
  if (tab.groupId === -1) return;
  return requestReview();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.discarded) return;
  if (tab.groupId === -1 && changeInfo.groupId === undefined) return;
  if (changeInfo.groupId !== undefined || changeInfo.audible !== undefined ||
      changeInfo.autoDiscardable !== undefined || changeInfo.status !== undefined ||
      changeInfo.discarded === false || changeInfo.url !== undefined) return requestReview();
});
chrome.tabs.onRemoved.addListener(tabId => {
  queueActivity(async () => {
    const { activityStats = {} } = await chrome.storage.local.get("activityStats");
    const ids = activityStats.managedTabIds || [];
    const filtered = ids.filter(id => id !== tabId);
    if (filtered.length !== ids.length) {
      await chrome.storage.local.set({ activityStats: { ...activityStats, managedTabIds: filtered } });
    }
  }).catch(console.error);
  return scheduleReview();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === REVIEW_ALARM ||
      LEGACY_ALARM_PREFIXES.some(prefix => alarm.name.startsWith(prefix))) return scheduleReview();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = async () => {
    switch (message?.type) {
      case "getState":
        return settingsState(await getSettings());
      case "getActivityState":
        return getActivityState();
      case "updateSettings":
        return updateSettings(message.settings);
      case "clearActivity":
        await queueActivity(() => chrome.storage.local.set({
          activityLog: [], activityStats: { totalDiscardActions: 0, managedTabIds: [] },
        }));
        return getActivityState();
      default:
        throw new Error("Unknown request.");
    }
  };
  respond().then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

// A normal MV3 wake does not fire onInstalled or onStartup.
requestReview();
