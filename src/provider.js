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
  CreateInstanceSnapshotCommand,
  GetInstanceSnapshotCommand,
  DeleteInstanceSnapshotCommand,
  CreateInstancesFromSnapshotCommand,
  AllocateStaticIpCommand,
  AttachStaticIpCommand,
  ReleaseStaticIpCommand,
  GetStaticIpCommand,
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
      // No tags: instances are identified by the ad- name prefix instead,
      // which keeps the required IAM policy to the bare minimum.
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

  // --- pause/resume via snapshots ---
  async createSnapshot(instanceName, snapshotName, region) {
    await client(region).send(new CreateInstanceSnapshotCommand({ instanceName, instanceSnapshotName: snapshotName }));
  },
  async getSnapshotState(snapshotName, region) {
    const r = await client(region).send(new GetInstanceSnapshotCommand({ instanceSnapshotName: snapshotName }));
    return r.instanceSnapshot?.state || 'unknown'; // pending | available | error
  },
  async deleteSnapshot(snapshotName, region) {
    await client(region).send(new DeleteInstanceSnapshotCommand({ instanceSnapshotName: snapshotName }));
  },
  async createFromSnapshot({ name, region, bundleId, snapshotName }) {
    await client(region).send(new CreateInstancesFromSnapshotCommand({
      instanceNames: [name],
      availabilityZone: `${region}a`,
      bundleId,
      instanceSnapshotName: snapshotName,
    }));
  },

  // --- static IPs ---
  async allocateStaticIp(ipName, region) {
    await client(region).send(new AllocateStaticIpCommand({ staticIpName: ipName }));
    const r = await client(region).send(new GetStaticIpCommand({ staticIpName: ipName }));
    return r.staticIp?.ipAddress || null;
  },
  async attachStaticIp(ipName, instanceName, region) {
    await client(region).send(new AttachStaticIpCommand({ staticIpName: ipName, instanceName }));
  },
  async releaseStaticIp(ipName, region) {
    await client(region).send(new ReleaseStaticIpCommand({ staticIpName: ipName }));
  },
};

// Mock provider for local development: instances "boot" after a few seconds,
// snapshots become available after a few seconds, static IPs are stable
// per-name (so pause/resume keeps the same fake address, like the real thing).
const mockState = new Map();
const mockSnapshots = new Map();
const mockIps = new Map();
const mock = {
  async createInstance({ name }) {
    mockState.set(name, { state: 'pending', publicIp: null, created: Date.now() });
  },
  async getInstance(name) {
    const m = mockState.get(name);
    if (!m) return { state: 'unknown', publicIp: null };
    if (Date.now() - m.created > 5000) {
      m.state = 'running';
      m.publicIp ??= '127.0.0.1';
    }
    return { state: m.state, publicIp: m.publicIp };
  },
  async deleteInstance(name) {
    mockState.delete(name);
  },
  async createSnapshot(instanceName, snapshotName) {
    mockSnapshots.set(snapshotName, { created: Date.now() });
  },
  async getSnapshotState(snapshotName) {
    const s = mockSnapshots.get(snapshotName);
    if (!s) return 'unknown';
    return Date.now() - s.created > 3000 ? 'available' : 'pending';
  },
  async deleteSnapshot(snapshotName) {
    mockSnapshots.delete(snapshotName);
  },
  async createFromSnapshot({ name }) {
    mockState.set(name, { state: 'pending', publicIp: null, created: Date.now() });
  },
  async allocateStaticIp(ipName) {
    if (!mockIps.has(ipName)) {
      // deterministic fake address per name — survives "pause/resume"
      let h = 0;
      for (const c of ipName) h = (h * 31 + c.charCodeAt(0)) % 250;
      mockIps.set(ipName, `203.0.113.${h + 1}`);
    }
    return mockIps.get(ipName);
  },
  async attachStaticIp(ipName, instanceName) {
    const m = mockState.get(instanceName);
    if (m) m.publicIp = mockIps.get(ipName);
  },
  async releaseStaticIp(ipName) {
    mockIps.delete(ipName);
  },
};

export function getProvider() {
  return process.env.MOCK_PROVIDER ? mock : lightsail;
}
