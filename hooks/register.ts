// quota-guard: plan usage in the status line, and what to do near the limit.
//
// - Status line: the active account, the 5-hour and weekly windows, when each
//   resets. The same line goes under every answer, for surfaces with no footer.
// - One account near the line (>= THRESHOLD): switch to another with cswap.
//   `cswap auto`, when it runs, usually gets there first; this covers the case
//   where it does not.
// - Every account near the line: deny tools from the next call on, so the rest
//   of the quota is not spent finishing a step, and submit a resume prompt in
//   THIS session when the earliest account is back. The built-in "continue at
//   usage limit" waits for the current account only; this waits for whichever
//   account resets first.
//
// Accounts and their usage come from cswap (`cswap list --json`); the session's
// own rate-limit readings come from `session.measure`.
import type { EngineInterface as Engine, Register } from 'claude-code'

const THRESHOLD = 95
const RESUME_DELAY_MS = 2 * 60_000
const LIST_TTL_MS = 60_000
const SWITCH_COOLDOWN_MS = 60_000
const TICK_MS = 60_000

type Win = { pct: number; resetsAt: number } // resetsAt: epoch ms
type Usage = { five?: Win; week?: Win; at: number }
type Acct = { email: string; plan: string }
type Listed = { email: string; active: boolean; usable: boolean; usage: Usage }
type Pause = { email: string; until: number; since: number }

const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const left = (t: number) => {
  const m = Math.max(0, Math.round((t - Date.now()) / 60_000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return d ? `${d}d${h}h` : h ? `${h}h${pad(mm)}m` : `${mm}m`
}

// A window whose reset has passed is empty, whatever the last reading said.
const live = (w?: Win) => (w && w.resetsAt > Date.now() ? w : undefined)
const windows = (u?: Usage) => [u?.five, u?.week].filter((w): w is Win => !!live(w))
const isOver = (u?: Usage) => windows(u).some(w => w.pct >= THRESHOLD)
// Usable again once every window over the line has reset.
const blockedUntil = (u?: Usage) =>
  Math.max(0, ...windows(u).filter(w => w.pct >= THRESHOLD).map(w => w.resetsAt))

function format(acct: Acct | undefined, u: Usage | undefined, pause: Pause | undefined) {
  const win = (w: Win | undefined, label: string, withDay: boolean) => {
    if (!w) return `${label} --`
    if (!live(w)) return `${label} 0% (reset)`
    const day = withDay ? DAYS[new Date(w.resetsAt).getDay()] + ' ' : ''
    return `${label} ${Math.round(w.pct)}% reset ${day}${hhmm(w.resetsAt)} (${left(w.resetsAt)})`
  }
  return [
    acct ? acct.email + (acct.plan ? ` (${acct.plan})` : '') : undefined,
    win(u?.five, '5h', false),
    win(u?.week, 'Week', true),
    pause ? `PAUSED until ${hhmm(pause.until)} (${pause.email})` : undefined,
  ].filter(Boolean).join(' | ')
}

// One-shot cron-like rounding is not needed here (the tick fires it), but the
// reset times the server gives are to the second: wait a little past them.
const fireTime = (resetAt: number) => resetAt + RESUME_DELAY_MS

const resumePrompt = (email: string) =>
  `[quota-guard] The usage window has reset and ${email} is the active account again. ` +
  'Continue the task you were working on before the quota pause, from exactly where you stopped.'

// Module state: starts over on a reload; what must survive is in $.store.
let home = ''
let configDir = ''
let cswapExe: string | undefined
let acctCache: { at: number; acct?: Acct } = { at: 0 }
let listCache: { at: number; list?: Listed[] } = { at: 0 }
let lastSwitch = 0
let sessionId = ''
let pause: Pause | undefined
let mainTurn: string | undefined
let deniedThisTurn = false
let tick: { cancel: () => void } | undefined

async function account($: Engine): Promise<Acct | undefined> {
  if (Date.now() - acctCache.at < 5_000) return acctCache.acct
  let acct: Acct | undefined
  try {
    const raw = (await $.fs.read(`${configDir}/.claude.json`)) as string
    const a = JSON.parse(raw).oauthAccount
    if (a?.emailAddress) {
      acct = { email: a.emailAddress, plan: String(a.organizationType || a.seatTier || '').replace(/^claude_/, '') }
    }
  } catch {}
  acctCache = { at: Date.now(), acct }
  return acct
}

async function usageOf($: Engine, email: string): Promise<Usage | undefined> {
  const all = ((await $.store.get('usage')) ?? {}) as Record<string, Usage>
  return all[email]
}

async function saveUsage($: Engine, email: string, u: Usage) {
  const all = ((await $.store.get('usage')) ?? {}) as Record<string, Usage>
  const prev = all[email]
  if (prev && prev.at > u.at) return
  all[email] = u
  await $.store.set('usage', all)
}

// A hook's PATH can be thin (macOS GUI apps); cswap lives in uv's bin folder.
async function cswap($: Engine, args: string[], timeoutMs = 30_000) {
  const candidates = cswapExe
    ? [cswapExe]
    : ['cswap', `${home}/.local/bin/cswap.exe`, `${home}/.local/bin/cswap`, '/opt/homebrew/bin/cswap', '/usr/local/bin/cswap']
  for (const exe of candidates) {
    try {
      const r = await $.process.run([exe, ...args], { timeoutMs })
      cswapExe = exe
      return r
    } catch {}
  }
  return undefined
}

async function list($: Engine): Promise<Listed[] | undefined> {
  if (listCache.list && Date.now() - listCache.at < LIST_TTL_MS) return listCache.list
  const r = await cswap($, ['list', '--json'])
  if (!r || r.exitCode !== 0) return listCache.list
  let data: any
  try { data = JSON.parse(r.stdout) } catch { return listCache.list }
  const win = (w: any): Win | undefined =>
    w && typeof w.pct === 'number' ? { pct: w.pct, resetsAt: Date.parse(w.resetsAt) || 0 } : undefined
  const out: Listed[] = []
  for (const a of data.accounts ?? []) {
    const usage: Usage = { five: win(a.usage?.fiveHour), week: win(a.usage?.sevenDay), at: Date.parse(a.usageFetchedAt) || Date.now() }
    const usable = a.usageStatus === 'ok' && !a.disabled && !!(usage.five || usage.week)
    out.push({ email: a.email, active: !!a.active, usable, usage })
    if (usable) await saveUsage($, a.email, usage)
  }
  listCache = { at: Date.now(), list: out }
  return out
}

async function refresh($: Engine) {
  const acct = await account($)
  const u = acct ? await usageOf($, acct.email) : undefined
  $.ui.status(format(acct, u, pause))
}

async function setPause($: Engine, p: Pause | undefined) {
  pause = p
  if (p) await $.store.set(`pause:${sessionId}`, p)
  else await $.store.delete(`pause:${sessionId}`)
  await refresh($)
}

async function resume($: Engine) {
  const p = pause
  if (!p) return
  await setPause($, undefined)
  listCache = { at: 0 }
  const r = await cswap($, ['switch', p.email])
  acctCache = { at: 0 }
  $.ui.toast(r?.exitCode === 0 ? `quota-guard: resuming on ${p.email}` : `quota-guard: resuming (cswap switch ${p.email} failed)`)
  await $.prompt.submit({ text: resumePrompt(p.email) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    home = home.replace(/\\/g, '/')
    configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || home).replace(/\\/g, '/')
    sessionId = await $.session.id()

    // Forget pauses of sessions long gone.
    const week = 8 * 86_400_000
    for (const k of await $.store.keys()) {
      if (!k.startsWith('pause:') || k === `pause:${sessionId}`) continue
      const p = (await $.store.get(k)) as Pause | undefined
      if (!p || Date.now() - p.since > week) await $.store.delete(k)
    }
    pause = ((await $.store.get(`pause:${sessionId}`)) as Pause | undefined) ?? undefined

    await $.command.register({ name: 'quota', description: 'Usage of every cswap account; `/quota resume` ends a pause now.' })

    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => {
      void (async () => {
        if (pause && Date.now() >= pause.until) await resume($)
        else await refresh($)
      })().catch(() => {})
    })
    await refresh($)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('rateLimits') && e.rateLimits.length) {
      const acct = await account($)
      const win = (kind: string): Win | undefined => {
        const w = e.rateLimits.find(x => x.kind === kind)
        return w && w.resetsAt ? { pct: w.percentUsed, resetsAt: Date.parse(w.resetsAt) } : undefined
      }
      const u: Usage = { five: win('five_hour'), week: win('seven_day'), at: Date.now() }
      // After `cswap switch`, the login record names the new account while the
      // reading may still be the old account's last reply: the same figures
      // under a different email are that stale reply.
      const sig = JSON.stringify([u.five, u.week])
      const last = (await $.store.get('last')) as { sig: string; email: string } | undefined
      if (acct && !(last && last.sig === sig && last.email !== acct.email)) {
        await saveUsage($, acct.email, u)
        await $.store.set('last', { sig, email: acct.email })
      }
    }
    await refresh($)
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurn = e.turnId
      deniedThisTurn = false
    }
    return next(e)
  })

  // The usage line under each answer, for surfaces that draw no status line.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const acct = await account($)
    const u = acct ? await usageOf($, acct.email) : undefined
    return { ...r, text: format(acct, u, pause) }
  })

  on('command.run', { command: 'quota' }, async ($, e) => {
    if (e.args.trim() === 'resume') {
      if (!pause) return { text: 'quota-guard: not paused.' }
      await resume($)
      return { text: 'quota-guard: pause ended.' }
    }
    listCache = { at: 0 }
    const all = await list($)
    if (!all) return { text: 'quota-guard: `cswap list --json` failed. Is cswap installed?' }
    const lines = all.map(a =>
      (a.active ? '* ' : '  ') +
      (a.usable ? format({ email: a.email, plan: '' }, a.usage, undefined) : `${a.email} | needs login (cswap)`))
    if (pause) lines.push(`Paused until ${hhmm(pause.until)}, resuming on ${pause.email}.`)
    return { text: lines.join('\n') }
  })

  on('tool.call', async ($, e, next) => {
    const denyPaused = (p: Pause) => {
      // A second tool call after the pause was announced: stop the turn rather
      // than let the model keep trying.
      if (deniedThisTurn && mainTurn && e.agentId === undefined) {
        const t = mainTurn
        $.clock.after(0, () => void $.turn.abort({ turnId: t }).catch(() => {}))
      }
      deniedThisTurn = true
      return {
        deny:
          `QUOTA GUARD: every Claude account is at or over ${THRESHOLD}% of a usage limit, so work is paused here. ` +
          `It resumes by itself at ${hhmm(p.until)} on ${p.email}, in this session. ` +
          'Do not call any more tools. End your turn now with one short line telling the user that.',
      }
    }

    if (pause) {
      if (Date.now() < pause.until) return denyPaused(pause)
      await resume($)
    }

    const acct = await account($)
    if (!acct || !isOver(await usageOf($, acct.email))) return next(e)

    const all = await list($)
    const usable = all?.filter(a => a.usable) ?? []
    if (!usable.length) return next(e) // cannot judge: never block on a guess

    const free = usable.find(a => !blockedUntil(a.usage))
    if (free) {
      const active = usable.find(a => a.active)
      if (active && blockedUntil(active.usage) && Date.now() - lastSwitch > SWITCH_COOLDOWN_MS) {
        lastSwitch = Date.now()
        const r = await cswap($, ['switch', free.email])
        listCache = { at: 0 }
        acctCache = { at: 0 }
        $.ui.toast(r?.exitCode === 0 ? `quota-guard: switched to ${free.email}` : `quota-guard: cswap switch ${free.email} failed`)
        await refresh($)
      }
      return next(e)
    }

    const earliest = usable
      .map(a => ({ email: a.email, at: blockedUntil(a.usage) }))
      .sort((x, y) => x.at - y.at)[0]!
    const p: Pause = { email: earliest.email, until: fireTime(earliest.at), since: Date.now() }
    await setPause($, p)
    $.ui.toast(`quota-guard: all accounts >= ${THRESHOLD}%, paused until ${hhmm(p.until)}`)
    return denyPaused(p)
  }).catch(($, e, next) =>
    // A broken guard must not block work: let the call through.
    next(e),
  )
}
