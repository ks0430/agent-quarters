// Generates a cc-connect config.toml for one agent, and the container env.
// Field names verified against cc-connect config.example.toml (v1.4.x).

function tomlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ') + '"';
}

export const AGENT_TYPES = ['claudecode', 'codex'];
export const PLATFORMS = ['telegram', 'slack'];

// mode: claudecode -> default | acceptEdits | plan | bypassPermissions
//       codex     -> suggest | auto-edit | full-auto
const DEFAULT_MODES = { claudecode: 'acceptEdits', codex: 'auto-edit' };

export function generateConfig(agent) {
  const { name, agentType, model, mode, platform, platformConfig } = agent;

  let out = `language = "en"

[log]
level = "info"

[[projects]]
name = ${tomlStr(name)}

[projects.agent]
type = ${tomlStr(agentType)}

[projects.agent.options]
work_dir = "/home/agent/workspace"
mode = ${tomlStr(mode || DEFAULT_MODES[agentType])}
`;
  if (model) out += `model = ${tomlStr(model)}\n`;

  // Platform is optional: without one the agent container idles in a
  // "waiting for platform" state until the user connects Slack/Telegram.
  if (!platform || platform === 'none') {
    out += `
[display]
mode = "quiet"
`;
    return out;
  }

  out += `
[[projects.platforms]]
type = ${tomlStr(platform)}

[projects.platforms.options]
`;

  if (platform === 'telegram') {
    out += `token = ${tomlStr(platformConfig.token)}\n`;
    out += `allow_from = ${tomlStr(platformConfig.allowFrom || '*')}\n`;
  } else if (platform === 'slack') {
    out += `bot_token = ${tomlStr(platformConfig.botToken)}\n`;
    out += `app_token = ${tomlStr(platformConfig.appToken)}\n`;
    out += `allow_from = ${tomlStr(platformConfig.allowFrom || '*')}\n`;
  }

  out += `
[display]
mode = "quiet"
`;
  return out;
}

export function generateEnv(agent) {
  const env = {};
  if (agent.agentType === 'claudecode') env.ANTHROPIC_API_KEY = agent.apiKey;
  if (agent.agentType === 'codex') env.OPENAI_API_KEY = agent.apiKey;
  return env;
}

export function validateAgentSpec(spec) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(spec.name || ''))
    errors.push('name must be lowercase letters, digits, dashes (2-31 chars)');
  if (!AGENT_TYPES.includes(spec.agentType)) errors.push('invalid agent type');
  if (!spec.apiKey || spec.apiKey.length < 8) errors.push('API key required');
  const platform = spec.platform || 'none';
  if (platform !== 'none') {
    if (!PLATFORMS.includes(platform)) errors.push('invalid platform');
    const pc = spec.platformConfig || {};
    if (platform === 'telegram' && !pc.token) errors.push('telegram bot token required');
    if (platform === 'slack' && (!pc.botToken || !pc.appToken))
      errors.push('slack bot token (xoxb-) and app token (xapp-) required');
  }
  return errors;
}
