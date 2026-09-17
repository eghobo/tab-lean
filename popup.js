const elements = {
  activityButton: document.querySelector("#activity-button"),
  disabledNotice: document.querySelector("#disabled-notice"),
  excludedHosts: document.querySelector("#excluded-hosts"),
  exclusionsForm: document.querySelector("#exclusions-form"),
  idleTimeout: document.querySelector("#idle-timeout"),
  loadError: document.querySelector("#load-error"),
  loadErrorMessage: document.querySelector("#load-error-message"),
  optimizationStrength: document.querySelector("#optimization-strength"),
  retryButton: document.querySelector("#retry-button"),
  saveExclusions: document.querySelector("#save-exclusions"),
  strengthOutput: document.querySelector("#strength-output"),
  toast: document.querySelector("#toast"),
};

let viewRevision = 0;
let exclusionsDirty = false;
let savingExclusions = false;
let toastTimer;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 1800);
}

function strengthLabel(value) {
  if (value <= 20) return "Gentle";
  if (value <= 60) return "Balanced";
  if (value <= 85) return "Aggressive";
  return "Maximum";
}

function updateStrengthAppearance() {
  const value = Number(elements.optimizationStrength.value);
  const label = strengthLabel(value);
  elements.strengthOutput.textContent = label;
  elements.optimizationStrength.style.setProperty("--range-progress", `${value}%`);
  elements.optimizationStrength.setAttribute("aria-valuetext", `${label}, ${value} percent`);
  // Display the same 30-300 second policy used by background.js.
  const seconds = Math.round(30 + (1 - value / 100) * 270);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const duration = [minutes ? `${minutes} min` : "", remainder ? `${remainder} sec` : ""].filter(Boolean).join(" ");
  elements.idleTimeout.textContent = `Idle timeout: ${duration}.`;
}

function renderState(state) {
  const { settings } = state;
  elements.optimizationStrength.value = settings.optimizationStrength ?? 80;
  elements.optimizationStrength.disabled = false;
  elements.disabledNotice.hidden = settings.extensionEnabled !== false;
  if (!exclusionsDirty) elements.excludedHosts.value = (settings.excludedHosts || []).join("\n");
  elements.excludedHosts.disabled = savingExclusions;
  elements.saveExclusions.disabled = savingExclusions;
  updateStrengthAppearance();
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "TabLean could not update."));
        return;
      }
      resolve(response.data);
    });
  });
}

async function saveSettings(patch) {
  const revision = ++viewRevision;
  const state = await sendMessage({
    type: "updateSettings",
    settings: patch,
  });
  if (revision === viewRevision) renderState(state);
  return state;
}

elements.optimizationStrength.addEventListener("input", () => {
  viewRevision += 1;
  updateStrengthAppearance();
});
elements.optimizationStrength.addEventListener("change", () => {
  saveSettings({ optimizationStrength: elements.optimizationStrength.value })
    .catch((error) => showToast(error.message, true));
});

elements.excludedHosts.addEventListener("input", () => {
  exclusionsDirty = true;
  viewRevision += 1;
});
elements.exclusionsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  savingExclusions = true;
  elements.excludedHosts.disabled = true;
  elements.saveExclusions.disabled = true;
  try {
    const excludedHosts = elements.excludedHosts.value.split(/\r?\n/).map(host => host.trim()).filter(Boolean);
    const state = await saveSettings({ excludedHosts });
    exclusionsDirty = false;
    elements.excludedHosts.value = (state.settings.excludedHosts || []).join("\n");
    showToast("Saved sites to keep loaded.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    savingExclusions = false;
    elements.excludedHosts.disabled = false;
    elements.saveExclusions.disabled = false;
  }
});

elements.activityButton.addEventListener("click", async () => {
  elements.activityButton.disabled = true;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("activity.html") });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.activityButton.disabled = false;
  }
});

async function loadState() {
  elements.loadError.hidden = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const state = await sendMessage({ type: "getState" });
      renderState(state);
      return;
    } catch (error) {
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        continue;
      }
      elements.loadErrorMessage.textContent = error.message;
      elements.loadError.hidden = false;
    }
  }
}

elements.retryButton.addEventListener("click", () => loadState());

loadState();
