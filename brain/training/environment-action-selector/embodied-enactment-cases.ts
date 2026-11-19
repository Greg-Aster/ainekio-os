import { addCase, intentOutput, noTask, task, type CaseSplit, type ContextRequirement } from './development-cases.js'
import { bodyObservation } from './posture-cases.js'

// Version 25: Embodied roleplay/enactment and open-ended expressive motions
// contrasted against verbal-only roleplay, mental imagination, delegated fact
// lookup, and direct factual questions. Observed live failures stay in
// regression only and are never used for fitting or checkpoint selection.
const E = 'environment', S = 'robotStatus', H = 'conversationHistory'
const P = 'persona.personality', I = 'persona.identity'
const expression = [I, P]

interface EnactmentFamily {
  name: string
  action: boolean
  tool?: boolean
  intentTaskContext: string[]
  intentConvContext: string[]
  taskReq: ContextRequirement
  convReq: ContextRequirement
  includeTask?: boolean
  development: string[]
  evaluation: string[]
}

const families: EnactmentFamily[] = [
  {
    name: 'roleplay-situated-scene',
    action: true,
    intentTaskContext: [E],
    intentConvContext: [P],
    taskReq: { required: [E], optional: [S] },
    convReq: { required: [], optional: [...expression, H, E, S] },
    includeTask: true,
    development: [
      "Please pretend that you're at a street market offering fresh fruit to passersby.",
      "Pretend that you're inside a cozy bakery presenting a warm croissant to a guest.",
      "Please pretend that you're behind a ticket counter welcoming travelers aboard.",
      'Pretend that you are in a flower shop arranging a bright bouquet for a visitor.',
      "Please pretend that you're on a theater stage taking an encore bow for the audience.",
      "Pretend you're at an ice cream stand handing a cone across the counter.",
      "Please pretend that you're inside a bookshop recommending a favorite novel to a reader.",
      "Pretend that you're in a neighborhood cafe pouring a warm cup of cocoa for a friend.",
    ],
    evaluation: [
      "Please pretend that you're inside an art gallery unveiling a new painting to visitors.",
      "Pretend that you're at a farmers market welcoming shoppers to your booth.",
    ],
  },
  {
    name: 'roleplay-hospitality',
    action: true,
    intentTaskContext: [E],
    intentConvContext: [P],
    taskReq: { required: [E], optional: [S] },
    convReq: { required: [], optional: [...expression, H, E, S] },
    includeTask: true,
    development: [
      'Please pretend you are a polite butler welcoming guests into the parlor.',
      'Play the part of a cheerful barista handing a warm mug across the counter.',
      'Act as an attentive host greeting visitors at the entrance.',
      "Pretend that you're a friendly shopkeeper showing off your finest wares.",
      'Please pretend to be a courteous usher guiding guests to their seats.',
      'Play the role of a welcoming innkeeper greeting weary travelers.',
      "Pretend that you're a cheerful conductor waving passengers onto the train.",
      'Please act like a proud sommelier presenting a vintage bottle.',
    ],
    evaluation: [
      'Please pretend that you are a courteous concierge welcoming a traveler to a hotel.',
      'Play the role of a proud chef presenting a freshly baked pastry.',
    ],
  },
  {
    name: 'roleplay-creature',
    action: true,
    intentTaskContext: [E],
    intentConvContext: [P],
    taskReq: { required: [E], optional: [S] },
    convReq: { required: [], optional: [...expression, H, E, S] },
    includeTask: true,
    development: [
      'Pretend to be a sleepy cat stretching after a long nap.',
      'Act like a curious fox peeking around a bush.',
      'Do an impression of a proud parade horse marching in place.',
      'Play the part of a bashful puppy hiding slightly and peeking up.',
      "Please pretend you're a playful otter bobbing in the water.",
      'Act like a watchful owl turning to scan the treetops.',
      "Pretend that you're a cheerful penguin waddling across the ice.",
      'Please do an impression of a lively squirrel perking up with an acorn.',
    ],
    evaluation: [
      'Pretend you are a startled rabbit perking up at a sudden rustle.',
      'Act like an eager hound waiting by the door for a walk.',
    ],
  },
  {
    name: 'expressive-celebration-dance',
    action: true,
    intentTaskContext: [E],
    intentConvContext: [P],
    taskReq: { required: [E], optional: [S] },
    convReq: { required: [], optional: [...expression, H, E, S] },
    includeTask: true,
    development: [
      'Please do a joyful celebration dance for us.',
      'Please do a little celebratory wiggle.',
      'Give me an excited little victory bounce.',
      'Show off a playful boogie right where you are.',
      'Celebrate our success with an upbeat body shimmy.',
      'Please do a little cheerful jig in place.',
      'Show how excited you are with a lively little dance.',
      'Do a lighthearted celebratory groove right there.',
    ],
    evaluation: [
      'Please perform a lively celebratory jig in place.',
      'Show how thrilled you are with a cheerful little shimmy.',
    ],
  },
  {
    name: 'expressive-reaction-pantomime',
    action: true,
    intentTaskContext: [E],
    intentConvContext: [P],
    taskReq: { required: [E], optional: [S] },
    convReq: { required: [], optional: [...expression, H, E, S] },
    includeTask: true,
    development: [
      'Act out taking a dramatic theatrical bow after a stage performance.',
      'Show me a puzzled head-tilt as if pondering a riddle.',
      'Pretend you just heard wonderful news and react with your whole body.',
      'Give a playful dramatic shrug with your shoulders.',
      'Show an eager curious lean as if spotting a butterfly on the floor.',
      'Please act out a surprised double-take as if noticing an old friend.',
      'Show how proud you are by puffing up in a triumphant stance.',
      'Act as though you are cheerfully waving to someone across a plaza.',
    ],
    evaluation: [
      'Act as though you are shyly thanking an applauding crowd.',
      'Show an exaggerated curious lean as if inspecting a tiny bug.',
    ],
  },
  {
    name: 'verbal-only-roleplay',
    action: false,
    intentTaskContext: [],
    intentConvContext: [P],
    taskReq: { required: [], optional: [] },
    convReq: { required: [], optional: [...expression, H] },
    includeTask: true,
    development: [
      'Without moving, pretend in words only that you are a radio announcer reading the evening news.',
      'Stay completely still and answer my question in the voice of a medieval knight.',
      'Tell me a short story about a cafe owner serving morning coffee, without acting it out.',
      'Describe in words how a waiter presents a menu, keeping your body motionless.',
    ],
    evaluation: [
      'Keep still and reply purely in words as if you were a ship captain logging the weather.',
      'Narrate a brief scene about a baker opening shop, without performing any movement.',
    ],
  },
  {
    name: 'pure-imagination-verbal',
    action: false,
    intentTaskContext: [],
    intentConvContext: [P],
    taskReq: { required: [], optional: [] },
    convReq: { required: [], optional: [...expression, H] },
    includeTask: true,
    development: [
      'Imagine a city floating in the clouds and describe its architecture.',
      'Make up a whimsical menu for a fictional tea house.',
      'Suppose trees could talk—what might an old oak tree complain about?',
      'Invent a short riddle about a teapot.',
    ],
    evaluation: [
      'Imagine a library on the moon and describe what visitors would read there.',
      'Make up three creative names for a neighborhood bakery.',
    ],
  },
  {
    name: 'fact-lookup-delegation',
    action: false,
    tool: true,
    intentTaskContext: [],
    intentConvContext: [P],
    taskReq: { required: [], optional: [H, P] },
    convReq: { required: [], optional: [...expression, H] },
    development: [
      'Please look up an interesting fact about oolong tea cultivation.',
      'Look up a historical fact about the invention of porcelain and share it.',
      'Could you look up the boiling point of ethanol at sea level?',
      'Please research where bergamot oranges are primarily grown and tell me.',
    ],
    evaluation: [
      'Please look up a verified fact about the origin of matcha tea.',
      'Look up when the first public railway opened and report the year.',
    ],
  },
  {
    name: 'direct-knowledge-question',
    action: false,
    intentTaskContext: [],
    intentConvContext: [],
    taskReq: { required: [], optional: [] },
    convReq: { required: [], optional: expression },
    development: [
      'What is the difference between green tea and black tea?',
      'Explain briefly why water boils at a lower temperature on a high mountain.',
      'Please tell me what the word hospitality means.',
      'How many cups are in a standard quart?',
    ],
    evaluation: [
      'What makes herbal infusions different from true teas?',
      'Explain in one sentence what photosynthesis does.',
    ],
  },
]

function enactmentTaskOutput(instruction: string) {
  return task(instruction, [{ kind: 'action', action: { type: 'requestMotion', description: instruction } }])
}

for (const [index, family] of families.entries()) {
  const fold = index % 4
  for (const split of ['development', 'evaluation'] as const) {
    const instructions = family[split]
    const expectedIntent = {
      ...intentOutput(family.intentTaskContext, family.intentConvContext, true, family.action, false),
      needsToolUse: family.tool === true,
      taskPlanner: 'specialist',
    }
    const intentItem = addCase('intent', `embodied-${family.name}`, instructions, [], expectedIntent, {}, split)
    intentItem.id = `intent-${split}-embodied-${family.name}`
    intentItem.fold = fold
    intentItem.contextRequirements = {
      taskContext: family.taskReq,
      conversationContext: family.convReq,
    }

    if (family.includeTask) {
      const selected = family.action
        ? ['needsResponse', 'needsAction', 'needsEnvironment']
        : ['needsResponse', 'needsPersona']
      const outputs = instructions.map(inst => (family.action ? enactmentTaskOutput(inst) : noTask()))
      const taskItem = addCase(
        'task',
        `embodied-${family.name}`,
        instructions,
        selected,
        outputs[0]!,
        { observation: bodyObservation() },
        split,
      )
      taskItem.id = `task-${split}-embodied-${family.name}`
      taskItem.fold = fold
      taskItem.targets = Object.fromEntries(outputs.map((out, i) => [i, out]))
    }
  }
}

// Observed live failures stay strictly in regression (never fitted or used for checkpoint selection).
export const LIVE_RESTAURANT_TEA_REGRESSION = "Please pretend that you're inside of a restaurant serving a customer some delicious tea"
export const LIVE_HAPPY_DANCE_REGRESSION = 'Please do a little happy dance'
export const LIVE_FACT_LOOKUP_REGRESSION = 'Please look up a fact about jasmine oolong tea'

const intentTea = addCase(
  'intent',
  'embodied-live-restaurant-tea',
  [LIVE_RESTAURANT_TEA_REGRESSION],
  [],
  { ...intentOutput([E], [P], true, true, false), taskPlanner: 'specialist' },
  {},
  'regression',
)
intentTea.id = 'intent-regression-embodied-restaurant-tea'
intentTea.contextRequirements = {
  taskContext: { required: [E], optional: [S] },
  conversationContext: { required: [], optional: [...expression, H, E, S] },
}

const intentFact = addCase(
  'intent',
  'embodied-live-fact-lookup',
  [LIVE_FACT_LOOKUP_REGRESSION],
  [],
  { ...intentOutput([], [P], true, false, false), needsToolUse: true, taskPlanner: 'specialist' },
  {},
  'regression',
)
intentFact.id = 'intent-regression-embodied-fact-lookup'
intentFact.contextRequirements = {
  taskContext: { required: [], optional: [H, P] },
  conversationContext: { required: [], optional: [...expression, H] },
}

const taskTea = addCase(
  'task',
  'embodied-live-restaurant-tea',
  [LIVE_RESTAURANT_TEA_REGRESSION],
  ['needsResponse', 'needsAction', 'needsEnvironment'],
  enactmentTaskOutput(LIVE_RESTAURANT_TEA_REGRESSION),
  { observation: bodyObservation() },
  'regression',
)
taskTea.id = 'task-regression-embodied-restaurant-tea'

const taskDance = addCase(
  'task',
  'embodied-live-happy-dance',
  [LIVE_HAPPY_DANCE_REGRESSION],
  ['needsResponse', 'needsAction', 'needsEnvironment'],
  enactmentTaskOutput(LIVE_HAPPY_DANCE_REGRESSION),
  { observation: bodyObservation() },
  'regression',
)
taskDance.id = 'task-regression-embodied-happy-dance'
