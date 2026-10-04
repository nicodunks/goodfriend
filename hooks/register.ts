import type { Engine, Register } from 'claude-code'

// Birthdays from Contacts, /seed (the people you've been texting) and /goodfriend add.

type Bday = { name: string; month: number; day: number }

const CONTACTS = `const C = Application('Contacts')
const n = C.people.name(), b = C.people.birthDate()
JSON.stringify(n.flatMap((x, i) => (b[i] ? [{ name: x, month: b[i].getMonth() + 1, day: b[i].getDate() }] : [])))`

// Recent one-on-one conversations, straight from the Messages app
const RECENT = `tell application "Messages"
  set out to ""
  repeat with c in (chats)
    try
      set ps to participants of c
      if (count of ps) is 1 then set out to out & (name of item 1 of ps) & linefeed
    end try
  end repeat
  return out
end tell`

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ')
const DAY = 86_400_000
const ENOUGH = "That's enough for now"

const first = (name: string) => name.split(' ')[0].toLowerCase()
const any = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
const valid = (m: number, d: number): [number, number] | null => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? [m, d] : null)

// "10/7", "oct 7", "October 7th", "7 Oct"
function parseDate(s: string): [number, number] | null {
  const num = /^\s*(\d{1,2})[/.-](\d{1,2})\s*$/.exec(s)
  if (num) return valid(+num[1], +num[2])
  const word = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})/i.exec(s)
  if (!word) return null
  const m = MONTHS.indexOf((word[1] ?? word[4]).toLowerCase()) + 1
  return m ? valid(m, +(word[2] ?? word[3])) : null
}

// people you've texted one-on-one lately, most recent first, skipping numbers, emails and short codes
async function recent($: Engine): Promise<string[]> {
  const r = await $.process.run(['osascript', '-e', RECENT], { timeoutMs: 120_000 })
  const names = r.stdout.split('\n').map(n => n.replace(/^Maybe:\s*/, '').trim())
  return [...new Set(names.filter(n => n && !/^[+\d(]/.test(n) && !n.includes('@')))]
}

async function load($: Engine): Promise<Bday[]> {
  const today = new Date().toDateString()
  let cache = (await $.store.get('contacts')) as { day: string; list: Bday[] } | undefined
  if (cache?.day !== today) {
    const r = await $.process.run(['osascript', '-l', 'JavaScript', '-e', CONTACTS], { timeoutMs: 90_000 })
    cache = { day: today, list: r.exitCode ? [] : JSON.parse(r.stdout) }
    await $.store.set('contacts', cache)
  }
  const manual = ((await $.store.get('manual')) as Bday[] | undefined) ?? []
  return [...new Map([...cache!.list, ...manual].map(b => [b.name.toLowerCase(), b])).values()] // manual wins
}

// add or correct; a bare first name matches someone already known when it's unambiguous
async function save($: Engine, name: string, month: number, day: number): Promise<Bday> {
  const known = (await load($)).filter(b => b.name.toLowerCase() === name.toLowerCase() || first(b.name) === name.toLowerCase())
  const b = { name: known.length === 1 ? known[0].name : name, month, day }
  const manual = ((await $.store.get('manual')) as Bday[] | undefined) ?? []
  await $.store.set('manual', [...manual.filter(x => x.name.toLowerCase() !== b.name.toLowerCase()), b])
  return b
}

function until(b: Bday): number {
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const next = (y: number) => Math.round((Date.UTC(y, b.month - 1, b.day) - today) / DAY)
  const d = next(now.getFullYear())
  return d < -3 ? next(now.getFullYear() + 1) : d
}

function line(b: Bday): string {
  const d = until(b)
  if (d === 0) return `🎂 It's ${b.name}'s birthday today`
  if (d === 1) return `🎂 ${b.name}'s birthday is tomorrow`
  if (d > 0) return `🎂 ${b.name}'s birthday is in ${d} days`
  return `🎂 You missed ${b.name}'s birthday ${-d} day${d === -1 ? '' : 's'} ago`
}

// Birthday today: 40% of turns for its first 3 showings, then 5%. Otherwise 5% for the week ahead / 3 days behind.
async function pick($: Engine): Promise<string | null> {
  const near = (await load($)).filter(b => until(b) <= 7)
  const todays = near.filter(b => until(b) === 0)
  if (!todays.length) return near.length && Math.random() < 0.05 ? line(any(near)) : null
  const day = new Date().toDateString()
  const shown = (await $.store.get('shown')) as { day: string; n: Record<string, number> } | undefined
  const n = (shown?.day === day && shown.n) || {}
  const fresh = todays.filter(b => (n[b.name] ?? 0) < 3)
  const b = Math.random() < (fresh.length ? 0.4 : 0.05) ? any(fresh.length ? fresh : todays) : null
  if (!b) return null
  n[b.name] = (n[b.name] ?? 0) + 1
  await $.store.set('shown', { day, n })
  return line(b)
}

// /seed: walk the people you've been texting and fill in the birthdays GoodFriend doesn't know yet
async function seed($: Engine): Promise<string> {
  const known = new Set((await load($)).map(b => b.name.toLowerCase()))
  const todo = (await recent($)).filter(n => !known.has(n.toLowerCase())).slice(0, 10)
  if (!todo.length) return "🎂 You already know everyone's birthday. Good friend."

  let saved = 0
  for (const [i, name] of todo.entries()) {
    const ask = `When's ${name}'s birthday? Type it under Other, like 10/7 or Oct 7.`
    const a = await $.ui.ask(ask, { header: `🎂 ${i + 1} of ${todo.length}`, options: ['Skip', ENOUGH] }).catch(() => ENOUGH)
    if (a === ENOUGH) break
    const date = parseDate(a)
    if (date) await save($, name, date[0], date[1]), saved++
    else if (a !== 'Skip') $.ui.toast(`Couldn't read "${a}", skipped ${name}`)
  }
  return saved ? `🎂 Saved ${saved} birthday${saved === 1 ? '' : 's'}. Your friends are lucky to have you.` : 'Nothing saved. /seed any time.'
}

async function welcome($: Engine) {
  const go = "Let's do it"
  const ask = 'GoodFriend reminds you of birthdays right here while you work. Want to add birthdays for the people you text most? It takes a minute.'
  const a = await $.ui.ask(ask, { header: 'GoodFriend', options: [go, 'Later'] }).catch(() => '')
  $.ui.toast(a === go ? await seed($) : 'Any time: /seed')
}

export const register: Register = on => {
  let current: string | null = null
  let test = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'goodfriend', description: 'Birthdays: list | add Name MM/DD | remove Name | test' })
    await $.command.register({ name: 'seed', description: 'Fill in birthdays for the people you text most' })
    await $.tool.register({
      name: 'set_birthday',
      description:
        "Save or correct a friend's birthday in GoodFriend, the user's birthday reminder. Use when the user says a birthday is wrong or tells you someone's birthday. Call list_birthdays first to use the exact name GoodFriend has.",
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, month: { type: 'integer', minimum: 1, maximum: 12 }, day: { type: 'integer', minimum: 1, maximum: 31 } },
        required: ['name', 'month', 'day'],
      },
    })
    await $.tool.register({ name: 'list_birthdays', description: 'List the birthdays GoodFriend knows, as "Full Name: M/D".' })
    if (!(await $.store.get('welcomed'))) await $.store.set('welcomed', true), void welcome($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__goodfriend__set_birthday' }, async ($, e) => {
    const { name, month, day } = e.input as { name: string; month: number; day: number }
    const b = await save($, name, month, day)
    return { text: `Saved ${b.name}: ${b.month}/${b.day}` }
  })

  on('tool.call', { tool: 'mcp__goodfriend__list_birthdays' }, async $ => ({
    text: (await load($)).map(b => `${b.name}: ${b.month}/${b.day}`).join('\n') || 'None yet',
  }))

  on('turn.start', async ($, e, next) => {
    const soonest = test ? (await load($)).sort((a, b) => until(a) - until(b))[0] : undefined
    current = soonest ? line(soonest) : await pick($)
    test = false
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) => next(current ? { ...e, props: { ...e.props, word: current } } : e))

  on('command.run', { command: 'seed' }, async $ => ({ text: await seed($) }))

  on('command.run', { command: 'goodfriend' }, async ($, e) => {
    const [cmd = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')

    if (cmd === 'test') return (test = true), { text: 'Next turn shows the soonest birthday.' }
    if (cmd === 'add') {
      const m = /^(.+?)\s+(\S+(?:\s+\d{1,2})?)$/.exec(arg)
      const date = m && parseDate(m[2])
      if (!m || !date) return { text: 'Usage: /goodfriend add Full Name MM/DD' }
      const b = await save($, m[1], date[0], date[1])
      return { text: `🎂 Saved ${b.name}: ${b.month}/${b.day}` }
    }
    if (cmd === 'remove') {
      const manual = ((await $.store.get('manual')) as Bday[] | undefined) ?? []
      await $.store.set('manual', manual.filter(b => b.name.toLowerCase() !== arg.toLowerCase()))
      return { text: `Removed ${arg}` }
    }

    const list = (await load($)).sort((a, b) => until(a) - until(b))
    const rows = list.map(b => `${until(b) === 0 ? '🎂' : '  '} ${b.name}: ${b.month}/${b.day}`)
    return { text: rows.join('\n') || 'No birthdays yet. Try /seed' }
  })
}
