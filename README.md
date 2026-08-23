# MC KRESHA | Idea Box

A single-page idea box for the MC Kresha project. Anyone can drop an idea straight
on the page, no account needed. Static site on GitHub Pages, no build step.

Live: https://vollerodaniele-rgb.github.io/mc-kresha-hub/

## How it works

- The form posts to a Cloudflare Worker relay (source in [`cloudflare-worker/`](cloudflare-worker/README.md)),
  which files each idea as a GitHub issue labeled `idea`.
- The wall reads open `idea` issues back from the public GitHub API.
- A picture can be attached to an idea. The browser resizes it to 1600px and re-encodes
  it as JPEG (which also strips location data), the relay stores it on the `uploads`
  branch, and the issue body links to it. Uploads never rebuild the website.
- Moderate from [`admin.html`](admin.html) (no link from the site, open the URL directly):
  it lists every idea with a Remove button, and keeps a "removed" list you can restore from.
  Removing closes the issue, which takes it off the wall; nothing is destroyed.
  Needs a fine-grained token with **Issues: read and write** on this repo, pasted once
  into the page (stored in that browser only).

## Style

House style: pitch black background, plain white text, no colors, no shadows,
Playfair Display headings with Inter body text. Do not add accent colors.

## Editing text

The headline and intro paragraph live directly in [`index.html`](index.html).
Settings (repo, label, relay URL) are in the `CONFIG` block at the top of [`app.js`](app.js).
