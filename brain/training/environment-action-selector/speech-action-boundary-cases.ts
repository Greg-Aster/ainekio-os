import { addCase, action, noTask, task, type CaseSplit } from './development-cases.js'
import { bodyObservation } from './posture-cases.js'

// Contrastive requests teaching the speech/action boundary without nested-quote
// objective echoes or fake autonomy clones of human speech.
const development = [
  ['Run for the hills!', 'wave', 'take two steps forward'],
  ['Let us dance another day.', 'nod', 'step sideways to the right'],
  ['I could use a hand.', 'bow', 'take a step backward'],
  ['Time to stand up for ourselves.', 'sit', 'turn slightly to the right'],
] as const
const evaluation = [
  ['We are making great strides.', 'shrug', 'step sideways to the left'],
  ['Take a bow, my friend.', 'nod', 'take a short step forward'],
] as const

function addFamily(entry: readonly string[], index: number, split: CaseSplit) {
  const [words, gesture, finiteMove] = entry as [string, string, string]
  const quoted = JSON.stringify(words)
  const literal = split === 'development' ? `Perform a ${gesture} gesture.` : `Try the ${gesture} gesture.`
  const variants = [
    { instruction: `Say ${quoted}.`, output: noTask() },
    { instruction: `Say ${quoted} and then give a brief ${gesture} gesture.`, output: task(`Perform a ${gesture} gesture.`, [action(gesture)]) },
    { instruction: `Do a ${gesture} gesture, then say ${quoted}.`, output: task(`Perform a ${gesture} gesture.`, [action(gesture)]) },
    { instruction: `Say ${quoted}, do a ${gesture}, and finish standing.`, output: task(`Perform ${gesture}, then stand.`, [action(gesture), action('stand')]) },
    { instruction: `Read aloud: ${JSON.stringify(literal)}`, output: noTask() },
    { instruction: `Please ${finiteMove}.`, output: task(`Carry out the requested movement: ${finiteMove}.`, [action(finiteMove)]) },
    { instruction: `Please ${finiteMove}, and then say ${quoted}.`, output: task(`Carry out the requested movement: ${finiteMove}.`, [action(finiteMove)]) },
    { instruction: `What does the phrase ${quoted} mean?`, output: noTask() },
  ]
  const outputs = variants.map(item => item.output)
  const source = addCase('task', `speech-action-boundary-${split}-${index}`,
    variants.map(item => item.instruction), ['needsAction', 'needsEnvironment'], outputs[0]!,
    { observation: bodyObservation() }, split)
  source.targets = Object.fromEntries(outputs.map((output, i) => [i, output]))
  source.inputSource = 'user'
  source.fold = index % 4
}

development.forEach((entry, index) => addFamily(entry, index, 'development'))
evaluation.forEach((entry, index) => addFamily(entry, index, 'evaluation'))
