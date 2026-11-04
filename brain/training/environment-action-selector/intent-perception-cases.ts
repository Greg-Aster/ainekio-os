import { addCase, intentOutput, type ContextRequirement } from './development-cases.js'

// Offline examples: a visual question can read a view without requesting a new
// photograph. Related phrasings stay together; the observed failure is replay-only.
const E = 'environment', V = 'vision', S = 'robotStatus', H = 'conversationHistory'
const expression = ['persona.identity', 'persona.personality']
const families = [
  { name: 'person-visible', context: [E, V], required: [V], optional: [E, S, ...expression],
    development: ['Am I in your view?', 'Can you make me out from there?', 'Do you have a view of my face?', 'Is anyone visible to you?'],
    evaluation: ['Does your view include where I am sitting?', 'Are you able to make out the person beside you?'] },
  { name: 'visible-detail', context: [E, V], required: [V], optional: [E, S, ...expression],
    development: ['What am I holding up?', 'Can you tell what I am wearing?', 'Is the light on behind me?', 'Which way am I facing?'],
    evaluation: ['What is resting on my shoulder?', 'Is there anything beside my left hand?'] },
  { name: 'camera-readiness', context: [E, S], required: [], optional: [E, S, V, ...expression], anyOf: [[E, S]],
    development: ['Is your camera ready yet?', 'Has your camera come online?', 'Is the camera connected right now?', 'What is your camera reporting at the moment?'],
    evaluation: ['Has the imaging hardware finished starting?', 'Is your camera currently reporting that it is ready?'] },
  { name: 'recheck-view', context: [H, E, S, V], required: [V], optional: [H, E, S, ...expression],
    development: ['You could not see a moment ago. How about now?', 'Is there a view available this time?', 'Check whether you can see anything now.', 'Has your view appeared since your last reply?'],
    evaluation: ['Earlier you had no view; can you make anything out now?', 'Can you see what is here this time around?'] },
  { name: 'earlier-description', context: [H], required: [H], optional: expression,
    development: ['What did you say you could see in your last answer?', 'Repeat what you told me was visible.', 'What were your words about the person you saw?', 'Remind me of your description from our last exchange.'],
    evaluation: ['In your preceding reply, how did you describe the view?', 'What did you tell me was beside that person earlier?'] },
  { name: 'new-photograph', context: [E, S], required: [], optional: [E, S, V, 'executionContext', ...expression], action: true,
    development: ['Take a fresh photo and tell me what it shows.', 'Please photograph me now and describe the result.', 'Get a new picture of this room and report what is visible.', 'Capture a new image, then tell me what is in it.'],
    evaluation: ['Make a new still image of the doorway and describe that photograph.', 'Photograph the chair as it is now and tell me what the shot contains.'] },
  { name: 'social-see', context: ['persona.personality'], required: [], optional: expression,
    development: ['Good to see you again, friend.', 'See you tomorrow, friend.', 'It has been nice seeing you today.', 'I will see you after dinner.'],
    evaluation: ['See you next weekend, my friend.', 'It is lovely to see you again.'] },
  { name: 'quoted-see', context: [], required: [], optional: [],
    development: ['Translate "can you see me" into Italian.', 'Count the words in "am I in your view".', 'Put "take a picture" into the past tense.', 'Spell the word photograph for me.'],
    evaluation: ['How many letters are in "camera"?', 'Rewrite "I can see you" as a question.'] },
]

for (const [fold, source] of families.entries()) {
  for (const split of ['development', 'evaluation'] as const) {
    const action = source.action === true
    const expected = { ...intentOutput(action ? [E] : [], source.context, true, action),
      taskPlanner: action ? 'vision' : 'specialist' }
    const item = addCase('intent', `perception-${source.name}`, source[split], [], expected, {}, split)
    item.id = `intent-${split}-perception-${source.name}`
    item.fold = fold % 4
    const requirement: ContextRequirement = { required: source.required, optional: source.optional,
      ...(source.anyOf ? { anyOf: source.anyOf } : {}) }
    item.contextRequirements = { conversationContext: requirement,
      taskContext: { required: action ? [E] : [], optional: action ? [S, V, 'executionContext'] : [] } }
  }
}

const replay = addCase('intent', 'perception-original-visibility', ['Can you see me?'], [],
  { ...intentOutput([], [E, V]), taskPlanner: 'specialist' }, {}, 'regression')
replay.id = 'intent-regression-perception-original-visibility'
replay.contextRequirements = { conversationContext: { required: [V], optional: [E, S, H, ...expression] } }
