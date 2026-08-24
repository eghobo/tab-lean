const DEFAULT_SETTINGS = Object.freeze({
  extensionEnabled: true,
  optimizationStrength: 80,
});

const REVIEW_ALARM_PREFIX = "review-group:";
const LEGACY_ALARM_PREFIXES = ["close-group:", "close-tab:"];
const tabUsage = new Map();
let activityQueue = Promise.resolve();

function appendActivity(entry) {
  const operation = activityQueue.then(async () => {
    const stored = await chrome.storage.local.get(["activityLog", "activityStats"]);
    const activityLog = stored.activityLog || [];
    const activityStats = stored.activityStats || { totalDiscardActions: 0 };
    const managedTabIds = new Set(activityStats.managedTabIds || []);
    for (const tabId of entry.discardedTabIds || []) managedTabIds.add(tabId);
    const nextStats = {
      totalDiscardActions:
        (Number(activityStats.totalDiscardActions) || 0) + (entry.discardedCount || 0),
      lastActivityAt: entry.timestamp,
      managedTabIds: [...managedTabIds],
    };
    await chrome.storage.local.set({
      activityLog: [entry, ...activityLog].slice(0, 200),
      activityStats: nextStats,
    });
    console.info("[TabLean]", entry.message, entry.tabTitles || "");
  });

  activityQueue = operation.catch(() => {});
  return operation;
}

function reviewAlarmName(groupId) {
  return `${REVIEW_ALARM_PREFIX}${groupId}`;
}

function groupIdFromReviewAlarm(name) {
  if (!name.startsWith(REVIEW_ALARM_PREFIX)) return null;
  const groupId = Number(name.slice(REVIEW_ALARM_PREFIX.length));
  return Number.isInteger(groupId) ? groupId : null;
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

function optimizationIntensity(settings) {
  return Math.min(100, Math.max(0, Number(settings.optimizationStrength) || 0)) / 100;
}

function reviewDelay(settings) {
  const intensity = optimizationIntensity(settings);
  return Math.round(30_000 + (1 - intensity) * 270_000);
}

function recordTabActivation(tabId) {
  const previous = tabUsage.get(tabId) || { activationCount: 0 };
  tabUsage.set(tabId, {
    activationCount: previous.activationCount + 1,
    lastActivatedAt: Date.now(),
  });
}

function calculateImportance(tab, now = Date.now()) {
  const usage = tabUsage.get(tab.id) || {};
  const lastAccessed = usage.lastActivatedAt || tab.lastAccessed || 0;
  const age = lastAccessed ? Math.max(0, now - lastAccessed) : Infinity;
  const recency = Number.isFinite(age) ? 48 * Math.exp(-age / 180_000) : 0;
  const repeatUse = Math.min(10, Math.log2(1 + (usage.activationCount || 0)) * 4);
  const active = tab.active ? 28 : 0;
  const audible = tab.audible ? 20 : 0;
  const loading = tab.status === "loading" ? 5 : 0;

  return Math.round(
    Math.min(100, Math.max(0, recency + repeatUse + active + audible + loading)),
  );
}

function discardThreshold(settings) {
  const intensity = optimizationIntensity(settings);
  return 10 + 45 * intensity ** 1.15;
}

async function clearReviewAlarm(groupId) {
  await chrome.alarms.clear(reviewAlarmName(groupId));
}

async function clearAllManagementAlarms() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter(
        (alarm) =>
          alarm.name.startsWith(REVIEW_ALARM_PREFIX) ||
          LEGACY_ALARM_PREFIXES.some((prefix) => alarm.name.startsWith(prefix)),
      )
      .map((alarm) => chrome.alarms.clear(alarm.name)),
  );
}

async function scheduleNextReview(groupId, settings) {
  await chrome.alarms.create(reviewAlarmName(groupId), {
    when: Date.now() + reviewDelay(settings),
  });
}

async function optimizeCollapsedGroup(groupId) {
  const settings = await getSettings();
  if (!settings.extensionEnabled) {
    await clearReviewAlarm(groupId);
    return;
  }

  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group || !group.collapsed) {
    await clearReviewAlarm(groupId);
    return;
  }

  const tabs = await chrome.tabs.query({ groupId });
  const threshold = discardThreshold(settings);
  const now = Date.now();
  const candidates = tabs.filter(
    (tab) =>
      !tab.active &&
      !tab.audible &&
      !tab.discarded &&
      calculateImportance(tab, now) < threshold,
  );

  const discardResults = await Promise.all(
    candidates.map(async (tab) => {
      // Keep optimization discard-only. Moving, regrouping, removing, or
      // recreating tabs would change Chrome's saved tab-group sync data.
      const result = await chrome.tabs.discard(tab.id).catch(() => null);
      return result ? tab : null;
    }),
  );
  const discardedTabs = discardResults.filter(Boolean);

  if (discardedTabs.length) {
    await appendActivity({
      type: "discard",
      timestamp: Date.now(),
      groupId,
      groupTitle: group.title || "Untitled group",
      discardedCount: discardedTabs.length,
      discardedTabIds: discardedTabs.map((tab) => tab.id),
      tabTitles: discardedTabs.map((tab) => tab.title || "Untitled tab"),
      message: `Discarded ${discardedTabs.length} tab${discardedTabs.length === 1 ? "" : "s"} in ${group.title || "Untitled group"}.`,
    });
  }

  // Revisit only if a loaded tab remains. Its score may fall as it stays unused.
  const currentTabs = await chrome.tabs.query({ groupId });
  const hasLoadedTabs = currentTabs.some((tab) => !tab.discarded);
  if (hasLoadedTabs) {
    await scheduleNextReview(groupId, settings);
  } else {
    await clearReviewAlarm(groupId);
  }
}

async function optimizeAllCollapsedGroups() {
  const settings = await getSettings();
  if (!settings.extensionEnabled) {
    await clearAllManagementAlarms();
    return;
  }

  const groups = await chrome.tabGroups.query({ collapsed: true });
  for (const group of groups) {
    await optimizeCollapsedGroup(group.id);
  }
}

async function removeLegacyClosingPlans() {
  const stored = await chrome.storage.local.get(["closingPlans", "savedGroups"]);
  const closingPlans = stored.closingPlans || [];
  if (!closingPlans.length) return;

  // Preserve recovery data from older development builds without closing anything else.
  const recoveredGroups = closingPlans.map((plan) => ({
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

async function resetCurrentActivityTracking() {
  const { activityStats = {} } = await chrome.storage.local.get("activityStats");
  await chrome.storage.local.set({
    activityStats: { ...activityStats, managedTabIds: [] },
  });
}

async function initializeBackgroundOptimization() {
  await clearAllManagementAlarms();
  await removeLegacyClosingPlans();
  await resetCurrentActivityTracking();
  await optimizeAllCollapsedGroups();
}

async function getActivityState() {
  const [settings, groups, tabs, stored] = await Promise.all([
    getSettings(),
    chrome.tabGroups.query({ collapsed: true }),
    chrome.tabs.query({}),
    chrome.storage.local.get(["activityLog", "activityStats"]),
  ]);
  const collapsedGroupIds = new Set(groups.map((group) => group.id));
  const collapsedTabs = tabs.filter((tab) => collapsedGroupIds.has(tab.groupId));
  const managedTabIds = new Set(stored.activityStats?.managedTabIds || []);

  return {
    settings,
    activityLog: stored.activityLog || [],
    metrics: {
      collapsedGroupCount: groups.length,
      collapsedTabCount: collapsedTabs.length,
      discardedTabCount: tabs.filter(
        (tab) => tab.discarded && managedTabIds.has(tab.id),
      ).length,
      totalDiscardActions: stored.activityStats?.totalDiscardActions || 0,
    },
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      extensionEnabled: settings.extensionEnabled !== false,
      optimizationStrength: Math.min(
        100,
        Math.max(0, Number(settings.optimizationStrength) || 0),
      ),
    },
  });
  await initializeBackgroundOptimization();
});

chrome.runtime.onStartup.addListener(() => {
  return initializeBackgroundOptimization().catch(console.error);
});

chrome.tabGroups.onCreated.addListener((group) => {
  if (group.collapsed) return optimizeCollapsedGroup(group.id).catch(console.error);
  return null;
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group.collapsed) {
    return optimizeCollapsedGroup(group.id).catch(console.error);
  }
  return clearReviewAlarm(group.id).catch(console.error);
});

chrome.tabGroups.onRemoved.addListener((group) => {
  return clearReviewAlarm(group.id).catch(console.error);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  recordTabActivation(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.groupId !== undefined && tab.groupId !== -1) {
    chrome.tabGroups
      .get(tab.groupId)
      .then((group) => {
        if (group.collapsed) return optimizeCollapsedGroup(group.id);
        return null;
      })
      .catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.groupId === undefined || tab.groupId === -1) return;
  chrome.tabGroups
    .get(tab.groupId)
    .then((group) => {
      if (group.collapsed) return optimizeCollapsedGroup(group.id);
      return null;
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabUsage.delete(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const groupId = groupIdFromReviewAlarm(alarm.name);
  if (groupId !== null) {
    optimizeCollapsedGroup(groupId).catch(console.error);
    return;
  }

  if (LEGACY_ALARM_PREFIXES.some((prefix) => alarm.name.startsWith(prefix))) {
    chrome.alarms.clear(alarm.name).catch(console.error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = async () => {
    switch (message?.type) {
      case "getState":
        return { settings: await getSettings() };

      case "getActivityState":
        return getActivityState();

      case "clearActivity":
        await activityQueue.catch(() => {});
        await chrome.storage.local.set({
          activityLog: [],
          activityStats: { totalDiscardActions: 0, managedTabIds: [] },
        });
        return getActivityState();

      case "updateSettings": {
        const previousSettings = await getSettings();
        const settings = {
          extensionEnabled: message.settings.extensionEnabled !== false,
          optimizationStrength: Math.min(
            100,
            Math.max(0, Number(message.settings.optimizationStrength) || 0),
          ),
        };
        await chrome.storage.local.set({ settings });

        if (settings.extensionEnabled) {
          await optimizeAllCollapsedGroups();
        } else {
          await clearAllManagementAlarms();
        }

        if (previousSettings.extensionEnabled !== settings.extensionEnabled) {
          await appendActivity({
            type: "status",
            timestamp: Date.now(),
            message: settings.extensionEnabled
              ? "Background optimization enabled."
              : "Background optimization disabled.",
          });
        }
        if (previousSettings.optimizationStrength !== settings.optimizationStrength) {
          await appendActivity({
            type: "sensitivity",
            timestamp: Date.now(),
            value: settings.optimizationStrength,
            message: `Sensitivity changed to ${settings.optimizationStrength}%.`,
          });
        }
        return { settings };
      }

      default:
        throw new Error("Unknown request.");
    }
  };

  respond()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
