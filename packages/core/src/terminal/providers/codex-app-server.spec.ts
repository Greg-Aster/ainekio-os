import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { EscalationOptions } from '../../escalation-backend.js'
import type { ParsedBigBrotherEvent } from './cli.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-codex-model-'))
process.env.METAHUMAN_ROOT = root
fs.mkdirSync(path.join(root, 'etc'))
const receipts = path.join(root, 'receipts')
fs.mkdirSync(receipts)
const log = path.join(root, 'calls.jsonl')
fs.writeFileSync(log, '')
const executable = path.join(root, 'codex.cjs')
fs.writeFileSync(executable, `#!/usr/bin/env node
const fs=require('fs'), readline=require('readline'), spawn=require('child_process').spawn;
const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,...value})+'\\n');
record({args:process.argv.slice(2)});
const send = value => console.log(JSON.stringify(value));
const threadId='thread-'+process.pid, turnId='turn-'+process.pid;
let injected=[];
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line); record({message:msg});
  if(msg.method==='initialize') send({id:msg.id,result:{userAgent:'fixture'}});
  if(msg.method==='thread/start') {
    if(msg.params.baseInstructions==='rpc-failure') return send({id:msg.id,error:{code:-32000,message:'fixture RPC failure'}});
    send({id:msg.id,result:{thread:{id:threadId}}});
  }
  if(msg.method==='thread/inject_items') {
    injected.push(...msg.params.items);
    send({method:'item/completed',params:{threadId,turnId:'prior-turn',item:{type:'agentMessage',id:'prior-answer',text:'Historical reply'}}});
    send({id:msg.id,result:{}});
  }
  if(msg.method==='turn/start') {
    const current=msg.params.input.map(x=>x.text||'').join('');
    if(current.length>1048576) return send({id:msg.id,error:{code:-32602,message:'Input exceeds the maximum length of 1048576 characters.'}});
    const command=current||(injected.at(-1)?.content||[]).map(x=>x.text||'').join('');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    record({child:child.pid,command});
    if(command==='exit') return process.exit(3);
    if(command==='malformed') return console.log('invalid protocol');
    send({id:msg.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});
    if(command==='wait') return;
    const item={type:'agentMessage',id:'answer',phase:'final_answer',text:'{"selected":"sense"}'};
    send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'commentary',phase:'commentary',text:'Working'}}});
    send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer',delta:'{"selected":'}});
    setTimeout(()=>{
      send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer',delta:'"sense"}'}});
      send({method:'item/completed',params:{threadId,turnId,item}});
      send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:command==='fail'?'failed':'completed',items:[item],error:command==='fail'?{message:'fixture turn failure'}:null}}});
    },30);
  }
});
`, { mode: 0o700 })
fs.writeFileSync(path.join(root, 'etc', 'tool-executor.json'), JSON.stringify({ backends: { codex: {
  enabled: true, command: executable, args: ['exec', '--color', 'always', '--json', '-c', 'service_tier="fast"'],
  dangerouslySkipPermissions: true, reasoningEffort: 'medium',
} } }))
const { runProvider } = await import('./session.js')
const { terminalJobs } = await import('../paths.js')
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const records = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const alive = (pid: number) => fs.existsSync(`/proc/${pid}/stat`) && !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')
async function eventually(check: () => boolean) {
  for (let index = 0; index < 200; index++) { if (check()) return; await delay(10) }
  assert.fail('Expected provider evidence was not delivered')
}
async function invoke(options: EscalationOptions, signal = new AbortController().signal) {
  const events: ParsedBigBrotherEvent[] = []
  let cleanup: (() => Promise<void>) | undefined
  const result = await runProvider('codex', '', options, receipts, signal, async () => {},
    event => events.push(event), release => { cleanup = release })
  await cleanup?.()
  return { result, events }
}
function request(text: string): EscalationOptions {
  return { modelRequest: { messages: [{ role: 'system', content: 'Graph instructions' }, { role: 'user', content: text }] }, enableThinking: false }
}
function assertReleased() {
  assert.deepEqual(fs.readdirSync(receipts), [])
  assert.deepEqual(fs.readdirSync(terminalJobs), [])
  for (const entry of records()) if (entry.child) assert.equal(alive(entry.child), false, 'Provider descendants must be released')
}

test('native Codex preserves role ordering, all image parts, supplied instructions, and final output across repeated calls', async () => {
  const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' as const } }
  const options: EscalationOptions = { modelRequest: { messages: [
    { role: 'system', content: 'Graph instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Earlier image' }, image] },
    { role: 'assistant', content: 'Recorded answer' },
    { role: 'system', content: 'Later system evidence' },
    { role: 'user', content: [{ type: 'text', text: 'current' }, image, { type: 'text', text: 'frame evidence' }] },
  ], responseInstructions: 'Return only the final JSON value, without Markdown fences or surrounding commentary.\nThe final response must conform to this JSON Schema:\n{"type":"object","properties":{"selected":{"type":"string"}}}' }, enableThinking: false }
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = records().length
    const { result, events } = await invoke(options)
    assert.equal(result.success, true, result.error)
    assert.deepEqual(JSON.parse(result.output), { selected: 'sense' })
    assert.equal(events.filter(event => event.finalText).length, 1)
    assert.equal(events.at(-1)?.finalText, result.output)
    assert.ok(events.some(event => event.displayLines.includes('{"selected":')))
    const call = records().slice(before)
    const args = call[0].args as string[]
    assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://'])
    for (const value of ['service_tier="fast"', 'approval_policy="never"', 'sandbox_mode="danger-full-access"', 'developer_instructions=""',
      'project_doc_max_bytes=0', 'memories.use_memories=false', 'memories.generate_memories=false', 'skills.include_instructions=false', 'model_reasoning_effort="none"']) assert.ok(args.includes(value), value)
    const messages = call.filter(entry => entry.message).map(entry => entry.message)
    assert.deepEqual(messages.map(msg => msg.method), ['initialize', 'initialized', 'thread/start', 'thread/inject_items', 'turn/start'])
    assert.equal(messages[2].params.baseInstructions, `Graph instructions\n\n${options.modelRequest!.responseInstructions}`)
    assert.equal(messages[2].params.developerInstructions, '')
    assert.deepEqual(messages[3].params.items.map((item: { role: string }) => item.role), ['user', 'assistant', 'system', 'user'])
    assert.deepEqual(messages[3].params.items[0].content, [
      { type: 'input_text', text: 'Earlier image' }, { type: 'input_image', image_url: image.image_url.url, detail: 'high' },
    ])
    assert.deepEqual(messages[3].params.items[3].content, [
      { type: 'input_text', text: 'current' }, { type: 'input_image', image_url: image.image_url.url, detail: 'high' }, { type: 'input_text', text: 'frame evidence' },
    ])
    assert.deepEqual(messages[4].params.input, [])
    assert.equal(messages[4].params.effort, 'none')
    assertReleased()
  }
})

test('native Codex preserves a complete oversized final user message without interactive-input rejection', async () => {
  const content = 'Recorded evidence with original provenance.\n'.repeat(30_000)
  assert.ok(content.length > 1_048_576)
  const before = records().length
  const { result } = await invoke(request(content))
  assert.equal(result.success, true, result.error)
  const messages = records().slice(before).filter(entry => entry.message).map(entry => entry.message)
  assert.deepEqual(messages.find(message => message.method === 'thread/inject_items').params.items,
    [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] }])
  assert.deepEqual(messages.find(message => message.method === 'turn/start').params.input, [])
  assertReleased()
})

test('native Codex retains a final assistant message without synthesizing user input', async () => {
  const before = records().length
  const { result } = await invoke({ modelRequest: { messages: [
    { role: 'system', content: 'Graph instructions' }, { role: 'user', content: 'Original request' },
    { role: 'assistant', content: 'Existing assistant response' },
  ] }, enableThinking: false })
  assert.equal(result.success, true, result.error)
  const messages = records().slice(before).filter(entry => entry.message).map(entry => entry.message)
  assert.deepEqual(messages.find(message => message.method === 'thread/inject_items').params.items.map((item: any) => item.role), ['user', 'assistant'])
  assert.deepEqual(messages.find(message => message.method === 'turn/start').params.input, [])
  assertReleased()
})

test('native Codex cancellation releases the selected process and descendants without cancelling concurrent work', async () => {
  const abort = new AbortController()
  const first = invoke(request('wait'), abort.signal)
  await eventually(() => records().some(entry => entry.command === 'wait'))
  const second = await invoke({ ...request('current'), enableThinking: true })
  assert.equal(second.result.success, true, second.result.error)
  const waiting = records().find(entry => entry.command === 'wait')
  assert.equal(alive(waiting.child), true)
  abort.abort(new Error('Selected request cancelled'))
  const cancelled = await first
  assert.equal(cancelled.result.success, false)
  assert.equal(cancelled.result.error, 'Selected request cancelled')
  const turns = records().filter(entry => entry.message?.method === 'turn/start')
  assert.equal(turns.at(-1).message.params.effort, 'high')
  assertReleased()
})

test('RPC failures, model failures, invalid output and premature exit preserve failures and release children', async () => {
  for (const [text, expected] of [['fail', /fixture turn failure/], ['malformed', /Unexpected token/], ['exit', /exited before completing/]] as const) {
    const { result } = await invoke(request(text))
    assert.equal(result.success, false)
    assert.match(result.error || '', expected)
    assertReleased()
  }
  const { result } = await invoke({ modelRequest: { messages: [{ role: 'system', content: 'rpc-failure' }, { role: 'user', content: 'current' }] } })
  assert.equal(result.success, false)
  assert.match(result.error || '', /fixture RPC failure/)
  assertReleased()
  assert.equal((await invoke(request('current'))).result.success, true, 'A failed request leaves no stranded provider state')
  assertReleased()
})
