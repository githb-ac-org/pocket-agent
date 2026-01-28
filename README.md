# Pocket Agent

**Your AI that actually knows you.**

A desktop assistant that runs 24/7 in your menu bar. It remembers your conversations, learns about you over time, and you can talk to it from your desktop or Telegram.

---

## Why this exists

Every time you open ChatGPT, you start from zero. Explain your job. Explain your project. Explain what you like. Again. And again.

That gets old fast.

Pocket Agent keeps everything. Every conversation. Every fact it learns about you. So when you come back tomorrow—or three months from now—it actually knows what you're talking about.

---

## What it actually does

### Remembers everything
Stores every message locally. Extracts facts about you (your projects, preferences, people you mention). When you bring something up later, it has context.

### Runs in the background
Lives in your menu bar. Always there when you need it. Set up scheduled tasks and it'll ping you—daily standup reminders, weekly recaps, whatever you want.

### Multiple conversation tabs
Create up to 5 separate sessions. One for work stuff. One for personal things. One for a specific project. Each session has its own isolated memory—they don't bleed into each other.

### Works on Telegram too
Set up a Telegram bot and talk to the same assistant from your phone. Same memory, same context. You can even add the bot to group chats and link each group to a different session—so your work group stays separate from your personal one.

### Browser automation
Two modes depending on what you need:

**Basic mode (default):** Runs in a hidden window. Good for:
- Taking screenshots of websites
- Clicking buttons and filling forms
- Extracting text, links, or table data
- Running JavaScript on pages

**Chrome mode:** Connects to your actual Chrome browser (you launch it with a debug flag). This one can:
- Access your logged-in sessions (Gmail, GitHub, whatever)
- Work with multiple tabs
- Do authenticated workflows without re-logging in

Not magic—you're not going to automate complex multi-step workflows out of the box. But for grabbing data from pages or doing simple interactions, it works.

### Scheduling
Tell it things like:
- "remind me every morning at 9am to check my calendar"
- "every friday at 5pm, ask me what I accomplished this week"
- "in 2 hours, ping me about the meeting"

Uses natural language or cron expressions if you're into that.

### Calendar and tasks
Basic built-in calendar and todo list. Create events, set reminders, track tasks. Nothing fancy, but it's there and it remembers everything.

### Customizable personality
Edit the identity file to change how it talks. Make it formal, casual, sarcastic—whatever works for you.

---

## Getting started

### Download

| Mac | Link |
|-----|------|
| Apple Silicon (M1/M2/M3/M4) | [Download](https://github.com/KenKaiii/pocket-agent/releases/latest) |
| Intel | [Download](https://github.com/KenKaiii/pocket-agent/releases/latest) |

### Setup

1. Drag to Applications, launch it
2. It shows up in your menu bar
3. Click it, paste your Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))
4. Start chatting

That's it.

---

## Telegram setup (optional)

If you want to talk to it from your phone:

1. Create a bot with [@BotFather](https://t.me/botfather) on Telegram
2. Copy the token into Pocket Agent settings
3. Message your bot

**Group chats:** You can add the bot to groups. Use `/link SessionName` to connect that group to a specific session. Each group can have its own isolated conversation.

**Note:** For the bot to see all messages in a group (not just commands), either make it an admin or disable privacy mode in BotFather.

**Commands:** `/status` `/facts` `/clear` `/link <session>` `/unlink` `/mychatid`

---

## Browser automation details

**Default mode** runs in a hidden Electron window. No setup needed. Works for:
- Screenshots
- Clicking elements (by CSS selector)
- Typing into inputs
- Extracting page content (text, HTML, links, tables)
- Running JavaScript
- Downloading files

**Chrome mode** connects to your actual browser. You need to start Chrome with remote debugging:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

Then it can access your logged-in sessions and manage multiple tabs.

---

## Privacy

- Everything stored locally in SQLite on your machine
- Conversations go to Anthropic's API (that's how it works)
- API keys stored in your system keychain
- No analytics, no telemetry

---

## Extensibility

There's a skill system with 70+ integrations (Notion, GitHub, Slack, Apple Notes, etc.) and support for MCP servers if you want to extend it. Plus full terminal access.

Most people won't need this stuff, but it's there if you do.

---

## For developers

```bash
git clone https://github.com/KenKaiii/pocket-agent.git
cd pocket-agent
npm install
npm run dev
```

Stack: Electron + Claude Agent SDK + SQLite + TypeScript

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) — tutorials and demos
- [Skool community](https://skool.com/kenkai) — come hang out

---

## License

MIT

---

**An AI that actually remembers you exists now. That's pretty cool.**

[Download →](https://github.com/KenKaiii/pocket-agent/releases/latest)
