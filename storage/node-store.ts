import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StateStorage } from "../core/session.ts"

// <project>/.claudeos/ on Node's fs. Synchronous underneath on purpose: a
// short-lived hook process must not exit before the write lands.

export class NodeStore implements StateStorage {
  readonly dir: string
  readonly statePath: string
  readonly journalPath: string

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, ".claudeos")
    this.statePath = join(this.dir, "state.json")
    this.journalPath = join(this.dir, "events.jsonl")
  }

  async readSnapshot(): Promise<string | null> {
    return existsSync(this.statePath) ? readFileSync(this.statePath, "utf8") : null
  }

  async writeSnapshot(text: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, this.statePath)
  }

  async quarantineSnapshot(text: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(`${this.statePath}.corrupt-${Date.now()}`, text, "utf8")
  }

  async readJournal(): Promise<string> {
    return existsSync(this.journalPath) ? readFileSync(this.journalPath, "utf8") : ""
  }

  async appendJournal(line: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.journalPath, line, "utf8")
  }
}
