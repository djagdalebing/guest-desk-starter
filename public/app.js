const $ = id => document.getElementById(id);
let filter = 'open', records = [], recommendation = undefined, busy = false;

// Same priority the backend uses to recommend: open work first, then urgency
// (urgent, normal, low), then the oldest request, then ascending id for an exact tie.
const URGENCY_RANK = { urgent: 0, normal: 1, low: 2 };
const byPriority = (a, b) =>
  (Number(a.status === 'resolved') - Number(b.status === 'resolved')) ||
  ((URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3)) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function renderNext() {
  const panel = $('next-panel'), bodyEl = $('next-body'), reasonEl = $('next-reason'), btn = $('next-handle');
  btn.hidden = true; btn.disabled = busy; panel.classList.remove('is-empty');
  if (recommendation === undefined) {
    bodyEl.textContent = !$('error').hidden ? 'Recommendation unavailable. Refresh to try again.' : 'Finding the next request…';
    reasonEl.textContent = '';
    return;
  }
  if (!recommendation.request) {
    panel.classList.add('is-empty');
    bodyEl.textContent = 'No open request to recommend.';
    reasonEl.textContent = recommendation.reason;
    return;
  }
  const r = recommendation.request;
  bodyEl.replaceChildren(
    text('strong', r.title),
    text('span', ` ${r.guest} · Room ${r.room}`, 'next-who'),
    text('span', r.urgency, `pill ${r.urgency}`)
  );
  reasonEl.textContent = recommendation.reason;
  btn.hidden = false;
  btn.setAttribute('aria-label', `Mark handled: ${r.title}`);
}

function render() {
  const shown = records.filter(item => filter === 'all' || item.status === filter).toSorted(byPriority);
  const nextId = recommendation?.request?.id;
  // Aging flag: the oldest open request is the one strict urgency-first priority starves.
  // Surfacing it lets the operator override when something has waited too long.
  const oldestId = records.filter(item => item.status === 'open')
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]?.id;
  $('requests').replaceChildren(...shown.map(item => {
    const card = document.createElement('article'); card.className = 'request';
    const body = document.createElement('div');
    if (item.id === nextId) { card.classList.add('recommended'); body.append(text('span', 'NEXT', 'next-badge')); }
    else if (item.id === oldestId) { card.classList.add('aging'); body.append(text('span', 'LONGEST WAIT', 'aging-badge')); }
    body.append(text('h3', item.title), text('p', item.detail));
    const meta = text('p', '', 'meta');
    meta.append(text('span', `${item.guest} · Room ${item.room}`), text('span', item.urgency, `pill ${item.urgency}`));
    if (item.status === 'resolved') meta.append(text('span', 'Handled', 'pill resolved'));
    meta.append(text('time', new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'));
    body.append(meta);
    const button = text('button', item.status === 'open' ? 'Mark handled' : 'Reopen', 'handle');
    button.type = 'button'; button.disabled = busy; button.setAttribute('aria-label', `${button.textContent}: ${item.title}`);
    button.addEventListener('click', () => update(item));
    card.append(text('span', item.guest[0], 'guest-icon'), body, button);
    return card;
  }));
  const open = records.filter(item => item.status === 'open').length;
  $('open-count').textContent = `${open} open`; $('nav-count').textContent = open;
  $('empty').hidden = busy || !$('error').hidden || shown.length > 0;
  $('empty').textContent = filter === 'resolved' ? 'Handled requests will appear here.' : 'All caught up. Your guests are in good hands.';
  $('refresh').disabled = busy;
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  renderNext();
}

function showError(error) {
  $('error').textContent = error.name === 'TimeoutError' ? 'The request took too long. Refresh the inbox to check its current state.' : error instanceof TypeError ? 'We could not reach the inbox. Check your connection, then refresh.' : error.message;
  $('error').hidden = false;
}

async function load() {
  if (busy) return;
  busy = true; $('status').textContent = 'Refreshing your inbox…'; $('error').hidden = true; recommendation = undefined; render();
  try {
    records = (await api('/api/requests')).requests;
    recommendation = await api('/api/next-request');
  } catch (error) { showError(error); }
  finally { busy = false; $('status').textContent = ''; render(); }
}

async function update(item) {
  if (busy) return;
  const wasOpen = item.status === 'open';
  busy = true; $('error').hidden = true; render();
  try {
    await api(`/api/requests/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status: wasOpen ? 'resolved' : 'open' }) });
    records = (await api('/api/requests')).requests;
    recommendation = await api('/api/next-request');
    $('status').textContent = wasOpen ? 'Request marked handled.' : 'Request reopened.';
  } catch (error) { showError(error); }
  finally { busy = false; render(); }
}

$('next-handle').addEventListener('click', () => { if (recommendation?.request && !busy) update(recommendation.request); });
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
$('refresh').addEventListener('click', load);
void load();
