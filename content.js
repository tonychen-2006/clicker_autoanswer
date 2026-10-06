(() => {
  "use strict";
  const {normalizeSettings, validId, createPoller, getAutoAnswerChoices} = IClickHelper;
  const debug = (...args) => console.log("[iClick Helper]", ...args);
  const source = "iclick-response-helper-state-v1";
  let settings = normalizeSettings();
  let appState = null;
  let currentKey = "";
  let suspended = false;
  let refreshTimer = null;
  let host = null;
  let answerNode;
  let percentageNode;
  let autoNode;
  let autoStatus = "";
  let lastAttempt = "";
  let result = null;
  let status = "Idle — no live question detected";
  let lastLog = "";
  let lastSession = "";

  function getSessionInfo() {
    try {
      const route = location.hash || location.pathname;
      const courseId = route.match(/\/class\/([\w-]+)\/poll(?:[/?]|$)/)?.[1];
      let legacy = null;
      try { legacy = JSON.parse(sessionStorage.getItem("activity")); } catch { /* Old state is optional. */ }
      const state = courseId ? (appState?.courseId === courseId ? appState : null) : legacy;
      const identity = document.querySelector("app-poll [data-question-id], app-poll [id*='extracted-text-']");
      const visibleId = identity?.getAttribute("data-question-id") ??
        identity?.id?.match(/extracted-text-['"]?([\w-]+)/)?.[1];
      return {accessToken: sessionStorage.getItem("access_token"),
        courseId: courseId ?? state?.courseId,
        activityId: state?.activityId,
        questionId: visibleId && visibleId !== state?.questionId ? undefined : state?.questionId,
        ended: state?.ended === true};
    } catch { return {}; }
  }
  function activePage() {
    const route = location.hash || location.pathname;
    const pollingRoute = /^#?\/class\/[\w-]+\/poll(?:[/?]|$)/.test(route) ||
      /^#?\/polling(?:[/?]|$)/.test(route);
    // Current semantic component + current/legacy controls, scoped to polling routes.
    return pollingRoute && Boolean(document.querySelector(
      "app-poll, .polling-page-wrapper, .multiple-choice-buttons, .question-answer-container"));
  }
  function render(nextStatus, highest = null) {
    status = nextStatus;
    result = highest;
    if (!settings.enabled || suspended || !activePage() || nextStatus.startsWith("Idle")) {
      if (host) host.hidden = true;
      return;
    }
    if (!document.body) return;
    if (!host) {
      host = document.createElement("div");
      host.id = "iclick-response-helper";
      const shadow = host.attachShadow({mode: "closed"});
      const style = document.createElement("style");
      style.textContent = ":host{all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important;pointer-events:none!important}:host([hidden]){display:none!important}section{font:14px/1.4 system-ui,sans-serif;background:#fff;color:#17212b;padding:14px 18px;border:1px solid #d7dee5;border-radius:10px;box-shadow:0 3px 16px #0002;max-width:220px}h2{font:600 13px/1.4 system-ui,sans-serif;margin:0 0 6px;color:#465568}p{margin:0;overflow-wrap:anywhere}.answer{font-size:26px;font-weight:700}.percent{color:#465568;margin-top:2px}";
      const panel = document.createElement("section");
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-live", "polite");
      const title = document.createElement("h2");
      title.textContent = "Highest response";
      answerNode = document.createElement("p");
      percentageNode = document.createElement("p");
      percentageNode.className = "percent";
      autoNode = document.createElement("p");
      autoNode.className = "percent";
      panel.append(title, answerNode, percentageNode, autoNode);
      shadow.append(style, panel);
    }
    if (!host.isConnected) document.body.append(host);
    host.hidden = false;
    const text = highest?.answer ?? (nextStatus.startsWith("Unavailable") ? "Unavailable" : "Waiting for responses...");
    if (answerNode.textContent !== text) answerNode.textContent = text;
    answerNode.className = highest ? "answer" : "";
    const percent = highest && settings.showPercentage ? `${Number(highest.percentage.toFixed(2))}%` : "";
    if (percentageNode.textContent !== percent) percentageNode.textContent = percent;
    percentageNode.hidden = !percent;
    const automatic = settings.autoAnswer ? autoStatus || "Auto-answer on" : "Auto-answer off";
    if (autoNode.textContent !== automatic) autoNode.textContent = automatic;
  }

  function tryAutoAnswer(highest, key) {
    autoStatus = "";
    if (!settings.enabled || !settings.autoAnswer || suspended || key !== currentKey || !activePage()) return;
    const choices = getAutoAnswerChoices(highest);
    if (!choices.length) return;
    const session = getSessionInfo();
    if (session.ended || [session.courseId, session.activityId, session.questionId].join(":") !== key) return;
    // Scope to the verified single-choice component; multi-answer/group/quiz controls are excluded.
    const component = document.querySelector("app-poll app-multiple-choice-question");
    if (!component) { autoStatus = "Auto-answer: single-choice controls unavailable"; return; }
    const buttons = [...component.querySelectorAll(".multiple-choice-buttons button")];
    const matches = answer => buttons.filter(button => button.id === `multiple-choice-${answer.toLowerCase()}` ||
      button.textContent.trim().toUpperCase() === answer);
    for (const answer of choices) {
      const [button] = matches(answer);
      if (button?.getAttribute("aria-pressed") === "true") {
        autoStatus = `iClicker shows ${answer} selected`;
        return;
      }
    }
    const answer = choices[0];
    const candidates = matches(answer);
    const button = candidates[0];
    if (candidates.length !== 1 || !button.isConnected || button.hidden ||
        button.getClientRects().length === 0 || button.closest("[hidden], [inert], [aria-hidden='true']")) {
      autoStatus = "Auto-answer: choice control unavailable";
      return;
    }
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      autoStatus = "Auto-answer: waiting for enabled controls";
      return;
    }
    const attempt = `${key}:${answer}`;
    if (lastAttempt === attempt) {
      autoStatus = `Auto-answer attempted ${answer} — check iClicker`;
      return;
    }
    lastAttempt = attempt;
    try {
      button.click();
      autoStatus = `Auto-answer attempted ${answer}`;
      debug("Auto-answer button activated", answer);
    } catch {
      autoStatus = "Auto-answer: could not activate choice";
    }
  }
  const poller = createPoller(async stillCurrent => {
    try {
      const session = getSessionInfo();
      const key = [session.courseId, session.activityId, session.questionId].join(":");
      if (!activePage() || session.ended || key !== currentKey) { refresh(); return; }
      if (!session.accessToken || ![session.courseId, session.activityId, session.questionId].every(validId)) {
        render("Unavailable — session or question identity missing");
        return;
      }
      const response = await chrome.runtime.sendMessage({type: "distribution", ...session});
      if (!stillCurrent()) return;
      const latest = getSessionInfo();
      if (!activePage() || latest.ended || [latest.courseId, latest.activityId, latest.questionId].join(":") !== key) {
        refresh(); return;
      }
      if (response?.error) { autoStatus = ""; render(`Unavailable — ${response.error}`); }
      else {
        tryAutoAnswer(response?.highest, key);
        render(response?.highest ? "Live response distribution" : "Waiting for responses...", response?.highest);
      }
      const change = response?.highest ? `${response.highest.answer}:${response.highest.percentage}` : "";
      if (change !== lastLog) { lastLog = change; debug("Highest-response changed", response?.highest ?? "waiting"); }
    } catch { if (stillCurrent()) render("Unavailable — extension connection failed"); }
  }, () => settings.interval * 1000);

  function refresh() {
    if (suspended) return;
    const session = getSessionInfo();
    const sessionFound = Boolean(session.accessToken && [session.courseId, session.activityId, session.questionId].every(validId));
    const sessionLabel = sessionFound ? "found" : "missing";
    if (sessionLabel !== lastSession) { lastSession = sessionLabel; debug("Session info", sessionLabel); }
    const active = settings.enabled && activePage() && !session.ended;
    const key = active ? [session.courseId, session.activityId, session.questionId].join(":") : "";
    if (key !== currentKey) {
      poller.stop();
      currentKey = key;
      lastLog = "";
      lastAttempt = "";
      autoStatus = "";
      if (active) debug("Polling page detected; question identity", sessionFound ? "found" : "missing");
      render(active ? "Waiting for responses..." : settings.enabled ? "Idle — no live question detected" : "Disabled");
    }
    if (active) poller.start();
    else { poller.stop(); render(settings.enabled ? "Idle — no live question detected" : "Disabled"); }
  }
  function scheduleRefresh() {
    if (refreshTimer !== null || suspended) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 100);
  }
  const observer = new MutationObserver(scheduleRefresh);
  function onState(event) {
    const state = event.data?.state;
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== source ||
        !state || ![state.courseId, state.activityId, state.questionId].every(validId) ||
        typeof state.ended !== "boolean") return;
    appState = {courseId: state.courseId, activityId: state.activityId,
      questionId: state.questionId, ended: state.ended};
    scheduleRefresh();
  }
  function onSettings(changes, area) {
    if (area !== "local" || !changes.settings) return;
    const previousAutoAnswer = settings.autoAnswer;
    settings = normalizeSettings(changes.settings.newValue);
    if (settings.autoAnswer !== previousAutoAnswer) lastAttempt = "";
    autoStatus = "";
    poller.stop();
    render(status, result);
    refresh();
  }
  function onMessage(message, _sender, respond) {
    if (message?.type === "status") respond({status: settings.enabled && settings.autoAnswer && currentKey ?
      `${status} · ${autoStatus || "Auto-answer on"}` : status, active: Boolean(currentKey)});
  }
  function attach() {
    suspended = false;
    observer.observe(document, {subtree: true, childList: true,
      attributes: true, attributeFilter: ["hidden", "class", "aria-disabled"]});
    window.addEventListener("message", onState);
    window.addEventListener("hashchange", scheduleRefresh);
    window.addEventListener("popstate", scheduleRefresh);
    chrome.storage.onChanged.addListener(onSettings);
    chrome.runtime.onMessage.addListener(onMessage);
    window.postMessage({source, request: "snapshot"}, location.origin);
    void chrome.storage.local.get("settings").then(value => {
      settings = normalizeSettings(value.settings);
      refresh();
    }).catch(() => render("Unavailable — settings could not be loaded"));
  }
  attach();
  window.addEventListener("pagehide", () => {
    suspended = true;
    poller.stop();
    observer.disconnect();
    clearTimeout(refreshTimer);
    refreshTimer = null;
    currentKey = "";
    host?.remove();
    window.removeEventListener("message", onState);
    window.removeEventListener("hashchange", scheduleRefresh);
    window.removeEventListener("popstate", scheduleRefresh);
    chrome.storage.onChanged.removeListener(onSettings);
    chrome.runtime.onMessage.removeListener(onMessage);
  });
  window.addEventListener("pageshow", event => { if (event.persisted) attach(); });
})();
