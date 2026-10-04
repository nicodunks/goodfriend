# GoodFriend

Be a GoodFriend and remember your friends' birthdays.

GoodFriend is a Claude Code mod. Every so often, the spinner that normally says "Thinking" tells you whose birthday it is instead:

```
🎂 It's Maya Chen's birthday today
🎂 Leo Park's birthday is in 3 days
🎂 You missed Sam Rivera's birthday 2 days ago
```

On the day, and for a week after if you missed it, a small card above the prompt offers to text them:

```
🎂 It's Maya Chen's birthday today   [ Text Maya ]   ✕
```

**Text Maya** opens Messages with "Happy birthday! 🎂" already typed to her. You press send. Text or dismiss, and GoodFriend stops reminding you.

It doesn't nag. On someone's birthday you'll see it a few times early on, then rarely. Otherwise it's an occasional heads-up for the week ahead, or a nudge if you just missed one.

## Install

```
/plugin marketplace add nicodunks/goodfriend
/plugin install goodfriend@goodfriend
```

macOS only. Needs Claude Code 2.1.286 or newer.

## Where birthdays come from

- **Contacts.** Anyone with a birthday set in the Contacts app. macOS asks once for permission.
- **You.** Run `/seed` and GoodFriend works out who matters most to you (family first, then the friends you talk to most, judged from your conversations and group chats) and asks for the birthdays it doesn't know. macOS asks once to let it look at Messages; that's it. Or add one directly: `/goodfriend add Maya Chen 10/7`.
- **Just tell Claude.** "Leo's birthday is actually March 3rd" works. Claude fixes it for you.

GoodFriend only sees who you talk to and the names of your group chats, never what you said. To rank people, it sends that list of names to Claude through your own Claude Code session. Birthdays are saved on your Mac.

## Commands

| | |
|---|---|
| `/seed` | fill in birthdays for the people you text most |
| `/goodfriend` | list everyone, soonest first |
| `/goodfriend add Full Name MM/DD` | add or fix a birthday |
| `/goodfriend remove Full Name` | remove one you added |
| `/goodfriend test` | show the next birthday on your next turn |

## License

MIT
