#!/usr/bin/env node
// Step 1 bridge validation: connect to a cc-connect [bridge] as an adapter,
// register, send one message, print the reply. Proves the register→message→
// reply cycle works on our pinned cc-connect for both claudecode and codex.
//
// Usage: node bridge-probe.mjs ws://127.0.0.1:9810/bridge/ws <token> "message"

import WebSocket from 'ws';

const [url, token, message = 'Reply with exactly: BRIDGE_OK'] = process.argv.slice(2);
if (!url || !token) {
  console.error('usage: bridge-probe.mjs <ws-url> <token> [message]');
  process.exit(2);
}

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
const sessionKey = 'api:probe:tester';
const replyCtx = 'probe-ctx-1';
let got = false;

const timeout = setTimeout(() => {
  console.error('TIMEOUT: no reply within 120s');
  process.exit(1);
}, 120000);

ws.on('open', () => {
  console.log('connected, registering...');
  ws.send(JSON.stringify({
    type: 'register',
    platform: 'api',
    capabilities: ['text'],
    metadata: { version: '0.1', description: 'AgentQuarters bridge probe' },
  }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'register_ack') {
    if (!msg.ok) { console.error('register rejected:', msg.error); process.exit(1); }
    console.log('registered ✓ — sending message:', JSON.stringify(message));
    ws.send(JSON.stringify({
      type: 'message',
      msg_id: 'probe-1',
      session_key: sessionKey,
      user_id: 'tester',
      user_name: 'Probe',
      content: message,
      reply_ctx: replyCtx,
    }));
  } else if (msg.type === 'reply') {
    got = true;
    clearTimeout(timeout);
    console.log('\n=== REPLY RECEIVED ===');
    console.log(msg.content);
    console.log('======================');
    console.log('BRIDGE VALIDATION: PASS ✓');
    ws.close();
    process.exit(0);
  } else if (msg.type === 'reply_stream') {
    process.stdout.write(msg.delta || '');
  } else {
    console.log(`(frame: ${msg.type})`);
  }
});

ws.on('error', (err) => { console.error('ws error:', err.message); process.exit(1); });
ws.on('close', () => { if (!got) { console.error('closed before reply'); process.exit(1); } });
