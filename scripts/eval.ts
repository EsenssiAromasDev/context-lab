// Context Lab eval from a terminal or CI, with the same harness the Mod runs:
//
//   node scripts/eval.ts init [--root <dir>]
//   node scripts/eval.ts <variant> [--root <dir>]
//
// A headless `claude -p` cannot run a Mod's /context-lab command, so this is
// how experiments run unattended. Node >= 22.18 (type stripping).

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { EvalHost, RunResult } from "../hooks/eval/host.ts"
import { initFiles, renderInit } from "../hooks/eval/init.ts"
import { renderExperiment } from "../hooks/eval/report.ts"
import { prepare, runExperiment } from "../hooks/eval/runner.ts"

export const nodeHost: EvalHost = {
  isWindows: process.platform === "win32",
  run(argv, opts = {}) {
    return new Promise<RunResult>((done, fail) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, shell: false, windowsHide: true })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.stdin.end()
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            child.kill()
            fail(new Error(`timed out after ${opts.timeoutMs} ms`))
          }, opts.timeoutMs)
        : undefined
      child.on("error", (err) => {
        if (timer) clearTimeout(timer)
        fail(err)
      })
      child.on("close", (code) => {
        if (timer) clearTimeout(timer)
        done({ exitCode: code ?? 1, stdout, stderr })
      })
    })
  },
  async read(path) {
    return readFileSync(path, "utf8")
  },
  async write(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  },
  async exists(path) {
    return existsSync(path)
  },
  async list(path) {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      kind: e.isFile() ? ("file" as const) : e.isDirectory() ? ("dir" as const) : ("other" as const),
    }))
  },
  async now() {
    return Date.now()
  },
}

async function main(args: string[]): Promise<number> {
  const rootAt = args.indexOf("--root")
  const root = resolve(rootAt >= 0 ? args[rootAt + 1]! : process.cwd()).replace(/\\/g, "/")
  const [command] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--root")
  if (!command) {
    console.error("uso: node scripts/eval.ts init | <versión> [--root <carpeta>]")
    return 2
  }
  if (command === "init") {
    const created: string[] = []
    const kept: string[] = []
    for (const f of initFiles()) {
      const path = `${root}/${f.path}`
      if (existsSync(path)) kept.push(f.path)
      else {
        await nodeHost.write(path, f.text)
        created.push(f.path)
      }
    }
    console.log(renderInit(created, kept))
    return 0
  }

  const prepared = await prepare(nodeHost, root, command)
  if ("error" in prepared) {
    console.error(prepared.error)
    return 1
  }
  const total = prepared.tasks.length * prepared.config.trialsPerTask * 2
  console.log(`Context Lab: tus instrucciones actuales contra "${command}" — ${prepared.tasks.length} tarea(s) × ${prepared.config.trialsPerTask} intento(s) × 2 = ${total} ejecuciones`)
  console.log(`git ${prepared.info.sha.slice(0, 10)} · Claude Code ${prepared.claude.version} · ${prepared.claude.argv.join(" ")}`)
  const outcome = await runExperiment(nodeHost, root, prepared, {
    onProgress: (p) => {
      if (p.current) console.log(`[${p.done + 1}/${p.total}] ${p.current}`)
    },
  })
  for (const r of outcome.results) {
    console.log(`  ${r.success ? "BIEN " : "FALLO"}  ${r.taskId} · ${r.variant} · intento ${r.trial}  ${(r.durationMs / 1000).toFixed(0)} s${r.error ? `  (${r.error})` : ""}`)
  }
  console.log(`\n${renderExperiment(outcome.summary)}\n\nResultados: ${outcome.resultsDir}`)
  return 0
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
