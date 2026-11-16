import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarterServer } from '../server.js';

async function fixture(t, options) {
  const server = createStarterServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

test('the starter serves its page, script, and fictional request inbox', async t => {
  const call = await fixture(t);
  assert.match(await (await call('/')).text(), /Small requests/);
  assert.match((await call('/app.js')).headers.get('content-type'), /javascript/);
  const response = await call('/api/requests');
  assert.equal(response.status, 200);
  const { requests } = await response.json();
  assert.equal(requests.length, 6);
  assert.equal(requests.filter(item => item.status === 'open').length, 5);
});

test('handling a request is reflected by the next read and is safe to repeat', async t => {
  const call = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const response = await call('/api/requests/GD-103', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
    assert.equal(response.status, 200);
  }
  assert.equal((await (await call('/api/requests')).json()).requests.find(item => item.id === 'GD-103').status, 'resolved');
  const other = await fixture(t);
  assert.equal((await (await other('/api/requests')).json()).requests.find(item => item.id === 'GD-103').status, 'open');
});

test('invalid updates and unknown paths do not mutate the inbox or expose source', async t => {
  const call = await fixture(t);
  for (const body of ['null', '{}', 'not-json', '{"status":"missing"}']) assert.equal((await call('/api/requests/GD-103', { method: 'PATCH', body })).status, 400);
  assert.equal((await call('/api/requests/GD-999', { method: 'PATCH', body: '{"status":"resolved"}' })).status, 404);
  assert.equal((await call('/server.js')).status, 404);
  assert.equal((await call('/package.json')).status, 404);
  assert.equal((await call('/api/requests/GD-103', { method: 'PATCH', body: ' '.repeat(4097) })).status, 413);
});

test('an empty inbox remains a successful response', async t => {
  const call = await fixture(t, { requests: [] });
  assert.deepEqual(await (await call('/api/requests')).json(), { requests: [] });
});

test('next-request orders by urgency then age, breaks equal-time ties by id, and excludes resolved', async t => {
  const call = await fixture(t);
  const next = async () => (await (await call('/api/next-request')).json());

  // GD-103 and GD-105 are both urgent at 08:30; the exact-time tie breaks by ascending id.
  // GD-104 is urgent but resolved, so it is never recommended.
  let body = await next();
  assert.equal(body.request.id, 'GD-103');
  assert.equal(body.request.urgency, 'urgent');
  assert.equal(typeof body.reason, 'string');
  assert.ok(body.reason.length > 0);

  // Resolve GD-103 -> the other equal-time urgent request surfaces.
  await call('/api/requests/GD-103', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  assert.equal((await next()).request.id, 'GD-105');

  // No urgent left -> normal before low; oldest normal (GD-102 at 08:10) over GD-106 (08:20).
  await call('/api/requests/GD-105', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  assert.equal((await next()).request.id, 'GD-102');

  // Urgency outranks age: GD-101 (low, 08:00) is the oldest open item but comes last.
  await call('/api/requests/GD-102', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  assert.equal((await next()).request.id, 'GD-106');
  await call('/api/requests/GD-106', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  assert.equal((await next()).request.id, 'GD-101');
});

test('next-request returns a null recommendation with a reason when nothing is open', async t => {
  const call = await fixture(t, { requests: [] });
  const body = await (await call('/api/next-request')).json();
  assert.equal(body.request, null);
  assert.equal(typeof body.reason, 'string');
  assert.ok(body.reason.length > 0);
});
