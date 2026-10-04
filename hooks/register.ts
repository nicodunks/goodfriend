import type { Engine, Register } from 'claude-code'

// Birthdays from Contacts, /goodfriend add, /seed, and (opt-in) "happy birthday" texts you've sent in iMessage.

type Bday = { name: string; month: number; day: number; maybe?: boolean }
type Person = [name: string, bday: [number, number] | null, handles: string[]]

const CONTACTS = `const C = Application('Contacts')
const n = C.people.name(), b = C.people.birthDate(), p = C.people.phones.value(), e = C.people.emails.value()
JSON.stringify(n.map((x, i) => [x, b[i] ? [b[i].getMonth() + 1, b[i].getDate()] : null, [...(p[i] || []), ...(e[i] || [])]]))`

const hex = (s: string) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase()
const WORDS = ['irthday', 'IRTHDAY', 'bday', 'Bday', 'BDAY', 'hbd', 'Hbd', 'HBD']
const WISHES = `select m.text t, hex(m.attributedBody) b,
  strftime('%Y-%m-%d', m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') d,
  (select group_concat(h.id) from chat_handle_join j join handle h on h.ROWID = j.handle_id where j.chat_id = c.chat_id) ids
from message m join chat_message_join c on c.message_id = m.ROWID
where m.is_from_me and (${WORDS.map(w => `instr(m.text, '${w}') or instr(hex(m.attributedBody), '${hex(w)}')`).join(' or ')})`
const CLOSEST = `select h.id id, count(*) n from message m join handle h on h.ROWID = m.handle_id
where m.date > (strftime('%s', 'now', '-365 days') - 978307200) * 1000000000 group by h.id order by n desc limit 60`

const BDAY = /happy\s+(belated\s+)?b(irth)?day|\bhbd\b/i
const NAMED = /(?:birthday|bday|hbd)[\s,!]+([a-z]{2,})/i
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ')
const FDA = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
const DAY = 86_400_000

const handle = (h: string) => (h.includes('@') ? h.toLowerCase() : h.replace(/\D/g, '').slice(-10))
const first = (name: string) => name.split(' ')[0].toLowerCase()
const any = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

// iMessage stores most text in an archived NSAttributedString; pull the plain string out of its hex
function decode(b: string): string {
  const at = b.indexOf(hex('NSString'))
  if (at < 0) return ''
  let i = at / 2 + 8 + 5
  const byte = (k: number) => parseInt(b.slice(k * 2, k * 2 + 2), 16)
  let n = byte(i)
  if (n === 0x81) (n = byte(i + 1) | (byte(i + 2) << 8)), (i += 2)
  return Array.from({ length: n }, (_, k) => String.fromCharCode(byte(i + 1 + k))).join('')
}

// "10/7", "oct 7", "October 7th", "7 Oct"
function parseDate(s: string): [number, number] | null {
  const num = /^\s*(\d{1,2})[/.-](\d{1,2})\s*$/.exec(s)
  if (num) return valid(+num[1], +num[2])
  const word = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})/i.exec(s)
  if (!word) return null
  const m = MONTHS.indexOf((word[1] ?? word[4]).toLowerCase()) + 1
  return m ? valid(m, +(word[2] ?? word[3])) : null
}
const valid = (m: number, d: number): [number, number] | null => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? [m, d] : null)

async function contacts($: Engine): Promise<Person[]> {
  const r = await $.process.run(['osascript', '-l', 'JavaScript', '-e', CONTACTS], { timeoutMs: 90_000 })
  return r.exitCode ? [] : JSON.parse(r.stdout)
}

// rows from the Messages database, or null when macOS blocks the read (no Full Disk Access)
async function messages<T>($: Engine, sql: string): Promise<T[] | null> {
  const db = 'sqlite3 -readonly -json "$HOME/Library/Messages/chat.db" "$1"'
  const r = await $.process.run(['sh', '-c', db, 'sh', sql], { timeoutMs: 120_000 })
  return r.exitCode ? null : JSON.parse(r.stdout || '[]')
}

const byHandle = (people: Person[]) => new Map(people.flatMap(([name, , hs]) => hs.map(h => [handle(h), name] as const)))

async function texts($: Engine, people: Person[]): Promise<Bday[] | null> {
  const rows = await messages<{ t: string | null; b: string; d: string; ids: string | null }>($, WISHES)
  if (!rows) return null
  const names = byHandle(people)
  const seen = new Map<string, Map<string, string>>() // name -> year -> first "MM-DD" wished
  for (const m of rows) {
    const text = m.t || decode(m.b)
    const ids = (m.ids ?? '').split(',').filter(Boolean)
    if (!BDAY.test(text)) continue
    const named = NAMED.exec(text)?.[1].toLowerCase()
    const who = ids.length === 1 ? ids : ids.filter(h => first(names.get(handle(h)) ?? '') === named)
    if (who.length !== 1) continue
    const name = names.get(handle(who[0])) ?? who[0]
    const years = seen.get(name) ?? new Map()
    if (!years.has(m.d.slice(0, 4))) years.set(m.d.slice(0, 4), m.d.slice(5))
    seen.set(name, years)
  }
  return [...seen].map(([name, years]) => {
    const counts = new Map<string, number>()
    for (const md of years.values()) counts.set(md, (counts.get(md) ?? 0) + 1)
    const [md, n] = [...counts].sort((a, b) => b[1] - a[1])[0]
    return { name, month: +md.slice(0, 2), day: +md.slice(3), maybe: n < 2 }
  })
}

async function load($: Engine, fresh = false): Promise<Bday[]> {
  const today = new Date().toDateString()
  const cache = (await $.store.get('cache')) as { day: string; list: Bday[] } | undefined
  const manual = ((await $.store.get('manual')) as Bday[] | undefined) ?? []
  let list = cache?.list ?? []
  if (fresh || cache?.day !== today) {
    const people = await contacts($)
    const fromTexts = (await $.store.get('imessage')) ? ((await texts($, people)) ?? []) : []
    list = [...people.flatMap(([name, b]) => (b ? [{ name, month: b[0], day: b[1] }] : [])), ...fromTexts]
    await $.store.set('cache', { day: today, list })
  }
  const byName = new Map([...list, ...manual].map(b => [b.name.toLowerCase(), b])) // manual wins
  return [...byName.values()]
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
  const d = until(b), maybe = b.maybe ? ' (maybe)' : ''
  if (d === 0) return `🎂 It's ${b.name}'s birthday today${maybe}`
  if (d === 1) return `🎂 ${b.name}'s birthday is tomorrow${maybe}`
  if (d > 0) return `🎂 ${b.name}'s birthday is in ${d} days${maybe}`
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

async function askFda($: Engine, why: string) {
  const open = 'Open Full Disk Access settings'
  const a = await $.ui
    .ask(`${why} Turn on Full Disk Access for Claude, then quit and reopen Claude.`, { header: 'GoodFriend', options: [open, 'Later'] })
    .catch(() => '')
  if (a === open) await $.process.run(['open', FDA])
}

async function enableTexts($: Engine) {
  await $.store.set('imessage', true)
  const found = await texts($, await contacts($))
  await load($, true)
  if (found) return `🎂 Learned ${found.length} birthdays from your texts`
  await askFda($, 'macOS is blocking Messages.')
  return 'iMessage sync is on, waiting for Full Disk Access'
}

async function offer($: Engine) {
  const yes = 'Yes, learn from my texts (requires Full Disk Access)'
  const ask = 'GoodFriend can learn birthdays from "happy birthday" texts you\'ve sent. This requires giving Claude Full Disk Access in macOS settings. Turn on iMessage sync?'
  const a = await $.ui.ask(ask, { header: 'GoodFriend', options: [yes, 'No thanks'] }).catch(() => '')
  $.ui.toast(a === yes ? await enableTexts($) : 'No problem. Turn it on later with /goodfriend imessage on')
}

// /seed: walk the people you text most and fill in the birthdays GoodFriend doesn't know yet
async function seed($: Engine): Promise<string> {
  const go = "Let's do it"
  const intro = "Let's fill in birthdays for the people you talk to most. I'll go one by one; skip anyone you're not sure about."
  if ((await $.ui.ask(intro, { header: 'GoodFriend', options: [go, 'Not now'] }).catch(() => '')) !== go) return 'Maybe later 🎂'
  const people = await contacts($)
  const rows = await messages<{ id: string; n: number }>($, CLOSEST)
  if (!rows) {
    await askFda($, 'To know who you text most, GoodFriend needs to read Messages.')
    return 'Run /seed again once Full Disk Access is on, or add people with /goodfriend add Full Name MM/DD'
  }
  const names = byHandle(people)
  const known = new Set((await load($)).filter(b => !b.maybe).map(b => b.name.toLowerCase()))
  const todo = [...new Set(rows.map(r => names.get(handle(r.id))).filter((n): n is string => !!n))]
    .filter(n => !known.has(n.toLowerCase()))
    .slice(0, 10)
  if (!todo.length) return "🎂 You already know everyone's birthday. Good friend."

  let saved = 0
  for (const [i, name] of todo.entries()) {
    const a = await $.ui
      .ask(`When's ${name}'s birthday? Type it under Other, like 10/7 or Oct 7.`, { header: `🎂 ${i + 1} of ${todo.length}`, options: ['Skip', "That's enough for now"] })
      .catch(() => "That's enough for now")
    if (a === "That's enough for now") break
    const date = parseDate(a)
    if (date) await save($, name, date[0], date[1]), saved++
    else if (a !== 'Skip') $.ui.toast(`Couldn't read "${a}", skipped ${name}`)
  }
  return saved ? `🎂 Saved ${saved} birthday${saved === 1 ? '' : 's'}. Your friends are lucky to have you.` : 'Nothing saved. /seed any time.'
}

export const register: Register = on => {
  let current: string | null = null
  let test = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'goodfriend', description: 'Birthdays: list | add Name MM/DD | remove Name | imessage on|off | test' })
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
    if (!(await $.store.get('asked'))) await $.store.set('asked', true), void offer($)
    void load($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__goodfriend__set_birthday' }, async ($, e) => {
    const { name, month, day } = e.input as { name: string; month: number; day: number }
    const b = await save($, name, month, day)
    return { text: `Saved ${b.name}: ${b.month}/${b.day}` }
  })

  on('tool.call', { tool: 'mcp__goodfriend__list_birthdays' }, async $ => ({
    text: (await load($)).map(b => `${b.name}: ${b.month}/${b.day}${b.maybe ? ' (maybe)' : ''}`).join('\n') || 'None yet',
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
    if (cmd === 'imessage' && arg === 'on') return { text: await enableTexts($) }
    if (cmd === 'imessage') return await $.store.set('imessage', false), await load($, true), { text: 'iMessage sync is off' }

    const list = (await load($, true)).sort((a, b) => until(a) - until(b))
    const rows = list.map(b => `${until(b) === 0 ? '🎂' : '  '} ${b.name}: ${b.month}/${b.day}${b.maybe ? ' (maybe)' : ''}`)
    const sync = (await $.store.get('imessage')) ? 'on' : 'off (/goodfriend imessage on)'
    return { text: `${rows.join('\n') || 'No birthdays yet. Try /seed'}\n\niMessage sync: ${sync}` }
  })
}
