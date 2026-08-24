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
const MAX_AUDIO_B64 = 3000000; // a minute of speech is far below this
const AUDIO_TYPES = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg"
};
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

    // Reading the wall goes through here too. Anonymous browsers only
    // get 60 GitHub calls an hour per address, which a shared office or
    // mobile network burns through quickly; the token we hold is good
    // for 5000, so the visitor never sees a rate limit.
    if (request.method === "GET" || request.method === "HEAD") {
      const url = new URL(request.url);
      // GitHub serves uploaded audio as text/plain with sniffing off,
      // so browsers refuse to play it. We hand it back properly typed.
      if (url.pathname === "/audio") return serveAudio(url, env);
      return listIdeas(url, env, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "POST or GET only" }, 405, cors);
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
    const hasVoice = !!(data.audio && data.audio.data);

    // a voice note can stand on its own, so text is only required
    // when nothing was recorded
    if (idea.length > 1000) {
      return json({ error: "idea must be under 1000 characters" }, 400, cors);
    }
    if (idea.length < 10 && !hasVoice) {
      return json({ error: "idea must be at least 10 characters" }, 400, cors);
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

    let audioUrl = "";
    if (hasVoice) {
      audioUrl = await uploadAudio(data.audio, repo, ghHeaders, new URL(request.url).origin);
    }

    const oneLine = idea.replace(/\s+/g, " ");
    const title = oneLine
      ? "Idea: " + oneLine.slice(0, 60) + (oneLine.length > 60 ? "..." : "")
      : "Idea: voice message";
    const body =
      idea +
      (imageUrl ? "\n\n![idea picture](" + imageUrl + ")" : "") +
      (audioUrl ? "\n\n[voice message](" + audioUrl + ")" : "") +
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

/* Reads the open ideas for one site and returns them ready to render.
   The GitHub call is cached briefly at the edge, so a burst of visitors
   costs one request rather than hundreds. */
async function listIdeas(url, env, cors) {
  const asked = url.searchParams.get("site");
  const site = SITES[asked] ? asked : DEFAULT_SITE;
  const { repo, label } = SITES[site];

  const api = `https://api.github.com/repos/${repo}/issues` +
    `?labels=${encodeURIComponent(label)}&state=open&sort=created&direction=desc&per_page=50`;

  const res = await fetch(api, {
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "mc-kresha-idea-box"
    },
    cf: { cacheTtl: 30, cacheEverything: true }
  });

  if (!res.ok) {
    return json({ error: "could not read ideas (github " + res.status + ")" }, 502, cors);
  }

  const issues = await res.json();
  const ideas = issues.filter((i) => !i.pull_request).map((i) => {
    let body = i.body || "";
    let author = i.user ? i.user.login : "anonymous";

    const trailer = body.match(/\n*-{3,}\nSubmitted by: (.+?) \(via the idea box\)\s*$/);
    if (trailer) {
      author = trailer[1];
      body = body.slice(0, trailer.index);
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
      text: body.trim() || (audio ? "" : i.title.replace(/^Idea:\s*/, "")),
      author,
      image,
      audio
    };
  });

  return json({ ideas }, 200, { ...cors, "Cache-Control": "public, max-age=30" });
}

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

/* Voice notes: same storage as pictures, but played back through
   this worker so the browser gets a real audio content type. */
async function uploadAudio(audio, repo, ghHeaders, origin) {
  const b64 = String(audio.data || "");
  const ext = AUDIO_TYPES[audio.type];

  if (!ext) return "";
  if (!b64 || b64.length > MAX_AUDIO_B64) return "";
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return "";

  const file = `${crypto.randomUUID()}.${ext}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/uploads/${file}`, {
    method: "PUT",
    headers: ghHeaders,
    body: JSON.stringify({
      message: "Add voice message",
      content: b64,
      branch: UPLOAD_BRANCH
    })
  });

  if (!res.ok) {
    console.log("audio upload failed:", res.status, await res.text());
    return "";
  }

  // repo is owner/name; the player needs to know which one to read from
  return `${origin}/audio?repo=${encodeURIComponent(repo)}&f=${encodeURIComponent(file)}`;
}

async function serveAudio(url, env) {
  const file = url.searchParams.get("f") || "";
  const repo = url.searchParams.get("repo") || "";

  if (!/^[0-9a-f-]{36}\.(webm|m4a|mp4|ogg)$/.test(file)) {
    return new Response("bad file", { status: 400 });
  }
  if (!Object.values(SITES).some((s) => s.repo === repo)) {
    return new Response("unknown repo", { status: 400 });
  }

  const raw = await fetch(
    `https://raw.githubusercontent.com/${repo}/${UPLOAD_BRANCH}/uploads/${file}`,
    { headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN }, cf: { cacheTtl: 3600, cacheEverything: true } }
  );

  if (!raw.ok) return new Response("not found", { status: 404 });

  const ext = file.split(".").pop();
  const type = ext === "webm" ? "audio/webm"
    : ext === "ogg" ? "audio/ogg"
    : "audio/mp4";

  return new Response(raw.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}
