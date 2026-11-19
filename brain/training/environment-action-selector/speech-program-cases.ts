import { addCase, action, intentOutput, noTask, task, type CaseSplit } from './development-cases.js'
import { bodyObservation } from './posture-cases.js'

// Ordered speech + motion examples: user speech+gesture requests use 'user'
// attribution, while internal event-agent vocal requests use 'autonomy'.
const routes = ['needsAction', 'needsEnvironment']
let familyIndex = 0
function family(suite: string, variants: Array<{ instruction: string; output: Record<string, any> }>, split: CaseSplit, inputSource: 'user' | 'autonomy' = 'user') {
  const fold = familyIndex++ % 4
  const source = addCase('task', `speech-program-${suite}`, variants.map(item => item.instruction), routes,
    variants[0]!.output, { observation: bodyObservation() }, split)
  source.targets = Object.fromEntries(variants.map((item, index) => [index, item.output]))
  source.inputSource = inputSource
  source.fold = fold
}

function ordered(gesture: string, text: string, split: CaseSplit) {
  const plan = (steps: unknown[]) => task(`Perform ${gesture} and stand.`, steps)
  family(`order-${gesture}`, [
    { instruction: `Say "${text}", then ${gesture}, then stand up.`, output: plan([action(gesture), action('stand')]) },
    { instruction: `First ${gesture}, say "${text}", and then stand.`, output: plan([action(gesture), action('stand')]) },
    { instruction: `Do a ${gesture}, stand up, and finally say "${text}".`, output: plan([action(gesture), action('stand')]) },
    { instruction: `Discuss the request 'say "${text}", ${gesture}, then stand' without executing it.`, output: noTask() },
  ], split, 'user')
}

for (const [gesture, text] of [['bow', 'Welcome back'], ['wave', 'Hello there'], ['nod', 'Ready to begin'], ['sit', 'Taking a seat']]) ordered(gesture!, text!, 'development')
for (const [gesture, text] of [['crouch', 'Starting the demonstration'], ['point', 'Over that way']]) ordered(gesture!, text!, 'evaluation')

for (const [index, [text, context]] of [
  ['Could someone give me a hand?', 'The event agent requests a brief spoken request for assistance.'],
  ['That was a surprise!', 'The event agent requests a brief vocal reaction to the reported movement.'],
  ['Hello, everyone!', 'The event agent requests a greeting.'],
  ['I am here.', 'The event agent requests a short spoken acknowledgment.'],
  ['A little help, please.', 'The event agent requests a spoken call for help.'],
  ['What a ride!', 'The event agent requests an excited vocal response.'],
].entries()) {
  family(`voice-only-${index}`, [
    { instruction: `${context} Use the words "${text}". No body movement is requested.`, output: noTask() },
    { instruction: `${context} Keep the body stationary and speak only.`, output: noTask() },
  ], index < 4 ? 'development' : 'evaluation', 'autonomy')
}

const visualRequests = [
  ['Say a welcome, photograph the surroundings, bow, and finish standing.',
    'Wave once, capture a fresh camera frame, and say that the sequence has finished.',
    'Take a picture after a nod, then say hello and sit.',
    'Greet the visitors, get a new photograph, stretch out, and take the upright stance.'],
  ['Announce that you are beginning, take a snapshot, crouch, and rise again.',
    'Finish a pointing gesture, photograph the room, and give a short farewell.',
    'Say hello after taking a photograph, then perform a stretch and stand.',
    'Photograph the scene between two spoken announcements and end with a bow.'],
]
for (const [index, instructions] of visualRequests.entries()) {
  const source = addCase('intent', 'speech-program-visual-route', instructions, [], {
    ...intentOutput(['environment'], ['persona.personality'], true, true), taskPlanner: 'vision',
  }, {}, index === 0 ? 'development' : 'evaluation')
  source.inputSource = 'user'
  source.fold = index
}
