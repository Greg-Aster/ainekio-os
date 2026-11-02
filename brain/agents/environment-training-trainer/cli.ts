#!/usr/bin/env node
import { runTraining } from './core.js'

async function main(): Promise<void> {
  const option = (name: string) => process.argv.includes(`--${name}`)
    ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined
  if (process.argv.includes('--specialist') && option('specialist') === undefined) {
    throw new Error('--specialist must be intent, task, or all')
  }
  await runTraining({ username: option('username'), specialist: option('specialist') })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch(error => { console.error(error); process.exitCode = 1 })
}
