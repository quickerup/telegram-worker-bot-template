# Telegram Bot → Cloudflare Workers, deployed by GitHub Actions

A reusable template: push to `main`, and GitHub Actions deploys a serverless
Telegram bot to Cloudflare Workers and registers the webhook automatically.
No servers, no polling loop, no manual `wrangler deploy`.

Comes with a working echo bot (`/start`, `/help`, and echoes anything else)
so you can confirm the whole pipeline before writing your own logic.

## How it works

```
Telegram user → Telegram servers → Cloudflare Worker (webhook) → your code
                                          ▲
                                          │ deployed by
                                    GitHub Actions (on push to main)
```

- `src/index.js` — Worker entrypoint. Verifies the request came from Telegram
  (via a secret header), then hands the update off to `src/bot.js`.
- `src/bot.js` — **this is where you build your bot.** A `commands` object
  maps `/command` → handler. Anything without a matching command falls
  through to the echo handler.
- `.github/workflows/deploy.yml` — on every push to `main`: installs deps,
  deploys the Worker, pushes secrets into it, and calls Telegram's
  `setWebhook` pointing at your Worker's URL.

## One-time setup

### Fast path: run the setup script

If you have the [GitHub CLI](https://cli.github.com) installed and logged in
(`gh auth login`), skip the manual steps below and run:

```bash
./scripts/setup.sh
```

It'll prompt you for your Telegram bot token, Cloudflare API token, and
Cloudflare Account ID; look up your `workers.dev` subdomain via the
Cloudflare API so it can compute the correct `WORKER_URL` up front; push all
the required GitHub secrets/variables; and trigger + watch the deploy.
One command, no double-deploy needed.

Want to spin up a brand new bot repo from this template in one shot?

```bash
./scripts/setup.sh --new-repo my-new-bot
```

Run `./scripts/setup.sh --help` for all options. If you'd rather do it by
hand (or don't have `gh`), the manual steps are below.

**1. Create the bot**

Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy
the token it gives you.

**2. Create a Cloudflare API token**
Cloudflare dashboard → My Profile → API Tokens → Create Token → use the
"Edit Cloudflare Workers" template. Also grab your **Account ID** (right
sidebar of the Workers & Pages overview page).

**3. Rename the Worker (optional but recommended)**
Edit `name = "my-telegram-bot"` in `wrangler.toml` to something unique —
this becomes part of your `*.workers.dev` URL.

**4. Add GitHub repo secrets**
Repo → Settings → Secrets and variables → Actions → **Secrets** tab:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 2 |
| `TELEGRAM_BOT_TOKEN` | from step 1 |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you make up (e.g. `openssl rand -hex 32`) — this just proves incoming requests really came from Telegram |

**5. First deploy**
Push to `main`. The webhook-registration step will fail the first time
(there's no `WORKER_URL` yet) — that's expected. Check the Action's
"Deploy to Cloudflare Workers" step output, or your Cloudflare dashboard,
for the deployed URL — it'll look like
`https://my-telegram-bot.<your-subdomain>.workers.dev`.

**6. Add the Worker URL as a repo *variable***
Same Settings page, **Variables** tab (not Secrets — it's not sensitive):

| Variable | Value |
|---|---|
| `WORKER_URL` | the URL from step 5 |

**7. Re-run the workflow**
Actions tab → re-run the failed workflow (or just push again). This time
the webhook registers successfully. Message your bot on Telegram — it
should reply.

## Building your own bot

Everything you'll customize day-to-day lives in `src/bot.js`:

```js
const commands = {
  start: async (env, msg) => { ... },
  weather: async (env, msg) => {
    // fetch an API, call sendMessage(env, msg.chat.id, result)
  },
};
```

Handlers get the full Telegram `message` object and the Worker's `env`
(for secrets/bindings). Use `sendMessage(env, chatId, text)` to reply, or
call the Telegram Bot API directly for things like photos, keyboards, etc.
(`https://core.telegram.org/bots/api`).

Need a KV store, D1 database, or other binding? Add it under `wrangler.toml`
as usual — it'll show up on `env` inside your handlers.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your token + a dummy secret
npm run dev
```

`wrangler dev` runs locally but Telegram can't reach `localhost` directly —
tunnel it with something like `cloudflared tunnel` or `ngrok http 8787` and
point `setWebhook` at the tunnel URL for testing.

## Spinning up another bot

This whole thing is meant to be duplicated. To run a second, independent
bot: copy this repo (or use it as a GitHub template repo), give it a new
`wrangler.toml` name, and repeat steps 1–7 with a fresh bot token — it's a
fully separate deployment, so pipelines never collide.
