/* Idea Box relay for MC Kresha Project HQ
   ------------------------------------------------------------
   Runs as a Cloudflare Worker (free tier). Receives ideas from
   the website form and files them as GitHub issues labeled
   "idea", so they appear on the site like any other idea.

   Secrets (set in the Worker's settings, never in code):
     GITHUB_TOKEN        fine-grained GitHub token, issues and
                         contents on the repos below
     TELEGRAM_BOT_TOKEN  optional, to be pinged on every submission
     TELEGRAM_CHAT_ID    optional, which chat to ping
   ------------------------------------------------------------ */

const SITES = {
  kresha: {
    repo: "vollerodaniele-rgb/mc-kresha-hub", label: "idea",
    name: "idea on Last Chapter", url: "https://kresha.noiraunoir.com/admin.html"
  },
  sakas: {
    repo: "vollerodaniele-rgb/sakas-portal", label: "idea",
    name: "request from the Sakas portal", url: "https://sakas.noiraunoir.com/admin.html"
  },
  sakasidea: {
    repo: "vollerodaniele-rgb/sakas-idea", label: "idea",
    name: "idea in the Sakas idea box", url: "https://sakasidea.noiraunoir.com/admin.html"
  },
  // every client portal shares one repo; the client is a second label,
  // so adding a client needs no change here at all
  clients: {
    repo: "vollerodaniele-rgb/clients", label: "idea",
    name: "client request", url: "https://clients.noiraunoir.com",
    perClient: true
  },
  // a standalone idea box; the box name is a second label so boxes
  // never see each other
  box: {
    repo: "vollerodaniele-rgb/clients", label: "idea",
    name: "idea", url: "https://clients.noiraunoir.com",
    perClient: true, clientWord: "box"
  },
  // someone picking a package on a proposal
  proposal: {
    repo: "vollerodaniele-rgb/clients", label: "accepted",
    name: "PROPOSAL ACCEPTED", url: "https://clients.noiraunoir.com",
    perClient: true, clientWord: "proposal", email: true
  },
  // a client tapping one of the shoot dates offered on their portal.
  // the client label is the same one a request carries, but the first
  // label is "shoot" and not "idea", so a picked date never turns up
  // on the requests wall or in the requests panel
  shoot: {
    repo: "vollerodaniele-rgb/clients", label: "shoot",
    name: "SHOOT DATE PICKED", url: "https://clients.noiraunoir.com",
    perClient: true, via: "the portal", email: true
  }
};

// folder names only, which is also what the label is built from
const CLIENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
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
  "https://sakasidea.noiraunoir.com",
  "https://kresha.noiraunoir.com",
  "http://localhost:4173",
  "http://localhost:4174",
  "http://localhost:4175",
  "http://localhost:4177",
  "https://clients.noiraunoir.com",
  "https://proposal.noiraunoir.com",
  "http://localhost:4176"
];

export default {
  /* Runs on the cron in wrangler.toml, not on a request. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(healthCheck(env, new Date(event.scheduledTime).getUTCDay() === 1));
  },

  async fetch(request, env, ctx) {
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
      if (url.pathname === "/telegram-setup") return telegramSetup(env, cors);
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
    const { repo, label, perClient } = SITES[site];

    const rawClient = String(data.client || "");
    const client = (SITES[site].clientWord === "proposal") ? rawClient : rawClient.toLowerCase();
    if (perClient && !CLIENT_RE.test(client)) {
      return json({ error: "unknown client" }, 400, cors);
    }
    const labelWord = SITES[site].clientWord || "client";
    const labels = perClient ? [label, labelWord + ":" + client] : [label];
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
    const word = label === "accepted" ? "Accepted"
      : label === "shoot" ? "Shoot"
      : "Idea";
    const title = oneLine
      ? word + ": " + oneLine.slice(0, 60) + (oneLine.length > 60 ? "..." : "")
      : word + ": voice message";
    const body =
      idea +
      (imageUrl ? "\n\n![idea picture](" + imageUrl + ")" : "") +
      (audioUrl ? "\n\n[voice message](" + audioUrl + ")" : "") +
      "\n\n---\nSubmitted by: " + (name || "anonymous") +
      " (via " + (SITES[site].via || "the idea box") + ")";

    const gh = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ title, body, labels })
    });

    if (!gh.ok) {
      return json({ error: "could not save idea (github " + gh.status + ")" }, 502, cors);
    }

    // ping Telegram after the reply is sent, so a slow or broken
    // notification never keeps the sender waiting
    const notice = { site, client, name, idea, hasImage: !!imageUrl, hasVoice: !!audioUrl };
    ctx.waitUntil(notifyTelegram(env, notice));
    // only the rare, worth keeping ones go to email. Telegram already
    // carries the rest, and a mailbox full of pings is a mailbox
    // nobody reads.
    if (SITES[site].email) ctx.waitUntil(notifyEmail(env, notice));

    return json({ ok: true }, 201, cors);
  }
};

/* Reads the open ideas for one site and returns them ready to render.
   The GitHub call is cached briefly at the edge, so a burst of visitors
   costs one request rather than hundreds. */
async function listIdeas(url, env, cors) {
  const asked = url.searchParams.get("site");
  const site = SITES[asked] ? asked : DEFAULT_SITE;
  const { repo, label, perClient } = SITES[site];

  // on the shared clients repo, a portal must only ever see its own
  // requests, which the client label guarantees
  let labels = label;
  if (perClient) {
    const raw = String(url.searchParams.get("client") || "");
    const client = (SITES[site].clientWord === "proposal") ? raw : raw.toLowerCase();
    if (!CLIENT_RE.test(client)) return json({ error: "unknown client" }, 400, cors);
    labels = label + "," + (SITES[site].clientWord || "client") + ":" + client;
  }

  const api = `https://api.github.com/repos/${repo}/issues` +
    `?labels=${encodeURIComponent(labels)}&state=open&sort=created&direction=desc&per_page=50`;

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

    // the wording after "via" differs per site, so match any of them
    const trailer = body.match(/\n*-{3,}\nSubmitted by: (.+?) \(via [^)]*\)\s*$/);
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

/* ============ TELEGRAM ============ */

async function notifyTelegram(env, { site, client, name, idea, hasImage, hasVoice }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const meta = SITES[site] || {};
  const who = !meta.perClient || !client ? meta.name
    : meta.clientWord === "proposal" ? meta.name
    : meta.clientWord === "box" ? "idea in the " + client + " box"
    : meta.label === "shoot" ? "shoot date from " + client.toUpperCase()
    : client.toUpperCase() + " request";
  const link = !meta.perClient || !client ? meta.url
    : meta.clientWord === "proposal" ? meta.url + "/p/" + client + "/"
    : meta.clientWord === "box" ? meta.url + "/i/" + client + "/admin.html"
    : meta.url + "/" + client + "/admin.html";
  const extras = [hasImage ? "a picture" : null, hasVoice ? "a voice message" : null].filter(Boolean);

  const lines = [
    "<b>New " + esc(who || site) + "</b>",
    "from " + esc(name || "anonymous"),
    ""
  ];
  lines.push(idea ? esc(idea.slice(0, 700)) : "<i>no text, see the attachment</i>");
  if (extras.length) lines.push("", "With " + extras.join(" and ") + ".");
  if (link) lines.push("", link);

  await telegram(env, lines.join("\n"));
}

/* One place that actually talks to Telegram, used by the submission
   pings and by the health check. */
async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    if (!res.ok) console.log("telegram failed:", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.log("telegram error:", String(err));
    return false;
  }
}

/* ============ EMAIL ============ */
/* Telegram is right for "something happened". Email is right for the
   two things worth keeping and forwarding: somebody accepting a
   proposal, and somebody booking a shoot day.

   It stays completely switched off until RESEND_API_KEY exists, so
   this ships harmlessly and turns itself on the moment the secret is
   added. Nothing here is hardcoded: MAIL_TO is where it lands and
   MAIL_FROM is who it comes from, so moving off the shared Resend
   sender onto send.noiraunoir.com is a setting, not a code change.

   Fonts are Georgia and Arial rather than Playfair and Inter, because
   Gmail and Outlook strip web fonts. Tables and inline styles, because
   email clients are stuck in 2005. */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Noir au Noir <onboarding@resend.dev>";
const REPLY_TO = "info@noiraunoir.com";

async function notifyEmail(env, { site, client, name, idea }) {
  if (!env.RESEND_API_KEY || !env.MAIL_TO) return false;

  const meta = SITES[site] || {};
  const isProposal = meta.label === "accepted";
  // a proposal is addressed by an unguessable slug, so the subject has
  // to go and look up whose proposal it actually is
  const who = isProposal
    ? await brandFor(env, meta.repo, client) || client
    : (client || "").toUpperCase();

  const chosen = isProposal ? (idea.match(/Chose the (.+?) package\./) || [])[1] : "";
  const booked = !isProposal ? (idea.match(/Picked (\d{4}-\d{2}-\d{2})(?: at (\d{1,2}:\d{2}))?/) || []) : [];
  const extra = isProposal ? (idea.match(/Note:\s*([\s\S]+)$/) || [])[1] : "";

  const subject = isProposal
    ? (chosen ? who + " chose " + chosen : who + " accepted the proposal")
    : (booked[1] ? who + " picked " + prettyDate(booked[1]) : who + " picked a shoot date");

  const link = isProposal
    ? meta.url + "/p/" + client + "/"
    : meta.url + "/" + client + "/admin.html";

  const detail = isProposal
    ? { label: "The package", big: chosen || "Accepted", sub: "" }
    : { label: "The day", big: booked[1] ? prettyDate(booked[1]) : "A date was picked", sub: booked[2] ? "at " + booked[2] : "" };

  const html = mailHtml({
    headline: subject,
    lead: (name ? esc(name) : "Someone") + " just did this from " +
      (isProposal ? "the proposal you sent." : "their portal."),
    detail,
    quote: extra ? extra.trim() : "",
    action: { text: isProposal ? "Open the proposal" : "Confirm the date", url: link },
    foot: isProposal
      ? "Sent when a proposal is accepted."
      : "Sent when a client picks a shoot date. Confirm it and it becomes their next shoot."
  });

  const text = [
    subject,
    "",
    detail.label + ": " + detail.big + (detail.sub ? " " + detail.sub : ""),
    extra ? "\nThey added: " + extra.trim() : "",
    "",
    link
  ].filter((l) => l !== null).join("\n");

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || DEFAULT_FROM,
        to: [env.MAIL_TO],
        reply_to: REPLY_TO,
        subject,
        html,
        text
      })
    });
    if (!res.ok) console.log("resend failed:", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.log("resend error:", String(err));
    return false;
  }
}

/* Reads the brand off the proposal itself. A failure here only costs a
   nicer subject line, so it never stops the mail going out. */
async function brandFor(env, repo, slug) {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${repo}/main/proposals/${encodeURIComponent(slug)}.json`,
      { headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN }, cf: { cacheTtl: 60, cacheEverything: true } }
    );
    if (!res.ok) return "";
    const data = await res.json();
    return String(data.client || "").trim();
  } catch (err) {
    console.log("could not read the proposal brand:", String(err));
    return "";
  }
}

/* One shell every mail is poured into, so a second kind of mail is a
   few lines rather than another wall of table markup. */
function mailHtml({ headline, lead, detail, quote, action, foot }) {
  const cell = "font-family:Arial,Helvetica,sans-serif;";
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#000000;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background-color:#000000;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;border-collapse:collapse;background-color:#000000;">
  <tr><td style="padding:28px 36px 0 36px;${cell}font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:#9a9a9a;">Noir au Noir</td></tr>
  <tr><td style="padding:22px 36px 0 36px;font-family:Georgia,'Times New Roman',serif;font-size:29px;line-height:1.15;color:#ffffff;">${esc(headline)}</td></tr>
  <tr><td style="padding:14px 36px 0 36px;${cell}font-size:15px;line-height:1.6;color:#9a9a9a;">${lead}</td></tr>
  <tr><td style="padding:26px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #333333;">
      <tr><td style="padding:20px 22px 6px 22px;${cell}font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#5e5e5e;">${esc(detail.label)}</td></tr>
      <tr><td style="padding:0 22px ${detail.sub ? "4px" : "20px"} 22px;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#ffffff;">${esc(detail.big)}</td></tr>
      ${detail.sub ? `<tr><td style="padding:0 22px 20px 22px;${cell}font-size:14px;color:#9a9a9a;">${esc(detail.sub)}</td></tr>` : ""}
    </table>
  </td></tr>
  ${quote ? `<tr><td style="padding:22px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:0 0 6px 0;${cell}font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#5e5e5e;">They added</td></tr>
      <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;font-style:italic;color:#ffffff;">&ldquo;${esc(quote)}&rdquo;</td></tr>
    </table>
  </td></tr>` : ""}
  <tr><td style="padding:30px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr><td style="background-color:#ffffff;border-radius:999px;">
        <a href="${esc(action.url)}" style="display:inline-block;padding:13px 30px;${cell}font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#000000;text-decoration:none;">${esc(action.text)}</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:30px 36px 32px 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border-top:1px solid #222222;">
      <tr><td style="padding:16px 0 0 0;${cell}font-size:12px;line-height:1.6;color:#5e5e5e;">${esc(foot)}</td></tr>
    </table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function prettyDate(iso) {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return iso;
  return d.getUTCDate() + " " +
    ["January","February","March","April","May","June","July",
     "August","September","October","November","December"][d.getUTCMonth()] + " " +
    d.getUTCFullYear();
}

/* ============ HEALTH CHECK ============ */
/* The failure this exists for: a token is regenerated or loses a repo,
   every page still renders perfectly, and every form silently stops
   working. Nobody finds out until a client mentions it weeks later.
   This runs every morning and only speaks when something is wrong,
   with one all clear on Mondays so a silent checker cannot be mistaken
   for a healthy one. */

const EXPIRY_WARNING_DAYS = 14;

async function healthCheck(env, isMonday) {
  const problems = [];
  const notes = [];

  if (!env.GITHUB_TOKEN) {
    await telegram(env, "<b>Idea box relay is down</b>\n\nThere is no GitHub token on the worker at all. Every form on every site is failing.");
    return;
  }

  const headers = {
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "mc-kresha-idea-box"
  };

  // one entry per distinct repo, since several sites share one
  const repos = [...new Set(Object.values(SITES).map((s) => s.repo))];
  let expiry = "";

  for (const repo of repos) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      expiry = expiry || res.headers.get("github-authentication-token-expiration") || "";

      if (res.status === 401) {
        problems.push(esc(repo) + ": the token was refused. It has been regenerated or revoked.");
      } else if (res.status === 403 || res.status === 404) {
        problems.push(esc(repo) + ": the token no longer reaches this repo (" + res.status + ").");
      } else if (!res.ok) {
        problems.push(esc(repo) + ": GitHub answered " + res.status + ".");
      } else {
        // a fine grained token reports what it may actually do here,
        // and filing an issue needs more than read
        const body = await res.json();
        if (body.permissions && body.permissions.push === false) {
          problems.push(esc(repo) + ": read only. Submissions will fail.");
        }
      }
    } catch (err) {
      problems.push(esc(repo) + ": could not be reached (" + esc(String(err)) + ").");
    }
  }

  const days = daysUntil(expiry);
  if (days !== null && days <= EXPIRY_WARNING_DAYS) {
    const when = days <= 0 ? "has expired" : "expires in " + days + " day" + (days === 1 ? "" : "s");
    problems.push("The idea-box-relay token " + when + " (" + esc(expiry.slice(0, 10)) + "). Edit its expiry, do not regenerate it.");
  } else if (days !== null) {
    notes.push("Token good for another " + days + " days.");
  }

  // a dead mail key is the same silent failure as a dead github one:
  // everything looks fine and nothing arrives
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { "Authorization": "Bearer " + env.RESEND_API_KEY }
      });
      if (res.status === 401 || res.status === 403) {
        problems.push("Resend refused the mail key. Acceptances are not being emailed.");
      } else if (!res.ok) {
        notes.push("Resend answered " + res.status + " on the check.");
      } else if (!env.MAIL_TO) {
        problems.push("There is a Resend key but no MAIL_TO, so nothing has anywhere to go.");
      } else {
        notes.push("Mail is working.");
      }
    } catch (err) {
      notes.push("Could not reach Resend (" + esc(String(err)) + ").");
    }
  }

  if (problems.length) {
    await telegram(env, [
      "<b>Something is broken</b>",
      "",
      ...problems.map((p) => "• " + p),
      "",
      "Pages still look fine, which is why this needs doing today.",
      "https://dash.cloudflare.com"
    ].join("\n"));
    return;
  }

  if (isMonday) {
    await telegram(env, [
      "<b>All good</b>",
      "",
      esc(String(repos.length)) + " repos reachable, submissions working.",
      ...notes.map((n) => esc(n))
    ].join("\n"));
  }
}

/* GitHub hands back the token's expiry on every authenticated call,
   which is the only warning you get before it dies. */
function daysUntil(stamp) {
  if (!stamp) return null;
  // the header looks like "2026-11-05 16:22:41 UTC"
  const when = Date.parse(stamp.replace(" UTC", "Z").replace(" ", "T"));
  if (isNaN(when)) return null;
  return Math.floor((when - Date.now()) / 86400000);
}

/* One time helper: message the bot, open this, and it tells you the
   chat id to store. It goes quiet once the chat id is configured, and
   it never reveals the bot token. */
async function telegramSetup(env, cors) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return json({ step: "Add TELEGRAM_BOT_TOKEN as a secret on this worker first." }, 200, cors);
  }
  if (env.TELEGRAM_CHAT_ID) {
    return json({ done: "Notifications are configured. This helper is switched off." }, 200, cors);
  }

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  if (!res.ok) {
    return json({ error: "Telegram refused the bot token (" + res.status + ")." }, 502, cors);
  }

  const data = await res.json();
  const chats = [];
  for (const u of data.result || []) {
    const chat = (u.message || u.channel_post || {}).chat;
    if (chat && !chats.some((c) => c.chat_id === chat.id)) {
      chats.push({ chat_id: chat.id, name: chat.first_name || chat.title || "" });
    }
  }

  return json(chats.length
    ? { step: "Store this as TELEGRAM_CHAT_ID on the worker.", chats }
    : { step: "Send your bot any message in Telegram, then reload this page." }, 200, cors);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}
