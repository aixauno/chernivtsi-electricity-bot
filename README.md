# Chernivtsi Electricity Bot

**Power outage schedules and reminders for Chernivtsi, Ukraine, on Telegram.**

```
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

[Telegram commands](#telegram-commands) · [How it works](#how-it-works) · [Local development](#local-development) · [Deployment](#deployment)

## Telegram commands

| Command                        | What it does                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `/start` or `/help`            | Opens the guide and the bot menu.                                                         |
| `/status`                      | Shows the current status according to the schedule, the next change, and today's outages. |
| `/alerts`                      | Configures alerts for schedule changes, outages, and restoration.                         |
| `/subscribe` or `/unsubscribe` | Turns alerts on or off.                                                                   |
| `/language`                    | Switches between English and Ukrainian.                                                   |

- Choose your **outage group** from 1 to 12 in `/status`.
- Set **reminders** in `/alerts` for 5, 15, or 30 minutes before a planned outage or restoration.

> All schedule times use the 24-hour clock in Kyiv local time.

## How it works

Telegram commands arrive through a webhook. A Cloudflare cron trigger checks for alerts every minute. Both use `ElectricityMonitor`, the Durable Object that stores preferences and shares schedule checks across commands and alerts.

The bot reuses each group's latest check for up to three minutes or until the Kyiv date changes. When it needs a fresh schedule, it follows these steps.

1. Request the group's schedule from **Energy UA**.
2. Retry the same page through **Cloudflare Browser Run** if the direct request fails.
3. Use the **backup source** if Browser Run can't retrieve the schedule.

## Local development

You’ll need **Node.js 24** and **npm**.

### Start the Worker

```sh
npm ci
npm run dev
```

To use a Telegram bot in development, add its BotFather token to a `.dev.vars` file next to `wrangler.jsonc`. [Environment variables and secrets](https://developers.cloudflare.com/workers/local-development/environment-variables/)

```
TELEGRAM_BOT_TOKEN=your_botfather_token
```

### Run checks

```sh
npm test -- --run
npm run format:check
```

## Deployment

### Deploy the Worker

Sign in to your Cloudflare account with Wrangler, then deploy the Worker and store the Telegram token as a secret. [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)

```sh
npm run deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

### Register the Telegram webhook

For your own deployment, set `$webhookUrl` in [`configurar-telegram.ps1`](configurar-telegram.ps1) to your Worker URL with `/telegram` appended. Then run the script in PowerShell.

```powershell
.\configurar-telegram.ps1 -ActivarWebhook
```

Send `/status` to your bot to verify that it receives commands.
