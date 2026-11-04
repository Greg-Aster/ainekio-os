<script lang="ts">
  let { shape = 'rectangle', width, height, accent, selected = false }: {
    shape?: string
    width: number
    height: number
    accent: string
    selected?: boolean
  } = $props()

  const right = $derived(width - 1)
  const bottom = $derived(height - 1)
  const midX = $derived(width / 2)
  const midY = $derived(height / 2)
  const strokeWidth = $derived(selected ? 2.3 : 1.4)
  const strokeOpacity = $derived(selected ? 1 : 0.8)
  const hex = $derived(`22,1 ${width - 22},1 ${right},${midY} ${width - 22},${bottom} 22,${bottom} 1,${midY}`)
  const slant = $derived(`24,1 ${right},1 ${width - 24},${bottom} 1,${bottom}`)
  const tag = $derived(`1,1 ${right},1 ${right},${bottom} 1,${bottom} 18,${midY}`)
  const device = $derived(`20,1 ${width - 20},1 ${right},20 ${right},${height - 20} ${width - 20},${bottom} 20,${bottom} 1,${height - 20} 1,20`)
  const folder = $derived(`M1 20V7Q1 1 7 1H${width * 0.6}L${width * 0.6 + 22} 20H${width - 7}Q${right} 20 ${right} 26V${height - 7}Q${right} ${bottom} ${width - 7} ${bottom}H7Q1 ${bottom} 1 ${height - 7}Z`)
</script>

<svg class="node-surface" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
  <g fill="#17202d" stroke={accent} stroke-width={strokeWidth} stroke-opacity={strokeOpacity} stroke-linejoin="miter">
    {#if shape === 'circle'}
      <circle cx={midX} cy={midY} r={Math.min(width, height) / 2 - 1} />
    {:else if shape === 'capsule'}
      <rect x="1" y="1" width={width - 2} height={height - 2} rx={Math.min(width, height) / 2 - 1} />
    {:else if shape === 'hexagon'}
      <polygon points={hex} />
    {:else if shape === 'parallelogram'}
      <polygon points={slant} />
      <path d={`M1 ${midY}H12.5M${width - 12.5} ${midY}H${right}`} fill="none" />
    {:else if shape === 'tag'}
      <polygon points={tag} />
      <path d={`M1 ${midY}H18`} fill="none" />
    {:else if shape === 'folder'}
      <path d={folder} />
    {:else if shape === 'stack'}
      <rect x="1" y="1" width={width - 2} height={height - 2} stroke-opacity="0.45" />
      <rect x="1" y="7" width={width - 8} height={height - 8} stroke-opacity="0.65" />
      <rect x="1" y="13" width={width - 14} height={height - 14} />
    {:else if shape === 'device'}
      <polygon points={device} />
    {:else}
      <rect x="1" y="1" width={width - 2} height={height - 2} />
      {#if shape === 'double'}
        <path d={`M10 1V${bottom}M${width - 10} 1V${bottom}`} fill="none" />
      {:else if shape === 'window'}
        <path d={`M1 21H${right}`} fill="none" stroke-opacity="0.6" />
        <g fill={accent} stroke="none" opacity="0.65"><circle cx="11" cy="11" r="2" /><circle cx="19" cy="11" r="2" /><circle cx="27" cy="11" r="2" /></g>
      {:else if shape === 'rack'}
        <path d={`M13 1V${bottom}M${width - 13} 1V${bottom}`} fill="none" stroke-opacity="0.5" />
        <g fill={accent} stroke="none" opacity="0.65"><circle cx="7" cy="12" r="2" /><circle cx={width - 7} cy="12" r="2" /><circle cx="7" cy={height - 12} r="2" /><circle cx={width - 7} cy={height - 12} r="2" /></g>
      {/if}
    {/if}
  </g>
</svg>

<style>
  .node-surface { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
</style>
