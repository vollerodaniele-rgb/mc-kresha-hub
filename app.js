/* MC KRESHA Idea Box
   ------------------------------------------------------------
   Ideas are GitHub issues labeled "idea". Visitors submit through
   the form, which posts to the relay worker; the relay files the
   issue. No account needed on the visitor's side.
   ------------------------------------------------------------ */
const CONFIG = {
  owner: "vollerodaniele-rgb",
  repo: "mc-kresha-hub",
  ideaLabel: "idea",
  submitUrl: "https://kresha-idea-box.vollerodaniele.workers.dev",
  site: "kresha"
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  loadIdeas();
  if (CONFIG.submitUrl) setupForm();
});

/* ============ THE WALL ============ */

async function loadIdeas() {
  const grid = $("idea-grid");
  const status = $("idea-status");

  try {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/issues` +
      `?labels=${encodeURIComponent(CONFIG.ideaLabel)}&state=open&sort=created&direction=desc&per_page=50`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store"
    });
    if (!res.ok) throw new Error("GitHub API " + res.status);
    const issues = await res.json();

    const ideas = issues
      .filter((i) => !i.pull_request)
      .map((i) => {
        let body = i.body || "";
        let author = i.user ? i.user.login : "anonymous";
        // ideas sent through the form carry the fan's name in a trailer
        const m = body.match(/\n*-{3,}\nSubmitted by: (.+?) \(via the idea box\)\s*$/);
        if (m) {
          author = m[1];
          body = body.slice(0, m.index);
        }
        return {
          text: clean(body) || i.title.replace(/^Idea:\s*/, ""),
          author
        };
      });

    if (!ideas.length) {
      status.textContent = "No ideas yet. Be the first!";
      return;
    }

    grid.innerHTML = "";
    for (const idea of ideas) grid.appendChild(card(idea));
  } catch (err) {
    status.textContent = "Could not reach the idea wall right now. Try again in a minute.";
    console.error("ideas load failed:", err);
  }
}

function card({ text, author }) {
  const el = document.createElement("article");
  el.className = "idea-card";
  el.innerHTML = `
    <p class="idea-body">${esc(text.slice(0, 300))}</p>
    <div class="idea-meta"><span>by ${esc(author)}</span></div>
  `;
  return el;
}

/* ============ FORM ============ */

function setupForm() {
  const form = $("idea-form");
  form.hidden = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("form-msg");
    const btn = $("idea-submit");
    const idea = $("idea-text").value.trim();
    const name = $("idea-name").value.trim();

    if (idea.length < 10) {
      msg.textContent = "Give it a few more words (at least 10 characters).";
      return;
    }

    btn.disabled = true;
    msg.textContent = "Sending...";

    try {
      const res = await fetch(CONFIG.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: CONFIG.site, idea, name, website: $("idea-website").value })
      });
      if (!res.ok) throw new Error("relay " + res.status);

      msg.textContent = "Got it! Your idea is on the wall.";
      form.reset();

      const status = $("idea-status");
      if (status) status.remove();
      $("idea-grid").prepend(card({ text: idea, author: name || "anonymous" }));
    } catch (err) {
      console.error("idea submit failed:", err);
      msg.textContent = "Could not send right now. Try again in a minute.";
    } finally {
      btn.disabled = false;
    }
  });
}

/* ============ HELPERS ============ */

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function clean(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
