const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  const sandbox = vm.createContext({console: {log() {}}, setTimeout, clearTimeout, AbortController, ...extra});
  vm.runInContext(read("helpers.js"), sandbox);
  return sandbox;
}
const helper = context().IClickHelper;
const choice = (answer, percentageOfTotalResponses) => ({answer, percentageOfTotalResponses});
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function timers() {
  let nextId = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimeout(fn, delay) { jobs.set(++nextId, {fn, delay}); return nextId; },
    clearTimeout(id) { jobs.delete(id); },
    async run(delay) {
      const job = [...jobs].find(([, value]) => delay === undefined || value.delay === delay);
      assert.ok(job, `Expected timer ${delay}`);
      jobs.delete(job[0]);
      job[1].fn();
      await flush();
    }
  };
}

test("highest response handles leaders, ties and duplicate choices", () => {
  assert.deepEqual(plain(helper.getHighestResponse([choice("A", 18), choice("B", 67), choice("C", 15)])), {answer: "B", percentage: 67});
  assert.deepEqual(plain(helper.getHighestResponse([choice("C", 42), choice("B", 42), choice("B", 30)])), {answer: "B / C", percentage: 42});
});
test("empty, zero, undefined and malformed distributions are safe", () => {
  for (const entries of [undefined, {}, [], [null], [choice("A", 0)], [choice("A", undefined)],
    [choice("A", "50")], [choice("A", NaN)], [choice("A", Infinity)], [choice("A", -1)],
    [choice("B", 101)], [choice("AB", 80)]]) assert.equal(helper.getHighestResponse(entries), null);
  assert.equal(helper.getHighestResponse([null, choice("B", 80)]).answer, "B");
});
test("question selection uses identity even when reporting order differs", () => {
  const questions = [{questionId: "new", answerOverview: [choice("B", 70)]},
    {questionId: "old", answerOverview: [choice("A", 90)]}];
  assert.equal(helper.getQuestion({data: {questions}}, "new").highest.answer, "B");
  assert.equal(helper.getQuestion({questions}, "new").highest.answer, "B");
  assert.equal(helper.getQuestion({questions}, "missing").waiting, true);
  assert.equal(helper.getQuestion({data: {}}, "new").error, "schema");
  assert.equal(helper.getQuestion({questions: [{_id: "new", answerOverview: []}]}, "new").highest, null);
  assert.equal(helper.getQuestion({questions: [{_id: "new", answerOverview: [{}]}]}, "new").error, "schema");
});
test("settings reject invalid intervals and retain boolean preferences", () => {
  assert.deepEqual(plain(helper.normalizeSettings({interval: 0, enabled: false, showPercentage: false})),
    {interval: 3, enabled: false, autoAnswer: true, showPercentage: false});
  assert.equal(helper.normalizeSettings({autoAnswer: false}).autoAnswer, false);
});
test("polling cannot stack, overlap, or restart from a stale request", async () => {
  const clock = timers();
  let finish;
  let count = 0;
  const validity = [];
  const poller = helper.createPoller(async valid => {
    count++;
    await new Promise(resolve => { finish = resolve; });
    validity.push(valid());
  }, () => 3000, clock);
  poller.start(); poller.start();
  assert.equal(count, 1);
  poller.stop(); poller.start();
  await clock.run(50);
  assert.equal(count, 1);
  finish(); await flush();
  assert.deepEqual(validity, [false]);
  await clock.run(50);
  assert.equal(count, 2);
  finish(); await flush();
  assert.equal(clock.jobs.size, 1);
  poller.stop();
  assert.equal(clock.jobs.size, 0);
});

function background() {
  const logs = [];
  const sandbox = context({importScripts() {}, console: {log: (...args) => logs.push(args)},
    chrome: {runtime: {id: "extension", onMessage: {addListener(fn) { sandbox.listener = fn; }}}}});
  vm.runInContext(read("background.js"), sandbox);
  return {sandbox, logs};
}
const session = {courseId: "course", activityId: "activity", questionId: "new", accessToken: "secret-token"};
test("worker uses only the current reporting GET with ephemeral credentials", async () => {
  const {sandbox, logs} = background();
  const result = await sandbox.getResponseDistribution(session, async (url, options) => {
    assert.equal(url, "https://api.iclicker.com/v2/reporting/courses/course/activities/activity/questions/view");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    assert.equal(options.redirect, "error");
    return {ok: true, status: 200, json: async () => ({data: {questions: [{questionId: "new", answerOverview: [choice("B", 67)]}]}})};
  });
  assert.equal(result.highest.answer, "B");
  assert.ok(!JSON.stringify(logs).includes("secret-token"));
});
test("worker handles auth, missing endpoint, rate limits, JSON and schema failures", async () => {
  const {sandbox} = background();
  for (const status of [401, 403, 404, 429, 500]) {
    const response = await sandbox.getResponseDistribution(session, async () => ({ok: false, status}));
    assert.equal(response.status, status);
    assert.ok(response.error);
  }
  assert.equal((await sandbox.getResponseDistribution(session, async () => ({ok: true, status: 200, json: async () => { throw Error(); }}))).error, "json");
  assert.equal((await sandbox.getResponseDistribution(session, async () => ({ok: true, status: 200, json: async () => ({unexpected: []})}))).error, "schema");
  assert.equal((await sandbox.getResponseDistribution(session, async () => { throw Error("secret-token"); })).error, "network");
  assert.equal((await sandbox.getResponseDistribution({...session, courseId: "../invalid"}, () => assert.fail())).error, "session");
});
test("worker rejects messages from unrelated pages", () => {
  const {sandbox} = background();
  for (const sender of [{url: "https://example.com", id: "extension", tab: {}},
    {url: "https://student.iclicker.com", id: "other", tab: {}}, {}]) {
    assert.equal(sandbox.listener({type: "distribution", ...session}, sender, () => assert.fail()), undefined);
  }
});

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, event) { for (const fn of [...this.listeners.get(name) ?? []]) fn(event); }
}
test("state bridge observes current snapshots and Pusher question/end events without credentials", () => {
  const window = new Events();
  const posted = [];
  window.postMessage = message => posted.push(plain(message));
  window.fetch = async () => {};
  window.WebSocket = class extends Events { constructor(url) { super(); this.url = url; } };
  class XHR extends Events { open() {} }
  const sandbox = context({window, XMLHttpRequest: XHR, URL,
    location: {origin: "https://student.iclicker.com", hash: "#/class/course/poll", pathname: "/"}});
  vm.runInContext(read("page-state.js"), sandbox);
  const xhr = new XHR();
  xhr.open("GET", "https://api.iclicker.com/v3/courses/course/class-sections");
  xhr.status = 200; xhr.responseType = "json";
  xhr.response = [{activities: [{_id: "activity", activityType: "POLL", questions: [{_id: "new", activityId: "activity"}]}]}];
  xhr.emit("load", {});
  assert.equal(posted.at(-1).state.questionId, "new");
  const socket = new window.WebSocket("wss://ws-us2.pusher.com/app/public");
  const emit = (event, data, channel = "private-course") => socket.emit("message", {data: JSON.stringify({event, data: JSON.stringify(data), channel})});
  emit("question", {questionId: "next", activityId: "activity", access_token: "SECRET"});
  assert.equal(posted.at(-1).state.questionId, "next");
  emit("question", {questionId: "wrong", activityId: "activity"}, "private-course-other");
  assert.equal(posted.at(-1).state.questionId, "next");
  emit("endQuestion", {questionId: "next"});
  assert.equal(posted.at(-1).state.ended, true);
  assert.ok(!JSON.stringify(posted).includes("SECRET"));
  window.emit("pagehide", {});
  assert.equal(socket.listeners.get("message").size, 0);
});

function contentHarness(initialSettings = {}) {
  const window = new Events();
  const clock = timers();
  const location = {origin: "https://student.iclicker.com", hash: "#/class/course/poll", pathname: "/"};
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.isConnected = false; this.textContent = ""; }
    append(...children) { this.children.push(...children); for (const child of children) child.isConnected = true; }
    attachShadow() { return this.shadow = new Element("shadow"); }
    setAttribute() {}
    remove() { this.isConnected = false; }
  }
  const controls = {buttons: []};
  const document = {body: new Element("body"), createElement: tag => new Element(tag),
    querySelector: selector => selector === "app-poll app-multiple-choice-question" ?
      (controls.buttons.length ? {querySelectorAll: () => controls.buttons} : null) :
      selector.startsWith("app-poll [") ? null : ({})};
  const storageListeners = new Set();
  const runtimeListeners = new Set();
  const requests = [];
  const chrome = {storage: {local: {get: async () => ({settings: initialSettings})}, onChanged: {
    addListener: fn => storageListeners.add(fn), removeListener: fn => storageListeners.delete(fn)}},
    runtime: {onMessage: {addListener: fn => runtimeListeners.add(fn), removeListener: fn => runtimeListeners.delete(fn)},
      sendMessage: async message => { requests.push(message); return {highest: {answer: "B", percentage: 67}}; }}};
  window.postMessage = () => {};
  const sandbox = context({window, document, location, chrome,
    sessionStorage: {getItem: key => key === "access_token" ? "secret" : null},
    MutationObserver: class {observe() {} disconnect() {}}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout});
  vm.runInContext(read("content.js"), sandbox);
  const state = value => window.emit("message", {source: window, origin: location.origin,
    data: {source: "iclick-response-helper-state-v1", state: {courseId: "course", activityId: "activity", questionId: "new", ended: false, ...value}}});
  return {window, clock, location, document, chrome, state, requests, controls, storageListeners, runtimeListeners};
}
test("content updates one overlay, stops at question end, and cleans up", async () => {
  const h = contentHarness();
  await flush();
  assert.equal(h.requests.length, 0);
  h.state({}); await h.clock.run(100);
  assert.equal(h.requests.length, 1);
  const host = h.document.body.children[0];
  const panel = host.shadow.children[1];
  assert.equal(panel.children[1].textContent, "B");
  assert.equal(panel.children[2].textContent, "67%");
  h.state({}); await h.clock.run(100);
  assert.equal(h.requests.length, 1);
  assert.equal(h.document.body.children.length, 1);
  for (const listener of h.storageListeners) listener({settings: {newValue: {enabled: true, interval: 5, showPercentage: false}}}, "local");
  await flush();
  assert.equal(panel.children[2].hidden, true);
  h.state({ended: true}); await h.clock.run(100);
  assert.equal(host.hidden, true);
  assert.equal(h.clock.jobs.size, 0);
  h.window.emit("pagehide", {});
  assert.equal(h.runtimeListeners.size, 0);
  assert.equal(h.storageListeners.size, 0);
  assert.equal(host.isConnected, false);
});
test("content rejects stale responses after a new question arrives", async () => {
  const h = contentHarness();
  await flush();
  let finish;
  h.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
  h.state({}); await h.clock.run(100);
  h.state({questionId: "next"}); await h.clock.run(100);
  finish({highest: {answer: "A", percentage: 99}}); await flush();
  const panel = h.document.body.children[0].shadow.children[1];
  assert.equal(panel.children[1].textContent, "Waiting for responses...");
  h.window.emit("pagehide", {});
  assert.equal(h.clock.jobs.size, 0);
});
test("disabling and navigating away stop requests without crashing on missing data", async () => {
  const h = contentHarness();
  await flush();
  h.chrome.runtime.sendMessage = async () => ({error: "schema"});
  h.state({}); await h.clock.run(100);
  const host = h.document.body.children[0];
  assert.equal(host.shadow.children[1].children[1].textContent, "Unavailable");
  for (const listener of h.storageListeners) listener({settings: {newValue: {enabled: false}}}, "local");
  await flush();
  assert.equal(host.hidden, true);
  assert.equal(h.clock.jobs.size, 0);
  for (const listener of h.storageListeners) listener({settings: {newValue: {enabled: true}}}, "local");
  await flush();
  h.location.hash = "#/course/course";
  h.window.emit("hashchange", {});
  await h.clock.run(100);
  assert.equal(host.hidden, true);
  assert.equal(h.clock.jobs.size, 0);
  h.window.emit("pagehide", {});
});
function answerButton(answer, properties = {}) {
  const attributes = {};
  return {id: `multiple-choice-${answer.toLowerCase()}`, textContent: answer, isConnected: true,
    disabled: false, hidden: false, clicks: 0, getClientRects: () => [{}], closest: () => null,
    getAttribute: name => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
    click() { this.clicks++; }, ...properties};
}
test("automatic choices reject missing/malformed statistics and break ties deterministically", () => {
  assert.deepEqual(plain(helper.getAutoAnswerChoices({answer: "C / B", percentage: 42})), ["B", "C"]);
  for (const highest of [undefined, {answer: "B", percentage: 0}, {answer: "B", percentage: "50"},
    {answer: "F", percentage: 20}, {answer: "B / unknown", percentage: 40}, {answer: "B", percentage: Infinity}]) {
    assert.deepEqual(plain(helper.getAutoAnswerChoices(highest)), []);
  }
});
test("auto-answer clicks the leader once and updates when the leader changes", async () => {
  const h = contentHarness();
  const b = answerButton("B"), c = answerButton("C");
  h.controls.buttons = [b, c];
  await flush();
  h.state({}); await h.clock.run(100);
  assert.equal(b.clicks, 1);
  await h.clock.run(3000);
  assert.equal(b.clicks, 1);
  h.chrome.runtime.sendMessage = async () => ({highest: {answer: "C", percentage: 70}});
  await h.clock.run(3000);
  assert.equal(c.clicks, 1);
  h.state({questionId: "next"}); await h.clock.run(100);
  assert.equal(c.clicks, 2);
  h.window.emit("pagehide", {});
});
test("auto-answer keeps a selected tied answer and chooses alphabetically otherwise", async () => {
  const h = contentHarness();
  const b = answerButton("B"), c = answerButton("C");
  c.setAttribute("aria-pressed", "true");
  h.controls.buttons = [b, c];
  h.chrome.runtime.sendMessage = async () => ({highest: {answer: "B / C", percentage: 42}});
  await flush();
  h.state({}); await h.clock.run(100);
  assert.equal(b.clicks + c.clicks, 0);
  c.setAttribute("aria-pressed", "false");
  await h.clock.run(3000);
  assert.equal(b.clicks, 1);
  h.window.emit("pagehide", {});
});
test("auto-answer skips disabled, hidden, detached and ambiguous controls", async () => {
  for (const properties of [{disabled: true}, {hidden: true}, {isConnected: false},
    {getClientRects: () => []}, {closest: () => ({hidden: true})},
    {getAttribute: name => name === "aria-disabled" ? "true" : null}]) {
    const h = contentHarness();
    const b = answerButton("B", properties);
    h.controls.buttons = [b];
    await flush();
    h.state({}); await h.clock.run(100);
    assert.equal(b.clicks, 0);
    h.window.emit("pagehide", {});
  }
  const h = contentHarness();
  h.controls.buttons = [answerButton("B"), answerButton("B")];
  await flush();
  h.state({}); await h.clock.run(100);
  assert.equal(h.controls.buttons.reduce((sum, button) => sum + button.clicks, 0), 0);
  h.window.emit("pagehide", {});
});
test("display-only mode never clicks and the popup setting enables automatic answers", async () => {
  const h = contentHarness({autoAnswer: false});
  const b = answerButton("B");
  h.controls.buttons = [b];
  await flush();
  h.state({}); await h.clock.run(100);
  assert.equal(b.clicks, 0);
  for (const listener of h.storageListeners) listener({settings: {newValue: {autoAnswer: true}}}, "local");
  await flush();
  assert.equal(b.clicks, 1);
  h.window.emit("pagehide", {});
});
test("missing data and API errors never trigger an answer", async () => {
  for (const response of [{highest: null}, {waiting: true}, {error: "http-403"}, undefined,
    {highest: {answer: "B", percentage: 0}}]) {
    const h = contentHarness();
    const b = answerButton("B");
    h.controls.buttons = [b];
    h.chrome.runtime.sendMessage = async () => response;
    await flush();
    h.state({}); await h.clock.run(100);
    assert.equal(b.clicks, 0);
    h.window.emit("pagehide", {});
  }
});
test("ended, navigated, or disabled questions cannot act on pending response data", async () => {
  for (const stop of [h => h.state({ended: true}), h => h.state({questionId: "next"}),
    h => { h.location.hash = "#/course/course"; },
    h => { for (const listener of h.storageListeners) listener({settings: {newValue: {enabled: false}}}, "local"); }]) {
    const h = contentHarness();
    const b = answerButton("B");
    h.controls.buttons = [b];
    let finish;
    h.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
    await flush();
    h.state({}); await h.clock.run(100);
    stop(h);
    finish({highest: {answer: "B", percentage: 67}}); await flush();
    assert.equal(b.clicks, 0);
    h.window.emit("pagehide", {});
  }
});
test("manifest resources exist and reporting worker remains read-only", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://api.iclicker.com/*"]);
  for (const script of [...manifest.content_scripts.flatMap(item => item.js), manifest.background.service_worker, "popup.js"]) {
    new vm.Script(read(script), {filename: script});
    assert.doesNotMatch(read(script), /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']|setInterval\s*\(/);
    if (script !== "content.js") assert.doesNotMatch(read(script), /\.click\s*\(/);
  }
  assert.ok(fs.existsSync(path.join(root, manifest.action.default_popup)));
});
