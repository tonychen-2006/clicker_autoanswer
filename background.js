"use strict";
importScripts("helpers.js");

const {validId, getQuestion} = IClickHelper;
async function getResponseDistribution(message, fetcher = fetch) {
  const {courseId, activityId, questionId, accessToken} = message;
  if (![courseId, activityId, questionId].every(validId) ||
      typeof accessToken !== "string" || !accessToken.trim() || accessToken.length > 16384 ||
      /[\r\n]/.test(accessToken)) return {error: "session"};
  const url = `https://api.iclicker.com/v2/reporting/courses/${courseId}/activities/${activityId}/questions/view`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(url, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      headers: {Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Reef-Auth-Type": "oauth"},
      signal: controller.signal
    });
    console.log("[iClick Helper] API status", response.status);
    if (!response.ok) return {error: [401, 403, 404].includes(response.status) ?
      `http-${response.status}` : "http", status: response.status};
    let payload;
    try { payload = await response.json(); } catch { return {error: "json"}; }
    const result = getQuestion(payload, questionId);
    if (result.error === "schema") {
      console.log("[iClick Helper] Unexpected schema keys", Object.keys(payload ?? {}),
        Object.keys(payload?.data ?? {}));
    }
    return result;
  } catch {
    // Fetch errors can embed headers/URLs. Never log the raw error or message.
    return {error: controller.signal.aborted ? "timeout" : "network"};
  } finally { clearTimeout(timeout); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "distribution") return;
  let origin;
  try { origin = new URL(sender.url).origin; } catch { return; }
  if (sender.id !== chrome.runtime.id || !sender.tab ||
      origin !== "https://student.iclicker.com") return;
  void getResponseDistribution(message).then(sendResponse, () => sendResponse({error: "internal"}));
  return true;
});
