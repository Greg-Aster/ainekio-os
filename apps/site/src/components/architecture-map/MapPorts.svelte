<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte'

  let { selected = false }: { selected?: boolean } = $props()

  const sides = [
    { side: 'left', position: Position.Left },
    { side: 'right', position: Position.Right },
    { side: 'top', position: Position.Top },
    { side: 'bottom', position: Position.Bottom },
  ] as const
  const portStyle = $derived(`width:7px;height:7px;border:1px solid #192333;background:#91a4be;opacity:${selected ? '.55' : '.15'};pointer-events:none`)
</script>

{#each sides as side}
  <Handle type="target" position={side.position} id={`in-${side.side}`} isConnectable={false} style={portStyle} />
  <Handle type="source" position={side.position} id={`out-${side.side}`} isConnectable={false} style={portStyle} />
{/each}
