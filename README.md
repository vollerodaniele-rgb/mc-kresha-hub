# MC KRESHA | Project HQ

A cinematic project hub for MC Kresha: roadmap, current work, and a public Idea Box.
Pure static site, hosted free on GitHub Pages. No backend, no build step.

## How it works

- **Roadmap and "Now Playing"** come from [`data/roadmap.json`](data/roadmap.json). Edit that one file (right on github.com if you like) and the site updates.
- **Idea Box** runs on GitHub Issues. Visitors click "Drop an idea", fill a short form, and it becomes an issue labeled `idea`. The site fetches all `idea` issues from the GitHub API and shows them as cards, with 👍 reactions counted as votes.
- Anyone with a free GitHub account can submit. You moderate by closing issues you do not want shown (only open issues are displayed).

## Publish on GitHub Pages (one time, ~3 minutes)

1. Create a new repository on GitHub (for example `mc-kresha-hub`) and push this folder to it.
2. Open `app.js` and fill in the two values at the top:
   ```js
   const CONFIG = {
     owner: "YOUR_GITHUB_USERNAME",
     repo: "mc-kresha-hub",
     ideaLabel: "idea"
   };
   ```
   Commit the change.
3. In the repo on github.com: **Settings > Pages > Source: Deploy from a branch**, pick `main` and `/ (root)`, save.
4. In the repo: **Issues > Labels > New label**, create a label named `idea` (any color).
5. Your site goes live at `https://YOUR_USERNAME.github.io/mc-kresha-hub/`.

## Updating the roadmap

Edit `data/roadmap.json`. Each phase looks like:

```json
{
  "title": "Act II: The Studio",
  "status": "active",
  "when": "Autumn 2026",
  "description": "One line about this phase.",
  "items": ["Task one", "Task two"]
}
```

`status` is one of `done`, `active`, `planned`. The `now` array at the bottom fills the "Now Playing" section. The site also shows an "Edit roadmap" button (visible once CONFIG is set) that jumps straight to the GitHub editor for this file.

## Moderating ideas

- Close an issue to remove it from the site.
- Pin or comment on the ones you love.
- The `data/ideas.json` file is only a local sample used before CONFIG is filled in; once the repo is configured, real GitHub issues are shown instead.

## Local preview

Any static server works, for example:

```bash
npx serve .
```
