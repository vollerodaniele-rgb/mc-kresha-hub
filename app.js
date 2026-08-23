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
        // and an attached picture as a markdown image
        let image = "";
        const img = body.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/);
        if (img) {
          image = img[1];
          body = body.replace(img[0], "");
        }
        return {
          text: clean(body) || i.title.replace(/^Idea:\s*/, ""),
          author,
          image
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

function card({ text, author, image }) {
  const el = document.createElement("article");
  el.className = "idea-card";
  el.innerHTML = `
    ${image ? `<img class="idea-image" src="${esc(image)}" alt="" loading="lazy">` : ""}
    <p class="idea-body">${esc(text.slice(0, 300))}</p>
    <div class="idea-meta"><span>by ${esc(author)}</span></div>
  `;
  return el;
}

/* ============ FORM ============ */

function setupForm() {
  const form = $("idea-form");
  form.hidden = false;
  setupPicker();

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
    msg.textContent = pendingImage ? "Sending picture..." : "Sending...";

    try {
      const payload = { site: CONFIG.site, idea, name, website: $("idea-website").value };
      if (pendingImage) payload.image = { type: "image/jpeg", data: pendingImage };

      const res = await fetch(CONFIG.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("relay " + res.status);

      msg.textContent = "Got it! Your idea is on the wall.";
      const shownImage = pendingImage ? "data:image/jpeg;base64," + pendingImage : "";
      form.reset();
      clearPicture();

      const status = $("idea-status");
      if (status) status.remove();
      $("idea-grid").prepend(card({ text: idea, author: name || "anonymous", image: shownImage }));
    } catch (err) {
      console.error("idea submit failed:", err);
      msg.textContent = "Could not send right now. Try again in a minute.";
    } finally {
      btn.disabled = false;
    }
  });
}

/* ============ PICTURE ============ */

// base64 JPEG of the chosen picture, ready to send
let pendingImage = "";

function setupPicker() {
  const input = $("idea-image");

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return clearPicture();

    const msg = $("form-msg");
    msg.textContent = "Preparing picture...";
    $("pic-name").textContent = file.name;

    try {
      pendingImage = await shrink(file);
      $("pic-preview").src = "data:image/jpeg;base64," + pendingImage;
      $("pic-preview").hidden = false;
      $("pic-clear").hidden = false;
      msg.textContent = "";
    } catch (err) {
      console.error("picture failed:", err);
      clearPicture();
      msg.textContent = "That picture could not be read. Try a JPG or PNG.";
    }
  });

  $("pic-clear").addEventListener("click", () => {
    clearPicture();
    $("form-msg").textContent = "";
  });
}

function clearPicture() {
  pendingImage = "";
  $("idea-image").value = "";
  $("pic-name").textContent = "No picture chosen";
  $("pic-preview").hidden = true;
  $("pic-preview").removeAttribute("src");
  $("pic-clear").hidden = true;
}

// Resize in the browser: keeps uploads small, and re-encoding to
// JPEG drops any location data the photo was carrying.
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // step the quality down until it fits comfortably under the relay's cap
  for (const quality of [0.82, 0.7, 0.6, 0.5]) {
    const b64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
    if (b64.length <= 2800000) return b64;
  }
  throw new Error("picture too large");
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
