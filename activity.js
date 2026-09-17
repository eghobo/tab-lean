const elements = {
  activityAnnounce: document.querySelector("#activity-announce"),
  activityList: document.querySelector("#activity-list"),
  clearButton: document.querySelector("#clear-button"),
  collapsedGroups: document.querySelector("#collapsed-groups"),
  collapsedTabs: document.querySelector("#collapsed-tabs"),
  discardedNow: document.querySelector("#discarded-now"),
  statusButton: document.querySelector("#status-button"),
  statusLabel: document.querySelector("#status-label"),
  toast: document.querySelector("#toast"),
  totalActions: document.querySelector("#total-actions"),
};

let currentSettings = { extensionEnabled: true, optimizationStrength: 80 };
let lastNewestTimestamp = 0;
let toastTimer;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2000);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "TabLean could not update."));
      resolve(response.data);
    });
  });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function activityIcon(type) {
  if (type === "discard") return "↓";
  if (type === "status") return "●";
  return "↔";
}

function renderLog(activityLog) {
  if (activityLog.length && lastNewestTimestamp > 0) {
    const newEntries = activityLog.filter((e) => e.timestamp > lastNewestTimestamp);
    if (newEntries.length) {
      elements.activityAnnounce.textContent = "";
      requestAnimationFrame(() => {
        elements.activityAnnounce.textContent = newEntries.map((e) => e.message).join(". ");
      });
    }
  }
  if (activityLog.length) {
    lastNewestTimestamp = activityLog[0].timestamp;
  }

  if (!activityLog.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No activity yet. Collapse a tab group to begin.";
    elements.activityList.replaceChildren(empty);
    return;
  }

  elements.activityList.replaceChildren(
    ...activityLog.map((entry) => {
      const row = document.createElement("article");
      row.className = "activity-row";
      const badge = document.createElement("span");
      badge.className = "activity-badge";
      badge.textContent = activityIcon(entry.type);
      const copy = document.createElement("div");
      copy.className = "activity-copy";
      const message = document.createElement("p");
      message.textContent = entry.message;
      copy.append(message);
      if (entry.tabTitles?.length) {
        const detail = document.createElement("small");
        detail.textContent = entry.tabTitles.join(" · ");
        detail.title = entry.tabTitles.join("\n");
        copy.append(detail);
      }
      const time = document.createElement("time");
      time.className = "activity-time";
      time.dateTime = new Date(entry.timestamp).toISOString();
      time.textContent = formatTime(entry.timestamp);
      row.append(badge, copy, time);
      return row;
    }),
  );
}

function renderState(state) {
  currentSettings = state.settings;
  elements.statusButton.classList.toggle("off", !currentSettings.extensionEnabled);
  elements.statusButton.setAttribute("aria-pressed", String(currentSettings.extensionEnabled));
  elements.statusLabel.textContent = currentSettings.extensionEnabled ? "Enabled" : "Disabled";
  elements.discardedNow.textContent = state.metrics.discardedTabCount;
  elements.totalActions.textContent = state.metrics.totalDiscardActions;
  elements.collapsedGroups.textContent = state.metrics.collapsedGroupCount;
  elements.collapsedTabs.textContent = state.metrics.collapsedTabCount;
  renderLog(state.activityLog);
}

async function refresh() {
  renderState(await sendMessage({ type: "getActivityState" }));
}

elements.statusButton.addEventListener("click", async () => {
  elements.statusButton.disabled = true;
  try {
    await sendMessage({
      type: "updateSettings",
      settings: {
        extensionEnabled: !currentSettings.extensionEnabled,
      },
    });
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.statusButton.disabled = false;
  }
});

elements.clearButton.addEventListener("click", async () => {
  elements.clearButton.disabled = true;
  lastNewestTimestamp = 0;
  try {
    renderState(await sendMessage({ type: "clearActivity" }));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.clearButton.disabled = false;
  }
});

refresh().catch((error) => showToast(error.message, true));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.activityLog || changes.activityStats || changes.settings)) {
    if (!document.hidden) refresh().catch(() => {});
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => {});
});

setInterval(() => {
  if (!document.hidden) refresh().catch(() => {});
}, 15_000);
