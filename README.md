# Chernivtsi Electricity Bot

```text
       .                     *                 .
                _                         .
              .'/       .                         *
              \_\

                     /\                 /\
         /\         /  \      /\       /  \
    ____/  \_______/____\____/  \_____/____\____
       | [] |       | [] |   | [] |    | [] |
   ____|_[]_|_______|____|___|_[]_|____|____|____

                  CHERNIVTSI / UA
```

Telegram bot for checking scheduled power outages in Chernivtsi, Ukraine, and getting reminders before a planned outage or restoration.

[Commands](#commands) · [How it works](#how-it-works) · [Local development](#local-development) · [Deployment](#deployment)

## Commands

| Command                        | What it does                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `/start` or `/help`            | Opens the guide and the bot menu.                                                         |
| `/status`                      | Shows the current status according to the schedule, the next change, and today's outages. |
| `/alerts`                      | Configures alerts for schedule changes, outages, and restoration.                         |
| `/subscribe` or `/unsubscribe` | Turns alerts on or off.                                                                   |
| `/language`                    | Switches between English and Ukrainian.                                                   |

Use `/status` to choose your outage group from 1 to 12. In `/alerts`, you can set reminders for 5, 15, or 30 minutes before a scheduled change. All times use the 24-hour clock in Kyiv local time.

## How it works

```text
  [Telegram] ------ webhook -----+
                                 +--> [ElectricityMonitor] --> [Schedule]
  [Cloudflare] ---- every min ---+
```

`ElectricityMonitor` is the Durable Object that stores preferences and coordinates schedule lookups. Alerts and commands reuse the latest check for each group for up to three minutes or until the date changes in Kyiv. The bot checks Energy UA first, retries through Browser Run if the request fails, and then falls back to its backup source.

## Local development

Use Node.js 24 and npm to install dependencies and start the local Worker.

```sh
npm ci
npm run dev
```

To use a Telegram bot in development, add its BotFather token to a `.dev.vars` file next to `wrangler.jsonc`. [Environment variables and secrets](https://developers.cloudflare.com/workers/local-development/environment-variables/)

```dotenv
TELEGRAM_BOT_TOKEN=your_botfather_token
```

Run the tests once and check repository formatting.

```sh
npm test -- --run
npm run format:check
```

## Deployment

Sign in to your Cloudflare account with Wrangler, then deploy the Worker and store the Telegram token as a secret. [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)

```sh
npm run deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

The PowerShell script registers the Telegram webhook. For your own deployment, set `$webhookUrl` in [`configurar-telegram.ps1`](configurar-telegram.ps1) to your Worker URL with `/telegram` appended.

```powershell
.\configurar-telegram.ps1 -ActivarWebhook
```

Send `/status` to your bot to verify that it receives commands.
