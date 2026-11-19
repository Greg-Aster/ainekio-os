import { addCase, intentOutput, observation, task, TIME, type CaseSplit } from './development-cases.js'

// Synthetic episodes keep the original objective unchanged across acquisition,
// using source-appropriate phrasing for user vs autonomous intentions.
function episode(target: string, index: number, split: CaseSplit) {
  const fold = index % 4
  const frameId = `synthetic-${split}-camera-8b27-${index}-epoch-12-frame-${731 + index * 23}`
  const box = { x: .12 + (index % 4) * .1, y: .18, width: .21, height: .32 }
  const candidate = { box, description: target, evidence: `One visible object matches the ${target} description.` }
  const evidence = { kind: 'vision_acquisition', acquisition: { purpose: 'locate', outcome: 'found',
    frame: { id: frameId, timestamp: TIME, metadata: { robotId: 'synthetic-robot', gatewayInstance: 'synthetic-gateway', epoch: 12, counter: 731 + index * 23 } },
    candidates: [candidate] } }
  const body = observation()
  body.state = { ...body.state, recognition: { enabled: true, visionOperations: ['search', 'select', 'release'], visionTarget: null } }

  for (const inputSource of ['user', 'autonomy'] as const) {
    const instructions = inputSource === 'user'
      ? [
          `Find the ${target} and maintain visual tracking while staying stationary. Report the result.`,
          `Locate and keep tracking the ${target} from where you are, then tell me what happens.`,
        ]
      : [
          `Establish and maintain stationary visual tracking of the ${target}.`,
          `Acquire the ${target} in the camera feed and hold stationary visual tracking.`,
        ]
    const routing = addCase('intent', `vision-continuation-route-${index}`, instructions, [],
      { ...intentOutput(['environment', 'vision'], inputSource === 'user' ? ['environment', 'robotStatus'] : [], inputSource === 'user', true), taskPlanner: 'vision' }, {}, split)
    routing.inputSource = inputSource
    routing.fold = fold
    for (const stage of ['initial', 'acquired'] as const) {
      const step = stage === 'initial' ? { kind: 'vision', operation: 'acquire', target }
        : { kind: 'vision', operation: 'select', frameId, box, description: target }
      const source = addCase('task', `vision-continuation-${stage}-${index}`, instructions,
        ['needsAction', 'needsEnvironment', 'needsVision'], task(`Establish stationary visual tracking of the ${target}.`, [step], {
          completionCriteria: `Fresh recognition for the accepted selection query identifies the ${target} with a track ID.`,
          continuationPolicy: 'bounded', requiredCompletionBasis: 'environment_state',
        }), { observation: body }, split)
      source.inputSource = inputSource
      source.fold = fold
      source.taskEvidence = stage === 'acquired' ? evidence : undefined
    }
    const locateText = inputSource === 'user'
      ? `Locate the ${target} in the image and report its location without configuring tracking.`
      : `Confirm the visible image location of the ${target} without starting tracking.`
    const locate = addCase('task', `vision-continuation-locate-only-${index}`, [locateText], ['needsEnvironment', 'needsVision'], {
      taskDecision: { objective: `Locate the ${target} in the image.`,
        completionCriteria: `The acquired image identifies the ${target} location.`, outcome: 'complete',
        reason: 'The returned acquisition establishes the requested image location; tracking was not requested.',
        continuationPolicy: 'none', requiredCompletionBasis: 'visual_observation' }, program: null,
    }, { observation: body }, split)
    locate.inputSource = inputSource
    locate.fold = fold
    locate.taskEvidence = evidence
  }
}

for (const [index, target] of ['purple watering can', 'striped oven mitt', 'yellow tape dispenser', 'wooden pepper mill'].entries()) episode(target, index, 'development')
for (const [index, target] of ['orange bicycle pump', 'white ceramic teapot'].entries()) episode(target, index + 4, 'evaluation')
