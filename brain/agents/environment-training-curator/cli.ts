#!/usr/bin/env node
import { run } from './core.js'

function option(name: string): string | undefined {
  const position = process.argv.indexOf(`--${name}`)
  return position < 0 ? undefined : process.argv[position + 1]
}

await run({ username: option('username'), bank: option('bank'),
  limit: Number(option('limit') || 10), force: process.argv.includes('--force'),
}).catch(error => { console.error(error); process.exitCode = 1 })
