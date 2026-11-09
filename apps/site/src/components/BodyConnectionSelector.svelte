<script lang="ts">
  import type { EnvironmentBridgeDiagnosticsSnapshot } from '../lib/client/environment-bridge-diagnostics-types';
  interface ConnectionAgent {
    id: string;
    variables: { key: string; value: string | number | boolean | string[] | null }[];
  }
  export let agents: ConnectionAgent[] = [];
  export let connections: EnvironmentBridgeDiagnosticsSnapshot['connections'] = [];
  let robotId = '';
  $: robotIds = [...new Set(connections.filter(item => item.connected && item.robotId).map(item => item.robotId!))];
  export let busy = false;
  export let reveal = false;
  export let onConnect: (agent: string, settings: Record<string, string | number | boolean>) => Promise<void>;

  let route = 'local';
  let followRobot = false;
  let initialized = false;
  let localUrl = '';
  let remoteUrl = '';
  let sshTarget = '';
  let sshGatewayPort = 8790;
  let cloudflareHostname = '';
  let accessEnvFile = '';

  function value(id: string, key: string) {
    return agents.find(agent => agent.id === id)?.variables.find(variable => variable.key === key)?.value;
  }

  $: if (!initialized && agents.some(agent => agent.id === 'environment-bridge')) {
    localUrl = String(value('environment-bridge', 'adapterUrl') || 'ws://127.0.0.1:8790/environment');
    remoteUrl = String(value('environment-bridge', 'remoteAdapterUrl') || '');
    robotId = String(value('environment-bridge', 'robotId') || '');
    sshTarget = String(value('environment-bridge', 'sshTarget') || '');
    sshGatewayPort = Number(value('environment-bridge', 'sshGatewayPort') ?? 8790);
    cloudflareHostname = String(value('environment-bridge', 'cloudflareHostname') || '');
    accessEnvFile = String(value('environment-bridge', 'accessEnvFile') || '');
    route = String(value('environment-bridge', 'transport') || 'local');
    followRobot = value('environment-bridge', 'followRobot') === true;
    initialized = true;
  }

  async function connect() {
    await onConnect('environment-bridge', { adapterUrl: localUrl, remoteAdapterUrl: remoteUrl,
      robotId, followRobot, transport: route, sshTarget, sshGatewayPort, cloudflareHostname, accessEnvFile });
  }

  function revealSection(node: HTMLFormElement, requested: boolean) {
    function update(visible: boolean) {
      if (!visible) return;
      node.scrollIntoView({ block: 'nearest' });
      node.querySelector('select')?.focus({ preventScroll: true });
    }
    update(requested);
    return { update };
  }
</script>

{#if initialized}
  <form id="body-connection" use:revealSection={reveal} class="mt-3 space-y-2 rounded border border-gray-300 p-2 dark:border-gray-700" on:submit|preventDefault={connect}>
    <fieldset disabled={busy} class="space-y-2 disabled:opacity-50">
      <legend class="text-xs font-semibold">Body connection</legend>
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={followRobot} /> Follow the same robot across saved hosts</label>
      <label class="block text-xs">{followRobot ? 'Saved remote connection' : 'Connection'}
        <select bind:value={route} class="mt-1 w-full rounded border bg-white p-2 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
          <option value="local">{followRobot ? "No remote host" : "Local — this computer"}</option>
          <option value="ssh">Remote — SSH</option>
          <option value="cloudflare">Remote — Cloudflare Access</option>
        </select>
      </label>
      <label class="block text-xs">Robot
        <select bind:value={robotId} class="mt-1 w-full rounded border bg-white p-2 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
          <option value="">Use Body Control’s selected robot</option>
          {#each robotIds as id}<option value={id}>{id}</option>{/each}
          {#if robotId && !robotIds.includes(robotId)}<option value={robotId}>{robotId} (disconnected)</option>{/if}
        </select>
      </label>
      {#each connections as connection}
        <p class="break-all text-xs">{connection.endpoint} · Body Control: {connection.adapterConnected ? 'connected' : 'disconnected'} · Robot: {connection.connected ? connection.robotId || 'connected' : 'disconnected'} · Bridge: {connection.ready ? 'ready' : connection.active ? 'connecting' : 'not selected'}{connection.error ? ` — ${connection.error}` : ''}</p>
      {/each}
      <p class="text-xs text-gray-500">{followRobot ? 'The local host and saved remote route are watched. One stream follows the same robot; Body Control computer speech remains available when that robot disconnects.' : 'Only the selected connection runs. Body Control must be running on that computer.'}</p>
      {#if route === 'local' || followRobot}
      <label class="block text-xs">Local adapter URL
        <input required type="url" bind:value={localUrl} class="mt-1 w-full rounded border bg-transparent p-2" />
      </label>
      {/if}
      {#if route !== 'local'}
        {#if route === 'ssh'}
          <label class="block text-xs">SSH destination
            <input bind:value={sshTarget} placeholder="user@hostname or SSH host alias" class="mt-1 w-full rounded border bg-transparent p-2" />
          </label>
          <label class="block text-xs">Gateway port on remote machine
            <input required type="number" min="1" max="65535" bind:value={sshGatewayPort} class="mt-1 w-full rounded border bg-transparent p-2" />
          </label>
          <p class="text-xs text-gray-500 dark:text-gray-400">Set up trusted, noninteractive SSH access from the Ainekio OS machine first. SSH host aliases can specify a user, key and SSH port. This forwards the gateway, not the dashboard.</p>
        {:else}
          <label class="block text-xs">Cloudflare hostname
            <input bind:value={cloudflareHostname} placeholder="Your configured Access TCP hostname" class="mt-1 w-full rounded border bg-transparent p-2" />
          </label>
          <label class="block text-xs">Service token file on Ainekio OS machine
            <input bind:value={accessEnvFile} placeholder="Empty uses existing browser login" class="mt-1 w-full rounded border bg-transparent p-2" />
          </label>
        {/if}
        <label class="block text-xs">Forwarded adapter URL on Ainekio OS machine
          <input type="url" bind:value={remoteUrl} class="mt-1 w-full rounded border bg-transparent p-2" />
        </label>
      {/if}
      <p class="text-xs text-gray-500 dark:text-gray-400">Save and connect applies these settings. Automatic following uses only these saved hosts and the selected robot. Manual local mode leaves remote connections stopped.</p>
      <button type="submit" class="rounded bg-gray-900 px-3 py-2 text-xs font-semibold text-white dark:bg-gray-100 dark:text-gray-950">{busy ? 'Connecting…' : 'Save and connect'}</button>
    </fieldset>
  </form>
{/if}
