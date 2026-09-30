# The relay (kresha-idea-box)

The studio's one server: a Cloudflare Worker on the free plan. It began
as the no-login idea box for this site and now does everything the
static sites cannot: idea boxes and client requests (as GitHub issues),
bookings and call links, deliveries and file transfers in R2, mail,
Telegram, partner boards, offer codes, contacts, the morning checks, the
usage meter, the calendar feed, and the private doors the studio
platform (noir-platform) uses. `worker.js` explains each part where it
is written.

## Deploying

From this folder, signed in to Cloudflare with wrangler:

    npx wrangler deploy

Never paste the code into the dashboard editor: the bindings below live
in `wrangler.toml` and a dashboard edit would drop them.

## What it is bound to (wrangler.toml)

- `DELIVERIES`: the R2 bucket `noir-deliveries` (deliveries, transfers
  and the small records: bookings, contacts, partners, codes)
- `READ_RATE`, `WRITE_RATE`: per address request budgets
- one schedule, every ten minutes; the daily jobs run inside it at fixed
  hours (see `scheduled()`)

## Secrets (Settings, Variables and Secrets; never in code)

- `GITHUB_TOKEN`: fine-grained, Issues and Contents read and write on the
  repos in `SITES`, and Contents on `studio-private` for the platform
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO`
- `CF_ANALYTICS_TOKEN`: read only, for the usage meter
- `PLATFORM_TICKET_SECRET`: shared with noir-platform

A missing Telegram or mail secret switches that part off quietly; the
morning check reports anything that stops working, including a GitHub
token close to expiry.

## Spam and safety

- Idea forms have a hidden honeypot field and a length limit, and every
  address has a request budget per minute.
- An idea is just an issue: close it and it leaves the site.
- If a key leaks, regenerate it where it was made and replace the secret.
