/* Idea Box relay for MC Kresha Project HQ
   ------------------------------------------------------------
   Runs as a Cloudflare Worker (free tier). Receives ideas from
   the website form and files them as GitHub issues labeled
   "idea", so they appear on the site like any other idea.

   Required secret (set in the Worker's settings, never in code):
     GITHUB_TOKEN  a fine-grained GitHub token that can only
                   write issues on the one repo below.
   ------------------------------------------------------------ */

const SITES = {
  kresha: { repo: "vollerodaniele-rgb/mc-kresha-hub", label: "idea" },
  sakas: { repo: "vollerodaniele-rgb/sakas-portal", label: "idea" }
};
const DEFAULT_SITE = "kresha";
const UPLOAD_BRANCH = "uploads";
const MAX_IMAGE_B64 = 3000000; // base64 chars, roughly 2.2 MB of image
const ALLOWED_ORIGINS = [
  "https://vollerodaniele-rgb.github.io",
  "https://sakas.noiraunoir.com",
  "https://kresha.noiraunoir.com",
  "http://localhost:4173",
  "http://localhost:4174"
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, cors);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400, cors);
    }

    // honeypot: humans never fill this field, bots do.
    // pretend success so bots do not learn they were caught.
    if (data.website) {
      return json({ ok: true }, 201, cors);
    }

    const site = SITES[data.site] ? data.site : DEFAULT_SITE;
    const { repo, label } = SITES[site];
    const idea = String(data.idea || "").trim();
    const name = String(data.name || "").trim().slice(0, 60);

    if (idea.length < 10 || idea.length > 1000) {
      return json({ error: "idea must be between 10 and 1000 characters" }, 400, cors);
    }

    const ghHeaders = {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "mc-kresha-idea-box",
      "Content-Type": "application/json"
    };

    // optional picture: the browser already resized it and encoded it
    // as base64 JPEG, so there is nothing heavy to do here.
    let imageUrl = "";
    if (data.image) {
      imageUrl = await uploadImage(data.image, repo, ghHeaders);
    }

    const oneLine = idea.replace(/\s+/g, " ");
    const title = "Idea: " + oneLine.slice(0, 60) + (oneLine.length > 60 ? "..." : "");
    const body =
      idea +
      (imageUrl ? "\n\n![idea picture](" + imageUrl + ")" : "") +
      "\n\n---\nSubmitted by: " + (name || "anonymous") + " (via the idea box)";

    const gh = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ title, body, labels: [label] })
    });

    if (!gh.ok) {
      return json({ error: "could not save idea (github " + gh.status + ")" }, 502, cors);
    }

    return json({ ok: true }, 201, cors);
  }
};

/* Pictures live on a separate "uploads" branch so that adding one
   does not rebuild the website. They are served straight from
   raw.githubusercontent.com, which is available immediately. */
async function uploadImage(image, repo, ghHeaders) {
  const b64 = String(image.data || "");

  // the browser sends resized JPEG only; anything else is rejected
  if (image.type !== "image/jpeg") return "";
  if (!b64 || b64.length > MAX_IMAGE_B64) return "";
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return "";

  const path = `uploads/${crypto.randomUUID()}.jpg`;

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders,
    body: JSON.stringify({
      message: "Add idea picture",
      content: b64,
      branch: UPLOAD_BRANCH
    })
  });

  if (!res.ok) {
    console.log("image upload failed:", res.status, await res.text());
    return "";
  }

  return `https://raw.githubusercontent.com/${repo}/${UPLOAD_BRANCH}/${path}`;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}
