# Idea Box relay: no-login submissions

This tiny script lets fans drop ideas straight on the website, no GitHub account needed.
It runs on Cloudflare Workers (free, no credit card) and files each idea as a GitHub
issue labeled `idea`, so ideas show up on the site exactly like before.

Setup takes about 10 minutes, one time.

## 1. Create the GitHub access key (fine-grained token)

1. On github.com go to **Settings (your account) > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**.
2. Name: `idea-box-relay`. Expiration: pick 1 year (put a reminder to renew).
3. Repository access: **Only select repositories** > choose `mc-kresha-hub`.
4. Permissions > Repository permissions > **Issues: Read and write** AND
   **Contents: Read and write** (the second one is what lets people attach pictures and voice messages;
   uploads go to the `uploads` branch, so the website is never rebuilt by an upload).
5. Generate, and copy the token (starts with `github_pat_`). Keep it somewhere safe for step 3; treat it like a password.

## 2. Create the Worker

1. Sign up free at https://dash.cloudflare.com (email + password, no card).
2. In the dashboard: **Workers & Pages > Create > Create Worker**.
3. Give it a name like `kresha-idea-box`, click **Deploy** (it deploys a hello-world first).
4. Click **Edit code**, delete everything, paste the full contents of `worker.js` from this folder, then **Deploy**.

## 3. Add the token as a secret

1. Back on the Worker's page: **Settings > Variables and Secrets > Add**.
2. Type: **Secret**. Name: `GITHUB_TOKEN` (exactly that). Value: paste the token from step 1.
3. Save and deploy.

## 4. Connect the website

1. Copy the Worker URL shown on its overview page, like `https://kresha-idea-box.YOUR-SUBDOMAIN.workers.dev`.
2. In the repo, edit `app.js` and paste it into `CONFIG.submitUrl`:
   ```js
   submitUrl: "https://kresha-idea-box.YOUR-SUBDOMAIN.workers.dev"
   ```
3. Commit. A minute later the form appears in the Idea Box on the live site.

## How spam is handled

- A hidden honeypot field silently swallows most bots.
- Ideas must be 10 to 1000 characters.
- Every idea is just a GitHub issue: close it and it disappears from the site.
- If spam ever gets bad, ask Claude to add moderation mode (ideas wait in an
  inbox until you approve them) or Cloudflare Turnstile (a free, invisible
  human check).

## Safety notes

- The token can ONLY create/edit issues on this one repo, nothing else.
- It lives as a secret inside Cloudflare, never in the website code or the repo.
- If it ever leaks, revoke it on GitHub (Developer settings > tokens) and make a new one.
