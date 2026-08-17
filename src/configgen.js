// Generates a cc-connect config.toml for one agent, and the container env.
// Field names verified against cc-connect config.example.toml (v1.4.x).

function tomlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ') + '"';
}

export const AGENT_TYPES = ['claudecode', 'codex'];
export const PLATFORMS = ['telegram', 'slack'];

// mode: claudecode -> default | acceptEdits | plan | bypassPermissions
//       codex     -> suggest | auto-edit | full-auto | yolo
// Default = full autonomy: the per-agent container is the sandbox, and the
// agents' own guardrails misbehave inside it (codex's landlock sandbox
// errors in docker; restricted modes make models confabulate refusals).
const DEFAULT_MODES = { claudecode: 'bypassPermissions', codex: 'yolo' };

export function generateConfig(agent) {
  const { name, agentType, model, mode, platform, platformConfig, bridgeToken } = agent;

  let out = `language = "en"

[log]
level = "info"
`;

  // API access: a global [bridge] block exposes the agent over WebSocket for
  // the control-plane tunnel. cc-connect still requires each project to
  // declare a real platform, so an API-only agent gets a placeholder below.
  if (bridgeToken) {
    out += `
[bridge]
enabled = true
port = 9810
token = ${tomlStr(bridgeToken)}
path = "/bridge/ws"
`;
  }

  out += `
[[projects]]
name = ${tomlStr(name)}`;

  // Privileged commands (/restart, /shell, /upgrade, /dir, /cron addexec) are
  // blocked for everyone unless admin_from lists them. Must live at the
  // [[projects]] level — cc-connect ignores it under platform options.
  if (agent.adminFrom) out += `\nadmin_from = ${tomlStr(agent.adminFrom)}`;

  out += `

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
    if (bridgeToken) {
      // API-only agent: cc-connect needs a platform to load, but there's no
      // chat platform. A telegram platform with an unused token satisfies the
      // requirement and just retries connecting harmlessly in the background.
      out += `
[[projects.platforms]]
type = "telegram"

[projects.platforms.options]
token = "0000:api-only-placeholder"
allow_from = "*"

[display]
mode = "quiet"
`;
      return out;
    }
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
  // Subscription auth: no key at deploy time. The host-agent injects
  // CLAUDE_CODE_OAUTH_TOKEN into the container after the web login relay.
  if (agent.authMethod === 'subscription') return env;
  if (agent.agentType === 'claudecode') env.ANTHROPIC_API_KEY = agent.apiKey;
  if (agent.agentType === 'codex') env.OPENAI_API_KEY = agent.apiKey;
  return env;
}

export function validateAgentSpec(spec) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(spec.name || ''))
    errors.push('name must be lowercase letters, digits, dashes (2-31 chars)');
  if (!AGENT_TYPES.includes(spec.agentType)) errors.push('invalid agent type');
  if (!['api-key', 'subscription'].includes(spec.authMethod || 'api-key'))
    errors.push('invalid auth method');
  if (spec.authMethod !== 'subscription' && (!spec.apiKey || spec.apiKey.length < 8))
    errors.push('API key required');
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
