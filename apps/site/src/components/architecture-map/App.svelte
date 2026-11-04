<script lang="ts">
  import { onMount } from 'svelte'
  import '@xyflow/svelte/dist/style.css'
  import { SvelteFlow, Controls, MiniMap, Background, BackgroundVariant, type Node, type Edge } from '@xyflow/svelte'
  import MapNode from './MapNode.svelte'
  import GroupCard from './GroupCard.svelte'
  import GroupFrame from './GroupFrame.svelte'
  import ReadAloud from './ReadAloud.svelte'
  import architectureData from './architecture.json'
  import { buildCanvas, defaultExpandedGroups, type Architecture, type Position } from './canvas-model'

  const architecture = architectureData as unknown as Architecture
  const nodeTypes = { mapNode: MapNode, groupCard: GroupCard, groupFrame: GroupFrame }
  const storageKey = 'metahuman-architecture-canvas-v3'
  const layoutVersion = 'software-boundaries-2'
  const colors: Record<string,string> = {brain:'#8c73b9',engine:'#5f557b',execution:'#aa91ce',control:'#4da395',body:'#b88b48',sensor:'#b88b48',model:'#82749f',provider:'#6a7b93',ui:'#5e8cba',human:'#abb9cb',support:'#6a7b93',speech:'#518ba5'}
  const lineColors=['#56d9f5','#ffbf69','#bc9cff','#6ee7a0','#ff87b2','#80adff','#e5dc71','#ee9aff']
  let nodes = $state<Node[]>([])
  let edges = $state<Edge[]>([])
  let expanded = defaultExpandedGroups(architecture)
  let positions: Record<string,Position> = {}
  let viewport = $state({x: 36,y: 72,zoom:0.8})
  let selected = $state<any>(null)
  let query = $state('')
  let ready = $state(false)
  let status = $state('')
  let results = $derived(query.trim() ? architecture.nodes.filter(node => `${node.title} ${node.description} ${JSON.stringify(node.details)} ${node.sourcePaths.join(' ')}`.toLowerCase().includes(query.toLowerCase())) : [])

  function redraw() {
    const view = buildCanvas(architecture,expanded,positions)
    nodes = view.nodes.map(node => ({...node, data:{...node.data,onToggle:toggleGroup}})) as Node[]
    edges = view.edges.map((edge,index)=>({...edge,label:undefined,interactionWidth:28,data:{...edge.data,color:lineColors[index%lineColors.length],baseStyle:edge.style}})) as Edge[]
    if (selected?.id) focusNode(selected.id)
  }
  function save() {
    try {localStorage.setItem(storageKey,JSON.stringify({layoutVersion,expanded:[...expanded],positions,viewport}));status=''}
    catch {status='Layout could not be saved in this browser.'}
  }
  function toggleGroup(id:string) {
    if(expanded.has(id))expanded.delete(id);else expanded.add(id)
    selected=null;redraw();save()
  }
  function expandAll(){expanded=defaultExpandedGroups(architecture);selected=null;redraw();save()}
  function collapseAll(){expanded=new Set();selected=null;redraw();save()}
  function resetLayout(){positions={};expanded=defaultExpandedGroups(architecture);selected=null;viewport={x:36,y:72,zoom:0.8};redraw();save()}
  function selectNode(event:any) {
    focusNode(event.node.id)
  }
  function connectionLabel(edge:Edge):string {
    const connections=edge.data?.connections as Architecture['edges'] | undefined
    return connections?.length===1 ? connections[0].label : `${connections?.length??0} connections`
  }
  function componentTitle(id:string):string {
    return architecture.nodes.find(node=>node.id===id)?.title??architecture.groups.find(group=>group.id===id)?.title??id
  }
  function presentEdge(edge:Edge,active:boolean,animate=false):Edge {
    const color=active?String(edge.data?.color):'#59687e'
    const bidirectional=Boolean(edge.markerStart)
    return {...edge,label:active?connectionLabel(edge):undefined,
      class:active?`connected${animate?' flowing':''}${animate&&bidirectional?' flow-both':''}`:'muted',
      zIndex:active?1:0,
      style:`${edge.data?.baseStyle??''};--connection-color:${color}`,
      labelStyle:`color:${color};border-color:${color}`,
      markerEnd:typeof edge.markerEnd==='object'?{...edge.markerEnd,color}:edge.markerEnd,
      markerStart:typeof edge.markerStart==='object'?{...edge.markerStart,color}:edge.markerStart,
    }
  }
  function connectionDetails(edge:Edge) {
    return (edge.data?.connections as Architecture['edges']??[]).map(connection=>({...connection,color:edge.data?.color}))
  }
  function focusNode(id:string) {
    const node=nodes.find(node=>node.id===id)
    if(!node)return
    let colorIndex=0
    edges=edges.map(edge=>edge.source===id||edge.target===id?{...edge,data:{...edge.data,color:lineColors[colorIndex++%lineColors.length]}}:edge)
    const connected=edges.filter(edge=>edge.source===id||edge.target===id)
    selected={...node.data,id,connections:connected.flatMap(connectionDetails)}
    edges=edges.map(edge=>presentEdge(edge,edge.source===id||edge.target===id))
  }
  function selectEdge(event:any) {
    const edge=event.edge as Edge
    selected={title:`${componentTitle(edge.source)} ${edge.markerStart?'↔':'→'} ${componentTitle(edge.target)}`,isConnection:true,description:'The animation illustrates direction, not live traffic.',connections:connectionDetails(edge)}
    edges=edges.map(item=>presentEdge(item,item.id===edge.id,true))
  }
  function selectConnection(id:string){const edge=edges.find(edge=>(edge.data?.connections as Architecture['edges'])?.some(connection=>connection.id===id));if(edge)selectEdge({edge})}
  function clearSelection(){selected=null;redraw()}
  function saveDrag({nodes:dragged}:{nodes:Node[]}){for(const node of dragged)positions[node.id]={...node.position};redraw();save()}
  function detailLines(value:unknown):string[]{return Array.isArray(value)?value:typeof value==='string'?value.split('\n').filter(Boolean):[]}
  function readingText(item:any):string {
    return [item.title,item.description,...detailLines(item.details),
      ...(item.sourcePaths?.length ? ['Source locations.',...item.sourcePaths] : []),
      ...(item.endpoints?.length ? ['Endpoints.',...item.endpoints] : []),
      ...(item.connections??[]).map((connection:any)=>`${componentTitle(connection.source)} ${connection.bidirectional?'and':'to'} ${componentTitle(connection.target)}. ${connection.label}`),
    ].filter(Boolean).join('\n\n')
  }
  function findNode(id:string){
    const source=architecture.nodes.find(node=>node.id===id)
    let group=source?.group
    while(group){expanded.add(group);group=architecture.groups.find(item=>item.id===group)?.parent ?? null}
    redraw();query=''
    const node=nodes.find(node=>node.id===id)
    if(!node)return
    let x=node.position.x,y=node.position.y,parent=node.parentId
    while(parent){const frame=nodes.find(n=>n.id===parent);if(!frame)break;x+=frame.position.x;y+=frame.position.y;parent=frame.parentId}
    viewport={x:80-x*0.9,y:100-y*0.9,zoom:0.9}
    focusNode(node.id);save()
  }
  onMount(()=>{
    try{const saved=JSON.parse(localStorage.getItem(storageKey)??'null');if(saved?.layoutVersion===layoutVersion){expanded=new Set(saved.expanded);positions=saved.positions??{};viewport=saved.viewport??viewport}}catch{}
    redraw();ready=true;save()
  })
</script>

<svelte:head><title>System architecture · MetaHuman OS</title></svelte:head>

<main aria-label="System architecture canvas" style:--label-scale={1/viewport.zoom}>
  {#if ready}
    <SvelteFlow bind:nodes bind:edges bind:viewport {nodeTypes} colorMode="dark" minZoom={0.1} maxZoom={2.5} nodesConnectable={false} elementsSelectable deleteKey={null} panOnScroll zoomOnScroll={false} zoomOnPinch panOnDrag onnodeclick={selectNode} onedgeclick={selectEdge} onpaneclick={clearSelection} onnodedragstop={saveDrag} onmoveend={save}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} patternColor="#202a37" />
      <Controls showLock={false} position="bottom-left" />
      <MiniMap position="bottom-right" pannable zoomable nodeColor={(node)=>colors[String(node.data?.kind)]??'#64748b'} nodeStrokeColor="#a2b1c3" maskColor="rgba(6,11,18,0.68)" ariaLabel="Canvas overview map" />
    </SvelteFlow>
  {/if}
  <div class="map-tools"><div class="search"><input aria-label="Find component" bind:value={query} placeholder="Find a component…" autocomplete="off" />{#if query}<div class="results">{#each results as result}<button onclick={()=>findNode(result.id)}>{result.title}</button>{/each}{#if !results.length}<p>No matching components</p>{/if}</div>{/if}</div><button class="map-action" onclick={expandAll} disabled={nodes.filter(node=>node.type==='groupFrame').length===architecture.groups.length}>Expand all</button><button class="map-action" onclick={collapseAll} disabled={!nodes.some(node=>node.type==='groupFrame')}>Collapse all</button><button class="map-action" onclick={resetLayout}>Reset layout</button></div>
  {#if status}<div class="save-error" role="status">{status}</div>{/if}
  {#if selected}<aside class="details"><button class="close" aria-label="Close details" onclick={clearSelection}>×</button><h2>{selected.title}</h2>
    {#key selected}<ReadAloud text={readingText(selected)} />{/key}
    {#if selected.description}<p>{selected.description}</p>{/if}
    {#if selected.isGroup}<button class="toggle" onclick={()=>toggleGroup(selected.groupId??selected.id)}>{selected.expanded?'Collapse group':'Expand group'}</button>{/if}
    {#if selected.connections?.length}
      <h3>{selected.isConnection?'Data sent':'Connected lines'}</h3>
      {#if !selected.isConnection}<p>Click a line or an entry below to inspect its data flow.</p>{/if}
      {#each selected.connections as connection}
        <button class="connection" style:--line-color={connection.color} onclick={()=>selectConnection(connection.id)}><strong>{componentTitle(connection.source)} {connection.bidirectional?'↔':'→'} {componentTitle(connection.target)}</strong><span>{connection.label}</span>{#if selected.isConnection}<small>{connection.bidirectional?'Two-way connection':'One-way connection'}</small>{/if}</button>
      {/each}
    {/if}
    {#if detailLines(selected.details).length}<h3>Details</h3>{#each detailLines(selected.details) as detail}<p>{detail}</p>{/each}{/if}
    {#if selected.sourcePaths?.length}<h3>Source</h3>{#each selected.sourcePaths as path}<code>{path}</code>{/each}{/if}
    {#if selected.endpoints?.length}<h3>Endpoint</h3>{#each selected.endpoints as endpoint}<code class="endpoint">{endpoint}</code>{/each}{/if}
  </aside>{/if}
</main>

<style>
  :global(body){margin:0;background:#0d131c;color:#dce5ef;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}:global(*){box-sizing:border-box}:global(button),:global(input){font:inherit}:global(button){cursor:pointer}:global(button:focus-visible),:global(input:focus-visible){outline:2px solid #829fc5;outline-offset:3px}main{height:100dvh;width:100%;position:relative;overflow:hidden}:global(.svelte-flow){background:#0d131c}:global(.svelte-flow__controls){box-shadow:none;border:1px solid #394556;border-radius:6px;overflow:hidden}:global(.svelte-flow__controls-button){background:#1b2634;color:#cbd5e1;border-color:#394556;fill:currentColor}:global(.svelte-flow__minimap){background:#131e2b;border:1px solid #405066;border-radius:7px;overflow:hidden}:global(.svelte-flow__edge.connected .svelte-flow__edge-path){stroke:var(--connection-color)!important;stroke-width:3!important;vector-effect:non-scaling-stroke}:global(.svelte-flow__edge.muted){opacity:.18}:global(.svelte-flow__edge-label){font-size:calc(14px * var(--label-scale))!important;font-weight:650;line-height:1.4;max-width:calc(250px * var(--label-scale));white-space:normal;text-align:center;padding:calc(6px * var(--label-scale)) calc(10px * var(--label-scale));border:calc(1px * var(--label-scale)) solid;border-radius:calc(6px * var(--label-scale));background:#101b2a!important;box-shadow:0 2px 12px #0009}.map-tools{position:absolute;top:16px;left:16px;display:flex;gap:8px;z-index:5;align-items:start}.search{position:relative}.search input{width:230px;border:1px solid #394759;background:#16212eee;border-radius:6px;padding:9px 12px;color:#e1e9f4;font-size:12px}.search input::placeholder{color:#8b9cb1}.map-action{border:1px solid #394759;background:#16212eee;color:#a9b9cc;padding:9px 12px;border-radius:6px;font-size:12px}.map-action:disabled{opacity:.4;cursor:default}.results{position:absolute;left:0;right:0;top:43px;max-height:360px;overflow:auto;background:#172331;border:1px solid #405168;border-radius:6px;box-shadow:0 12px 30px #0005}.results button{display:block;text-align:left;background:none;border:0;padding:11px 12px;color:#d1deed;width:100%;font-size:12px}.results button:hover{background:#26374c}.results p{padding:10px;font-size:12px;color:#94a9c3}.details{position:absolute;right:16px;top:16px;bottom:190px;width:300px;z-index:8;overflow:auto;padding:20px;background:#172230f5;border:1px solid #43536a;border-radius:9px;box-shadow:0 10px 35px #0005}.close{float:right;line-height:1;border:0;background:none;font-size:23px;color:#a8bbd4}.details h2{font-size:19px;font-weight:600;margin:6px 25px 14px 0;line-height:1.4}.details p{font-size:12px;line-height:1.65;color:#aebfd2}.details h3{font-size:11px;font-weight:600;color:#8da4c1;margin:22px 0 10px}.details code{display:block;color:#a5cdb9;font-size:10px;line-height:1.8;overflow-wrap:anywhere;margin-bottom:8px}.details .endpoint{color:#d5c496}.toggle{border:1px solid #4b607d;background:#263b53;color:#d5e4f8;border-radius:5px;padding:8px 12px;font-size:12px}.connection{display:block;width:100%;text-align:left;padding:10px 12px;margin:8px 0;border:1px solid #354257;border-left:4px solid var(--line-color);border-radius:5px;background:#101b2a;color:#e1eaf6;cursor:pointer}.connection:hover{background:#223249}.connection strong{display:block;font-size:13px;line-height:1.5;color:var(--line-color)}.connection span{display:block;margin-top:6px;font-size:14px;line-height:1.6}.connection small{display:block;margin-top:6px;font-size:12px;color:#aebfd2}.save-error{position:absolute;bottom:18px;left:65px;color:#e9bd81;background:#25211b;padding:8px;border-radius:5px;font-size:11px;z-index:4}@media(max-width:650px){.map-tools{top:10px;left:10px}.search input{width:190px}.map-action{padding-left:8px;padding-right:8px}.details{width:270px;right:10px;top:58px;bottom:170px}}
  :global(.svelte-flow__edge.flowing .svelte-flow__edge-path){stroke-dasharray:10 7!important;animation:connection-flow 1s linear infinite}
  :global(.svelte-flow__edge.flow-both .svelte-flow__edge-path){animation:connection-flow 1s linear infinite alternate}
  @keyframes -global-connection-flow{from{stroke-dashoffset:34}to{stroke-dashoffset:0}}
</style>
