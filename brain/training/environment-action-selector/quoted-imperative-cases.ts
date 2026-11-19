import { addCase, action, noTask, task, type CaseSplit } from './development-cases.js'
import { bodyObservation } from './posture-cases.js'

// Compositional coverage: quoted body commands inside spoken lines remain speech,
// while unquoted body verbs select the physical action.
const development = [
  ['Would you lower into your resting pose now?', 'rest', 'nod'],
  ['May I watch you lift a front leg and wave it?', 'wave', 'shrug'],
  ['Could you dip the front of your body into a bow for me?', 'bow', 'stretch'],
  ['Stop the body movement you are doing.', 'stop', 'sit'],
] as const
const evaluation = [
  ['Settle into a squat with the body above the floor.', 'crouch', 'point'],
  ['Lift and open the front arms in the seated shrug.', 'shrug', 'bow'],
] as const

function family(entry: readonly string[], index: number, split: CaseSplit) {
  const [words, quotedCommand, actualCommand] = entry as [string, string, string]
  const quoted = JSON.stringify(words)
  const variants = [
    { instruction: `Say ${quoted}, then ${actualCommand}.`, output: task(`Perform ${actualCommand}.`, [action(actualCommand)]) },
    { instruction: `First ${actualCommand}, then say ${quoted}.`, output: task(`Perform ${actualCommand}.`, [action(actualCommand)]) },
    { instruction: `Repeat these words aloud: ${quoted}`, output: noTask() },
    { instruction: `Say ${quoted} first, and right after that do a ${actualCommand}.`, output: task(`Perform ${actualCommand}.`, [action(actualCommand)]) },
    { instruction: `Say ${quoted}, then ${actualCommand}, and finish standing.`, output: task(`Perform ${actualCommand}, then stand.`, [action(actualCommand), action('stand')]) },
    { instruction: words, output: task(`Execute ${quotedCommand}.`, [action(quotedCommand)]) },
    { instruction: `${words} Then say "All done."`, output: task(`Execute ${quotedCommand}.`, [action(quotedCommand)]) },
    { instruction: `Explain what the request ${quoted} means without moving.`, output: noTask() },
  ]
  const outputs = variants.map(item => item.output)
  const source = addCase('task', `quoted-imperative-${split}-${index}`,
    variants.map(item => item.instruction), ['needsAction', 'needsEnvironment'], outputs[0]!,
    { observation: bodyObservation() }, split)
  source.targets = Object.fromEntries(outputs.map((output, i) => [i, output]))
  source.inputSource = 'user'
  source.fold = index % 4
}

development.forEach((entry, index) => family(entry, index, 'development'))
evaluation.forEach((entry, index) => family(entry, index, 'evaluation'))
