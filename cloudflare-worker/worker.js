/* Idea Box relay for MC Kresha Project HQ
   ------------------------------------------------------------
   Runs as a Cloudflare Worker (free tier). Receives ideas from
   the website form and files them as GitHub issues labeled
   "idea", so they appear on the site like any other idea.

   Required secret (set in the Worker's settings, never in code):
     GITHUB_TOKEN  a fine-grained GitHub token that can only
                   write issues on the one repo below.
   ------------------------------------------------------------ */

const REPO = "vollerodaniele-rgb/mc-kresha-hub";
const ALLOWED_ORIGINS = [
  "https://vollerodaniele-rgb.github.io",
  "http://localhost:4173"
];
const IDEA_LABEL = "idea";

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

    const idea = String(data.idea || "").trim();
    const name = String(data.name || "").trim().slice(0, 60);

    if (idea.length < 10 || idea.length > 1000) {
      return json({ error: "idea must be between 10 and 1000 characters" }, 400, cors);
    }

    const oneLine = idea.replace(/\s+/g, " ");
    const title = "Idea: " + oneLine.slice(0, 60) + (oneLine.length > 60 ? "..." : "");
    const body =
      idea +
      "\n\n---\nSubmitted by: " + (name || "anonymous") + " (via the idea box)";

    const gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "Accept": "application/vnd.github+json",
        "User-Agent": "mc-kresha-idea-box",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title, body, labels: [IDEA_LABEL] })
    });

    if (!gh.ok) {
      return json({ error: "could not save idea (github " + gh.status + ")" }, 502, cors);
    }

    return json({ ok: true }, 201, cors);
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}
