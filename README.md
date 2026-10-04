# GoodFriend

Be a GoodFriend and remember your friends' birthdays.

GoodFriend is a Claude Code mod. Every so often, the spinner that normally says "Thinking" tells you whose birthday it is instead:

```
🎂 It's Maya Chen's birthday today
🎂 Leo Park's birthday is in 3 days
🎂 You missed Sam Rivera's birthday 2 days ago
```

It doesn't nag. On someone's birthday you'll see it a few times early on, then rarely. Otherwise it's an occasional heads-up for the week ahead, or a nudge if you just missed one.

## Install

```
/plugin marketplace add nicodunks/goodfriend
/plugin install goodfriend@goodfriend
```

macOS only. Tested on Claude Code 2.1.286.

## Where birthdays come from

- **Contacts.** Anyone with a birthday set in the Contacts app. macOS asks once for permission.
- **You.** Run `/seed` and GoodFriend walks through the people you've been texting and asks for the birthdays it doesn't know. macOS asks once to let it look at Messages; that's it. Or add one directly: `/goodfriend add Maya Chen 10/7`.
- **Just tell Claude.** "Leo's birthday is actually March 3rd" works. Claude fixes it for you.
- **Your texts (optional).** GoodFriend can look for "happy birthday" and "hbd" texts you've sent and work out the date. Someone you've wished two years running is a sure thing; one text gets a "(maybe)".

Learning from your texts needs Full Disk Access for Claude, under System Settings → Privacy & Security → Full Disk Access. That's a big permission and covers more than Messages, so it's off by default. Turn it on with `/goodfriend imessage on`.

Everything stays on your Mac. GoodFriend keeps names and dates, never message text.

## Commands

| | |
|---|---|
| `/seed` | fill in birthdays for the people you text most (no special access needed) |
| `/goodfriend` | list everyone, soonest first |
| `/goodfriend add Full Name MM/DD` | add or fix a birthday |
| `/goodfriend remove Full Name` | remove one you added |
| `/goodfriend imessage on` / `off` | learn birthdays from your texts |
| `/goodfriend test` | show the next birthday on your next turn |

## License

MIT
