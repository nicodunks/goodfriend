import type { Engine, Register } from 'claude-code'

// Birthdays from Contacts, /seed (the people you've been texting) and /goodfriend add.

type Bday = { name: string; month: number; day: number }

const CONTACTS = `const C = Application('Contacts')
const n = C.people.name(), b = C.people.birthDate()
JSON.stringify(n.flatMap((x, i) => (b[i] ? [{ name: x, month: b[i].getMonth() + 1, day: b[i].getDate() }] : [])))`

// Every conversation, most recent first: "member count|chat name|name~handle;name~handle;"
const CHATS = `tell application "Messages"
  set out to ""
  repeat with c in (chats)
    try
      set ns to ""
      repeat with p in (participants of c)
        set ns to ns & (name of p) & "~" & (handle of p) & ";"
      end repeat
      set n to name of c
      if n is missing value then set n to ""
      set out to out & (count of participants of c) & "|" & n & "|" & ns & linefeed
    end try
  end repeat
  return out
end tell`

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ')
const DAY = 86_400_000
const ENOUGH = "That's enough for now"

const first = (name: string) => name.split(' ')[0].toLowerCase()
const any = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
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

type Candidate = { name: string; handle: string; recent: number; groups: string[] }
type Chat = { size: number; title: string; members: { name: string; handle: string }[] }

const realName = (n: string) => n && !/^[+\d(]/.test(n) && !n.includes('@')

async function chats($: Engine): Promise<Chat[]> {
  const r = await $.process.run(['osascript', '-e', CHATS], { timeoutMs: 120_000 })
  return r.stdout.split('\n').filter(Boolean).map(row => {
    const [size, title, members = ''] = row.split('|')
    const people = members.split(';').filter(Boolean).map(m => m.split('~'))
    return { size: +size, title, members: people.map(([n, handle]) => ({ name: n.replace(/^Maybe:\s*/, '').trim(), handle })) }
  })
}

// everyone you talk to, with the signals that say how close you are
async function candidates($: Engine): Promise<Candidate[]> {
  const people = new Map<string, Candidate>()
  for (const [i, chat] of (await chats($)).entries()) {
    for (const { name, handle } of chat.members.filter(m => realName(m.name))) {
      const p = people.get(name) ?? { name, handle, recent: Infinity, groups: [] }
      if (chat.size === 1) p.recent = Math.min(p.recent, i + 1)
      else p.groups.push(chat.title || 'unnamed group')
      people.set(name, p)
    }
  }
  return [...people.values()]
}

const named = (p: Candidate) => p.groups.filter(g => g !== 'unnamed group')

// let Sonnet use judgment (family, close friends) over the raw signals; recency if it can't
async function rank($: Engine, list: Candidate[], me: string): Promise<string[]> {
  const top = list.sort((a, b) => a.recent - b.recent || b.groups.length - a.groups.length).slice(0, 80)
  const facts = top.map(p =>
    [p.name, p.recent < Infinity && `texted 1:1 (#${p.recent} most recent)`, p.groups.length && `in ${p.groups.length} group chats with me${named(p).length ? `: ${named(p).slice(0, 4).join(', ')}` : ''}`]
      .filter(Boolean)
      .join(' · '),
  )
  const prompt = `I'm ${me || 'the user'}. Pick the 10 people whose birthdays I'd most regret forgetting, most important first. Family comes first (Mom, Dad, grandparents, siblings, anyone sharing my last name or in family group chats), then the friends I talk to most. Skip businesses and bots.

${facts.join('\n')}

Reply with only a JSON array of names, exactly as written above.`
  const r = await $.model.complete({ model: 'claude-sonnet-5-5', prompt, maxTokens: 400, timeoutMs: 60_000 })
  const names = new Set(top.map(p => p.name))
  try {
    if (r.isAnswered) return (JSON.parse(/\[[\s\S]*\]/.exec(r.text)![0]) as string[]).filter(n => names.has(n)).slice(0, 10)
  } catch {}
  return top.slice(0, 10).map(p => p.name)
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
  const near = await unwished($, (await load($)).filter(b => until(b) <= 7))
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

// You've wished them once you text from the band (or say you already did); reminders stop for 10 days
async function unwished($: Engine, list: Bday[]): Promise<Bday[]> {
  const wished = ((await $.store.get('wished')) as Record<string, number> | undefined) ?? {}
  return list.filter(b => !(Date.now() - (wished[b.name] ?? 0) < 10 * DAY))
}

async function markWished($: Engine, b: Bday) {
  const wished = ((await $.store.get('wished')) as Record<string, number> | undefined) ?? {}
  await $.store.set('wished', { ...wished, [b.name]: Date.now() })
}

// someone whose birthday is today or was in the last 2 days, and who you haven't wished yet
async function due($: Engine): Promise<Bday | undefined> {
  return (await unwished($, await load($))).filter(b => until(b) <= 0 && until(b) >= -2).sort((a, b) => until(b) - until(a))[0]
}

// their number or email: from your conversations, else from Contacts
async function handleFor($: Engine, name: string): Promise<string> {
  const people = (await chats($)).sort((a, b) => a.size - b.size).flatMap(c => c.members)
  const fromChats = people.find(m => m.name === name)?.handle
  if (fromChats) return fromChats
  const js = `const p = Application('Contacts').people.whose({ name: ${JSON.stringify(name)} })()
p.length ? p[0].phones.value()[0] || p[0].emails.value()[0] || '' : ''`
  return (await $.process.run(['osascript', '-l', 'JavaScript', '-e', js])).stdout.trim()
}

// open Messages with the wish already typed; you press send
async function textThem($: Engine, b: Bday) {
  const handle = await handleFor($, b.name)
  if (!handle) return $.ui.toast(`Couldn't find a number for ${b.name}`)
  const wish = until(b) === 0 ? 'Happy birthday! 🎂' : 'Happy belated birthday! 🎂'
  await $.process.run(['open', `sms:${handle}&body=${encodeURIComponent(wish)}`])
  await markWished($, b)
}

// /seed: walk the people who matter most to you and fill in the birthdays GoodFriend doesn't know yet
async function seed($: Engine): Promise<string> {
  const known = new Set((await load($)).map(b => b.name.toLowerCase()))
  const me = (await $.process.run(['osascript', '-l', 'JavaScript', '-e', "Application('Contacts').myCard().name()"])).stdout.trim()
  const todo = await rank($, (await candidates($)).filter(p => !known.has(p.name.toLowerCase()) && p.name !== me), me)
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
    const { name, month, day } = e as unknown as { name: string; month: number; day: number } // a tool's arguments ride on the event itself
    const b = await save($, name, month, day)
    return { result: `Saved ${b.name}: ${b.month}/${b.day}` }
  })

  on('tool.call', { tool: 'mcp__goodfriend__list_birthdays' }, async $ => ({
    result: (await load($)).map(b => `${b.name}: ${b.month}/${b.day}`).join('\n') || 'None yet',
  }))

  on('turn.start', async ($, e, next) => {
    const soonest = test ? (await load($)).sort((a, b) => until(a) - until(b))[0] : undefined
    current = soonest ? line(soonest) : await pick($)
    test = false
    return next(e)
  })

  // the birthday band above the prompt, with a button to text them
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = e.props.hasSurvey ? undefined : await due($)
    if (!b) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>{line(b)} </Text>
        <Button key="text" variant="primary" label={`Text ${b.name.split(' ')[0]}`} onPress={() => textThem($, b)} />
        <Text> </Text>
        <Button key="done" label="Already did" onPress={() => markWished($, b)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) => next(current ? { ...e, props: { ...e.props, word: current } } : e))

  on('command.run', { command: 'seed' }, async $ => ({ text: await seed($) }))

  on('command.run', { command: 'goodfriend' }, async ($, e) => {
    const [cmd = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')

    if (cmd === 'test') return (test = true), { text: 'Next turn shows the soonest birthday.' }
    if (cmd === 'add') {
      // the date is the last one or two words: "10/7", "Oct 7", "7th October"
      const words = arg.split(' ')
      const split = [2, 1].map(k => [words.slice(0, -k).join(' '), parseDate(words.slice(-k).join(' '))] as const).find(([n, d]) => n && d)
      if (!split) return { text: 'Usage: /goodfriend add Full Name MM/DD' }
      const [name, [month, day]] = split as [string, [number, number]]
      const b = await save($, name, month, day)
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
