"use strict";
(() => {
  const fields = Object.fromEntries(["enabled", "autoAnswer", "interval", "showPercentage"].map(id => [id, document.getElementById(id)]));
  const status = document.getElementById("status");
  let saving = Promise.resolve();
  async function updateStatus() {
    if (!fields.enabled.checked) { status.textContent = "Disabled"; return; }
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      const response = await chrome.tabs.sendMessage(tab.id, {type: "status"});
      status.textContent = response?.status ?? "Open iClicker Student to view status";
    } catch { status.textContent = "Open or reload iClicker Student to view status"; }
  }
  async function initialize() {
    try {
      const value = await chrome.storage.local.get("settings");
      const settings = IClickHelper.normalizeSettings(value.settings);
      fields.enabled.checked = settings.enabled;
      fields.autoAnswer.checked = settings.autoAnswer;
      fields.interval.value = String(settings.interval);
      fields.showPercentage.checked = settings.showPercentage;
      for (const field of Object.values(fields)) field.addEventListener("change", () => {
        const next = {enabled: fields.enabled.checked, autoAnswer: fields.autoAnswer.checked, interval: Number(fields.interval.value),
          showPercentage: fields.showPercentage.checked};
        saving = saving.then(async () => {
          await chrome.storage.local.set({settings: next});
          await updateStatus();
        }).catch(() => { status.textContent = "Could not save settings"; });
      });
      await updateStatus();
    } catch { status.textContent = "Could not load settings"; }
  }
  void initialize();
})();
