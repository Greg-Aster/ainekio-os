<script lang="ts">
  import MapPorts from './MapPorts.svelte'
  import NodeSurface from './NodeSurface.svelte'

  type MapData = {
    title: string
    description?: string
    kind?: string
    shape?: string
    width?: number
    height?: number
    presentation?: string
    entryCategory?: string
    entryType?: string
    sectionTitle?: string
    typeLabel?: string
    runtime?: string
  }

  let { id, data, selected = false }: { id: string; data: MapData; selected?: boolean } = $props()

  const kinds: Record<string, { label: string; accent: string }> = {
    brain: { label: 'Process', accent: '#b59bff' },
    engine: { label: 'Library', accent: '#9d90c6' },
    execution: { label: 'Execution', accent: '#cfb8ff' },
    control: { label: 'Body Control', accent: '#62d9c3' },
    body: { label: 'Robot', accent: '#edbf69' },
    sensor: { label: 'Sensor', accent: '#d8bb82' },
    support: { label: 'Supporting component', accent: '#9caec3' },
    model: { label: 'Model preset', accent: '#b8a2e3' },
    provider: { label: 'Provider', accent: '#a3b4ce' },
    speech: { label: 'Speech service', accent: '#66c9ee' },
    ui: { label: 'Interface', accent: '#7eb7ff' },
    human: { label: 'Person', accent: '#e0e9f5' },
    destination: { label: 'Output', accent: '#9caec3' },
  }
  const appearance = $derived(kinds[data.kind ?? 'support'] ?? kinds.support)
  const shapeNames: Record<string, string> = { '((': 'circle', '(': 'window', '([': 'capsule', '[[': 'double', '[': 'rectangle', '{{': 'hexagon', '[/': 'parallelogram', '>': 'tag' }
  const silhouette = $derived(shapeNames[data.shape ?? ''] ?? data.shape ?? (data.kind === 'human' ? 'circle' : 'rectangle'))
  const surfaceWidth = $derived(data.width ?? (silhouette === 'circle' ? 200 : 260))
  const surfaceHeight = $derived(data.height ?? (silhouette === 'circle' ? 200 : 160))
  const shapeLabels: Record<string, string> = { circle: 'Person', window: 'Interface', capsule: 'Process', double: 'Execution / control owner', hexagon: 'Service API', parallelogram: 'Hardware', tag: 'Model preset', rectangle: 'Library function' }
  const typeLabel = $derived(data.typeLabel ?? (silhouette === 'rectangle' && ['control', 'body', 'sensor', 'support'].includes(data.kind ?? '') ? 'Component' : shapeLabels[silhouette] ?? 'Component'))
</script>

<article class={`map-node shape-${silhouette} category-${data.entryCategory ?? ''}`} class:list-row={data.presentation === 'list'} class:process={data.runtime === 'process'} class:selected style:--accent={appearance.accent} aria-label={data.title}>
  {#if data.sectionTitle}<div class="section-heading">{data.sectionTitle}</div>{/if}
  {#if data.presentation !== 'list'}
  <NodeSurface shape={silhouette} width={surfaceWidth} height={surfaceHeight} accent={appearance.accent} {selected} />
  {/if}
  <MapPorts {selected} />
  <div class="node-content">
  {#if data.presentation === 'list'}
    <span class="entry-type">{data.entryType}</span>
    <h3>{data.title}</h3>
    {#if data.description}<p>{data.description}</p>{/if}
  {:else if silhouette === 'circle'}
    <svg class="human-image" viewBox="0 0 80 80" role="img" aria-label="Human silhouette">
      <circle cx="40" cy="20" r="13" fill="currentColor" />
      <path d="M16 72V61c0-14 10-24 24-24s24 10 24 24v11Z" fill="currentColor" />
    </svg>
    <h3>{data.title}</h3>
    <div class="eyebrow">{typeLabel}</div>
  {:else}
  <div class="eyebrow">
    <span class="type-marker" aria-hidden="true"></span>
    <span>{typeLabel}</span>
  </div>
  <h3>{data.title}</h3>
  {#if data.description}<p>{data.description}</p>{/if}
  {/if}
  </div>
</article>

<style>
  .map-node {
    position: relative;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    color: #e7edf5;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  .node-content { position: relative; z-index: 1; width: 100%; height: 100%; box-sizing: border-box; padding: 17px 18px 16px; }
  .shape-window .node-content { padding-top: 32px; }
  .shape-double .node-content { padding-left: 24px; padding-right: 24px; }
  .shape-capsule .node-content { padding: 20px 35px; text-align: center; }
  .shape-capsule .eyebrow { justify-content: center; }
  .shape-hexagon .node-content, .shape-parallelogram .node-content, .shape-tag .node-content { padding-left: 32px; padding-right: 32px; }
  .shape-circle .node-content { padding: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .shape-circle .eyebrow { margin-top: 6px; }
  .human-image { width: 72px; height: 72px; color: var(--accent); flex: 0 0 auto; }
  .eyebrow { display: flex; align-items: center; gap: 7px; color: var(--accent); font-size: 10px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
  .type-marker { width: 6px; height: 6px; border: 1px solid currentColor; border-radius: 2px; flex: 0 0 auto; }
  h3 { margin: 9px 0 0; color: #f2f5fa; font-size: 15px; font-weight: 650; line-height: 1.35; letter-spacing: -.015em; overflow-wrap: anywhere; }
  p { margin: 8px 0 0; color: #b4c1d2; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .list-row { background: #182130; border-left: 3px solid var(--accent); border-bottom: 1px solid #344052; }
  .list-row.selected { background: #263249; outline: 1px solid var(--accent); }
  .list-row .node-content { padding: 12px 16px; text-align: left; }
  .list-row h3 { margin: 0; font-size: 14px; line-height: 20px; }
  .list-row p { margin: 3px 0 0; font-size: 12px; line-height: 18px; }
  .list-row h3 { padding-right: 115px; }
  .section-heading { position: absolute; top: -28px; left: -3px; color: #c8d5e7; font-size: 12px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; pointer-events: none; }
  .entry-type { position: absolute; top: 14px; right: 14px; font-size: 10px; color: var(--accent); }
  .category-infrastructure { --accent: #9caec3 !important; background: transparent; border-left: 0; border-bottom: 1px dashed #526075; }
  .category-agents { --accent: #b59bff !important; }
  .category-workflows { --accent: #7eb7ff !important; border-left: 4px double var(--accent); background: #182739; }
  .category-services { --accent: #62d9c3 !important; background: #152b2d; }
  .category-services .entry-type::before { content: ''; display: inline-block; width: 6px; height: 6px; border: 1px solid currentColor; border-radius: 50%; margin-right: 5px; }
  .list-row.process { border: 1px dashed var(--accent); border-left: 3px solid var(--accent); }
  .process:not(.list-row)::after { content: ''; position: absolute; inset: -5px; border: 1px dashed #9baec3; border-radius: 18px; pointer-events: none; }
</style>
