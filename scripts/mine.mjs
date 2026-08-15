#!/usr/bin/env node
/**
 * Mining loop, script side: collects raw community signals for the AI triage
 * pass. Runs on a schedule and on demand; the AI only sees the DIFF of new or
 * changed signals, so the analysis cost stays near zero.
 *
 * Outputs:
 *   docs/reports/<date>/signals.json — the raw payload of this run
 *   docs/reports/latest-seen.json   — the watermark for the next run
 *   stdout                          — markdown suitable for a triage issue
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GITHUB_DISCUSSIONS = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/discussions?per_page=100'
const NPM_DSH = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'dsh-doctor-miner', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.json()
}

const discussions = await fetchJson(GITHUB_DISCUSSIONS)
const discussionSignals = discussions
  .filter(item => typeof item.number === 'number' && typeof item.title === 'string')
  .map(item => ({ id: `disc-${item.number}`, title: item.title, url: item.html_url, updatedAt: item.updated_at }))

const dsh = await fetchJson(NPM_DSH)
const distTags = dsh['dist-tags'] ?? {}

const date = new Date().toISOString().slice(0, 10)
const reportDir = join(process.cwd(), 'docs', 'reports', date)
mkdirSync(reportDir, { recursive: true })
const seenFile = join(process.cwd(), 'docs', 'reports', 'latest-seen.json')
const seen = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : { discussions: {}, distTag: '' }

const fresh = discussionSignals.filter(signal => seen.discussions[signal.id] !== signal.updatedAt)
const distTagChanged = seen.distTag !== distTags.latest

const payload = {
  minedAt: new Date().toISOString(),
  distTags,
  distTagChanged,
  newOrChangedDiscussions: fresh.length,
  signals: fresh.slice(0, 30),
}
writeFileSync(join(reportDir, 'signals.json'), `${JSON.stringify(payload, null, 2)}\n`)
writeFileSync(seenFile, `${JSON.stringify({
  discussions: Object.fromEntries(discussionSignals.map(signal => [signal.id, signal.updatedAt])),
  distTag: distTags.latest,
}, null, 2)}\n`)

let markdown = `## Mining run ${payload.minedAt}\n\n`
markdown += `- dsh dist-tags: \`${JSON.stringify(distTags)}\`${distTagChanged ? ' ⚠️ **CHANGED — new DSH release, triage now**' : ''}\n`
markdown += `- new/changed discussions: ${fresh.length}\n\n`
if (fresh.length > 0) {
  markdown += '| # | title |\n|---|---|\n'
  for (const signal of fresh) markdown += `| [${signal.id}](${signal.url}) | ${signal.title.replace(/\|/g, '\\|')} |\n`
} else {
  markdown += '_Nothing new since the last run._\n'
}
process.stdout.write(markdown)
