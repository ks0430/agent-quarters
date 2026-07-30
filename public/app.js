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

function statusPill(inst, agent) {
  const mk = (cls, label) => `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
  if (inst.state === 'provisioning') return mk('busy', 'Creating server…');
  if (inst.state === 'bootstrapping') return mk('busy', 'Installing software…');
  if (inst.state === 'error') return mk('bad', 'Server error');
  if (!agent) return mk('warn', 'No agent');
  if (agent.status === 'pending') return mk('busy', 'Starting agent…');
  if (agent.status === 'running' && agent.platform === 'none') return mk('warn', 'Ready — connect a platform');
  if (agent.status === 'running') return mk('live', 'Live');
  if (agent.status === 'stopped') return mk('bad', 'Stopped');
  return mk('bad', agent.status);
}

function regionLabel(id) {
  return (meta.regions.find((r) => r.id === id) || { label: id }).label;
}

async function refresh() {
  let instances;
  try { instances = await api('GET', '/instances'); } catch { return showAuth(); }

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
        ${agent ? `
          <button class="btn" data-act="edit" data-id="${agent.id}" data-platform="${agent.platform}"
            data-model="${agent.model || ''}" data-type="${agent.agent_type}">${connectLabel}</button>
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
bindPlatformToggle('d-platform', 'd');
bindPlatformToggle('e-platform', 'e');

$('d-type').onchange = () => {
  fillModes($('d-mode'), $('d-type').value);
  $('d-apikey-hint').textContent = $('d-type').value === 'codex'
    ? 'OpenAI API key — get one at platform.openai.com'
    : 'Anthropic API key — get one at console.anthropic.com';
};

$('deploy-btn').onclick = () => {
  fillModes($('d-mode'), $('d-type').value);
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
    await api('POST', '/deploy', {
      name: $('d-name').value.trim(),
      region: $('d-region').value,
      agentType: $('d-type').value,
      model: $('d-model').value.trim() || null,
      mode: $('d-mode').value,
      apiKey: $('d-apikey').value.trim(),
      ...platformConfigFrom('d'),
    });
    $('deploy-modal').close();
    $('deploy-form').reset();
    refresh();
  } catch (err) {
    $('deploy-error').textContent = err.message;
  } finally {
    $('deploy-submit').disabled = false;
  }
};

// ---------- edit modal ----------

function openEdit(data) {
  $('e-agent-id').value = data.id;
  $('edit-title').textContent = data.platform === 'none' ? 'Connect a chat platform' : 'Agent settings';
  $('e-model').value = data.model || '';
  fillModes($('e-mode'), data.type);
  $('e-apikey').value = '';
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

// ---------- boot ----------

(async function boot() {
  meta = await api('GET', '/meta');
  fillModes($('d-mode'), 'claudecode');
  try {
    const me = await api('GET', '/me');
    if (me.email) return showDash();
  } catch { /* fall through */ }
  showAuth();
})();
