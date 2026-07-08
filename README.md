# TG Work Parser

A Node.js **lead-generation agent** for Telegram. It scans a configurable set of
Telegram groups and channels, uses an LLM to classify every new message, and
forwards only genuine client requests (people looking to *hire* for automation /
AI / bot / parsing work) to a Telegram chat via the Bot API. It also surfaces
relevant Claude/AI product news and actionable tips.

The heart of the project is the **LLM classification layer** — a carefully
engineered prompt that turns a noisy, mostly-irrelevant group feed into a clean
stream of qualified leads.

---

## Architecture

```
              ┌────────────────────┐
  Telegram    │  user-client CLI   │   reads N latest messages per group
  groups  ───▶│  (external, pluggable) │──┐
              └────────────────────┘  │
                                      ▼
                            ┌───────────────────┐
                            │  parseMessages()  │  structured {sender, id, text, ...}
                            └───────────────────┘
                                      │  new messages only (per-group cursor)
                                      ▼
                            ┌───────────────────┐
                            │  classifyMessages │  LLM, batched 10 at a time
                            └───────────────────┘
                                      │  category per message
                                      ▼
        client_request ─┐  claude_update ─┐  self_improvement ─┐  ai_news ─┐  ignore
                        ▼                 ▼                     ▼           ▼
              Bot API notification to the target chat (deduplicated)
```

Reading is delegated to an **external, pluggable** Telegram user-client CLI
(`TG_USER_PATH`), so the parser itself holds no session credentials. Sending is
done through a standard Bot API token. Classification runs through an optional
multi-provider helper (`AI_HELPER_PATH`, e.g. Groq → OpenAI → OpenRouter) and
falls back to a direct Gemini call.

---

## The classification engine

Each batch of up to 10 messages is sent to the LLM with a strict prompt that
sorts every message into exactly one category:

| Category | Meaning | Action |
|---|---|---|
| `client_request` | Someone explicitly wants to **hire** for bots / automation / n8n / parsing / scripts / AI / CRM integration | Forward as a hot lead |
| `claude_update` | Concrete Claude / Anthropic product news | Notify |
| `self_improvement` | A concrete, actionable Claude Code / MCP / n8n tip | Notify (never auto-applied) |
| `ai_news` | Major model or platform releases | Notify |
| `ignore` | Everything else — questions, chatter, ads, self-promotion | Drop |

### Why the prompt is the product

Freelance and business chats are dominated by two kinds of noise that naïve
keyword matching gets wrong:

1. **Self-promotion that looks like demand.** A competitor posting "I build bots,
   DM me, portfolio attached" contains every positive keyword yet is the exact
   opposite of a lead. The prompt hard-codes this distinction: *anyone offering
   their services is always `ignore`.*
2. **On-topic questions that aren't orders.** "How do I set up n8n for myself?" is
   a peer question, not a buyer. The prompt separates *asking for help* from
   *hiring someone to do the work*.

The prompt also carries an explicit, exhaustive **exclusion list** (design, SMM,
video editing, marketplaces, accounting, crypto/trading, logistics, recruiting,
etc.) and a default-to-`ignore` rule. In entrepreneur chats — where ~95% of
"I need a specialist" posts are unrelated to IT — it instructs the model to be
especially strict and require an explicit IT keyword before flagging a lead.
This is what keeps precision high enough that the output is a lead list a human
can act on directly, not a firehose.

---

## Reliability details

- **Per-group cursor** (`state.lastMessageIds`) — only messages newer than the
  last one seen are classified, so nothing is re-processed.
- **Lead dedup** (`state.sentLeads`) — each lead is keyed `chatId:msgId` and never
  sent twice; the list is trimmed to stay bounded.
- **Rate limiting** — deliberate delays between LLM batches, between sends, and
  between groups to avoid Bot API and account throttling.
- **Health endpoint** — `GET /health` on `127.0.0.1:<HEALTH_PORT>` returns scan
  stats and uptime; `GET /scan` triggers an on-demand scan.

---

## Setup

```bash
npm install                       # no runtime deps; uses Node built-ins
cp config.example.json config.json   # edit your group list
cp .env.example .env                 # add BOT_TOKEN, chat ids, LLM keys
node work_parser.js
```

Requires Node.js ≥ 18. You must supply your own Telegram user-client CLI via
`TG_USER_PATH` for the reading side (any tool that prints messages in the
expected `[date] Sender (id:X) @user [msg#N]:` format works).

### Configuration

- **Secrets** (`BOT_TOKEN`, `TARGET_CHAT_ID`, `ADMIN_CHAT_ID`, LLM keys, tool
  paths) live in `.env` — see [`.env.example`](.env.example).
- **Group list & scan cadence** live in `config.json` — see
  [`config.example.json`](config.example.json).

Neither file with real values is committed (both are in `.gitignore`).

---

## Security note

An earlier iteration experimented with auto-applying "self-improvement" tips to
the host via an agent CLI. That path has been **removed** — actionable tips are
only ever surfaced as notifications for a human to review. Never let an untrusted
group message drive privileged actions on your machine.
