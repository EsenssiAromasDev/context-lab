import type { StateStorage } from "../../core/session.ts"

// <project>/.claudeos/ through Claude Code's `$.fs`, the only file access a
// hooks module has (no Node). Same layout as storage/node-store.ts, so a Node
// CLI, this plugin, or another agent's adapter all read the same state.
//
// $.fs has no append or rename: the journal is read and rewritten whole, and
// a write is not guaranteed atomic. The journal is recovery only (the
// snapshot is read first), and parseJournal skips a torn last line.
// Known limit: $.fs.read refuses files over 4 MiB (~40k events); rotate the
// journal before that matters.

/** The subset of `$.fs` this store needs. */
export interface RuntimeFs {
  read(path: string): Promise<string | { base64: string }>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export class RuntimeStore implements StateStorage {
  readonly dir: string
  readonly statePath: string
  readonly journalPath: string
  private readonly fs: RuntimeFs
  private readonly now: () => number

  constructor(fs: RuntimeFs, projectRoot: string, now: () => number) {
    this.fs = fs
    this.now = now
    this.dir = `${projectRoot.replace(/[\\/]+$/, "")}/.claudeos`
    this.statePath = `${this.dir}/state.json`
    this.journalPath = `${this.dir}/events.jsonl`
  }

  readSnapshot(): Promise<string | null> {
    return this.readText(this.statePath)
  }

  writeSnapshot(text: string): Promise<void> {
    return this.fs.write(this.statePath, text)
  }

  quarantineSnapshot(text: string): Promise<void> {
    return this.fs.write(`${this.statePath}.corrupt-${this.now()}`, text)
  }

  async readJournal(): Promise<string> {
    return (await this.readText(this.journalPath)) ?? ""
  }

  async appendJournal(line: string): Promise<void> {
    const current = await this.readJournal()
    // Keep a torn tail on its own line so the new event still parses.
    const sep = current === "" || current.endsWith("\n") ? "" : "\n"
    await this.fs.write(this.journalPath, current + sep + line)
  }

  private async readText(path: string): Promise<string | null> {
    if (!(await this.fs.exists(path))) return null
    const content = await this.fs.read(path)
    return typeof content === "string" ? content : null
  }
}
