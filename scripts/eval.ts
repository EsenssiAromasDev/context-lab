// Context Lab eval from a terminal or CI, with the same harness the Mod runs:
//
//   node scripts/eval.ts init [--root <dir>]
//   node scripts/eval.ts <variant> [--root <dir>]
//
// A headless `claude -p` cannot run a Mod's /context-lab command, so this is
// how experiments run unattended. Node >= 22.18 (type stripping).

import { spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { EvalHost, RunResult } from "../hooks/eval/host.ts"
import { initFiles, renderInit } from "../hooks/eval/init.ts"
import { renderExperiment } from "../hooks/eval/report.ts"
import { prepare, runExperiment } from "../hooks/eval/runner.ts"
import { parseAnalysisConfig } from "../hooks/analysis/config.ts"
import { applyToProject, planApply, renderApplyPlan } from "../hooks/eval/apply.ts"
import { parseEvalConfig } from "../hooks/eval/config.ts"
import { resolveClaude } from "../hooks/eval/host.ts"
import { mineTasks } from "../hooks/eval/mine.ts"
import { optimize, renderOptimize } from "../hooks/eval/optimize.ts"
import { propose, renderProposal } from "../hooks/eval/propose.ts"
import { latestSummary } from "../hooks/eval/runner.ts"
import { loadVariant } from "../hooks/eval/variant.ts"
import { gitInfo } from "../hooks/eval/worktree.ts"

export const nodeHost: EvalHost = {
  isWindows: process.platform === "win32",
  run(argv, opts = {}) {
    return new Promise<RunResult>((done, fail) => {
      // A grader is its own process: never part of a test run that started this one.
      const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env
      const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, shell: false, windowsHide: true })
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
  async link(target, path) {
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(target, path, "junction")
  },
  async unlink(path) {
    // Removes the link itself (a junction or symlink), never its target.
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    else throw new Error(`${path} is not a link`)
  },
}

async function main(args: string[]): Promise<number> {
  const rootAt = args.indexOf("--root")
  const root = resolve(rootAt >= 0 ? args[rootAt + 1]! : process.cwd()).replace(/\\/g, "/")
  const [command] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--root")
  if (!command) {
    console.error(
      [
        "uso: node scripts/eval.ts <comando> [--root <carpeta>]",
        "  init                       crea .context-lab/",
        "  optimize [--resumir]       saca tareas del historial, propone un recorte y lo prueba",
        "  mine                       saca tareas de prueba de tus commits",
        "  propose [--resumir]        escribe una versión recortada (no toca nada)",
        "  apply <versión> [--confirmar]  enseña qué cambia; con --confirmar, lo aplica",
        "  <versión>                  prueba tus instrucciones actuales contra esa versión",
      ].join("\n"),
    )
    return 2
  }
  const flag = (f: string) => args.includes(f)
  const configText = () => (existsSync(`${root}/.context-lab/config.json`) ? readFileSync(`${root}/.context-lab/config.json`, "utf8") : undefined)
  if (command === "optimize") {
    const o = await optimize(nodeHost, root, {
      summarize: flag("--resumir"),
      onStep: (st) => {
        if (st.step === "mine" && st.progress.current) console.log(`[historial] ${st.progress.kept} tareas · ${st.progress.scanned} commits · probando «${st.progress.current.slice(0, 60)}»`)
        if (st.step === "propose") console.log("[propuesta] preparando la versión recortada…")
        if (st.step === "eval" && st.progress.current) console.log(`[prueba ${st.progress.done + 1}/${st.progress.total}] ${st.progress.current}`)
      },
    })
    console.log(`\n${renderOptimize(o)}`)
    return o.stopped && !o.run ? 1 : 0
  }
  if (command === "mine" || command === "propose" || command === "apply") {
    const info = await gitInfo(nodeHost, root)
    if ("error" in info) {
      console.error(info.error)
      return 1
    }
    const text = configText()
    const config = parseEvalConfig(text)
    if (command === "mine") {
      const o = await mineTasks(nodeHost, root, info, config, (p) => {
        if (p.current) console.log(`[${p.kept} tareas · ${p.scanned} commits] probando «${p.current.slice(0, 60)}»`)
      })
      console.log(`\nTareas: ${o.kept.length}`)
      for (const k of o.kept) console.log(`  ${k.id}  ${k.subject.slice(0, 70)}`)
      console.log(`Commits revisados ${o.scanned} · candidatos comprobados ${o.candidates} · descartes: ${JSON.stringify(o.skipped)}`)
      return 0
    }
    if (command === "propose") {
      let claude: string[] | undefined
      if (flag("--resumir")) {
        const c = await resolveClaude(nodeHost, config.claude)
        if ("error" in c) {
          console.error(c.error)
          return 1
        }
        claude = c.argv
      }
      const p = await propose(nodeHost, root, info, config, { analysis: parseAnalysisConfig(text), ...(claude ? { summarize: true, claude } : {}) })
      console.log(p ? renderProposal(p) : "No hay nada que recortar con seguridad.")
      return 0
    }
    const name = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--root")[1]
    if (!name) {
      console.error("uso: node scripts/eval.ts apply <versión> [--confirmar]")
      return 2
    }
    const v = await loadVariant(nodeHost, root, name)
    if ("error" in v) {
      console.error(v.error)
      return 1
    }
    const latest = await latestSummary(nodeHost, root).catch(() => undefined)
    const plan = await planApply(nodeHost, root, info, v, latest?.variant === name ? latest : undefined)
    if (!flag("--confirmar") || plan.blocked.length) {
      console.log(renderApplyPlan(plan).replace(`/context-lab aplicar ${name} confirmar`, `node scripts/eval.ts apply ${name} --confirmar`))
      return plan.blocked.length ? 1 : 0
    }
    console.log(`Aplicado: ${(await applyToProject(nodeHost, root, v)).join(", ")}`)
    return 0
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
