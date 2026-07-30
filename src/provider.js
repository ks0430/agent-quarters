// Cloud provider adapter. Lightsail today; the interface is deliberately tiny
// so a Hetzner/Vultr adapter is a ~100-line drop-in later:
//   createInstance({name, region, bundleId, userData}) -> Promise<void>
//   getInstance(name, region) -> Promise<{state, publicIp}>
//   deleteInstance(name, region) -> Promise<void>

import {
  LightsailClient,
  CreateInstancesCommand,
  GetInstanceCommand,
  DeleteInstanceCommand,
} from '@aws-sdk/client-lightsail';

export const REGIONS = [
  { id: 'us-east-1', label: 'US East (N. Virginia)' },
  { id: 'us-west-2', label: 'US West (Oregon)' },
  { id: 'eu-west-1', label: 'EU (Ireland)' },
  { id: 'eu-central-1', label: 'EU (Frankfurt)' },
  { id: 'ap-southeast-1', label: 'Asia (Singapore)' },
  { id: 'ap-northeast-1', label: 'Asia (Tokyo)' },
];

const BLUEPRINT = 'ubuntu_24_04';

const clients = new Map();
function client(region) {
  if (!clients.has(region)) clients.set(region, new LightsailClient({ region }));
  return clients.get(region);
}

const lightsail = {
  async createInstance({ name, region, bundleId, userData }) {
    await client(region).send(new CreateInstancesCommand({
      instanceNames: [name],
      availabilityZone: `${region}a`,
      blueprintId: BLUEPRINT,
      bundleId,
      userData,
      tags: [{ key: 'managed-by', value: 'agentdeploy' }],
    }));
  },

  async getInstance(name, region) {
    const res = await client(region).send(new GetInstanceCommand({ instanceName: name }));
    return {
      state: res.instance?.state?.name || 'unknown', // pending | running | ...
      publicIp: res.instance?.publicIpAddress || null,
    };
  },

  async deleteInstance(name, region) {
    await client(region).send(new DeleteInstanceCommand({ instanceName: name }));
  },
};

// Mock provider for local development: instances "boot" after a few seconds.
const mockState = new Map();
const mock = {
  async createInstance({ name }) {
    mockState.set(name, { state: 'pending', publicIp: null, created: Date.now() });
  },
  async getInstance(name) {
    const m = mockState.get(name);
    if (!m) return { state: 'unknown', publicIp: null };
    if (Date.now() - m.created > 5000) {
      m.state = 'running';
      m.publicIp = '127.0.0.1';
    }
    return { state: m.state, publicIp: m.publicIp };
  },
  async deleteInstance(name) {
    mockState.delete(name);
  },
};

export function getProvider() {
  return process.env.MOCK_PROVIDER ? mock : lightsail;
}
