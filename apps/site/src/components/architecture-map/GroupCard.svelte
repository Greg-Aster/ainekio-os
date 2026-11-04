<script lang="ts">
  import MapPorts from './MapPorts.svelte'
  import NodeSurface from './NodeSurface.svelte'

  type GroupData = {
    title: string
    description?: string
    kind?: string
    groupLabel?: string
    count?: number
    isGroup?: boolean
    groupId?: string
    onToggle?: (groupId: string) => void
  }

  let { id, data, selected = false }: { id: string; data: GroupData; selected?: boolean } = $props()
  const accents: Record<string, string> = {
    brain: '#b59bff', engine: '#b59bff', execution: '#cfb8ff',
    control: '#62d9c3', body: '#edbf69', sensor: '#d8bb82',
    ui: '#7eb7ff', speech: '#66c9ee', model: '#b8a2e3',
    provider: '#a3b4ce', support: '#9caec3', human: '#e0e9f5',
  }
  const profiles: Record<string,{shape:string;label:string}> = {
    MH:{shape:'folder',label:'Software system'}, BC:{shape:'folder',label:'Application'},
    ENGINE:{shape:'folder',label:'Library'}, AGENTS:{shape:'stack',label:'Agents'},
    BODY:{shape:'device',label:'Hardware'}, INPUTS:{shape:'window',label:'Interfaces'},
    INFERENCE:{shape:'rack',label:'Services'}, LLAMA:{shape:'rack',label:'Host'},
    OTHER:{shape:'hexagon',label:'Providers'}, SPEECH:{shape:'hexagon',label:'Services'},
    STATE:{shape:'stack',label:'Stored data'}, TRAINING:{shape:'folder',label:'Training tools'},
  }
  const profile = $derived(profiles[data.groupId ?? id] ?? {shape:'folder',label:'Group'})
  const accent = $derived(accents[data.kind ?? 'support'] ?? accents.support)
  function toggle(event: MouseEvent) {
    event.stopPropagation()
    data.onToggle?.(data.groupId ?? id)
  }
</script>

<article class="group-card" class:selected data-shape={profile.shape} style:--accent={accent} aria-label={`${data.title} subsystem`}>
  <NodeSurface shape={profile.shape} width={300} height={180} {accent} {selected} />
  <MapPorts {selected} />
  <header>
    <h3>{data.title}</h3>
  </header>
  {#if data.description}<p>{data.description.split('\n')[0]}</p>{/if}
  <footer>
    {#if data.count !== undefined}<span class="count">{data.groupLabel ?? profile.label} · {data.count} components</span>{/if}
    <button class="nodrag nopan expand" onclick={toggle} aria-label={`Expand ${data.title}`} aria-expanded="false">
      Expand group <span aria-hidden="true">+</span>
    </button>
  </footer>
</article>

<style>
  .group-card {
    width: 300px;
    height: 180px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 16px 18px 13px;
    position:relative;
    border:0;
    background:transparent;
    color: #edf2f9;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;

  }
  .group-card[data-shape="folder"] { padding-top:28px; }
  .group-card[data-shape="window"] { padding-top:36px; }
  .group-card[data-shape="stack"] { padding:27px 25px 15px 18px; }
  .group-card[data-shape="rack"] { padding:20px 30px 14px; }
  .group-card[data-shape="hexagon"] { padding:20px 35px 16px; }
  header,p,footer { position:relative;z-index:1; }
  header { flex: 0 0 auto; }
  .count { color: #98a8bd; font-size: 10px; white-space: nowrap; }
  h3 { margin: 0; min-width: 0; color: #f3f6fb; font-size: 18px; font-weight: 650; line-height: 1.3; letter-spacing: -.025em; overflow-wrap: anywhere; }
  p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; margin: 9px 0 0; color: #b9c6d7; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
  footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; padding-top: 10px; border-top: 1px solid #344052; }
  .expand { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
  .expand:focus-visible { outline: 2px solid var(--accent); outline-offset: 5px; border-radius: 3px; }
</style>
