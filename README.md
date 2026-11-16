# Guest desk: final technical prompting task

Use AI to extend a small working app for a hospitality operator. Show how you turn a user need into a focused change, guide your AI tool, and check what it actually produced. This is one final submission. Aim to spend about 25 minutes.

## Start the app

You need Node 22.13 or newer and an AI coding tool you can use locally. The starter has no package dependencies, API keys, or installation step.

1. Extract the starter archive and open `guest-desk-starter` in your coding tool.
2. Run `npm start` in that directory.
3. Open `http://127.0.0.1:43211`.
4. Run `npm test` to check the working baseline.

If the port is occupied, run `PORT=43212 npm start`. On Windows PowerShell, run `$env:PORT=43212; npm start`.

The inbox loads fictional requests from a Node HTTP API. You can filter requests and mark them handled. Changes survive a browser refresh and reset when the server restarts. Keep that storage model for this task. If you cannot run the starter within a few minutes, stop setup, continue with the parts you can do (plan, code changes, test plan), and describe the limitation in the Verification section of your submission.

## The user need

An operator says: "When the inbox is busy, I keep reading through every request to decide what needs attention first. I don't want a guest stuck outside while I work on extra towels. Help me choose the next request, and tell me why."

Before generating code, write a short plan: who you are helping, what success looks like, what you will change, and what you will leave for later. Ask clarifying questions or state reasonable assumptions. You may use any AI coding tool. Keep a short record of the prompts and decisions that shaped your work.

## Make the change

Add a **Handle next** feature that connects the UI to new backend logic:

- Implement `GET /api/next-request`. Return `{ "request": null, "reason": "..." }` when no open requests remain. Otherwise return an existing request object and a short, useful `reason`.
- Recommend only open requests. Use urgency in this order: `urgent`, `normal`, `low`. Within the same urgency, choose the oldest `createdAt`; break an exact tie by ascending request ID.
- Make the backend own that decision. The browser must use the endpoint's response.
- Show the recommendation and its reason clearly. Let the operator mark it handled through the existing API, then see the next recommendation.
- Handle loading, an empty queue, and a failed request honestly. Keep existing inbox controls working. A failed update must not appear successful.

Choose one small usability improvement you believe this operator would appreciate. Explain the benefit and the tradeoff. Focus on the core flow before adding polish or extra features. An external AI service, login system, deployment, and durable database are outside this exercise.

`server.js` owns the API and serves the page. `requests.json` is the starting data. `public/app.js`, `public/index.html`, and `public/style.css` own the interface. `test/server.test.js` checks existing behavior; add checks that exercise your new behavior.

## Verify and submit

Use [SUBMISSION.md](SUBMISSION.md) as your answer outline. Submit your short plan, a patch or a reviewer-accessible code link, the important AI interactions, and actual verification results in **Review & submit** in the interview. The answer box accepts up to 30,000 characters; keep the diff focused. A local path alone is not a usable handoff. Include the relevant code as a diff if your link requires access the reviewer does not have.

Check the API's ordering, equal-time tie, resolved-item exclusion, and empty queue. Check the browser flow from recommendation to completion and the error state. Report commands run, observed results, and anything you did not verify. Expected results without execution must be labeled as a test plan.

The in-interview Exercise assistant can discuss the task and inspect copies of the starter files. It cannot edit or run your local app. Its chat is saved automatically; interactions with your own coding tool must be included in your handoff.

## How your work is reviewed

Human reviewers assess organization of ideas, attention to the operator's needs, effective AI collaboration, functional integration, and verification. They look at concrete decisions, code, prompts, and results. Prompt count, writing style, visible excitement, and how much you claim to enjoy programming do not earn points.

You may briefly describe what you enjoyed or found frustrating and what you would improve next. This reflection is optional and unscored.
