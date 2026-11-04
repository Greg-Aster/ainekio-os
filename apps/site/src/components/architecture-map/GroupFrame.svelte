<script lang="ts">
  import MapPorts from './MapPorts.svelte'

  type GroupData = {
    title: string
    description?: string
    count?: number
    groupId?: string
    groupLabel?: string
    boundary?: string
    onToggle?: (groupId: string) => void
  }

  let { id, data, selected = false }: { id: string; data: GroupData; selected?: boolean } = $props()

  function toggle(event: MouseEvent) {
    event.stopPropagation()
    data.onToggle?.(data.groupId ?? id)
  }
</script>

<section class={`group-frame boundary-${data.boundary ?? 'area'}`} class:selected aria-label={`${data.title} expanded group`}>
  <MapPorts {selected} />
  <header class="group-header">
    <div class="group-title">
      <div class="title-row"><h3>{data.title}</h3>{#if data.groupLabel}<span class="boundary-label">{data.groupLabel}</span>{/if}{#if data.count !== undefined}<span class="count">{data.count} components</span>{/if}</div>
      {#if data.description}<p title={data.description}>{data.description}</p>{/if}
    </div>
    <button class="nodrag nopan group-collapse" onclick={toggle} aria-label={`Collapse ${data.title}`} aria-expanded="true">
      Collapse <span aria-hidden="true">−</span>
    </button>
  </header>
</section>

<style>
  .group-frame {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    border: 1px solid #546173;
    border-radius: 12px;
    background: #26344552;
    color: #d8e2ef;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  .group-frame.selected { border-color: #a0b1c7; box-shadow: 0 0 0 1px #a0b1c730; }
  .boundary-system { border: 2px solid #9d87cc; background: #8b6cc90a; border-radius: 18px; }
  .boundary-system > .group-header { background: #74569a25; border-radius: 16px 16px 0 0; }
  .boundary-library { border-style: dotted; background: #72638d12; }
  .boundary-data { border-style: double; border-width: 3px; background: #577d6a12; }
  .boundary-label { font-size: 10px; color: #c6b4e8; border: 1px solid #6c6382; border-radius: 3px; padding: 2px 5px; }
  .group-header { height: 74px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 18px; border-bottom: 1px solid #4c5b6e80; border-radius: 11px 11px 0 0; background: #26344575; cursor: grab; }
  .group-header:active { cursor: grabbing; }
  .group-title { min-width: 0; flex: 1; }
  .title-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 7px 12px; }
  h3 { margin: 0; color: #e9eef6; font-size: 15px; font-weight: 650; line-height: 1.3; letter-spacing: -.015em; overflow-wrap: anywhere; }
  .count { color: #97a9bf; font-size: 10px; white-space: nowrap; }
  p { margin: 5px 0 0; color: #9fb1c8; font-size: 11px; line-height: 1.4; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .group-collapse { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; padding: 6px 9px; border: 1px solid #5c6d84; border-radius: 5px; background: #182231b3; color: #c4d2e5; font: inherit; font-size: 11px; cursor: pointer; }
  .group-collapse:hover { color: #f0f5fc; border-color: #9aadc6; }
  .group-collapse:focus-visible { outline: 2px solid #9db9df; outline-offset: 3px; }
</style>
