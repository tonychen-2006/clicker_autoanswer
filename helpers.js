(() => {
  "use strict";
  const defaults = Object.freeze({enabled: true, autoAnswer: true, interval: 3, showPercentage: true});
  const validId = value => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
  const normalizeSettings = value => ({
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    autoAnswer: typeof value?.autoAnswer === "boolean" ? value.autoAnswer : defaults.autoAnswer,
    interval: [2, 3, 5].includes(value?.interval) ? value.interval : defaults.interval,
    showPercentage: typeof value?.showPercentage === "boolean" ? value.showPercentage : defaults.showPercentage
  });

  function getAutoAnswerChoices(highest) {
    if (typeof highest?.answer !== "string" ||
        !/^[A-E](?: \/ [A-E]){0,4}$/.test(highest.answer) ||
        typeof highest.percentage !== "number" || !Number.isFinite(highest.percentage) ||
        highest.percentage <= 0 || highest.percentage > 100) return [];
    return [...new Set(highest.answer.split(" / "))].sort();
  }

  function getHighestResponse(answerOverview) {
    if (!Array.isArray(answerOverview)) return null;
    const choices = new Map();
    for (const entry of answerOverview) {
      if (typeof entry?.answer !== "string") continue;
      const answer = entry.answer.trim().toUpperCase();
      const percentage = entry.percentageOfTotalResponses;
      // This helper deliberately supports single-letter choices only.
      if (!/^[A-E]$/.test(answer) || typeof percentage !== "number" ||
          !Number.isFinite(percentage) || percentage < 0 || percentage > 100) continue;
      choices.set(answer, Math.max(choices.get(answer) ?? -1, percentage));
    }
    if (!choices.size) return null;
    const percentage = Math.max(...choices.values());
    if (percentage === 0) return null;
    const answers = [...choices].filter(([, value]) => value === percentage)
      .map(([answer]) => answer).sort();
    return {answer: answers.join(" / "), percentage};
  }

  function getQuestion(payload, questionId) {
    const questions = payload?.data?.questions ?? payload?.questions;
    if (!Array.isArray(questions)) return {error: "schema"};
    // Never use the last array item: reporting order may differ from live order.
    const question = questions.find(item => (item?.questionId ?? item?._id) === questionId);
    if (!question) return {waiting: true};
    if (question.answerOverview == null) return {error: "schema"};
    if (!Array.isArray(question.answerOverview)) return {error: "schema"};
    if (question.answerOverview.length && !question.answerOverview.some(item =>
      /^[A-E]$/i.test(item?.answer ?? "") && typeof item?.percentageOfTotalResponses === "number" &&
      Number.isFinite(item.percentageOfTotalResponses) && item.percentageOfTotalResponses >= 0 &&
      item.percentageOfTotalResponses <= 100)) return {error: "schema"};
    return {highest: getHighestResponse(question.answerOverview)};
  }

  // A single recursive timeout; a stopped generation can never schedule another poll.
  function createPoller(task, delay, timers = globalThis) {
    let generation = 0;
    let timer = null;
    let running = false;
    let busy = false;
    async function run(current) {
      if (!running || current !== generation) return;
      if (busy) {
        timer = timers.setTimeout(() => run(current), 50);
        return;
      }
      busy = true;
      try { await task(() => running && current === generation); }
      finally {
        busy = false;
        if (running && current === generation) {
          timer = timers.setTimeout(() => run(current), delay());
        }
      }
    }
    return {
      start() {
        if (running) return;
        running = true;
        void run(++generation);
      },
      stop() {
        running = false;
        generation++;
        timers.clearTimeout(timer);
        timer = null;
      }
    };
  }
  globalThis.IClickHelper = Object.freeze({defaults, validId, normalizeSettings,
    getHighestResponse, getQuestion, getAutoAnswerChoices, createPoller});
})();
