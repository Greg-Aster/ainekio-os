import { addCase, action, task, noTask, intentOutput, type CaseSplit } from './development-cases.js'
import { bodyObservation } from './posture-cases.js'

// Role-boundary contrasts in natural spoken phrasing: separating local motion,
// camera capture routing, and quoted/non-action speech.
const capture = { kind: 'action', action: { type: 'captureImage' } }
function family(gesture: string, phrase: string, index: number, split: CaseSplit) {
  const gesturePlan = task(`Perform a ${gesture}.`, [action(gesture)])
  const variants = [
    { instruction: `Just show me a ${gesture}—no photo needed.`, output: gesturePlan },
    { instruction: `I'll watch you do a ${gesture}; just perform the movement.`, output: gesturePlan },
    { instruction: `Say "${phrase}", do a ${gesture}, and stand up without taking a picture.`,
      output: task(`Perform ${gesture}, then stand.`, [action(gesture), action('stand')]) },
    { instruction: `Say "${phrase}", take a photo of the room, do a ${gesture}, and stand up.`,
      output: task(`Photograph the surroundings, perform ${gesture}, then stand.`, [capture, action(gesture), action('stand')]) },
    { instruction: `Do a ${gesture}, snap a picture, and then say "${phrase}".`,
      output: task(`Perform ${gesture} and capture a photograph.`, [action(gesture), capture]) },
    { instruction: `Explain this sentence without doing it: "Say ${phrase}, photograph the room, and ${gesture}."`, output: noTask() },
    { instruction: `Just say "${phrase}"—don't move or take a photo.`, output: noTask() },
  ]
  const source = addCase('task', `planner-boundary-${gesture}`, variants.map(v => v.instruction),
    ['needsAction', 'needsEnvironment'], variants[0]!.output, { observation: bodyObservation() }, split)
  source.targets = Object.fromEntries(variants.map((v, i) => [i, v.output]))
  source.inputSource = 'user'
  source.fold = index % 4

  const intentVariants = variants.map((v, i) => ({
    instruction: v.instruction,
    output: {
      ...intentOutput(i >= 5 ? [] : ['environment'], i >= 2 ? ['persona.personality'] : [], i >= 2, i < 5),
      taskPlanner: i === 3 || i === 4 ? 'vision' : 'specialist',
    },
  }))
  const routing = addCase('intent', `planner-boundary-${gesture}`, intentVariants.map(v => v.instruction), [], intentVariants[0]!.output, {}, split)
  routing.targets = Object.fromEntries(intentVariants.map((v, i) => [i, v.output]))
  routing.inputSource = 'user'
  routing.fold = index % 4
}

for (const [index, [gesture, phrase]] of [
  ['bow', 'Welcome to the workshop'],
  ['wave', 'Nice to see everyone'],
  ['nod', 'Ready to begin'],
  ['sit', 'Let us get started'],
  ['crouch', 'Here is the next pose'],
  ['point', 'Please look over there'],
].entries()) {
  family(gesture!, phrase!, index, index < 4 ? 'development' : 'evaluation')
}
