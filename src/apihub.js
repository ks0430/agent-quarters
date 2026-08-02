// In-memory correlation between customer API calls and each instance's
// long-poll tunnel. A customer request is queued for an instance; the host's
// held GET picks it up; the host POSTs deltas/final back, which resolve the
// customer's (possibly streaming) HTTP response.
//
// In-memory = single control-plane process (matches our SQLite single-node
// model). If the process restarts mid-request the customer sees a 502/timeout
// and retries — acceptable for MVP.

import crypto from 'node:crypto';

const queues = new Map();   // instanceId -> [request]
const waiters = new Map();  // instanceId -> resolve(requests[]) for a held poll
const pending = new Map();  // requestId -> { onDelta, resolve, reject, timer, stream }

export function enqueueRequest(instanceId, payload, handlers, timeoutMs = 300000) {
  const requestId = crypto.randomBytes(12).toString('hex');
  const req = { requestId, ...payload };

  const timer = setTimeout(() => {
    pending.delete(requestId);
    handlers.reject(new Error('agent did not respond in time'));
  }, timeoutMs);
  pending.set(requestId, { ...handlers, timer, stream: payload.stream });

  // Deliver to a held poll if one is waiting, else queue.
  const waiter = waiters.get(instanceId);
  if (waiter) { waiters.delete(instanceId); waiter([req]); }
  else {
    if (!queues.has(instanceId)) queues.set(instanceId, []);
    queues.get(instanceId).push(req);
  }
  return requestId;
}

// Host long-poll: return queued requests immediately, else hold until one
// arrives or the timeout fires (returns []).
export function pollRequests(instanceId, holdMs = 25000) {
  const q = queues.get(instanceId);
  if (q && q.length) { queues.set(instanceId, []); return Promise.resolve(q); }
  return new Promise((resolve) => {
    const t = setTimeout(() => { if (waiters.get(instanceId) === resolve) waiters.delete(instanceId); resolve([]); }, holdMs);
    waiters.set(instanceId, (reqs) => { clearTimeout(t); resolve(reqs); });
  });
}

// Host reports progress/result for a request.
export function deliverResponse({ requestId, delta, done, content, error }) {
  const p = pending.get(requestId);
  if (!p) return false;
  if (delta && p.stream && p.onDelta) p.onDelta(delta);
  if (done) {
    clearTimeout(p.timer);
    pending.delete(requestId);
    if (error) p.reject(new Error(error));
    else p.resolve(content || '');
  }
  return true;
}
