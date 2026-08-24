/* MC KRESHA Idea Box Admin
   ------------------------------------------------------------
   Lists the ideas (GitHub issues labeled "idea") and lets you
   remove them with a button. "Removing" closes the issue, which
   takes it off the wall; restoring reopens it. Nothing is ever
   destroyed, so a misclick is always recoverable.

   The access token is a fine-grained GitHub token (Issues: read
   and write, this repo only) kept in this browser's localStorage.
   ------------------------------------------------------------ */
const OWNER = "vollerodaniele-rgb";
const REPO = "mc-kresha-hub";
const LABEL = "idea";
const TOKEN_KEY = "kresha-admin-token";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  wireTokenPanel();
  $("refresh").addEventListener("click", loadAll);
  $("toggle-removed").addEventListener("click", toggleRemoved);
  loadAll();
});

/* ============ TOKEN ============ */

function token() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function wireTokenPanel() {
  const msg = $("token-msg");
  if (token()) msg.textContent = "A key is saved in this browser.";

  $("token-save").addEventListener("click", () => {
    const v = $("token-input").value.trim();
    if (!v) { msg.textContent = "Paste the token first."; return; }
    localStorage.setItem(TOKEN_KEY, v);
    $("token-input").value = "";
    msg.textContent = "Key saved in this browser.";
  });

  $("token-clear").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    msg.textContent = "Key removed from this browser.";
  });
}

/* ============ LOADING ============ */

async function loadAll() {
  $("count").textContent = "Loading...";
  try {
    const [open, closed] = await Promise.all([fetchIdeas("open"), fetchIdeas("closed")]);

    renderList($("live-list"), open, false);
    renderList($("removed-list"), closed, true);

    $("count").textContent =
      `${open.length} idea${open.length === 1 ? "" : "s"} on the wall` +
      (closed.length ? ` · ${closed.length} removed` : "");
  } catch (err) {
    console.error("load failed:", err);
    $("count").textContent = "Could not load ideas.";
  }
}

async function fetchIdeas(state) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/issues` +
    `?labels=${encodeURIComponent(LABEL)}&state=${state}&sort=created&direction=desc&per_page=100`;
  const headers = { Accept: "application/vnd.github+json" };
  if (token()) headers.Authorization = "Bearer " + token();

  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) throw new Error("GitHub API " + res.status);
  const issues = await res.json();

  return issues.filter((i) => !i.pull_request).map((i) => {
    let body = i.body || "";
    let author = i.user ? i.user.login : "anonymous";
    const m = body.match(/\n*-{3,}\nSubmitted by: (.+?) \(via the idea box\)\s*$/);
    if (m) {
      author = m[1];
      body = body.slice(0, m.index);
    }
    let image = "";
    const img = body.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/);
    if (img) {
      image = img[1];
      body = body.replace(img[0], "");
    }
    let audio = "";
    const voice = body.match(/\[voice message\]\((https:\/\/[^\s)]+)\)/);
    if (voice) {
      audio = voice[1];
      body = body.replace(voice[0], "");
    }
    return {
      number: i.number,
      image,
      audio,
      text: clean(body) || (audio ? "Voice message" : i.title.replace(/^Idea:\s*/, "")),
      author,
      date: new Date(i.created_at).toLocaleDateString("en-GB",
        { day: "numeric", month: "short", year: "numeric" }),
      url: i.html_url
    };
  });
}

/* ============ RENDERING ============ */

function renderList(wrap, ideas, isRemoved) {
  wrap.innerHTML = "";

  if (!ideas.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.style.fontSize = "0.9rem";
    p.textContent = isRemoved ? "Nothing removed yet." : "No ideas on the wall yet.";
    wrap.appendChild(p);
    return;
  }

  for (const idea of ideas) {
    const row = document.createElement("div");
    row.className = "idea-row" + (isRemoved ? " removed" : "");

    if (idea.image) {
      const thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.src = idea.image;
      thumb.alt = "";
      thumb.loading = "lazy";
      row.appendChild(thumb);
    }

    const text = document.createElement("div");
    text.className = "text";
    const p = document.createElement("p");
    p.textContent = idea.text;
    text.appendChild(p);

    if (idea.audio) {
      const player = document.createElement("audio");
      player.className = "idea-audio";
      player.controls = true;
      player.preload = "none";
      player.src = idea.audio;
      text.appendChild(player);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>by ${esc(idea.author)}</span><span>${esc(idea.date)}</span>` +
      `<a href="${esc(idea.url)}" target="_blank" rel="noopener">open on GitHub</a>`;
    text.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(isRemoved
      ? restoreButton(idea)
      : removeButton(idea));

    row.append(text, actions);
    wrap.appendChild(row);
  }
}

function removeButton(idea) {
  const btn = document.createElement("button");
  btn.className = "btn-mini";
  btn.textContent = "Remove";
  let armed = false;

  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Sure?";
      btn.classList.add("armed");
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        btn.textContent = "Remove";
        btn.classList.remove("armed");
      }, 4000);
      return;
    }
    await setState(idea, "closed", btn, "Removed from the wall.");
  });

  return btn;
}

function restoreButton(idea) {
  const btn = document.createElement("button");
  btn.className = "btn-mini";
  btn.textContent = "Restore";
  btn.addEventListener("click", () => setState(idea, "open", btn, "Back on the wall."));
  return btn;
}

/* ============ ACTIONS ============ */

async function setState(idea, state, btn, okMessage) {
  const msg = $("action-msg");

  if (!token()) {
    msg.textContent = "Save your access key first (top of the page).";
    btn.textContent = state === "closed" ? "Remove" : "Restore";
    btn.classList.remove("armed");
    return;
  }

  btn.disabled = true;
  msg.textContent = state === "closed" ? "Removing..." : "Restoring...";

  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues/${idea.number}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": "Bearer " + token(),
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ state })
      }
    );
    if (!res.ok) throw new Error(String(res.status));

    msg.textContent = okMessage + " The live page updates within a minute.";
    await loadAll();
  } catch (err) {
    console.error("state change failed:", err);
    const code = String(err.message);
    msg.textContent = "Could not do that (error " + code + ")" +
      (code === "401" || code === "403"
        ? ": check the access key and that it has Issues read and write on this repo."
        : ".");
    btn.disabled = false;
  }
}

/* ============ HELPERS ============ */

function toggleRemoved() {
  const wrap = $("removed-wrap");
  wrap.hidden = !wrap.hidden;
  $("toggle-removed").textContent = wrap.hidden ? "Show removed" : "Hide removed";
}

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
