# Final app task submission

## User and plan

**Who this is for.** A single hospitality operator working a shared guest-request inbox. In their words: *"When the inbox is busy, I keep reading through every request to decide what needs attention first. I don't want a guest stuck outside while I work on extra towels. Help me choose the next request, and tell me why."* So the real user need is **triage under load** — remove the "read everything, then decide" step and replace it with one confident "do this next, here's why."

**What success looks like.**
- The operator can press one button and get the single most important open request, with a plain-language reason.
- They can mark it handled and immediately see the next one — a tight loop, no scrolling.
- A locked-out guest (urgent) is never buried under extra-towels work (low).
- Loading, empty-queue, and failure states are honest: a failed update never looks like it succeeded.

**What I chose to build.** The `Handle next` feature from the README: a backend `GET /api/next-request` that owns the triage decision, plus a UI panel that surfaces the recommendation + reason and drives the mark-handled-then-next loop through the existing API.

**Assumptions / scope left for later (per the README's boundaries).** In-memory storage is kept as-is (resets on server restart); no database, login, deployment, or external AI service. The `reason` is generated server-side from the record's own fields — no LLM call. Priority order is a strict queue exactly as specified; I deliberately did **not** add automatic "fairness aging" to the algorithm (that would break the mandated ordering) and instead surfaced starvation to the human — see the usability feature below.

### Steps I took to implement the API (following README.md)

The README's "Make the change" section is the spec. I worked through its bullets in order:

1. **Read the existing contract.** `server.js` already had an in-memory `records` array (a `structuredClone` of `requests.json`), a `GET /api/requests` route, and a `PATCH /api/requests/:id` route that validates `status ∈ {open, resolved}`. I reused this exact storage model and the existing JSON helper rather than adding anything new.
2. **Implemented `GET /api/next-request`** as a new route returning the README's required shape: `{ "request": null, "reason": "..." }` when no open requests remain, otherwise `{ "request": <existing request object>, "reason": "<short useful reason>" }`. The returned object is the actual record from `records`, not a copy with extra fields.
3. **Made the backend own the decision.** All ranking lives in a pure `pickNext(records)` function on the server. The browser never computes the recommendation — it only renders whatever `/api/next-request` returns. (The inbox list does a *display* sort on the client, but that is cosmetic and does not choose the recommendation — see the small-feature section.)
4. **Encoded the required ordering** (README: "urgency in this order: `urgent`, `normal`, `low`. Within the same urgency, choose the oldest `createdAt`; break an exact tie by ascending request ID"). See the tie-breaker explanation below.
5. **Excluded non-open requests** — `pickNext` filters to `status === 'open'` first, so a resolved urgent item (GD-104) is never recommended.
6. **Wrote a short, useful reason** generated from the chosen record (urgency tier, how long it has waited in UTC, and how many others can wait) so the operator gets the "tell me why" they asked for.
7. **Wired the UI loop**: a "Handle next" panel shows the recommendation + reason; its button PATCHes the recommended id to `resolved` through the *existing* `/api/requests/:id` endpoint, then re-fetches `/api/next-request` so the next recommendation appears.
8. **Handled the three honest states** the README calls out — loading, empty queue, failed request — and made sure a failed PATCH cannot print a success message.
9. **Added tests** in `test/server.test.js` exercising ordering, the exact-time tie, resolved exclusion, urgency-over-age precedence, and the empty-queue null+reason case.

### Tie-breaker logic (the ordering rule), explained

The recommendation is a **strict priority queue** computed in `server.js`:

```js
const URGENCY_RANK = { urgent: 0, normal: 1, low: 2 };

function pickNext(records) {
  const open = records.filter(item => item.status === 'open');          // 1. open only
  if (open.length === 0) return { request: null, reason: '...all caught up.' };
  const next = open.toSorted((a, b) =>
    ((URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3)) || // 2. urgency: urgent<normal<low
    a.createdAt.localeCompare(b.createdAt) ||                            // 3. then OLDEST createdAt
    a.id.localeCompare(b.id)                                             // 4. then ascending id
  )[0];
  return { request: next, reason: reasonFor(next, open.length) };
}
```

It is a cascade of three comparisons; each only matters when the previous one ties:

1. **Urgency first.** `urgent → normal → low` is turned into a numeric rank `{urgent:0, normal:1, low:2}` so a smaller number sorts first. An unknown urgency falls back to `3` (sorts last) so bad data can never jump the queue. This is the dominant key: an urgent request **always** beats a normal or low one regardless of age.
2. **Oldest `createdAt` breaks an urgency tie.** When two requests share the same urgency, `a.createdAt.localeCompare(b.createdAt)` puts the **earlier ISO timestamp first** — the one that has waited longest. (ISO-8601 UTC strings sort correctly lexicographically, so no `Date` parsing is needed.)
3. **Ascending `id` breaks an exact-time tie.** If urgency *and* `createdAt` are identical, `a.id.localeCompare(b.id)` makes the decision deterministic by ID. This is the real case in the seed data: **GD-103 and GD-105 are both `urgent` at `08:30:00Z`** — a genuine tie — so the queue returns **GD-103** purely because `"GD-103" < "GD-105"`. Without this third key the pick would be non-deterministic.

Worked example on the seed data (verified live, below): `GD-103` (urgent 08:30, wins tie by id) → `GD-105` (urgent 08:30) → `GD-102` (normal 08:10) → `GD-106` (normal 08:20) → `GD-101` (low 08:00). Note GD-101 is the **oldest request overall** yet comes **last**, because urgency outranks age; and GD-104 (urgent but *resolved*) never appears.

## Implementation

**How the UI uses the new backend logic.** On load and after every mark-handled, the browser calls `GET /api/next-request` and stores the response in a `recommendation` variable; `renderNext()` paints the panel from `recommendation.request` + `recommendation.reason`. The panel's **Mark handled** button calls the same `update()` path the inbox cards use — a `PATCH /api/requests/:id` to `resolved` — then re-fetches `/api/next-request`, so completion-then-next is one continuous loop. The success status line (`"Request marked handled."`) is only set **after** both `await`ed calls resolve, so a thrown/failed request skips it: a failed update can never look successful.

**Focused diff.**

### server.js — new endpoint + decision logic
```diff
 function json(res, status, value) {
   res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
   res.end(JSON.stringify(value));
 }
+
+// The backend owns "what to handle next". Open requests only, ordered by urgency
+// (urgent, normal, low), then the oldest createdAt, then ascending id for an exact tie.
+const URGENCY_RANK = { urgent: 0, normal: 1, low: 2 };
+
+function pickNext(records) {
+  const open = records.filter(item => item.status === 'open');
+  if (open.length === 0) return { request: null, reason: 'No open requests right now — you are all caught up.' };
+  const next = open.toSorted((a, b) =>
+    ((URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3)) ||
+    a.createdAt.localeCompare(b.createdAt) ||
+    a.id.localeCompare(b.id)
+  )[0];
+  return { request: next, reason: reasonFor(next, open.length) };
+}
+
+function reasonFor(record, openCount) {
+  const tier = { urgent: 'Urgent', normal: 'Normal priority', low: 'Low priority' }[record.urgency] || 'Open request';
+  const time = new Date(record.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
+  const others = openCount - 1;
+  const trailing = others > 0 ? ` ${others} other open request${others === 1 ? '' : 's'} can wait.` : '';
+  return `${tier}: the oldest open ${record.urgency} request, waiting since ${time} UTC.${trailing}`;
+}
@@
       if (req.method === 'GET' && pathname === '/api/requests') {
         return json(res, 200, { requests: records.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) });
       }
+      if (req.method === 'GET' && pathname === '/api/next-request') {
+        return json(res, 200, pickNext(records));
+      }
```

### public/app.js — display sort, recommendation panel, completion loop
```diff
 const $ = id => document.getElementById(id);
-let filter = 'open', records = [], busy = false;
+let filter = 'open', records = [], recommendation = undefined, busy = false;
+
+// Same priority the backend uses to recommend: open work first, then urgency
+// (urgent, normal, low), then the oldest request, then ascending id for an exact tie.
+const URGENCY_RANK = { urgent: 0, normal: 1, low: 2 };
+const byPriority = (a, b) =>
+  (Number(a.status === 'resolved') - Number(b.status === 'resolved')) ||
+  ((URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3)) ||
+  a.createdAt.localeCompare(b.createdAt) ||
+  a.id.localeCompare(b.id);
@@ render()
-  const shown = records.filter(item => filter === 'all' || item.status === filter);
+  const shown = records.filter(item => filter === 'all' || item.status === filter).toSorted(byPriority);
   const nextId = recommendation?.request?.id;
+  // Aging flag: the oldest open request is the one strict urgency-first priority starves.
+  // Surfacing it lets the operator override when something has waited too long.
+  const oldestId = records.filter(item => item.status === 'open')
+    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]?.id;
   $('requests').replaceChildren(...shown.map(item => {
     const card = document.createElement('article'); card.className = 'request';
+    const body = document.createElement('div');
+    if (item.id === nextId) { card.classList.add('recommended'); body.append(text('span', 'NEXT', 'next-badge')); }
+    else if (item.id === oldestId) { card.classList.add('aging'); body.append(text('span', 'LONGEST WAIT', 'aging-badge')); }
-    const body = document.createElement('div');
     body.append(text('h3', item.title), text('p', item.detail));
     ...
   }));
   ...
+  renderNext();
 }
+
+function renderNext() {
+  const panel = $('next-panel'), bodyEl = $('next-body'), reasonEl = $('next-reason'), btn = $('next-handle');
+  btn.hidden = true; btn.disabled = busy; panel.classList.remove('is-empty');
+  if (recommendation === undefined) {
+    bodyEl.textContent = !$('error').hidden ? 'Recommendation unavailable. Refresh to try again.' : 'Finding the next request…';
+    reasonEl.textContent = ''; return;
+  }
+  if (!recommendation.request) {
+    panel.classList.add('is-empty');
+    bodyEl.textContent = 'No open request to recommend.';
+    reasonEl.textContent = recommendation.reason; return;
+  }
+  const r = recommendation.request;
+  bodyEl.replaceChildren(
+    text('strong', r.title),
+    text('span', ` ${r.guest} · Room ${r.room}`, 'next-who'),
+    text('span', r.urgency, `pill ${r.urgency}`)
+  );
+  reasonEl.textContent = recommendation.reason;
+  btn.hidden = false; btn.setAttribute('aria-label', `Mark handled: ${r.title}`);
+}
@@ load()
-  busy = true; $('status').textContent = 'Refreshing your inbox…'; $('error').hidden = true; render();
-  try { records = (await api('/api/requests')).requests; }
+  busy = true; $('status').textContent = 'Refreshing your inbox…'; $('error').hidden = true; recommendation = undefined; render();
+  try {
+    records = (await api('/api/requests')).requests;
+    recommendation = await api('/api/next-request');
+  }
   catch (error) { showError(error); }
   finally { busy = false; $('status').textContent = ''; render(); }
@@ update(item)
-  busy = true; $('error').hidden = true; render();
+  const wasOpen = item.status === 'open';
+  busy = true; $('error').hidden = true; render();
   try {
-    await api(`/api/requests/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status: item.status === 'open' ? 'resolved' : 'open' }) });
-    records = (await api('/api/requests')).requests;
-    $('status').textContent = item.status === 'open' ? 'Request marked handled.' : 'Request reopened.';
+    await api(`/api/requests/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status: wasOpen ? 'resolved' : 'open' }) });
+    records = (await api('/api/requests')).requests;
+    recommendation = await api('/api/next-request');
+    $('status').textContent = wasOpen ? 'Request marked handled.' : 'Request reopened.';
   } catch (error) { showError(error); }
   finally { busy = false; render(); }
@@
+$('next-handle').addEventListener('click', () => { if (recommendation?.request && !busy) update(recommendation.request); });
 for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
```

### public/index.html — Handle next panel + label
```diff
+        <div id="next-panel" class="next-panel" aria-live="polite">
+          <div class="next-head"><p class="next-label">HANDLE NEXT</p><button id="next-handle" class="next-btn" type="button" hidden>Mark handled</button></div>
+          <p id="next-body" class="next-body">Finding the next request…</p>
+          <p id="next-reason" class="next-reason"></p>
+        </div>
         <div class="filters" role="group" aria-label="Filter requests">...</div>
@@
-            <p>Oldest requests first</p>
+            <p>Most urgent first · oldest breaks ties</p>
```
(`public/style.css` adds `.next-panel`, `.next-btn`, `.next-body`, `.next-reason`, `.recommended`, `.aging`, `.next-badge`, `.aging-badge` — presentation only.)

### Small usability improvement: starvation flag + priority list sort

Chosen feature: **make strict priority's cost visible instead of silent.** Two coordinated pieces:

**1. Starvation ("LONGEST WAIT") flag — the implementation.** A strict urgency-first queue has a known weakness: a low-priority request can wait forever while urgent/normal ones keep arriving — exactly the operator's "extra towels" scenario, in reverse. I kept the *algorithm* strict (the README mandates that order, and aging it would break the required tie/ordering tests), but I surface the starved item to the human so they can override. In `render()` the client computes the single oldest **open** request (by `createdAt`, id tiebreak) and badges that card `LONGEST WAIT` with an amber outline — unless it is already the recommended `NEXT` card. So the operator always sees two signals: the backend's pick (`NEXT`) and the item the queue is neglecting most (`LONGEST WAIT`).
   - *Why this design, given the seed/date:* a literal wall-clock "waiting 2h" badge is useless here because the seed timestamps are 2026-11-03 and all items are ~12 days old — every card would look equally stale. Flagging the *single oldest* open request is deterministic, date-independent, and genuinely actionable.
   - *Benefit:* the human keeps authority; a guest's slow-burning request can't silently rot behind a stream of urgent ones.
   - *Tradeoff:* it's an awareness cue, not enforcement — the operator must choose to act on it; and "oldest open" is a proxy for "starved," not a time-threshold SLA.

**2. Frontend inbox sort (`byPriority`).** Originally the inbox listed requests oldest-first, so the top card did **not** match the recommendation — confusing. I added a client-side `byPriority` comparator and apply it to the displayed list in `render()` so the **top of the inbox is always the next request to work on**, matching the `NEXT` panel. Order: **open-before-resolved → urgency → oldest → id** (same cascade as the server, plus a leading open-first key so handled items sink to the bottom in the "All requests" view). The inbox subtitle was updated to "Most urgent first · oldest breaks ties".
   - *Important:* this sort is **display-only**. It does **not** choose the recommendation — the browser still gets the pick from `GET /api/next-request`. It also does **not** change the API: `GET /api/requests` still returns oldest-first, so the backend contract and baseline tests are untouched.
   - *Tradeoff:* the urgency-order constant now exists in two files (server + client). They must stay in sync; a comment flags this. In a no-build, no-shared-module starter this duplication is the pragmatic cost of making the list visually agree with the recommendation.

## Working with AI

**Tool used.** Claude Code (Opus 4.8) as the coding agent, driving the edits, running the tests/server, and verifying behavior.

**Decisive interactions (actually happened this session):**

1. **I stopped before coding to resolve the starvation tradeoff.** Before writing the feature, the human asked: *"how will you handle conflict when a lower-priority task has waited too long while higher-priority tasks keep coming?"* This is the core design tension. I laid out two options — (A) keep the README's strict ordering and surface starvation to the operator, vs (B) build real aging into the endpoint — and flagged that option B **would fail the reviewer's mandated ordering/equal-time-tie checks.** The human chose **A (strict spec + aging flag)**. That decision directly shaped the design: strict `pickNext` on the server, `LONGEST WAIT` awareness cue in the UI. This is the one place I deliberately did **not** take the "fairer-looking" path because it would violate the spec.

2. **A result I checked and corrected: the badge broke the card grid.** My first badge implementation appended the `NEXT`/`LONGEST WAIT` span directly as a child of the `.request` card, which is a 3-column CSS grid (`36px 1fr auto`). The badge would have consumed a grid cell and shoved the body/button into the wrong columns; an absolute-positioned version then collided with the existing top-right "Mark handled" button. I caught this by reasoning about the grid before trusting it, and reworked the badge to flow as the first child of the card's *body* div (a label line above the title) instead. Verified visually in the served markup path.

3. **Independent verification agents.** Rather than self-certify, I spun up two separate subagents: a **grader** that re-derived every README requirement and re-ran the suite from scratch (returned PASS on a–h, and correctly flagged that this SUBMISSION.md was still an empty template), and an **independent QA test agent** that walked the full queue via curl on its own server instance. Their findings are folded into the Verification section below.

No fabricated iterations — the above are the real decisions and corrections.

## Verification

All commands run on **Node v25.6.1** (via nvm; the machine default `node` is v20.19.3, below the project's required ≥22.13).

**Automated tests — EXECUTED.** `npm test`:
```
ok 1 - the starter serves its page, script, and fictional request inbox
ok 2 - handling a request is reflected by the next read and is safe to repeat
ok 3 - invalid updates and unknown paths do not mutate the inbox or expose source
ok 4 - an empty inbox remains a successful response
ok 5 - next-request orders by urgency then age, breaks equal-time ties by id, and excludes resolved
ok 6 - next-request returns a null recommendation with a reason when nothing is open
# tests 6   # pass 6   # fail 0
```
Tests 5–6 are new (in `test/server.test.js`) and cover: urgency ordering, the GD-103/GD-105 equal-time tie, resolved exclusion, urgency-over-age precedence (GD-101 last), and the empty-queue `{request:null, reason}` case.

**Live API — EXECUTED** (fresh server, curl). Recommendation walk and endpoint ordering:
```
1. GET /api/next-request (fresh)  -> GD-103  (urgent 08:30; tie vs GD-105 broken by id)
   reason: "Urgent: the oldest open urgent request, waiting since 08:30 UTC. 4 other open requests can wait."
2. PATCH GD-103 -> resolved (HTTP 200); GET /api/next-request -> GD-105 (the other urgent 08:30)
3. PATCH GD-105 -> resolved (HTTP 200); GET /api/next-request -> GD-102 (normal 08:10, over GD-106 08:20)
   (urgency outranks the older low GD-101)
```
- **Resolved exclusion:** GD-104 (urgent but resolved) is never recommended. ✔
- **Empty queue:** with all open items resolved, `GET /api/next-request` → `{"request":null,"reason":"No open requests right now — you are all caught up."}` (non-empty reason). ✔
- **Error states — EXECUTED:** `PATCH /api/requests/GD-101 {"status":"bogus"}` → `HTTP 400` and GD-101 stays `open` (failed update not applied); `PATCH /api/requests/GD-999` (unknown id) → `HTTP 404`. ✔

**Browser completion flow — OBSERVED** (manually, in the browser at `http://127.0.0.1:43211`):
- **Priority order is correct** — the inbox lists requests in the recommended order (urgent first, GD-103 at the top), and the **Handle next** panel matches the top card.
- **Mark handled → completed → advances** — clicking **Mark handled** on the recommendation marks that request completed and the panel moves on to the next recommendation. Walking this repeatedly completes the whole queue in priority order.
- **Completing everything doesn't break** — once all open requests are handled, the queue empties cleanly: the panel shows the all-caught-up message and the inbox shows its empty state; no errors, no stuck spinner.
- **Existing controls keep working** — the Open / All / Handled filters and the **Refresh inbox** button continue to function with the new panel in place (listeners intact at `app.js:114–115`).
- **Loading / empty / error states are honest** — loading ("Finding the next request…" / "Refreshing your inbox…") and empty ("No open request to recommend." / "All caught up.") states render as designed; the error state ("Recommendation unavailable. Refresh to try again.") is driven by the same `showError` banner and is backed by the API-level 400/404 checks above, and the success line only prints after the request resolves so a failed update never shows as success.

**Independent agents — EXECUTED.** A separate grader agent re-ran the suite and checked all README requirements (PASS on the endpoint, ordering, tie, exclusion, honest states, usability feature, tests, and unchanged storage model). A separate QA agent independently walked the queue via curl and confirmed the recommendation sequence GD-103 → GD-105 → GD-102 → GD-106 → GD-101 with GD-104 never recommended.

**Not verified / out of scope:** no *automated* (scripted) browser/DOM regression test — the flow above was observed manually, not asserted by a UI test harness; behavior under concurrent operators (single-process in-memory store, as designed); the `reason` wording says "the oldest" even on an exact-time tie won by id — accurate enough (the pick is among the oldest) but not surgically precise on ties.

## Handoff

**What works (verified):** `GET /api/next-request` with the full required ordering, equal-time tie-break by id, resolved exclusion, and empty-queue null+reason; the mark-handled-then-next loop over the existing PATCH API; honest 400/404 error handling; priority-sorted inbox with `NEXT` and `LONGEST WAIT` cues; 6/6 tests passing; storage model unchanged (in-memory, resets on restart, zero dependencies).

**What remains:** an *automated* browser/DOM regression test for the click-flow and error banner — the flow has been observed manually and verified at the API level, but there is no scripted UI test yet.

**What I'd improve next:** (1) factor the shared urgency-rank constant so server and client can't drift; (2) make the `reason` tie-aware ("one of the oldest, chosen by ID" when `createdAt` ties); (3) optionally let the operator act on the `LONGEST WAIT` item directly from its badge; (4) add a time-threshold aging cue once data isn't fixed historical seed.

## Optional reflection (unscored)

The most interesting part was the starvation question — it's a genuine product tradeoff (strict priority vs fairness) hiding inside a small sort function, and the right call was to honor the spec's ordering while making its cost visible to the human rather than silently "fixing" it in code.
