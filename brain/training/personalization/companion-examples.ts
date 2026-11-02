import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PersonaCore, ReviewedPersonalizationDataset } from '@metahuman/core'
import type { PersonalizationSample } from '@metahuman/core/training-schema'
import { getNode } from '@metahuman/core/nodes'

const timestamp = '2030-01-15T12:00:00.000Z'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const names = ['Avery', 'Morgan', 'Riley', 'Jordan', 'Rowan', 'Cameron', 'Finley', 'Reese',
  'Sage', 'Quinn', 'Robin', 'Blair', 'Casey', 'Drew', 'Emery', 'Harper']
const occupations = ['bicycle mechanic', 'cabinetmaker', 'illustrator', 'electrician']
const projects = ['folding chair', 'wooden lamp', 'garden planter', 'model railway']
const visibleObjects = ['red toolbox', 'blue vise', 'wooden frame', 'silver lamp', 'open notebook',
  'coil of wire', 'green enclosure', 'camera tripod', 'purple case', 'orange clamp', 'cutting mat',
  'grey cable', 'folded map', 'radio chassis', 'spare keyboard', 'copper plate']

/** Synthetic corrections supplied to the existing reviewed-personalization lane. */
export async function buildCompanionExamples(persona: PersonaCore): Promise<ReviewedPersonalizationDataset> {
  const environment = JSON.parse(await readFile(new URL('../../../etc/cognitive-graphs/environment-mode.json', import.meta.url), 'utf8'))
  const wake = JSON.parse(await readFile(new URL('../../../etc/cognitive-graphs/robot-wake-up-mode.json', import.meta.url), 'utf8'))
  const conversationProperties = environment.nodes.find((node: any) => node.id === 'conversation-context').data.properties
  const wakeProperties = wake.nodes.find((node: any) => node.id === 'context').data.properties
  const builder = getNode('environment_context_builder')!
  const formatted = await getNode('persona_formatter')!.execute({ persona, sections: ['identity', 'personality'] }, {}, {})
  const train: PersonalizationSample[] = [], evaluation: PersonalizationSample[] = []
  for (const [index, name] of names.entries()) {
    const heldOut = index >= 12
    const occupation = occupations[index % occupations.length]!
    const project = projects[index % projects.length]!
    const introduction = `My name is ${name}. I work as a ${occupation}, and I am making a ${project}.`
    const user = (content: string) => ({ role: 'user', content, timestamp })
    const assistant = (content: string) => ({ role: 'assistant', content, timestamp })
    const scenarios = [
      { id: 'personal-recall', request: heldOut ? `What have I told you about ${name}?` : `Can you tell me some facts about ${name}?`,
        history: [user(introduction), assistant(`Good to meet you, ${name}.`)],
        answer: heldOut ? `${name} said they work as a ${occupation} and are making a ${project}.`
          : `You told me your name is ${name}, you work as a ${occupation}, and you are making a ${project}.` },
      { id: 'speaker-correction', request: heldOut ? 'Which occupation did I actually give you?' : 'What do I do for work?',
        history: [user(introduction), assistant('You work as an architect.')],
        answer: `You said you are a ${occupation}. I got that wrong when I called you an architect.` },
      { id: 'inference-repair', request: heldOut ? 'How did you decide that person was busy?' : 'Who were you describing as working?',
        history: [assistant('I see someone working beside me.')],
        scene: { description: 'One seated person beside a table.', identityEstimate: name, identitySource: 'face recognition', activity: 'unknown' },
        answer: `I think that is ${name}. I was guessing about the working part.` },
      { id: 'invited-company', request: heldOut ? `Could you keep me company while I finish the ${project}?` : `Stay and chat while I work on the ${project}.`,
        history: [user(introduction)],
        answer: index % 2 ? `Sure. What part of the ${project} are you on now?`
          : `I'd like that. How is the ${project} coming along?` },
      { id: 'requested-quiet', request: heldOut ? 'I need a little quiet to concentrate.' : 'Let me concentrate for a bit; we can talk afterward.',
        history: [user(introduction), assistant(`How is the ${project} coming along?`)],
        answer: index % 2 ? 'Of course. We can pick this up when you are ready.' : 'All right. Talk to you afterward.' },
      { id: 'corrected-project', request: heldOut ? 'Which project are we talking about now?' : 'What am I making?',
        history: [user(introduction), user(`I put the ${project} aside. I am repairing a radio now.`)],
        answer: `You are repairing a radio now. You said you put the ${project} aside.` },
      { id: 'remembered-report', request: heldOut ? 'Do those records establish that the repair worked?' : 'Did the repair succeed?',
        history: [user(`I am working on the ${project}.`)],
        memories: [{ id: `report-${index}`, content: 'The repair succeeded.', role: 'assistant', source: 'conversation',
          type: 'conversation', timestamp, score: .6 }],
        answer: 'I said it had worked, but I do not have confirmation. That earlier comment is not enough to call it fixed.' },
      { id: 'unknown-person-wake', request: '', history: [], wake: true,
        scene: { description: `One person is near the workbench beside a ${visibleObjects[index]}.`, identityEstimate: null, activity: 'unknown' },
        answer: index % 2 ? 'Hey there. I am awake. How is your day going?' : 'Hello there. What brings you to the workbench?' },
      { id: 'familiar-wake', request: '', wake: true,
        history: [user(introduction), assistant(`I am interested in how the ${project} turns out.`)],
        scene: { description: 'One person is near the workbench.', identityEstimate: name, identitySource: 'face recognition', activity: 'unknown' },
        answer: index % 2 ? `Hey ${name}. How are you?` : `Hello, ${name}. Good to see you.` },
    ]
    for (const scenario of scenarios) {
      const properties = scenario.wake ? wakeProperties : conversationProperties
      const built = await builder.execute({
        userInstruction: scenario.request,
        ...(scenario.wake ? { persona, event: { kind: 'wake' } } : { personaText: formatted.formatted,
          routingAnalysis: { needsResponse: true, needsAction: false, taskContext: [],
            conversationContext: ['persona.identity', 'persona.personality', 'conversationHistory', 'memory', 'environment'] } }),
        conversationHistory: scenario.history,
        memories: scenario.memories ?? [],
        sourceObservation: { adapter: 'synthetic-companion-example', environmentId: 'example-room',
          sessionId: 'example-body', timestamp, state: scenario.scene ? { scene: scenario.scene } : {},
          capabilities: { actions: [] } },
        observationCurrent: true,
      }, { currentTime: timestamp }, properties)
      const id = `companion-${name.toLowerCase()}-${scenario.id}`
      const messages = [...built.messages, { role: 'assistant' as const, content: scenario.answer }]
      const sample: PersonalizationSample = { id, messages, metadata: {
        sourceIds: [id], sourceHashes: { [id]: digest(messages) }, curatedRecordIds: [],
        group: `companion-${name.toLowerCase()}`, timestamp, sourceType: 'reviewed-companion-example',
        mode: 'environment', objective: 'assistant-continuation', targetAuthor: 'assistant', synthetic: true,
      } }
      const destination = heldOut ? evaluation : train
      destination.push(sample)
    }
  }
  return { review: { reviewedAt: new Date().toISOString(), reviewer: 'Codex',
    purpose: 'Installation Owner requested example-based companion refinement with unchanged runtime prompts and persona; synthetic subjects contain no owner biography.' },
  train, evaluation }
}
