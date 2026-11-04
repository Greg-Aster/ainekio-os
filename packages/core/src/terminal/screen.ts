import { createRequire } from 'node:module'

// The service runs through both ESM and tsx's CommonJS entrypoint. Load the
// packages' Node exports consistently in both launch paths.
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')

/** A bounded, parsed screen. Slow viewers reconnect to a snapshot, never an output log. */
export class TerminalScreen {
  private terminal: InstanceType<typeof Terminal>
  private serializer = new SerializeAddon()
  private pending: Promise<void> = Promise.resolve()
  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    this.terminal.loadAddon(this.serializer)
  }
  write(data: string): Promise<void> {
    this.pending = this.pending.then(() => new Promise<void>(resolve => this.terminal.write(data, resolve)))
    return this.pending
  }
  async snapshot(): Promise<string> {
    await this.pending
    return this.serializer.serialize()
  }
  async text(): Promise<string> {
    await this.pending
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)!
      if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true)
      else lines.push(line.translateToString(true))
    }
    return lines.join('\n').trimEnd()
  }
  dispose(): void { this.terminal.dispose() }
}
