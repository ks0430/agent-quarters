// AgentDeploy dashboard — plain JS, no build step.

const $ = (id) => document.getElementById(id);

const MODES = {
  claudecode: [
    ['acceptEdits', 'Accept edits (recommended)'],
    ['default', 'Ask before actions'],
    ['plan', 'Plan only'],
    ['bypassPermissions', 'Full autonomy'],
  ],
  codex: [
    ['auto-edit', 'Auto edit (recommended)'],
    ['suggest', 'Suggest only'],
    ['full-auto', 'Full autonomy'],
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

function statusPill(inst, agent) {
  const mk = (cls, label) => `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
  if (inst.state === 'provisioning') return mk('busy', 'Creating server…');
  if (inst.state === 'bootstrapping') return mk('busy', 'Installing software…');
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
            · ${regionLabel(inst.region)}${inst.public_ip ? ` · ${inst.public_ip}` : ''}</div>
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
          <button class="btn" data-act="restart" data-id="${agent.id}">Restart</button>` : ''}
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

// Slack app manifest: pre-fills the entire app config (Socket Mode, events,
// scopes, DM tab) so users only click Create → generate token → Install.
// The bot name comes from the "Bot name in Slack" field, live.
function updateSlackManifestLink() {
  const name = ($('e-sl-name').value.trim() || 'my-agent').slice(0, 35);
  const manifest = {
    display_information: { name, description: 'Your always-on AI coding agent' },
    features: {
      bot_user: { display_name: name, always_online: true },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: { scopes: { bot: ['chat:write', 'im:history', 'channels:history'] } },
    settings: {
      event_subscriptions: { bot_events: ['message.im', 'message.channels'] },
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
    await api('POST', '/deploy', { region: $('d-region').value });
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
