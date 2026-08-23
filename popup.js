const elements = {
  activityButton: document.querySelector("#activity-button"),
  optimizationStrength: document.querySelector("#optimization-strength"),
  strengthOutput: document.querySelector("#strength-output"),
  toast: document.querySelector("#toast"),
};

let extensionEnabled = true;
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
}

function renderState(state) {
  const { settings } = state;
  extensionEnabled = settings.extensionEnabled !== false;
  elements.optimizationStrength.value = settings.optimizationStrength ?? 80;
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

async function saveSettings(enabled = extensionEnabled) {
  const state = await sendMessage({
    type: "updateSettings",
    settings: {
      extensionEnabled: enabled,
      optimizationStrength: elements.optimizationStrength.value,
    },
  });
  renderState(state);
}

elements.optimizationStrength.addEventListener("input", updateStrengthAppearance);
elements.optimizationStrength.addEventListener("change", () => {
  saveSettings().catch((error) => showToast(error.message, true));
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

sendMessage({ type: "getState" })
  .then(renderState)
  .catch((error) => showToast(error.message, true));
