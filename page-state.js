(() => {
  "use strict";
  // Observe only the client's existing responses/events. No credentials cross this bridge.
  const source = "iclick-response-helper-state-v1";
  let latest = null;
  const id = value => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
  const course = () => location.hash.match(/\/class\/([\w-]+)/)?.[1] ??
    location.pathname.match(/\/class\/([\w-]+)/)?.[1];
  function publish(question, activity, courseId = course()) {
    const questionId = question?.questionId ?? question?._id;
    const activityId = question?.activityId ?? activity?.activityId ?? activity?._id;
    if (!id(questionId) || !id(activityId) || !id(courseId)) return;
    latest = {courseId, activityId, questionId, ended: Boolean(question.ended)};
    window.postMessage({source, state: latest}, location.origin);
  }
  function inspect(url, payload) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== "https://api.iclicker.com") return;
      const match = parsed.pathname.match(/^\/v[23]\/courses\/([\w-]+)\/class-sections$/);
      if (match && match[1] === course()) {
        const sections = Array.isArray(payload) ? payload : payload?.data;
        if (!Array.isArray(sections)) return;
        let activeQuestion = false;
        for (const activity of sections[0]?.activities ?? []) {
          if (activity.activityType !== "POLL" || activity.ended) continue;
          const question = activity.questions?.find(item => !item.ended);
          if (question) { activeQuestion = true; publish(question, activity, match[1]); }
        }
        if (!activeQuestion && latest?.courseId === match[1]) publish({...latest, ended: true});
      } else if (/^\/v2\/activities\/[\w-]+$/.test(parsed.pathname)) {
        const activity = payload?.data ?? payload;
        if (activity?.activityType !== "POLL" || activity.ended) return;
        if (activity.courseId && activity.courseId !== course()) return;
        const question = activity.questions?.find(item => !item.ended);
        if (question) publish(question, activity);
      }
    } catch { /* Unknown app response: leave state unchanged. */ }
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  function observedOpen(method, url, ...args) {
    let relevant = false;
    try {
      const parsed = new URL(url, location.href);
      relevant = parsed.origin === "https://api.iclicker.com" &&
        /^\/v[23]\/(courses\/[\w-]+\/class-sections|activities\/[\w-]+)$/.test(parsed.pathname);
    } catch { /* Let the original browser method handle invalid URLs. */ }
    if (!relevant) return originalOpen.call(this, method, url, ...args);
    this.addEventListener("load", () => {
      try {
        if (this.status < 200 || this.status >= 300) return;
        const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
        inspect(String(url), payload);
      } catch { /* Non-JSON responses are not state. */ }
    }, {once: true});
    return originalOpen.call(this, method, url, ...args);
  }
  const originalFetch = window.fetch;
  async function observedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    const url = response.url;
    if (response.ok && /^https:\/\/api\.iclicker\.com\/v[23]\/(courses\/[\w-]+\/class-sections|activities\/[\w-]+)(?:\?|$)/.test(url)) {
      void response.clone().json().then(payload => inspect(url, payload)).catch(() => {});
    }
    return response;
  }
  const OriginalSocket = window.WebSocket;
  const sockets = new Map();
  const ObservedSocket = new Proxy(OriginalSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      let hostname;
      try { hostname = new URL(args[0]).hostname; } catch { return socket; }
      if (!hostname.endsWith(".pusher.com")) return socket;
      const listener = event => {
        try {
          const message = JSON.parse(event.data);
          // Do not mix events from a different course channel.
          if (!course() || (message.channel !== `private-${course()}` &&
              !message.channel?.startsWith(`private-${course()}@`))) return;
          const data = typeof message.data === "string" ? JSON.parse(message.data) : message.data;
          if (message.event === "question") publish(data);
          else if (message.event === "endQuestion" && latest?.questionId === data?.questionId) {
            publish({...latest, ended: true});
          } else if (message.event === "MEETING_ENDED" && latest) {
            publish({...latest, ended: true});
          }
        } catch { /* Pusher control messages do not contain question state. */ }
      };
      socket.addEventListener("message", listener);
      sockets.set(socket, listener);
      socket.addEventListener("close", () => sockets.delete(socket), {once: true});
      return socket;
    }
  });
  function replay(event) {
    if (event.source === window && event.origin === location.origin &&
        event.data?.source === source && event.data?.request === "snapshot" && latest) {
      window.postMessage({source, state: latest}, location.origin);
    }
  }
  function attach() {
    XMLHttpRequest.prototype.open = observedOpen;
    window.fetch = observedFetch;
    window.WebSocket = ObservedSocket;
    window.addEventListener("message", replay);
    for (const [socket, listener] of sockets) socket.addEventListener("message", listener);
  }
  attach();
  window.addEventListener("pagehide", () => {
    if (XMLHttpRequest.prototype.open === observedOpen) XMLHttpRequest.prototype.open = originalOpen;
    if (window.fetch === observedFetch) window.fetch = originalFetch;
    if (window.WebSocket === ObservedSocket) window.WebSocket = OriginalSocket;
    window.removeEventListener("message", replay);
    for (const [socket, listener] of sockets) socket.removeEventListener("message", listener);
  });
  window.addEventListener("pageshow", event => { if (event.persisted) attach(); });
})();
