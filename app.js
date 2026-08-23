/* MC KRESHA Project HQ
   ------------------------------------------------------------
   SETUP: after you create the GitHub repo, fill in these two
   values. Everything else works automatically.
   ------------------------------------------------------------ */
const CONFIG = {
  owner: "vollerodaniele-rgb",
  repo: "mc-kresha-hub",
  ideaLabel: "idea"     // ideas are GitHub issues with this label
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  $("year").textContent = new Date().getFullYear();
  loadRoadmap();
  loadIdeas();
  wireLinks();
});

/* ============ ROADMAP (from data/roadmap.json) ============ */

async function loadRoadmap() {
  try {
    const res = await fetch("data/roadmap.json", { cache: "no-store" });
    const data = await res.json();

    $("project-tagline").textContent = data.tagline || "";

    const timeline = $("timeline");
    timeline.innerHTML = "";
    for (const phase of data.phases || []) {
      const li = document.createElement("li");
      li.className = "status-" + (phase.status || "planned");

      const badgeClass =
        phase.status === "done" ? "done" :
        phase.status === "active" ? "active" : "";
      const badgeText =
        phase.status === "done" ? "Done" :
        phase.status === "active" ? "In progress" : "Planned";

      li.innerHTML = `
        <div class="phase-top">
          <span class="phase-title">${esc(phase.title)}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
          ${phase.when ? `<span class="phase-when">${esc(phase.when)}</span>` : ""}
        </div>
        ${phase.description ? `<p class="phase-desc">${esc(phase.description)}</p>` : ""}
        ${(phase.items && phase.items.length)
          ? `<ul class="phase-items">${phase.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
          : ""}
      `;
      timeline.appendChild(li);
    }

    const nowList = $("now-list");
    nowList.innerHTML = "";
    for (const item of data.now || []) {
      const li = document.createElement("li");
      li.textContent = item;
      nowList.appendChild(li);
    }
  } catch (err) {
    $("project-tagline").textContent = "Could not load roadmap data.";
    console.error("roadmap load failed:", err);
  }
}

/* ============ IDEA BOX (GitHub issues) ============ */

async function loadIdeas() {
  const grid = $("idea-grid");
  const status = $("idea-status");

  if (!CONFIG.owner || !CONFIG.repo) {
    // repo not configured yet: show the local sample ideas so the
    // page still looks alive during development
    try {
      const res = await fetch("data/ideas.json", { cache: "no-store" });
      const ideas = await res.json();
      renderIdeas(grid, ideas);
    } catch {
      status.textContent = "No ideas yet. Be the first!";
    }
    return;
  }

  try {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/issues` +
      `?labels=${encodeURIComponent(CONFIG.ideaLabel)}&state=open&sort=created&direction=desc&per_page=30`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error("GitHub API " + res.status);
    const issues = await res.json();

    const ideas = issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        title: i.title,
        body: i.body || "",
        author: i.user ? i.user.login : "anonymous",
        votes: i.reactions ? i.reactions["+1"] : 0,
        url: i.html_url
      }));

    if (!ideas.length) {
      status.textContent = "No ideas yet. Be the first!";
      return;
    }
    renderIdeas(grid, ideas);
  } catch (err) {
    status.textContent = "Could not reach GitHub right now. Try again in a minute.";
    console.error("ideas load failed:", err);
  }
}

function renderIdeas(grid, ideas) {
  grid.innerHTML = "";
  for (const idea of ideas) {
    const card = document.createElement("article");
    card.className = "idea-card";
    card.innerHTML = `
      <h3>${idea.url ? `<a href="${esc(idea.url)}" target="_blank" rel="noopener">${esc(idea.title)}</a>` : esc(idea.title)}</h3>
      <p class="idea-body">${esc(stripMd(idea.body))}</p>
      <div class="idea-meta">
        <span>by ${esc(idea.author)}</span>
        <span class="idea-votes">▲ ${idea.votes || 0}</span>
      </div>
    `;
    grid.appendChild(card);
  }
}

/* ============ LINKS ============ */

function wireLinks() {
  const addIdea = $("add-idea");
  const editRoadmap = $("edit-roadmap");

  if (CONFIG.owner && CONFIG.repo) {
    const base = `https://github.com/${CONFIG.owner}/${CONFIG.repo}`;
    addIdea.href = `${base}/issues/new?labels=${encodeURIComponent(CONFIG.ideaLabel)}` +
      `&template=idea.yml&title=${encodeURIComponent("Idea: ")}`;
    editRoadmap.href = `${base}/edit/main/data/roadmap.json`;
    editRoadmap.hidden = false;
  } else {
    addIdea.href = "#";
    addIdea.addEventListener("click", (e) => {
      e.preventDefault();
      alert("Almost there! Fill in CONFIG.owner and CONFIG.repo at the top of app.js once the GitHub repo exists.");
    });
  }
}

/* ============ HELPERS ============ */

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

// keep idea previews readable: drop common markdown noise
function stripMd(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}
