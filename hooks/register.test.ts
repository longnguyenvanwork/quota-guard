import { expect, mock, test } from 'claude-code/testing'

const H = 3_600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

// Account a is the one logged in. `weekB` sets b's weekly usage.
function world(on: any, opts: { aPct: number; bPct: number; weekB: number; pause?: object }) {
  const calls: string[][] = []
  const prompts: string[] = []
  const status: (string | undefined)[] = []
  mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
  mock.store(on, opts.pause ? { 'pause:s1': opts.pause } : {})
  const clock = mock.clock(on, { now: Date.now() })
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('ui.status', (_: any, e: any) => (status.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => (prompts.push(e.text), { text: e.text }))
  on('fs.read', () => ({ value: JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', organizationType: 'claude_team' } }) }))
  on('process.run', (_: any, e: any) => {
    calls.push([...e.argv])
    if (e.argv[1] === 'list') {
      const acc = (email: string, active: boolean, five: number, week: number, fiveReset: number) => ({
        email, active, usageStatus: 'ok',
        usage: { fiveHour: { pct: five, resetsAt: iso(fiveReset) }, sevenDay: { pct: week, resetsAt: iso(30 * H) } },
      })
      const stdout = JSON.stringify({
        accounts: [
          acc('a@x.com', true, opts.aPct, 20, 1 * H),
          acc('b@x.com', false, opts.bPct, opts.weekB, 3 * H),
          { email: 'dead@x.com', active: false, usageStatus: 'relogin_required', usage: null },
        ],
      })
      return { value: { exitCode: 0, stdout, stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('tool.call', () => ({ result: {} }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  return { calls, prompts, status, clock }
}

async function start($: any, aPct: number) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: {} as any,
    rateLimits: [
      { kind: 'five_hour', percentUsed: aPct, resetsAt: iso(1 * H) },
      { kind: 'seven_day', percentUsed: 20, resetsAt: iso(30 * H) },
    ],
    changed: ['rateLimits'],
  })
}

test('below the line: nothing is asked of cswap and the call goes through', async ($, on) => {
  const w = world(on, { aPct: 50, bPct: 10, weekB: 10 })
  await start($, 50)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.isError).not.toBe(true)
  expect(w.calls.length).toBe(0)
  expect(w.status.at(-1)).toContain('a@x.com (team) | 5h 50%')
})

test('the account in use is full, another is free: switch to it, let the call through', async ($, on) => {
  const w = world(on, { aPct: 96, bPct: 10, weekB: 10 })
  await start($, 96)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.isError).not.toBe(true)
  expect(w.calls.some(c => c[1] === 'switch' && c[2] === 'b@x.com')).toBe(true)
})

test('every account is over (b by its week): pause until a is back, deny tools', async ($, on) => {
  const w = world(on, { aPct: 96, bPct: 10, weekB: 97 })
  await start($, 96)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: 'x', old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeDefined()
  expect(r.deny).toContain('on a@x.com')
  expect(w.calls.some(c => c[1] === 'switch')).toBe(false)
  expect(w.status.at(-1)).toContain('PAUSED until')
  const again: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(again.deny).toBeDefined()
})

test('a pause whose time has come resumes the session on the tick', async ($, on) => {
  const w = world(on, {
    aPct: 10, bPct: 10, weekB: 10,
    pause: { email: 'a@x.com', until: Date.now() - 1000, since: Date.now() - H },
  })
  await start($, 10)
  await w.clock.advance(60_000)
  expect(w.calls.some(c => c[1] === 'switch' && c[2] === 'a@x.com')).toBe(true)
  expect(w.prompts.at(-1)).toContain('[quota-guard]')
  expect(w.status.at(-1)).not.toContain('PAUSED')
})
