# iClick Response Helper

A Manifest V3 Chrome extension that displays the highest-response **A–E choice**, including ties, while an iClicker Student poll is live. **Automatic answering is enabled by default:** when response data is available, it activates the corresponding single-choice button, letting iClicker's own client submit the answer. Turn off **Automatically answer** in the popup for display-only operation. It does not automatically join classes. The highest-response choice is a popularity measure, not a guarantee of correctness.

The extension depends on response distributions actually being available to your logged-in client. It displays `Waiting for responses...` for empty/zero distributions or a current question not yet present in reporting. It displays `Unavailable` for missing identity/authentication, unsupported schemas, or failed requests. It hides when disabled, outside the live polling page, or when the question ends.

## Install locally

1. Open Chrome 111 or later and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the switch at the top right.
3. Choose **Load unpacked** and select this repository directory:
   `/Users/tonychen/DEV/personal/clicker_autoanswer` (the directory containing `manifest.json`).
4. Reload any existing `https://student.iclicker.com/` tab so the extension can observe the app from startup.
5. Sign in normally and manually join a live class. When a poll begins, the overlay appears at the top right.
6. Open the extension popup to enable/disable it, turn **Automatically answer** on/off, choose 2/3/5 seconds (default: 3), or hide percentages. Chrome saves these preferences locally.

After updating the extension's files, click its **Reload** button in `chrome://extensions`, then reload your iClicker tab. Version 1.1.0 adds automatic answering; existing settings without an `autoAnswer` field default to automatic answering on.

No build step, dependencies, external backend, or credentials configuration is needed. `package.json` is only for the developer tests.

## Architecture

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 registrations, `storage` permission, and only `api.iclicker.com` API host access |
| `page-state.js` | Runs in the page's MAIN world at document start; passively observes app XHR/fetch responses and Pusher WebSocket events, forwarding only course/activity/question IDs and ended state |
| `content.js` | Reads the tab's session token, detects polling routes and components, tracks question identity, manages one polling loop, updates the overlay, and activates eligible single-choice buttons when automatic answering is on |
| `helpers.js` | Pure settings/distribution/schema helpers and reusable single-timeout polling controller |
| `background.js` | Makes a constrained reporting GET using the token supplied for that request; checks HTTP/JSON/schema errors and returns the current question's highest choice |
| `popup.html`, `popup.js`, `styles.css` | Accessible settings popup and current-tab status |
| `tests/extension.test.cjs` | Dependency-free Node tests for calculations, failures, message validation, lifecycle, bridge, and stale-response rejection |

The overlay uses private shadow styling. All reporting requests made by the worker are GETs to the one constructed reporting path; automatic answering activates an iClicker button, which makes the app's normal answer-submission request. The worker rejects messages from unrelated pages and never accepts an arbitrary fetch URL. Tokens are used in memory for reporting requests and are never saved by the extension, logged, sent through the page bridge, or forwarded to third parties. Logs use `[iClick Helper]` and include API statuses, unexpected schema keys, session availability, highest-response changes, and activated answer choices.

The bridge is an observation mechanism within the existing page, not an authentication boundary. It does not evaluate arbitrary page code or copy raw response bodies into extension messages. Changes to browser API wrappers by iClicker or another extension can affect observation.

## Current-client inspection and compatibility

Inspected the public production client on **October 6, 2026**. The [old reference repository](https://github.com/aszaw/byeClicker) was consulted for behavior; this implementation was written independently. Automatic answering now uses the current client's single-choice controls; the reference's random/default-answer fallback and notification backend are excluded.

Verified by static inspection of these currently served assets:

- [Main bundle](https://student.iclicker.com/main.3dc42192eff1d21c.js): the app still reads/writes `sessionStorage.access_token`, configures `https://api.iclicker.com`, and receives Pusher `question`, `endQuestion`, and `MEETING_ENDED` events on `private-{courseId}` / `private-{courseId}@{userId}` channels.
- [Admin/repository bundle](https://student.iclicker.com/817.f980c9be6857853f.js): `fetchActivityResults()` calls `https://api.iclicker.com/v2/reporting/courses/{courseId}/activities/{activityId}/questions/view`. Result questions are matched by `questionId` and merged with `answerOverview`. The app retrieves live class sections from `/v2/courses/{courseId}/class-sections` or `/v3/...` depending on a feature flag; activities/questions may use `_id` before the app normalizes them.
- [Live-class bundle](https://student.iclicker.com/280.1b8cd88112c0239f.js): live polls use `/class/{courseId}/poll` and `app-poll`. Class history selects a `POLL` activity and a question with a falsy `ended` field. End events navigate to a question result route.
- [Shared question-controls bundle](https://student.iclicker.com/968.df92face68aa775c.js): `app-multiple-choice-question` renders `multiple-choice-a` through `multiple-choice-e` buttons. Their click handler calls `sendAnswer(value)`, which submits a single-choice response. Disabled/ARIA-disabled states represent pending submission or an ended question; `aria-pressed` marks the currently selected answer.

**Changes from the reference:** replaced the old `activity-service.iclicker.com/reporting/...` endpoint with the current `api.iclicker.com/v2/reporting/...`; observe current live-state responses/events instead of depending on `sessionStorage.activity`; match the exact question ID instead of using the last reporting question. The old `#/polling` route and legacy `activity` storage are supported only if a reliable question ID is present. There is no speculative fallback to the old API host.

**Not verified:** no signed-in live polling session was available during implementation. Static code establishes the current route and endpoint, but does not establish student access to response distributions during a live poll. `percentageOfTotalResponses` is retained as the requested/reference distribution contract; its presence in a live response has not been confirmed. Accepted wrappers are `data.questions` and `questions`; unrecognized structures produce `Unavailable`, with diagnostic key names. The extension does not infer percentages from other undocumented fields.

## Polling and identity

A debounced MutationObserver plus hash/popstate events detects route and UI changes. The bridge supplies current question identity from observed class history/activity responses and Pusher events. The content script rereads sessionStorage before each request so refreshed tokens can take effect. Where exposed, DOM question IDs are checked against bridge state to avoid showing an older question's result.

A single recursive timeout starts immediately on detection and runs again after the previous request finishes plus the selected delay. Calls never overlap within a tab. Question changes, settings changes, disable, route exit, question end, and pagehide invalidate pending results and stop the timer. The worker has a ten-second request timeout; a request already sent can finish after a question ends, but its result is discarded and no next poll is scheduled. Pagehide removes content listeners and observers and restores bridge wrappers when they are still owned by this extension. BFCache restoration reinstates observation.

## Automatic answering

- When enabled, the helper clicks the highest-response choice in **`app-poll app-multiple-choice-question`**. It checks that the current question still matches the reporting result immediately before acting.
- It uses the existing app button rather than implementing a separate submission API. Only visible, attached, enabled controls are eligible. It excludes group questions, multi-answer controls, quizzes, and unverified legacy controls.
- Empty/zero distributions, malformed leaders, missing identity, or API errors never trigger a choice. There is no random or default-answer fallback.
- For ties, it keeps a currently selected choice if that choice is tied for highest. Otherwise it chooses the first tied letter alphabetically.
- It avoids another click when iClicker already shows a tied/highest choice selected, and otherwise attempts a given leader once until the leader or question changes. If a submission fails, switch **Automatically answer** off/on to retry the current leader; it does not repeatedly click an unconfirmed answer.
- The overlay reports `Auto-answer attempted B` after a click and `iClicker shows B selected` after observing the app's selected state. An attempted click is not a guarantee of server acceptance; verify iClicker's own response confirmation. Automatic answering can change a previously selected answer when another choice becomes the leader.

## Verification and live test

Run `npm test` with Node 22 or later. Tests check valid JSON/resources, JavaScript syntax, leaders/ties/malformed inputs, HTTP 401/403/404 and other errors, malformed JSON, missing schemas, timer stacking/overlap, bridge IDs, overlay updates, cleanup, and stale results. Automatic-answer tests cover leader changes, ties, deduplication, disabled/hidden/ambiguous controls, the off switch, missing data, and pending results after disable/navigation/question end. The reporting worker remains read-only; only the content script activates choice buttons.

Then test with a real session:

1. Load the unpacked extension and reload iClicker before joining a live class.
2. Start with the 3-second interval. Confirm that a live poll displays the overlay, initially waiting when distribution data is empty.
3. In **Chrome DevTools → Network**, filter for `class-sections` and `activities`. Inspect response structure for the live `POLL` activity, its `_id`/`activityId`, and current question `_id`/`questionId`. In the WS filter, inspect Pusher messages for current question/end events.
4. From `chrome://extensions`, open this extension's **service worker → Inspect**. In its Network tab, filter for `questions/view` to see the extension's reporting GETs. Extension-worker requests may not appear in the page's Network tab.
5. Inspect the reporting response. Confirm the displayed answer and percentage match the **current question ID** and its `answerOverview[].percentageOfTotalResponses`. Check ties and an empty/zero distribution when possible.
6. With **Automatically answer** on, confirm that iClicker's own UI acknowledges the highest choice and its Network tab shows the app's normal submission request. Confirm unchanged leaders don't cause repeated submissions and a changed leader updates the choice. Turn automatic answering off and confirm the overlay still updates without submitting.
7. Hide percentages, change intervals, and disable/re-enable the helper. Confirm settings persist after reopening the popup and reloading the page.
8. Move to another question, end the poll, and leave the live class. Confirm the previous answer disappears, stale requests cannot update or answer it, and reporting traffic stops.
9. Check the page console and worker console for `[iClick Helper]` diagnostics. Never share tokens or unsanitized Authorization headers while troubleshooting.

## Failure modes and limitations

- **401:** sign in again or reload iClicker; the helper does not refresh credentials itself.
- **403:** the server does not permit that session to read reporting data. The helper cannot bypass that restriction. Some classes may expose statistics only after questions end, when this helper intentionally stops.
- **404:** compare the client's reporting request with the documented endpoint. If it has changed, update the worker path and the manifest host permission only after observing the actual client.
- **Malformed JSON or schema changes:** use the diagnostic key names and inspect the response. Update `getQuestion()` and `getHighestResponse()` to a verified contract; do not guess statistics or reuse another question's results.
- **Missing IDs:** reload the page after loading the extension so initial class/activity responses are observed. The helper will display `Unavailable` rather than use the last historical reporting question.
- **Pusher transport changes:** current WebSocket messages are observed. XHR/SockJS fallback transports, a changed Pusher hostname/channel format, a rewritten frontend, or changed response shapes may prevent subsequent questions/end events from being observed. Verify these in a live session before relying on the display.
- **Question types:** only single-letter A–E choices are supported. Numeric responses, multi-answer selections, target questions, and quizzes are excluded. A malformed entry is ignored when other valid entries exist; zero-only distributions are waiting.
- **Automatic-answer controls:** a changed component/button structure can leave the distribution visible while automatic answering reports controls unavailable. No generic page buttons are clicked. Group polls and the legacy `#/polling` client are display-only.
- **Submission confirmation:** the extension observes the app's selected state but does not independently validate server acceptance. A failed attempt is not continuously retried; toggle automatic answering off/on to retry. Confidence ratings are left to you.
- **Timing:** refresh cadence is the selected delay after request completion, not an exact wall-clock interval. Chrome may throttle inactive tabs. HTTP failures retry on that same cadence while the question remains active.
- **Status:** the popup reports the current tab when opened or when settings change; it is not a live streaming monitor.
- **Browser validation:** automated tests use simulated Chrome/DOM/network APIs. Actual Chrome installation, layout, authenticated requests, server-required headers, and instructor-specific access remain to be checked using the steps above. If the server requires additional headers such as `Client-Tag`, inspect the client's request and add only verified requirements.
