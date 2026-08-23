# MC KRESHA | Idea Box

A single-page idea box for the MC Kresha project. Anyone can drop an idea straight
on the page, no account needed. Static site on GitHub Pages, no build step.

Live: https://vollerodaniele-rgb.github.io/mc-kresha-hub/

## How it works

- The form posts to a Cloudflare Worker relay (source in [`cloudflare-worker/`](cloudflare-worker/README.md)),
  which files each idea as a GitHub issue labeled `idea`.
- The wall reads open `idea` issues back from the public GitHub API.
- 👍 reactions on an issue count as votes; the "vote" link on a card opens the issue.
- Moderate by closing an issue: it disappears from the wall.

## Style

House style: pitch black background, plain white text, no colors, no shadows,
Playfair Display headings with Inter body text. Do not add accent colors.

## Editing text

The headline and intro paragraph live directly in [`index.html`](index.html).
Settings (repo, label, relay URL) are in the `CONFIG` block at the top of [`app.js`](app.js).
