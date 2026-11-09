import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Log errors, never requests, evidence, provider bodies or model replies.
// Keep useful transport/status/stack details while stripping common secrets.
export function redact(value, limit = 4000) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:["']?)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|token)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1?[REDACTED]')
    .slice(0, limit)
}

export function errorDetail(error, depth = 0) {
  const detail = { name: redact(error?.name || 'Error', 80), message: redact(error?.message ?? error) }
  for (const key of ['code', 'status', 'statusCode']) {
    if (typeof error?.[key] === 'number' || typeof error?.[key] === 'string') detail[key] = redact(error[key], 120)
  }
  if (error?.stack) detail.stack = redact(error.stack, 6000)
  if (error?.cause && depth < 2) detail.cause = errorDetail(error.cause, depth + 1)
  return detail
}

/** Private, bounded diagnostic history beside state.json; survives restarts. */
export function appendDiagnostic(dir, diagnostic) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'observer-errors.jsonl')
  if (existsSync(path) && statSync(path).size >= 1_000_000) renameSync(path, `${path}.1`)
  appendFileSync(path, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}
