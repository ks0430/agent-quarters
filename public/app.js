// AgentDeploy dashboard — plain JS, no build step.

const $ = (id) => document.getElementById(id);

// Full autonomy is the recommended default: each agent runs in its own
// isolated container (that IS the sandbox), and the CLIs' internal guardrails
// misbehave inside docker (codex's sandbox errors; restricted modes make
// agents confabulate refusals instead of asking).
const MODES = {
  claudecode: [
    ['bypassPermissions', 'Full autonomy (recommended)'],
    ['acceptEdits', 'Accept edits, ask for commands'],
    ['default', 'Ask before actions'],
    ['plan', 'Plan only'],
  ],
  codex: [
    ['yolo', 'Full autonomy (recommended)'],
    ['auto-edit', 'Auto edit, ask for commands'],
    ['suggest', 'Suggest only'],
  ],
};

let meta = { regions: [] };
let pollTimer = null;

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- auth ----------

let authTab = 'login';
document.querySelectorAll('.tab').forEach((el) => {
  el.onclick = () => {
    authTab = el.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === el));
    $('auth-submit').textContent = authTab === 'login' ? 'Log in' : 'Create account';
  };
});

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    await api('POST', `/${authTab}`, {
      email: $('auth-email').value,
      password: $('auth-password').value,
    });
    showDash();
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};

$('logout-btn').onclick = async () => {
  await api('POST', '/logout').catch(() => {});
  location.reload();
};

// ---------- views ----------

function showAuth() {
  $('view-auth').classList.remove('hidden');
  $('view-dash').classList.add('hidden');
  $('userbox').classList.add('hidden');
  clearInterval(pollTimer);
}

async function showDash() {
  const me = await api('GET', '/me');
  if (!me.email) return showAuth();
  $('user-email').textContent = me.email;
  $('userbox').classList.remove('hidden');
  $('view-auth').classList.add('hidden');
  $('view-dash').classList.remove('hidden');
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

// ---------- dashboard rendering ----------

function needsLogin(agent) {
  return agent && agent.auth_method === 'subscription' && agent.login_state !== 'logged_in';
}

function healthNote(agent) {
  if (!agent || !agent.health || agent.health === 'checking') return '';
  if (agent.health === 'connected') return ' · <span style="color:var(--green)">✓ connection ok</span>';
  if (agent.health === 'login_expired') return ' · <span style="color:var(--red)">⚠ login expired</span>';
  return '';
}

function statusPill(inst, agent) {
  const mk = (cls, label) => `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
  if (inst.state === 'provisioning') return mk('busy', 'Creating server…');
  if (inst.state === 'bootstrapping') return mk('busy', 'Installing software…');
  if (inst.state === 'pausing') return mk('busy', 'Pausing (snapshotting)…');
  if (inst.state === 'paused') return mk('warn', 'Paused — ~$1/mo');
  if (inst.state === 'resuming') return mk('busy', 'Resuming…');
  if (inst.state === 'error') return mk('bad', 'Server error');
  if (!agent) return mk('warn', 'Ready — set up your agent');
  if (agent.status === 'pending') return mk('busy', 'Starting agent…');
  if (agent.status === 'running' && needsLogin(agent)) {
    return mk('warn', `Ready — login to ${agent.agent_type === 'codex' ? 'ChatGPT' : 'Claude'}`);
  }
  if (agent.status === 'running' && agent.platform === 'none') return mk('warn', 'Ready — connect a platform');
  if (agent.status === 'running') return mk('live', 'Live');
  if (agent.status === 'stopped') return mk('bad', 'Stopped');
  return mk('bad', agent.status);
}

function regionLabel(id) {
  return (meta.regions.find((r) => r.id === id) || { label: id }).label;
}

async function refreshBalance() {
  try {
    const b = await api('GET', '/billing');
    const banner = $('balance-banner');
    const days = b.burnCentsDay > 0 ? b.balanceCents / b.burnCentsDay : Infinity;
    if (b.balanceCents <= 0 && b.activeServers > 0) {
      banner.className = 'danger';
      banner.innerHTML = `⚠️ Your credit balance is empty — servers will be deleted after a 48h grace period.
        <a href="/settings.html">Top up now</a>`;
    } else if (days < 3) {
      banner.className = '';
      banner.innerHTML = `Your credits cover ~${days.toFixed(1)} more days.
        <a href="/settings.html">Top up in Settings</a>`;
    } else {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
  } catch { /* billing not configured yet */ }
}

async function refresh() {
  let instances;
  try { instances = await api('GET', '/instances'); } catch { return showAuth(); }
  refreshBalance();

  $('empty-state').classList.toggle('hidden', instances.length > 0);
  $('agent-list').innerHTML = instances.map((inst) => {
    const agent = inst.agents[0];
    const typeLabel = agent ? (agent.agent_type === 'codex' ? 'Codex' : 'Claude Code') : '';
    const platform = agent && agent.platform !== 'none' ? ` · ${agent.platform}` : '';
    const connectLabel = agent && agent.platform === 'none' ? 'Connect platform' : 'Settings';
    return `
    <div class="agent-card">
      <div class="agent-top">
        <div>
          <div class="agent-name">${agent ? agent.name : inst.name}</div>
          <div class="agent-meta">${typeLabel}${agent && agent.model ? ` (${agent.model})` : ''}${platform}
            · ${regionLabel(inst.region)}${inst.static_ip ? ` · 📌 ${inst.static_ip}` : (inst.public_ip ? ` · ${inst.public_ip}` : '')}${healthNote(agent)}</div>
        </div>
        ${statusPill(inst, agent)}
      </div>
      ${inst.error ? `<div class="err">${inst.error}</div>` : ''}
      <div class="agent-actions">
        ${!agent && inst.state !== 'error' ? `
          <button class="btn primary" data-act="setup" data-id="${inst.id}">Set up agent</button>` : ''}
        ${agent && needsLogin(agent) && agent.status === 'running' ? `
          <button class="btn primary" data-act="login" data-id="${agent.id}" data-type="${agent.agent_type}">
            Login to ${agent.agent_type === 'codex' ? 'ChatGPT' : 'Claude'}</button>` : ''}
        ${agent ? `
          <button class="btn" data-act="edit" data-id="${agent.id}" data-platform="${agent.platform}"
            data-model="${agent.model || ''}" data-type="${agent.agent_type}"
            data-auth="${agent.auth_method}" data-name="${agent.name}">${connectLabel}</button>
          <button class="btn" data-act="logs" data-id="${agent.id}" data-name="${agent.name}">Logs</button>
          <button class="btn" data-act="test" data-id="${agent.id}">Test connection</button>
          <button class="btn" data-act="restart" data-id="${agent.id}">Restart</button>` : ''}
        <button class="btn" data-act="details" data-id="${inst.id}" data-name="${inst.name}">Details</button>
        ${agent && inst.state === 'ready' ? `
          <button class="btn" data-act="api" data-id="${agent.id}">API</button>` : ''}
        ${inst.state === 'ready' ? `
          <button class="btn" data-act="pause" data-id="${inst.id}" data-name="${inst.name}">Pause</button>` : ''}
        ${inst.state === 'paused' ? `
          <button class="btn primary" data-act="resume" data-id="${inst.id}">Resume</button>` : ''}
        <button class="btn ghost danger" data-act="delete" data-id="${inst.id}" data-name="${inst.name}">Delete</button>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-act]').forEach((btn) => { btn.onclick = () => onAction(btn); });
}

async function onAction(btn) {
  const { act, id } = btn.dataset;
  try {
    if (act === 'restart') {
      btn.disabled = true;
      await api('POST', `/agents/${id}/restart`);
      setTimeout(() => { btn.disabled = false; }, 3000);
    } else if (act === 'test') {
      btn.disabled = true; btn.textContent = 'Testing…';
      await api('POST', `/agents/${id}/test`);
      const started = Date.now();
      const poll = setInterval(async () => {
        let ag = null;
        try {
          const insts = await api('GET', '/instances');
          insts.forEach((i) => i.agents.forEach((a) => { if (String(a.id) === id) ag = a; }));
        } catch { /* transient */ }
        if (ag && ag.health && ag.health !== 'checking') {
          clearInterval(poll);
          const m = ag.health === 'connected' ? '✅ Connected — the agent is logged in and responding.'
            : ag.health === 'login_expired' ? '⚠️ Login expired. Open the agent and log in again (Login button).'
            : ag.health === 'stopped' ? '⚠️ The agent container is stopped. Try Restart.'
            : `Result: ${ag.health}`;
          alert(m);
          refresh();
        } else if (Date.now() - started > 90000) {
          clearInterval(poll); btn.disabled = false; btn.textContent = 'Test connection';
          alert('Test timed out — the agent did not respond. It may be busy or offline.');
        }
      }, 3000);
    } else if (act === 'logs') {
      $('logs-title').textContent = `Logs — ${btn.dataset.name}`;
      $('logs-body').textContent = 'loading…';
      $('logs-modal').showModal();
      const r = await api('GET', `/agents/${id}/logs`);
      $('logs-body').textContent = r.logs || '(no logs yet)';
    } else if (act === 'edit') {
      openEdit(btn.dataset);
    } else if (act === 'login') {
      openLogin(btn.dataset.id, btn.dataset.type);
    } else if (act === 'setup') {
      openSetup(btn.dataset.id);
    } else if (act === 'api') {
      openApi(btn.dataset.id);
    } else if (act === 'details') {
      openDetails(btn.dataset.id);
    } else if (act === 'pause') {
      if (confirm(`Pause ${btn.dataset.name}? The server is snapshotted and shut down (~$1/mo instead of ~$18/mo). Your agent, logins and files are preserved; resume anytime in ~3 minutes.`)) {
        btn.disabled = true;
        await api('POST', `/instances/${btn.dataset.id}/pause`);
        refresh();
      }
    } else if (act === 'resume') {
      btn.disabled = true;
      await api('POST', `/instances/${btn.dataset.id}/resume`);
      refresh();
    } else if (act === 'delete') {
      if (confirm(`Delete ${btn.dataset.name} and its server? This cannot be undone.`)) {
        await api('DELETE', `/instances/${id}`);
        refresh();
      }
    }
  } catch (err) {
    alert(err.message);
  }
}

// ---------- deploy modal ----------

function fillModes(select, type, current) {
  select.innerHTML = MODES[type].map(([v, l]) =>
    `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`).join('');
}

function bindPlatformToggle(selectId, prefix) {
  $(selectId).onchange = () => {
    const v = $(selectId).value;
    $(`${prefix}-telegram`).classList.toggle('hidden', v !== 'telegram');
    $(`${prefix}-slack`).classList.toggle('hidden', v !== 'slack');
  };
}
bindPlatformToggle('e-platform', 'e');

// Slack app manifest: pre-fills the entire app config so users only click
// Create → generate token → Install. Mirrors cc-connect's official manifest
// (docs/slack-app-manifest.json): full scopes plus its native slash commands
// (/new /list /model /mode etc.) — Slack only forwards declared commands.
// The bot name comes from the "Bot name in Slack" field, live.
const SLACK_COMMANDS = [
  ['/ps', 'Send a P.S. to the running task', '[message]'],
  ['/new', 'Start a new session', '[name]'],
  ['/list', 'List agent sessions', ''],
  ['/switch', 'Resume a session by its list number', '<number>'],
  ['/delete', 'Delete sessions by list number(s)', '<number>'],
  ['/name', 'Name a session for easy identification', '[number] <text>'],
  ['/current', 'Show current active session', ''],
  ['/history', 'Show last n messages', '[n]'],
  ['/model', 'View or switch model', '[name]'],
  ['/mode', 'View or switch permission mode', '[default|edit|plan|yolo]'],
  ['/stop', 'Stop current execution', ''],
  ['/compress', 'Compress conversation context', ''],
  // note: /status and /help are Slack built-ins — registering them makes
  // manifest validation fail with "slash command has invalid name"
  ['/quiet', 'Toggle thinking and tool progress display', ''],
  ['/usage', 'Show account and model quota usage', ''],
  ['/shell', 'Run a shell command and return the output', '<command>'],
  ['/memory', 'View or edit agent memory files', ''],
  ['/lang', 'View or switch language', '[en|zh|ja|es|auto]'],
  ['/cron', 'Manage scheduled tasks', '[add|list|del]'],
  ['/skills', 'List agent skills', ''],
  ['/reasoning', 'View or switch reasoning effort', '[low|medium|high]'],
  ['/workspace', 'Manage workspaces', '[list|switch|add]'],
];

function updateSlackManifestLink() {
  const name = ($('e-sl-name').value.trim() || 'my-agent').slice(0, 35);
  // App title allows spaces; the bot username is strict (letters, digits,
  // - and _ only) — Slack's "invalid name" errors otherwise, misleadingly
  // pointing at slash commands.
  const botName = (name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent').slice(0, 32);
  const manifest = {
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: { name, description: 'Your always-on AI coding agent' },
    features: {
      bot_user: { display_name: botName, always_online: true },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: SLACK_COMMANDS.map(([command, description, usage_hint]) => ({
        command, description, ...(usage_hint ? { usage_hint } : {}), should_escape: false,
      })),
    },
    oauth_config: { scopes: { bot: [
      'app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'commands',
      'files:read', 'files:write', // receive user uploads / send files back
      'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
      'reactions:write', 'users:read',
    ] } },
    settings: {
      // app_mention + message.im ONLY (matches cc-connect's official manifest):
      // adding message.channels makes channel @mentions fire twice → double replies.
      event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
    },
  };
  $('slack-manifest-link').href =
    'https://api.slack.com/apps?new_app=1&manifest_json=' + encodeURIComponent(JSON.stringify(manifest));
}
$('e-sl-name').oninput = updateSlackManifestLink;

$('deploy-btn').onclick = () => {
  $('d-region').innerHTML = meta.regions.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
  $('deploy-error').textContent = '';
  $('deploy-modal').showModal();
};
$('deploy-cancel').onclick = () => $('deploy-modal').close();

function platformConfigFrom(prefix) {
  const platform = $(`${prefix}-platform`).value;
  if (platform === 'telegram') {
    return { platform, platformConfig: {
      token: $(`${prefix}-tg-token`).value.trim(),
      allowFrom: $(`${prefix}-tg-allow`).value.trim() || '*',
    } };
  }
  if (platform === 'slack') {
    return { platform, platformConfig: {
      botToken: $(`${prefix}-sl-bot`).value.trim(),
      appToken: $(`${prefix}-sl-app`).value.trim(),
      allowFrom: $(`${prefix}-sl-allow`).value.trim() || '*',
    } };
  }
  return { platform: 'none', platformConfig: {} };
}

$('deploy-form').onsubmit = async (e) => {
  e.preventDefault();
  $('deploy-error').textContent = '';
  $('deploy-submit').disabled = true;
  try {
    await api('POST', '/deploy', { region: $('d-region').value, staticIp: $('d-staticip').checked });
    $('deploy-modal').close();
    refresh();
  } catch (err) {
    $('deploy-error').textContent = err.message;
  } finally {
    $('deploy-submit').disabled = false;
  }
};

// ---------- agent setup (step 2) ----------

function setupType() {
  return document.querySelector('input[name="s-type"]:checked').value;
}

function syncSetupFields() {
  const type = setupType();
  const isClaude = type === 'claudecode';
  const auth = $('s-auth').value;
  $('s-auth').options[0].text = isClaude
    ? 'Claude subscription — guided login, no API key (recommended)'
    : 'ChatGPT subscription — guided device login (recommended)';
  $('s-auth-hint').textContent = !isClaude && auth === 'subscription'
    ? 'Requires "Device code login" enabled in your ChatGPT security settings.'
    : '';
  $('s-apikey-wrap').classList.toggle('hidden', auth === 'subscription');
  $('s-apikey').required = auth !== 'subscription';
  $('s-apikey-hint').textContent = type === 'codex'
    ? 'OpenAI API key — get one at platform.openai.com'
    : 'Anthropic API key — get one at console.anthropic.com';
  fillModes($('s-mode'), type);
}
document.querySelectorAll('input[name="s-type"]').forEach((r) => { r.onchange = syncSetupFields; });
$('s-auth').onchange = syncSetupFields;

function openSetup(instanceId) {
  $('s-instance-id').value = instanceId;
  $('setup-error').textContent = '';
  syncSetupFields();
  $('setup-modal').showModal();
}
$('setup-cancel').onclick = () => $('setup-modal').close();

$('setup-form').onsubmit = async (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  $('setup-submit').disabled = true;
  try {
    await api('POST', `/instances/${$('s-instance-id').value}/agent`, {
      name: $('s-name').value.trim(),
      agentType: setupType(),
      authMethod: $('s-auth').value,
      apiKey: $('s-apikey').value.trim(),
      model: $('s-model').value.trim() || null,
      mode: $('s-mode').value,
      platform: 'none',
    });
    $('setup-modal').close();
    refresh();
  } catch (err) {
    $('setup-error').textContent = err.message;
  } finally {
    $('setup-submit').disabled = false;
  }
};

// ---------- edit modal ----------

function openEdit(data) {
  $('e-agent-id').value = data.id;
  $('edit-title').textContent = data.platform === 'none' ? 'Connect a chat platform' : 'Agent settings';
  $('e-model').value = data.model || '';
  fillModes($('e-mode'), data.type);
  $('e-apikey').value = '';
  // Subscription agents have no API key to edit — hide the field entirely.
  $('e-apikey').closest('label').classList.toggle('hidden', data.auth === 'subscription');
  $('e-sl-name').value = data.name || '';
  updateSlackManifestLink();
  $('e-platform').value = data.platform === 'none' ? 'telegram' : data.platform;
  $('e-platform').onchange();
  $('edit-error').textContent = '';
  $('edit-modal').showModal();
}
$('edit-cancel').onclick = () => $('edit-modal').close();

$('edit-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('POST', `/agents/${$('e-agent-id').value}/config`, {
      model: $('e-model').value.trim() || null,
      mode: $('e-mode').value,
      apiKey: $('e-apikey').value.trim(),
      ...platformConfigFrom('e'),
    });
    $('edit-modal').close();
    refresh();
  } catch (err) {
    $('edit-error').textContent = err.message;
  }
};

$('logs-close').onclick = () => $('logs-modal').close();

// ---------- server details / activity timeline ----------

const EVENT_ICONS = {
  deploy: '🚀', vm: '⚙️', ip: '📌', ready: '✅', agent: '🤖', login: '🔑',
  platform: '💬', pause: '⏸️', resume: '▶️', snapshot: '📦', billing: '💳',
  delete: '🗑️', error: '❌',
};
let detailsTimer = null;

async function renderDetails(instanceId) {
  const instances = await api('GET', '/instances');
  const inst = instances.find((i) => String(i.id) === String(instanceId));
  if (!inst) { $('details-modal').close(); return; }
  const agent = inst.agents[0];
  $('det-title').textContent = `${agent ? agent.name : inst.name} — details`;
  const rows = [
    ['Server', inst.name], ['Region', regionLabel(inst.region)],
    ['State', inst.state], ['Size', inst.bundle],
    ['IP address', inst.static_ip ? `📌 ${inst.static_ip} (static)` : (inst.public_ip || '—')],
    ['Created', (inst.created_at || '').slice(0, 16) + ' UTC'],
  ];
  if (agent) {
    rows.push(['Agent', `${agent.name} (${agent.agent_type === 'codex' ? 'Codex' : 'Claude Code'})`],
      ['Auth', agent.auth_method === 'subscription' ? `subscription (${agent.login_state || '—'})` : 'API key'],
      ['Platform', agent.platform === 'none' ? 'not connected' : agent.platform]);
  }
  $('det-info').innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('');

  const { events } = await api('GET', `/instances/${instanceId}/events`);
  $('det-timeline').innerHTML = events.length
    ? events.map((e) => `<div class="tl-row ${e.kind === 'error' ? 'err' : ''}">
        <span class="tl-time">${e.created_at.slice(5, 16)}</span>
        <span>${EVENT_ICONS[e.kind] || '·'}</span>
        <span class="tl-msg">${e.message}</span></div>`).join('')
    : '<p class="muted">No activity recorded yet.</p>';
}

function openDetails(instanceId) {
  $('details-modal').showModal();
  renderDetails(instanceId).catch(() => {});
  clearInterval(detailsTimer);
  detailsTimer = setInterval(() => renderDetails(instanceId).catch(() => {}), 4000);
}
$('det-close').onclick = () => { clearInterval(detailsTimer); $('details-modal').close(); };

// ---------- API access ----------

let apiAgentId = null;

function apiSnippet(baseUrl, agentId) {
  const url = `${baseUrl}/agents/${agentId}/messages`;
  return `# curl — message your agent\ncurl -N ${url} \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n` +
    `  -H "Content-Type: application/json" \\\n  -d '{"message": "summarize the repo", "stream": true}'\n\n` +
    `# optional fields:\n` +
    `#   "session": "ci"          named conversation — context persists across calls\n` +
    `#   "stateless": true        isolated one-off call, no memory (ignores session)\n` +
    `#   "model": "gpt-5.6-luna"  switch model for this call (cheaper/faster)\n` +
    `#   "reasoning": "low"       minimal|low|medium|high|xhigh`;
}

async function renderApi() {
  const d = await api('GET', `/agents/${apiAgentId}/api`);
  $('api-enabled').checked = d.enabled;
  $('api-body').classList.toggle('hidden', !d.enabled);
  $('api-snippet').textContent = apiSnippet(d.baseUrl, d.agentId);
  $('api-keys').innerHTML = d.keys.length
    ? d.keys.map((k) => `<div class="api-key-row">
        <span>${k.name} <span class="mono">${k.prefix}…</span></span>
        <span><span class="muted" style="font-size:12px">${k.last_used_at ? 'used ' + k.last_used_at.slice(0, 10) : 'never used'}</span>
        <button class="btn ghost danger" data-revoke="${k.id}" style="padding:2px 10px">Revoke</button></span>
      </div>`).join('')
    : '<p class="muted">No keys yet.</p>';
  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => { await api('DELETE', `/agents/${apiAgentId}/api/keys/${b.dataset.revoke}`); renderApi(); };
  });
}

function openApi(agentId) {
  apiAgentId = agentId;
  $('api-error').textContent = '';
  $('api-newkey').classList.add('hidden');
  $('api-keyname').value = '';
  $('api-modal').showModal();
  renderApi().catch((e) => { $('api-error').textContent = e.message; });
}

$('api-enabled').onchange = async () => {
  try {
    await api('POST', `/agents/${apiAgentId}/api/enable`, { enabled: $('api-enabled').checked });
    renderApi();
  } catch (e) { $('api-error').textContent = e.message; }
};

$('api-createkey').onclick = async () => {
  $('api-error').textContent = '';
  try {
    const r = await api('POST', `/agents/${apiAgentId}/api/keys`, { name: $('api-keyname').value.trim() || 'key' });
    $('api-newkey-val').textContent = r.key;
    $('api-newkey').classList.remove('hidden');
    $('api-keyname').value = '';
    renderApi();
  } catch (e) { $('api-error').textContent = e.message; }
};

$('api-close').onclick = () => $('api-modal').close();

// ---------- claude subscription login ----------

let loginPollTimer = null;

function loginStep(step) {
  for (const s of ['start', 'wait', 'code', 'verify', 'done']) {
    $(`l-step-${s}`).classList.toggle('hidden', s !== step);
  }
}

function openLogin(agentId, agentType) {
  const codex = agentType === 'codex';
  $('l-title').textContent = `Log in with your ${codex ? 'ChatGPT' : 'Claude'} subscription`;
  $('l-intro').textContent = `We'll start ${codex ? 'Codex' : 'Claude Code'} on your server and ` +
    `generate a secure login link. You sign in on ${codex ? 'openai.com' : 'claude.com'} — ` +
    'your password never touches this site.';
  $('l-agent-id').value = agentId;
  $('l-error').textContent = '';
  $('l-code').value = '';
  loginStep('start');
  $('login-modal').showModal();
}

async function pollLogin(agentId, until, onReach, tries = 60) {
  clearInterval(loginPollTimer);
  loginPollTimer = setInterval(async () => {
    try {
      const r = await api('GET', `/agents/${agentId}/login`);
      if (r.state === until) {
        clearInterval(loginPollTimer);
        onReach(r);
      } else if (r.state === 'failed') {
        clearInterval(loginPollTimer);
        $('l-error').textContent = 'Login failed — check the agent logs, then try again.';
        loginStep('start');
      } else if (--tries <= 0) {
        clearInterval(loginPollTimer);
        $('l-error').textContent = 'Timed out — please try again.';
        loginStep('start');
      }
    } catch { /* transient */ }
  }, 2000);
}

$('l-start').onclick = async () => {
  const id = $('l-agent-id').value;
  $('l-error').textContent = '';
  loginStep('wait');
  try {
    await api('POST', `/agents/${id}/login/start`);
    pollLogin(id, 'awaiting_code', (r) => {
      $('l-url').href = r.url;
      const isDeviceAuth = !!r.code; // codex: show code, completes on its own
      $('l-codex-part').classList.toggle('hidden', !isDeviceAuth);
      $('l-claude-part').classList.toggle('hidden', isDeviceAuth);
      if (isDeviceAuth) {
        $('l-code-display').textContent = r.code;
        pollLogin(id, 'logged_in', () => { loginStep('done'); refresh(); }, 300);
      }
      loginStep('code');
    });
  } catch (err) {
    $('l-error').textContent = err.message;
    loginStep('start');
  }
};

$('l-submit').onclick = async () => {
  const id = $('l-agent-id').value;
  const code = $('l-code').value.trim();
  if (!code) { $('l-error').textContent = 'Paste the code first.'; return; }
  $('l-error').textContent = '';
  loginStep('verify');
  try {
    await api('POST', `/agents/${id}/login/code`, { code });
    pollLogin(id, 'logged_in', () => { loginStep('done'); refresh(); });
  } catch (err) {
    $('l-error').textContent = err.message;
    loginStep('code');
  }
};

$('l-close').onclick = () => { clearInterval(loginPollTimer); $('login-modal').close(); };

// ---------- boot ----------

(async function boot() {
  meta = await api('GET', '/meta');
  fillModes($('s-mode'), 'claudecode');
  try {
    const me = await api('GET', '/me');
    if (me.email) return showDash();
  } catch { /* fall through */ }
  showAuth();
})();
