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
    perClient: true, clientWord: "proposal", via: "the proposal", email: true
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
    // an expired transfer is unreachable but still costs storage, so
    // it is swept rather than left to accumulate forever
    ctx.waitUntil(sweepExpiredTransfers(env));
  },

  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      // uploads carry the key and the file type as headers, and a header
      // the browser has not been told about turns into a blocked request
      // that reports itself as a dropped connection
      "Access-Control-Allow-Headers": "Content-Type, X-Studio-Key, X-File-Type",
      "Access-Control-Max-Age": "86400"
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
      if (url.pathname === "/mail-setup") return mailSetup(env, cors);
      if (url.pathname === "/delivery") return listDelivery(url, env, cors);
      if (url.pathname === "/file") return serveDelivery(url, env);
      if (url.pathname === "/transfer") return readTransfer(url, env, cors);
      if (url.pathname === "/transfer/file") return serveTransferFile(url, env, ctx);
      if (url.pathname === "/transfers") return listTransfers(request, url, env, cors);
      if (url.pathname === "/call/slots") return openSlots(env, cors);
      if (url.pathname === "/call/invite") return readInvite(url, env, cors);
      if (url.pathname === "/ref") return readPartner(url, env, cors);
      if (url.pathname === "/refs") return listPartners(request, url, env, cors);
      if (url.pathname === "/call/list") return listCalls(request, url, env, cors);
      return listIdeas(url, env, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "POST or GET only" }, 405, cors);
    }

    // the one endpoint that sends mail to an address chosen by the
    // caller, so it is the one endpoint that has to prove who is asking
    if (new URL(request.url).pathname === "/welcome") {
      return sendWelcome(request, env, cors);
    }

    if (new URL(request.url).pathname === "/seen") {
      return recordSeen(request, env, ctx, cors);
    }

    if (new URL(request.url).pathname === "/shoot-confirmed") {
      return sendShootInvite(request, env, cors);
    }

    if (new URL(request.url).pathname === "/deliver") {
      return acceptDelivery(request, env, cors);
    }

    if (new URL(request.url).pathname.startsWith("/transfer/")) {
      return handleTransfer(request, env, cors);
    }

    if (new URL(request.url).pathname.startsWith("/call/")) {
      return handleCall(request, env, ctx, cors);
    }

    if (new URL(request.url).pathname.startsWith("/ref/")) {
      return handlePartner(request, env, ctx, cors);
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

    /* An address the sender typed. It is deliberately never written
       into the issue: these repos are public, and putting a client's
       email in one publishes it to every scraper there is. It reaches
       you through Telegram and your own notification instead, both of
       which are private. */
    const rawEmail = String(data.email || "").trim().slice(0, 120);
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawEmail) ? rawEmail : "";

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
    const notice = { site, client, name, email, idea, hasImage: !!imageUrl, hasVoice: !!audioUrl };
    ctx.waitUntil(notifyTelegram(env, notice));
    // only the rare, worth keeping ones go to email. Telegram already
    // carries the rest, and a mailbox full of pings is a mailbox
    // nobody reads.
    if (SITES[site].email) ctx.waitUntil(notifyEmail(env, notice));

    // and the person who just accepted gets a confirmation, provided
    // the proposal they accepted actually exists
    if (label === "accepted" && email) {
      ctx.waitUntil((async () => {
        const proposal = await readProposal(env, repo, client);
        await emailClient(env, {
          proposal,
          to: email,
          name,
          chosen: (idea.match(/Chose the (.+?) package\./) || [])[1] || ""
        });
      })());
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

async function notifyTelegram(env, { site, client, name, email, idea, hasImage, hasVoice }) {
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
  // the address is never written to the public issue, so this and the
  // notification email are the only places it reaches you
  if (email) lines.push("", "Reply to: " + esc(email));
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
// the line under the name in a client facing mail. One place, because
// getting this wrong is getting it wrong in front of a client: the
// company is a US production company, not a Belgian photographer.
const STUDIO_LINE = "Production company &middot; Las Vegas, Nevada";

async function notifyEmail(env, { site, client, name, email, idea }) {
  // say so out loud. Returning quietly here once cost an evening,
  // because a missing key and a delivered mail look identical in the
  // logs when neither writes a line.
  if (!env.RESEND_API_KEY || !env.MAIL_TO) {
    console.log("email skipped: RESEND_API_KEY " + (env.RESEND_API_KEY ? "set" : "MISSING") +
      ", MAIL_TO " + (env.MAIL_TO ? "set" : "MISSING"));
    return false;
  }
  console.log("emailing " + site + " for " + client);

  const meta = SITES[site] || {};
  const isProposal = meta.label === "accepted";
  // a proposal is addressed by an unguessable slug, so the subject has
  // to go and look up whose proposal it actually is
  const who = isProposal
    ? await (async () => { const p = await readProposal(env, meta.repo, client); return p && String(p.client || "").trim(); })() || client
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
      (isProposal ? "the proposal you sent." : "their portal.") +
      (email ? "<br>Reply to: <a href=\"mailto:" + esc(email) + "\" style=\"color:#ffffff;\">" + esc(email) + "</a>" : ""),
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
        // trimmed, because a key pasted with a trailing newline is
        // indistinguishable from a wrong one at the far end
        "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(),
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

/* ============ DELIVERING THE WORK ============ */
/* The month's finished work, kept where a client can always fetch it
   again. This replaces a WeTransfer link that expires in seven days
   with a page that still works next March.

   Files live in R2, one folder per client per month. Nothing in the
   bucket has a public address: every byte a client downloads is handed
   over by this worker, which is also why downloads can be counted,
   revoked, or restricted later without moving anything.

   Uploading is guarded by the admin key, the same as the mail routes.
   Downloading is not, deliberately: it sits at the same level as the
   portal it belongs to, which is reachable by anyone who knows the
   client name. Raising that is a per client code and a separate job. */

const MONTH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// Workers cap a request body at 100MB, so refuse just under it and say
// so, rather than failing halfway through a long upload
const MAX_UPLOAD = 95 * 1024 * 1024;

function deliveryKey(client, month, name) {
  return client + "/" + month + "/" + name;
}

/* A file name that cannot escape its folder or carry surprises.
   Anything with a path in it is refused rather than quietly trimmed to
   its last part: silently storing a file under a different name than
   the one asked for is worse than saying no. */
function safeName(raw) {
  const name = String(raw || "").trim();
  if (!name || name.length > 120) return "";
  if (/[\\/]/.test(name)) return "";
  if (name === "." || name === "..") return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) return "";
  return name;
}

async function acceptDelivery(request, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const url = new URL(request.url);
  const client = String(url.searchParams.get("client") || "").toLowerCase();
  const month = String(url.searchParams.get("month") || "");
  const name = safeName(url.searchParams.get("name"));
  const key = request.headers.get("X-Studio-Key") || "";

  if (!key) return json({ error: "no key" }, 401, cors);
  if (!CLIENT_RE.test(client)) return json({ error: "unknown client" }, 400, cors);
  if (!MONTH_RE.test(month)) return json({ error: "bad month" }, 400, cors);
  if (!name) return json({ error: "that file name cannot be used" }, 400, cors);
  if (!await mayWrite(env, key)) {
    return json({ error: "that key cannot write to this studio" }, 403, cors);
  }

  const size = Number(request.headers.get("Content-Length") || 0);
  if (size > MAX_UPLOAD) {
    return json({
      error: "that file is over 95MB, which is more than one upload can carry. " +
        "Export it smaller, or split the delivery."
    }, 413, cors);
  }

  try {
    await env.DELIVERIES.put(deliveryKey(client, month, name), request.body, {
      httpMetadata: { contentType: request.headers.get("X-File-Type") || "application/octet-stream" }
    });
    return json({ ok: true, name }, 201, cors);
  } catch (err) {
    console.log("delivery upload failed:", String(err));
    return json({ error: "could not store it" }, 502, cors);
  }
}

async function listDelivery(url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const client = String(url.searchParams.get("client") || "").toLowerCase();
  const month = String(url.searchParams.get("month") || "");
  if (!CLIENT_RE.test(client) || !MONTH_RE.test(month)) {
    return json({ error: "unknown delivery" }, 400, cors);
  }

  try {
    const listed = await env.DELIVERIES.list({ prefix: client + "/" + month + "/", limit: 500 });
    const files = listed.objects.map((o) => ({
      name: o.key.split("/").pop(),
      size: o.size,
      type: (o.httpMetadata && o.httpMetadata.contentType) || "",
      uploaded: o.uploaded
    })).sort((a, b) => a.name.localeCompare(b.name));

    return json({ files }, 200, { ...cors, "Cache-Control": "public, max-age=30" });
  } catch (err) {
    console.log("could not list a delivery:", String(err));
    return json({ error: "could not read it" }, 502, cors);
  }
}

async function serveDelivery(url, env) {
  if (!env.DELIVERIES) return new Response("storage is not connected", { status: 503 });

  const client = String(url.searchParams.get("client") || "").toLowerCase();
  const month = String(url.searchParams.get("month") || "");
  const name = safeName(url.searchParams.get("name"));
  if (!CLIENT_RE.test(client) || !MONTH_RE.test(month) || !name) {
    return new Response("unknown file", { status: 400 });
  }

  const object = await env.DELIVERIES.get(deliveryKey(client, month, name));
  if (!object) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  // download rather than open, and never under a name the URL invented
  headers.set("Content-Disposition", 'attachment; filename="' + name.replace(/"/g, "") + '"');
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(object.body, { headers });
}

/* ============ REFERRAL PARTNERS ============ */
/* A photographer gets their own page, with their name on it, to send
   to their own clients. Since a fee is paid per client who books, the
   thing that actually matters is attribution: who sent whom. So opens
   are counted and bookings are tied back to the link they came from. */

const partnerKey = (id) => "_ref/" + id + ".json";

async function readPartnerRecord(env, id) {
  const object = await env.DELIVERIES.get(partnerKey(id));
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

async function readPartner(url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const id = String(url.searchParams.get("id") || "");
  if (!TRANSFER_RE.test(id)) return json({ error: "gone" }, 404, cors);

  const partner = await readPartnerRecord(env, id);
  if (!partner) return json({ error: "gone" }, 404, cors);

  // only what the page needs. The fee and the tally are his business.
  return json({
    name: partner.name || "",
    discount: partner.discount || "",
    note: partner.note || ""
  }, 200, cors);
}

async function listPartners(request, url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);
  const key = url.searchParams.get("key") || request.headers.get("X-Studio-Key") || "";
  if (!await mayWrite(env, key)) return json({ error: "no" }, 403, cors);

  const listed = await env.DELIVERIES.list({ prefix: "_ref/", limit: 1000 });
  const booked = await readBookings(env);

  const partners = [];
  for (const o of listed.objects) {
    const object = await env.DELIVERIES.get(o.key);
    if (!object) continue;
    try {
      const p = await object.json();
      const theirs = booked.filter((b) => b.ref === p.id);
      partners.push({
        id: p.id,
        name: p.name || "",
        discount: p.discount || "",
        at: p.at || "",
        opens: p.opens || 0,
        lastOpen: p.lastOpen || "",
        calls: theirs.length,
        who: theirs.map((b) => ({ name: b.name, date: b.date, time: b.time }))
      });
    } catch { /* one broken record should not hide the rest */ }
  }

  partners.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return json({ partners }, 200, cors);
}

async function handlePartner(request, env, ctx, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const action = new URL(request.url).pathname.slice("/ref/".length);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, cors);
  }

  /* Counting an open is public, because the page counting itself is
     the whole idea. It writes nothing a caller controls. */
  if (action === "seen") {
    const id = String(body.id || "");
    if (!TRANSFER_RE.test(id)) return json({ error: "gone" }, 404, cors);
    ctx.waitUntil(notePartnerOpen(env, id));
    return json({ ok: true }, 202, cors);
  }

  const key = request.headers.get("X-Studio-Key") || "";
  if (!key) return json({ error: "no key" }, 401, cors);
  if (!await mayWrite(env, key)) {
    return json({ error: "that key cannot write to this studio" }, 403, cors);
  }

  if (action === "new") {
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return json({ error: "give it a name" }, 400, cors);

    const id = newTransferId();
    await env.DELIVERIES.put(partnerKey(id), JSON.stringify({
      id, name,
      discount: String(body.discount || "").trim().slice(0, 40),
      note: String(body.note || "").trim().slice(0, 300),
      opens: 0, lastOpen: "",
      at: new Date().toISOString()
    }), { httpMetadata: { contentType: "application/json" } });

    return json({ ok: true, id }, 201, cors);
  }

  if (action === "remove") {
    const id = String(body.id || "");
    if (!TRANSFER_RE.test(id)) return json({ error: "unknown partner" }, 400, cors);
    await env.DELIVERIES.delete(partnerKey(id));
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "unknown action" }, 404, cors);
}

async function notePartnerOpen(env, id) {
  try {
    const partner = await readPartnerRecord(env, id);
    if (!partner) return;
    partner.opens = (partner.opens || 0) + 1;
    partner.lastOpen = new Date().toISOString();
    await env.DELIVERIES.put(partnerKey(id), JSON.stringify(partner), {
      httpMetadata: { contentType: "application/json" }
    });
  } catch (err) {
    console.log("could not note a partner open:", String(err));
  }
}

/* ============ BOOKING A CALL ============ */
/* The same idea as a client picking a shoot date, pointed at someone
   who is not a client yet. You offer times, they take one, and it
   disappears so nobody can take it twice.

   Slots and bookings live in R2 rather than in a repo, because a
   booking carries a stranger's name and email and the repos are
   public. */

const SLOTS_KEY = "_call/slots.json";
const bookingKey = (id) => "_call/booked/" + id + ".json";
const slotId = (date, time) => date + "-" + String(time).replace(":", "");

async function readSlots(env) {
  const object = await env.DELIVERIES.get(SLOTS_KEY);
  if (!object) return { slots: [], minutes: 20, note: "" };
  try {
    const data = await object.json();
    return {
      slots: Array.isArray(data.slots) ? data.slots : [],
      minutes: Number(data.minutes) || 20,
      note: String(data.note || "")
    };
  } catch {
    return { slots: [], minutes: 20, note: "" };
  }
}

async function readBookings(env) {
  const listed = await env.DELIVERIES.list({ prefix: "_call/booked/", limit: 1000 });
  const out = [];
  for (const o of listed.objects) {
    const object = await env.DELIVERIES.get(o.key);
    if (!object) continue;
    try {
      out.push(await object.json());
    } catch { /* a broken record should not hide the rest */ }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/* A slot is gone once it is taken or once it is in the past. Nobody
   should be offered yesterday. */
function slotIsOpen(slot, booked) {
  const id = slotId(slot.date, slot.time);
  if (booked.some((b) => b.id === id)) return false;
  return Date.parse(slot.date + "T23:59:59Z") >= Date.now();
}

/* A personal invitation: one name, a few times, its own link.
   The times are per invitation, but a booking is not. Every booking
   lands in one ledger keyed by the date and hour, so the same slot can
   be offered to three people and the first to take it removes it from
   all three links. That is what stops you being double booked. */

const inviteKey = (id) => "_call/invite/" + id + ".json";

async function readInviteRecord(env, id) {
  const object = await env.DELIVERIES.get(inviteKey(id));
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

async function readInvite(url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const id = String(url.searchParams.get("id") || "");
  if (!TRANSFER_RE.test(id)) return json({ error: "gone" }, 404, cors);

  const invite = await readInviteRecord(env, id);
  if (!invite) return json({ error: "gone" }, 404, cors);

  // already used, so it says so rather than offering times again
  if (invite.booked) {
    return json({
      name: invite.name || "",
      minutes: invite.minutes || 20,
      note: invite.note || "",
      booked: invite.booked,
      slots: []
    }, 200, cors);
  }

  const taken = await readBookings(env);
  const slots = (invite.slots || [])
    .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && slotIsOpen(s, taken))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  return json({
    name: invite.name || "",
    minutes: invite.minutes || 20,
    note: invite.note || "",
    booked: null,
    slots
  }, 200, cors);
}

async function listInvites(env) {
  const listed = await env.DELIVERIES.list({ prefix: "_call/invite/", limit: 1000 });
  const out = [];
  for (const o of listed.objects) {
    const object = await env.DELIVERIES.get(o.key);
    if (!object) continue;
    try {
      out.push(await object.json());
    } catch { /* one broken invitation should not hide the rest */ }
  }
  return out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

async function openSlots(env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const { slots, minutes, note } = await readSlots(env);
  const booked = await readBookings(env);
  const open = slots
    .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && slotIsOpen(s, booked))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  return json({ slots: open, minutes, note }, 200, cors);
}

async function listCalls(request, url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);
  const key = url.searchParams.get("key") || request.headers.get("X-Studio-Key") || "";
  if (!await mayWrite(env, key)) return json({ error: "no" }, 403, cors);

  const { slots, minutes, note } = await readSlots(env);
  return json({
    booked: await readBookings(env),
    invites: await listInvites(env),
    slots, minutes, note
  }, 200, cors);
}

async function handleCall(request, env, ctx, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const action = new URL(request.url).pathname.slice("/call/".length);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, cors);
  }

  /* Booking is open to anyone, which is the point. It cannot mail an
     address of the caller's choosing with anything they wrote, and it
     can only ever take a slot that was deliberately offered. */
  if (action === "book") {
    const date = String(body.date || "");
    const time = String(body.time || "");
    const name = String(body.name || "").trim().slice(0, 60);
    const email = String(body.email || "").trim().slice(0, 120);
    const about = String(body.note || "").trim().slice(0, 500);
    const from = String(body.invite || "");
    // which partner sent them, if any. The fee is paid per booking, so
    // this is the number that decides what anybody is owed.
    const ref = TRANSFER_RE.test(String(body.ref || "")) ? String(body.ref) : "";

    if (body.website) return json({ ok: true }, 201, cors);
    if (!name) return json({ error: "no name" }, 400, cors);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "bad email" }, 400, cors);

    // a personal link offers its own times; the open page offers the
    // shared ones. Either way the slot must still be free for everyone.
    let offered, minutes, invite = null;
    if (from) {
      if (!TRANSFER_RE.test(from)) return json({ error: "gone" }, 404, cors);
      invite = await readInviteRecord(env, from);
      if (!invite) return json({ error: "gone" }, 404, cors);
      if (invite.booked) return json({ error: "that link has already been used" }, 409, cors);
      offered = invite.slots || [];
      minutes = invite.minutes || 20;
    } else {
      const shared = await readSlots(env);
      offered = shared.slots;
      minutes = shared.minutes;
    }

    const booked = await readBookings(env);
    const slot = offered.find((s) => s.date === date && s.time === time);
    if (!slot || !slotIsOpen(slot, booked)) {
      return json({ error: "that time has just gone, pick another" }, 409, cors);
    }

    const record = {
      id: slotId(date, time),
      date, time, name, email, note: about,
      minutes,
      invite: from || "",
      ref,
      at: new Date().toISOString()
    };

    await env.DELIVERIES.put(bookingKey(record.id), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" }
    });

    if (invite) {
      invite.booked = { date, time, at: record.at, name, email };
      await env.DELIVERIES.put(inviteKey(from), JSON.stringify(invite), {
        httpMetadata: { contentType: "application/json" }
      });
    }

    ctx.waitUntil(confirmCall(env, record));
    return json({ ok: true }, 201, cors);
  }

  // everything below changes what is offered, so it needs the key.
  // Missing and wrong answer differently, the same as every other
  // guarded route here.
  const key = request.headers.get("X-Studio-Key") || "";
  if (!key) return json({ error: "no key" }, 401, cors);
  if (!await mayWrite(env, key)) {
    return json({ error: "that key cannot write to this studio" }, 403, cors);
  }

  if (action === "offer") {
    const slots = (Array.isArray(body.slots) ? body.slots : [])
      .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{1,2}:\d{2}$/.test(s.time))
      .slice(0, 40)
      .map((s) => ({ date: s.date, time: s.time }));

    await env.DELIVERIES.put(SLOTS_KEY, JSON.stringify({
      slots,
      minutes: Math.min(180, Math.max(10, Number(body.minutes) || 20)),
      note: String(body.note || "").slice(0, 300)
    }), { httpMetadata: { contentType: "application/json" } });

    return json({ ok: true, slots: slots.length }, 200, cors);
  }

  if (action === "invite") {
    const slots = (Array.isArray(body.slots) ? body.slots : [])
      .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{1,2}:\d{2}$/.test(s.time))
      .slice(0, 6)
      .map((s) => ({ date: s.date, time: s.time }));

    if (!slots.length) return json({ error: "give it at least one time" }, 400, cors);

    const id = newTransferId();
    const invite = {
      id,
      name: String(body.name || "").trim().slice(0, 60),
      note: String(body.note || "").trim().slice(0, 300),
      minutes: Math.min(180, Math.max(10, Number(body.minutes) || 20)),
      slots,
      booked: null,
      at: new Date().toISOString()
    };

    await env.DELIVERIES.put(inviteKey(id), JSON.stringify(invite), {
      httpMetadata: { contentType: "application/json" }
    });
    return json({ ok: true, id }, 201, cors);
  }

  if (action === "uninvite") {
    const id = String(body.id || "");
    if (!TRANSFER_RE.test(id)) return json({ error: "unknown link" }, 400, cors);
    await env.DELIVERIES.delete(inviteKey(id));
    return json({ ok: true }, 200, cors);
  }

  if (action === "cancel") {
    const id = String(body.id || "");
    if (!/^[0-9-]{6,20}$/.test(id)) return json({ error: "unknown booking" }, 400, cors);

    // free the personal link too, or its slot is gone and it can never
    // be used again
    const gone = await env.DELIVERIES.get(bookingKey(id));
    if (gone) {
      try {
        const record = await gone.json();
        if (record.invite) {
          const invite = await readInviteRecord(env, record.invite);
          if (invite) {
            invite.booked = null;
            await env.DELIVERIES.put(inviteKey(record.invite), JSON.stringify(invite), {
              httpMetadata: { contentType: "application/json" }
            });
          }
        }
      } catch { /* the booking still goes */ }
    }

    await env.DELIVERIES.delete(bookingKey(id));
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "unknown action" }, 404, cors);
}

/* They get a confirmation with a calendar invitation, the same as a
   client whose shoot is confirmed. He gets a Telegram. */
async function confirmCall(env, record) {
  await telegram(env, [
    "<b>Call booked</b>",
    "",
    esc(record.name) + " &middot; " + esc(record.email),
    record.ref ? "Sent by a partner" : "",
    esc(prettyDate(record.date)) + " at " + esc(record.time),
    record.note ? "\n" + esc(record.note) : ""
  ].filter(Boolean).join("\n"));

  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return;

  const first = record.name.split(/\s+/)[0];
  const subject = "Booked: " + prettyDate(record.date) + " at " + record.time;

  const ics = buildIcs({
    slug: "call",
    date: record.date,
    time: record.time,
    location: "",
    focus: "A call with Noir au Noir",
    stamp: Date.now()
  });

  const html = mailHtml({
    headline: "We are on",
    lead: (first ? esc(first) + ", that" : "That") +
      " time is yours. The invitation is attached so it goes straight into your calendar.",
    detail: {
      label: "The call",
      big: prettyDate(record.date) + ", " + record.time,
      sub: record.minutes + " minutes"
    },
    quote: "",
    action: { text: "See the work", url: "https://clients.noiraunoir.com/demo/" },
    foot: "If something comes up, just reply to this and we will find another time."
  });

  const text = [subject, "", record.minutes + " minutes.", "",
    "Reply to this if you need to move it.", "Noir au Noir"].join("\n");

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [record.email],
        reply_to: REPLY_TO,
        subject, html, text,
        attachments: [{ filename: "call.ics", content: btoa(unescape(encodeURIComponent(ics))) }]
      })
    });
    if (!res.ok) console.log("call confirmation failed:", res.status, await res.text());
  } catch (err) {
    console.log("call confirmation error:", String(err));
  }
}

/* ============ SENDING FILES TO ANYONE ============ */
/* A transfer: make a link, put files behind it, send it to whoever.
   Not tied to a client and not tied to a portal. The difference from
   the services that do this is that the link is yours, it does not
   expire in seven days unless you say so, and you can kill it.

   Everything lives under _t/<id>/ in the same bucket. A client folder
   can never collide with it, because a client name has to start with a
   letter or a digit and this starts with an underscore. */

const TRANSFER_RE = /^[A-Za-z0-9_-]{10,24}$/;
const TRANSFER_PREFIX = "_t/";

const metaKey = (id) => TRANSFER_PREFIX + id + "/meta.json";
const transferFileKey = (id, name) => TRANSFER_PREFIX + id + "/files/" + name;

function newTransferId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readMeta(env, id) {
  const object = await env.DELIVERIES.get(metaKey(id));
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

function transferIsGone(meta) {
  if (!meta) return true;
  if (!meta.expires) return false;
  // an expiry is a date, so it dies at the end of that day
  return Date.now() > Date.parse(meta.expires + "T23:59:59Z");
}

/* Everything that changes a transfer, behind the studio key. */
async function handleTransfer(request, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const url = new URL(request.url);
  const action = url.pathname.slice("/transfer/".length);
  const key = request.headers.get("X-Studio-Key") || "";

  if (!key) return json({ error: "no key" }, 401, cors);
  if (!await mayWrite(env, key)) {
    return json({ error: "that key cannot write to this studio" }, 403, cors);
  }

  if (action === "new") {
    const id = newTransferId();
    const meta = {
      id,
      title: "",
      note: "",
      created: new Date().toISOString(),
      expires: ""
    };
    await env.DELIVERIES.put(metaKey(id), JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" }
    });
    return json({ ok: true, id }, 201, cors);
  }

  const id = String(url.searchParams.get("id") || "");
  if (!TRANSFER_RE.test(id)) return json({ error: "unknown link" }, 400, cors);

  if (action === "meta") {
    const meta = await readMeta(env, id);
    if (!meta) return json({ error: "unknown link" }, 404, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400, cors);
    }

    meta.title = String(body.title || "").slice(0, 80);
    meta.note = String(body.note || "").slice(0, 500);
    meta.expires = /^\d{4}-\d{2}-\d{2}$/.test(String(body.expires || "")) ? body.expires : "";

    await env.DELIVERIES.put(metaKey(id), JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" }
    });
    return json({ ok: true }, 200, cors);
  }

  if (action === "upload") {
    const meta = await readMeta(env, id);
    if (!meta) return json({ error: "unknown link" }, 404, cors);

    const name = safeName(url.searchParams.get("name"));
    if (!name) return json({ error: "that file name cannot be used" }, 400, cors);

    const size = Number(request.headers.get("Content-Length") || 0);
    if (size > MAX_UPLOAD) {
      return json({ error: "that file is over 95MB, which is more than one upload can carry." }, 413, cors);
    }

    await env.DELIVERIES.put(transferFileKey(id, name), request.body, {
      httpMetadata: { contentType: request.headers.get("X-File-Type") || "application/octet-stream" }
    });
    return json({ ok: true, name }, 201, cors);
  }

  /* Mails the link to whoever should have it. Same rule as every other
     route that writes to an address the caller supplies: the key was
     already checked above. */
  if (action === "send") {
    const meta = await readMeta(env, id);
    if (transferIsGone(meta)) return json({ error: "gone" }, 404, cors);
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
      return json({ error: "mail is not configured on this worker" }, 503, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400, cors);
    }

    const to = String(body.to || "").trim().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ error: "bad email" }, 400, cors);

    const listed = await env.DELIVERIES.list({ prefix: TRANSFER_PREFIX + id + "/files/", limit: 500 });
    if (!listed.objects.length) return json({ error: "there are no files behind that link yet" }, 400, cors);

    const sent = await mailTransfer(env, {
      to, id, meta,
      count: listed.objects.length,
      size: listed.objects.reduce((t, o) => t + o.size, 0)
    });
    if (!sent) return json({ error: "the mail service refused it" }, 502, cors);

    // remembered, so the dashboard can say who already has it
    meta.sent = (meta.sent || []).filter((s) => s.to !== to);
    meta.sent.push({ to, at: new Date().toISOString() });
    await env.DELIVERIES.put(metaKey(id), JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" }
    });

    return json({ ok: true }, 200, cors);
  }

  /* Killing a link really deletes the files. A transfer nobody can
     reach but that still costs storage is the worst of both. */
  if (action === "kill") {
    const listed = await env.DELIVERIES.list({ prefix: TRANSFER_PREFIX + id + "/", limit: 1000 });
    for (const object of listed.objects) await env.DELIVERIES.delete(object.key);
    return json({ ok: true, removed: listed.objects.length }, 200, cors);
  }

  if (action === "remove") {
    const name = safeName(url.searchParams.get("name"));
    if (!name) return json({ error: "unknown file" }, 400, cors);
    await env.DELIVERIES.delete(transferFileKey(id, name));
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "unknown action" }, 404, cors);
}

async function sweepExpiredTransfers(env) {
  if (!env.DELIVERIES) return;
  try {
    const listed = await env.DELIVERIES.list({ prefix: TRANSFER_PREFIX, limit: 1000 });
    const ids = [...new Set(listed.objects.map((o) => o.key.split("/")[1]))];

    let removed = 0;
    for (const id of ids) {
      const meta = await readMeta(env, id);
      if (!meta || !meta.expires || !transferIsGone(meta)) continue;
      for (const o of listed.objects.filter((x) => x.key.startsWith(TRANSFER_PREFIX + id + "/"))) {
        await env.DELIVERIES.delete(o.key);
        removed++;
      }
    }
    if (removed) console.log("swept " + removed + " expired transfer objects");
  } catch (err) {
    console.log("could not sweep transfers:", String(err));
  }
}

/* The mail that carries a link. Built from the same shell as every
   other studio mail, so a transfer looks like it came from the same
   place as everything else. */
async function mailTransfer(env, { to, id, meta, count, size }) {
  const link = "https://clients.noiraunoir.com/t/#" + id;
  const title = meta.title || "Files for you";
  const mb = size / (1024 * 1024);
  const readable = mb >= 1 ? mb.toFixed(1) + " MB" : Math.max(1, Math.round(size / 1024)) + " KB";

  const html = mailHtml({
    headline: title,
    lead: meta.note
      ? esc(meta.note)
      : "There are files waiting for you. The link below opens them, and it does not expire in a week.",
    detail: {
      label: "Waiting for you",
      big: count + (count === 1 ? " file" : " files"),
      sub: readable
    },
    quote: "",
    action: { text: count === 1 ? "Open the file" : "Open the files", url: link },
    foot: meta.expires
      ? "This link works until " + esc(meta.expires) + "."
      : "The link stays open. Ask any time if you need it again."
  });

  const text = [
    title, "",
    meta.note || "There are files waiting for you.",
    count + (count === 1 ? " file" : " files") + ", " + readable, "",
    link, "",
    meta.expires ? "This link works until " + meta.expires + "." : "",
    "Noir au Noir"
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: title,
        html,
        text
      })
    });
    if (!res.ok) console.log("transfer mail failed:", res.status, await res.text());
    else console.log("transfer mail sent for " + id);
    return res.ok;
  } catch (err) {
    console.log("transfer mail error:", String(err));
    return false;
  }
}

/* Notes that a file was actually fetched, so "did they get it" stops
   being a question you have to ask them.

   Counted when the file starts being sent, not when it finishes, since
   nothing tells us about the finish. A cancelled download still counts,
   which is the honest limit of doing this without a tracker. */
async function noteDownload(env, id, name) {
  try {
    const meta = await readMeta(env, id);
    if (!meta) return;

    if (!meta.downloads || typeof meta.downloads !== "object") meta.downloads = {};
    const before = meta.downloads[name] || { count: 0, last: "" };
    meta.downloads[name] = { count: before.count + 1, last: new Date().toISOString() };

    await env.DELIVERIES.put(metaKey(id), JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" }
    });
  } catch (err) {
    console.log("could not note a download:", String(err));
  }
}

/* What the person holding the link sees. No key, by design: the link
   is the permission. */
async function readTransfer(url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const id = String(url.searchParams.get("id") || "");
  if (!TRANSFER_RE.test(id)) return json({ error: "gone" }, 404, cors);

  const meta = await readMeta(env, id);
  // a killed link and a link that never existed answer identically, so
  // nothing can be learned by trying
  if (transferIsGone(meta)) return json({ error: "gone" }, 404, cors);

  const listed = await env.DELIVERIES.list({ prefix: TRANSFER_PREFIX + id + "/files/", limit: 500 });
  const taken = meta.downloads || {};
  const files = listed.objects.map((o) => {
    const name = o.key.split("/").pop();
    return { name, size: o.size, downloaded: !!taken[name] };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return json({
    title: meta.title || "",
    note: meta.note || "",
    expires: meta.expires || "",
    files
  }, 200, cors);
}

async function serveTransferFile(url, env, ctx) {
  if (!env.DELIVERIES) return new Response("storage is not connected", { status: 503 });

  const id = String(url.searchParams.get("id") || "");
  const name = safeName(url.searchParams.get("name"));
  if (!TRANSFER_RE.test(id) || !name) return new Response("gone", { status: 404 });

  // the expiry is checked on every file, not only on the page, or a
  // saved direct link would outlive the transfer
  if (transferIsGone(await readMeta(env, id))) return new Response("gone", { status: 404 });

  const object = await env.DELIVERIES.get(transferFileKey(id, name));
  if (!object) return new Response("not found", { status: 404 });

  // noted after the reply is on its way, so nobody waits on bookkeeping
  if (ctx) ctx.waitUntil(noteDownload(env, id, name));

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Disposition", 'attachment; filename="' + name.replace(/"/g, "") + '"');
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(object.body, { headers });
}

/* The list for the dashboard, so old links can be found and killed. */
async function listTransfers(request, url, env, cors) {
  if (!env.DELIVERIES) return json({ error: "storage is not connected" }, 503, cors);

  const key = url.searchParams.get("key") || request.headers.get("X-Studio-Key") || "";
  if (!await mayWrite(env, key)) return json({ error: "no" }, 403, cors);

  const listed = await env.DELIVERIES.list({ prefix: TRANSFER_PREFIX, limit: 1000 });
  const ids = [...new Set(listed.objects.map((o) => o.key.split("/")[1]))];

  const transfers = [];
  for (const id of ids) {
    const meta = await readMeta(env, id);
    if (!meta) continue;
    const files = listed.objects.filter((o) => o.key.startsWith(TRANSFER_PREFIX + id + "/files/"));
    const taken = meta.downloads || {};
    const names = files.map((o) => o.key.split("/").pop());
    const got = names.filter((n) => taken[n]);
    const last = got.map((n) => taken[n].last).sort().pop() || "";

    transfers.push({
      id,
      title: meta.title || "",
      created: meta.created || "",
      expires: meta.expires || "",
      expired: transferIsGone(meta),
      files: files.length,
      size: files.reduce((t, o) => t + o.size, 0),
      downloaded: got.length,
      lastDownload: last,
      sent: meta.sent || []
    });
  }

  transfers.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return json({ transfers }, 200, cors);
}

/* ============ THE SHOOT, IN THEIR CALENDAR ============ */
/* A date on a webpage is a date people forget. A calendar entry is not.
   When a picked date is confirmed, the client gets one.

   The whole thing turns on the time being right, and a shoot at 19:00
   in Gent is 17:00 UTC in summer and 18:00 in winter. Getting that
   wrong puts a client at a shoot an hour early once a year, so the
   conversion is done properly against the real zone rather than by
   assuming an offset. */

const SHOOT_TZ = "Europe/Brussels";
const SHOOT_HOURS = 3;

function zoneOffsetMinutes(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(ts));

  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return (asIfUtc - ts) / 60000;
}

/* Wall clock time in a zone to a real instant. Two passes, because the
   offset depends on the instant you are trying to find. */
function zonedToUtc(date, time, tz) {
  const [y, m, d] = String(date).split("-").map(Number);
  const [hh, mm] = String(time || "09:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let ts = wall - zoneOffsetMinutes(wall, tz) * 60000;
  ts = wall - zoneOffsetMinutes(ts, tz) * 60000;
  return ts;
}

function icsStamp(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/* Folded at 75 octets, because strict calendar clients reject longer
   lines outright and Outlook is one of them. */
function icsFold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(out.length ? " " + rest.slice(0, 72) : rest.slice(0, 73));
    rest = rest.slice(out.length === 1 ? 73 : 72);
  }
  out.push(out.length ? " " + rest : rest);
  return out.join("\r\n");
}

function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
    .replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function buildIcs({ slug, date, time, location, focus, stamp }) {
  const start = zonedToUtc(date, time, SHOOT_TZ);
  const end = start + SHOOT_HOURS * 3600000;

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Noir au Noir//Shoot//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:shoot-" + slug + "-" + String(date).replace(/-/g, "") + "@noiraunoir.com",
    "DTSTAMP:" + icsStamp(stamp),
    "DTSTART:" + icsStamp(start),
    "DTEND:" + icsStamp(end),
    icsFold("SUMMARY:" + icsEscape("Shoot with Noir au Noir")),
    location ? icsFold("LOCATION:" + icsEscape(location)) : "",
    focus ? icsFold("DESCRIPTION:" + icsEscape(focus)) : "",
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");
}

/* Same rule as the welcome: this mails an address the caller supplies,
   so the caller proves themselves first. */
async function sendShootInvite(request, env, cors) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, cors);
  }

  const client = String(data.client || "").toLowerCase();
  const to = String(data.email || "").trim().slice(0, 120);
  const who = String(data.name || "").trim().slice(0, 60);
  const date = String(data.date || "");

  if (!data.key) return json({ error: "no key" }, 401, cors);
  if (!CLIENT_RE.test(client)) return json({ error: "unknown client" }, 400, cors);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ error: "bad email" }, 400, cors);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad date" }, 400, cors);
  if (!await mayWrite(env, String(data.key))) {
    return json({ error: "that key cannot write to this studio" }, 403, cors);
  }

  const plan = await readJson(env, CLIENTS_REPO, `data/${client}.json`);
  if (!plan) return json({ error: "no portal by that name" }, 404, cors);
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return json({ error: "mail is not configured on this worker" }, 503, cors);
  }

  const ok = await mailShootInvite(env, {
    to, who, client, plan, date,
    time: String(data.time || ""),
    location: String(data.location || ""),
    focus: String(data.focus || "")
  });

  return ok ? json({ ok: true }, 200, cors) : json({ error: "the mail service refused it" }, 502, cors);
}

async function mailShootInvite(env, { to, who, client, plan, date, time, location, focus }) {
  const first = who.split(/\s+/)[0];
  const pretty = prettyDate(date);
  const subject = "Confirmed: " + pretty + (time ? " at " + time : "");

  const ics = buildIcs({ slug: client, date, time, location, focus, stamp: Date.now() });

  const html = mailHtml({
    headline: "Your shoot is confirmed",
    lead: (first ? esc(first) + ", that" : "That") + " is the date locked in. " +
      "The invitation is attached, so it goes straight into your calendar.",
    detail: {
      label: "The day",
      big: pretty + (time ? ", " + time : ""),
      sub: [location, focus].filter(Boolean).join(" &middot; ")
    },
    quote: "",
    action: { text: "See it in your portal", url: "https://clients.noiraunoir.com/" + client + "/" },
    foot: "Anything you need to have ready is listed in your portal."
  });

  const text = [subject, "", location, focus, "",
    "https://clients.noiraunoir.com/" + client + "/"].filter(Boolean).join("\n");

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        html,
        text,
        attachments: [{
          filename: "shoot.ics",
          content: btoa(unescape(encodeURIComponent(ics)))
        }]
      })
    });
    if (!res.ok) console.log("shoot invite failed:", res.status, await res.text());
    else console.log("shoot invite sent for " + client);
    return res.ok;
  } catch (err) {
    console.log("shoot invite error:", String(err));
    return false;
  }
}

/* ============ WHO OPENED A PROPOSAL ============ */
/* Silence after sending a proposal is ambiguous. Opened three times
   and gone quiet is a follow up. Never opened is a different problem,
   probably that it went to a spam folder. Without this you cannot tell
   them apart, so you either chase too early or not at all.

   Counts live in one issue per proposal, labelled "seen", so this needs
   no new storage and no new token. */

async function recordSeen(request, env, ctx, cors) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, cors);
  }

  const slug = String(data.client || "");
  if (!CLIENT_RE.test(slug)) return json({ error: "unknown proposal" }, 400, cors);

  /* Who and where, read off the request itself. Cloudflare hands these
     over with no extra service and no tracker on the page.

     None of it is written into the issue. That repo is public, and a
     client's address and device are theirs, not something to publish.
     It goes to Telegram, which only he reads. */
  const cf = request.cf || {};
  const who = {
    ip: request.headers.get("CF-Connecting-IP") || "",
    device: describeDevice(request.headers.get("User-Agent") || ""),
    place: [cf.city, cf.postalCode, cf.region, cf.country].filter(Boolean).join(", "),
    network: [cf.asOrganization, cf.asn ? "AS" + cf.asn : ""].filter(Boolean).join(" "),
    timezone: cf.timezone || "",
    // IP derived, so this is the area the address belongs to and not
    // where the person is standing. Precise location needs the browser
    // to ask them, and they have to press Allow.
    coords: (cf.latitude && cf.longitude) ? cf.latitude + "," + cf.longitude : ""
  };

  ctx.waitUntil(countView(env, slug, who));
  return json({ ok: true }, 202, cors);
}

/* Enough to tell a phone from a laptop and one reader from another,
   from the user agent alone. */
function describeDevice(ua) {
  const os = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";

  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "";

  return [os, browser].filter(Boolean).join(", ") || "unknown device";
}

async function countView(env, slug, who) {
  const repo = CLIENTS_REPO;
  const headers = {
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "mc-kresha-idea-box",
    "Content-Type": "application/json"
  };

  // a proposal that does not exist is not worth a record
  const proposal = await readProposal(env, repo, slug);
  if (!proposal) return;
  const brand = String(proposal.client || slug).trim();

  try {
    const labels = encodeURIComponent("seen,proposal:" + slug);
    const found = await fetch(
      `https://api.github.com/repos/${repo}/issues?labels=${labels}&state=all&per_page=1`,
      { headers }
    );
    const existing = found.ok ? (await found.json())[0] : null;

    const now = new Date().toISOString();
    const before = existing ? (existing.body || "").match(/Opened (\d+) time/) : null;
    const count = (before ? Number(before[1]) : 0) + 1;

    // the issue records how often and when, and nothing about who
    const body = "Opened " + count + " time" + (count === 1 ? "" : "s") + ".\nLast on " + now;

    if (existing) {
      await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}`, {
        method: "PATCH", headers, body: JSON.stringify({ body })
      });
    } else {
      await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST", headers,
        body: JSON.stringify({ title: "Seen: " + brand, body, labels: ["seen", "proposal:" + slug] })
      });
    }

    // every single open, as asked
    const w = who || {};
    await telegram(env, [
      "<b>" + esc(brand) + " opened the proposal</b>",
      "",
      count === 1 ? "First time." : "That is " + count + " times now.",
      w.device ? esc(w.device) : "",
      w.place ? esc(w.place) : "",
      w.network ? esc(w.network) : "",
      w.timezone ? esc(w.timezone) : "",
      w.ip ? "IP " + esc(w.ip) : "",
      w.coords ? "Roughly https://www.google.com/maps?q=" + esc(w.coords) : "",
      "",
      "https://clients.noiraunoir.com/p/" + slug + "/"
    ].filter((l) => l !== "").join("\n"));
  } catch (err) {
    console.log("could not record a view:", String(err));
  }
}

/* ============ WELCOME A NEW PORTAL ============ */
/* Every other route here either writes to a repo the worker owns or
   mails an address the worker already knows. This one mails an address
   the caller supplies, which is the definition of an open relay unless
   the caller proves themselves. So it does: the dashboard passes the
   admin key and it is checked against GitHub for write access to the
   clients repo before anything is sent. The key is used for that one
   call and never stored or logged. */

const CLIENTS_REPO = "vollerodaniele-rgb/clients";

/* Does this key belong to somebody who runs this studio. Asked of
   GitHub, not taken on trust, and the key is used for this one call
   and never stored or logged. Every route that mails an address the
   caller supplies goes through here first. */
async function mayWrite(env, key) {
  if (!key) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${CLIENTS_REPO}`, {
      headers: {
        "Authorization": "Bearer " + key,
        "Accept": "application/vnd.github+json",
        "User-Agent": "mc-kresha-idea-box"
      }
    });
    return res.ok && !!(await res.json()).permissions?.push;
  } catch (err) {
    console.log("could not check the key:", String(err));
    return false;
  }
}

async function sendWelcome(request, env, cors) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, cors);
  }

  const key = String(data.key || "");
  const client = String(data.client || "").toLowerCase();
  const to = String(data.email || "").trim().slice(0, 120);
  const who = String(data.name || "").trim().slice(0, 60);

  if (!key) return json({ error: "no key" }, 401, cors);
  if (!CLIENT_RE.test(client)) return json({ error: "unknown client" }, 400, cors);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ error: "bad email" }, 400, cors);

  if (!await mayWrite(env, key)) {
    return json({ error: "that key cannot write to this studio" }, 403, cors);
  }

  // and the portal has to exist, so a typo cannot mail a stranger
  const plan = await readJson(env, CLIENTS_REPO, `data/${client}.json`);
  if (!plan) return json({ error: "no portal by that name" }, 404, cors);

  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return json({ error: "mail is not configured on this worker" }, 503, cors);
  }

  const ok = await mailWelcome(env, { to, who, client, plan });
  return ok
    ? json({ ok: true }, 200, cors)
    : json({ error: "the mail service refused it" }, 502, cors);
}

async function mailWelcome(env, { to, who, client, plan }) {
  const brand = String(plan.name || client).trim();
  const url = "https://clients.noiraunoir.com/" + client + "/";
  const first = who.split(/\s+/)[0];
  const isProject = plan.kind === "project";

  const subject = "Your portal is ready";

  const html = welcomeMailHtml({
    greeting: first ? "Welcome, " + first + "." : "Welcome.",
    line: "Everything about our work together lives in one place now, and it stays up to date as we go.",
    brand,
    url,
    points: isProject
      ? [
          ["Where we are", "How far the work has got, and the date it lands."],
          ["The shoot day", "Time, place, and what we are filming."],
          ["Everything else", "What you are getting, the files when they are ready, and billing."]
        ]
      : [
          ["The plan", "What we film this month and when the shoot is."],
          ["The posting plan", "What goes out, and on which day."],
          ["Everything else", "Deliveries, documents and billing, all in one page."]
        ],
    closing: "There is a box at the bottom of the page for anything you want us to film. It reaches us straight away."
  });

  const text = [
    subject, "",
    (first ? "Welcome, " + first + "." : "Welcome."),
    "Everything about our work together lives in one place now:",
    url, "",
    "Noir au Noir", REPLY_TO
  ].join("\n");

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], reply_to: REPLY_TO, subject, html, text })
    });
    if (!res.ok) console.log("welcome mail failed:", res.status, await res.text());
    else console.log("welcome mail sent for " + client);
    return res.ok;
  } catch (err) {
    console.log("welcome mail error:", String(err));
    return false;
  }
}

function welcomeMailHtml({ greeting, line, brand, url, points, closing }) {
  const cell = "font-family:Arial,Helvetica,sans-serif;";
  const rows = points.map(([t, d]) => `
    <tr>
      <td valign="top" style="padding:0 0 16px 0;${cell}font-size:14px;line-height:1.6;color:#ffffff;">
        <strong style="color:#ffffff;">${esc(t)}</strong><br>
        <span style="color:#9a9a9a;">${esc(d)}</span>
      </td>
    </tr>`).join("");

  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#000000;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background-color:#000000;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;border-collapse:collapse;background-color:#000000;">
  <tr><td style="padding:28px 36px 0 36px;${cell}font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:#9a9a9a;">Noir au Noir</td></tr>
  <tr><td style="padding:24px 36px 0 36px;font-family:Georgia,'Times New Roman',serif;font-size:31px;line-height:1.12;color:#ffffff;">${esc(greeting)}</td></tr>
  <tr><td style="padding:16px 36px 0 36px;${cell}font-size:15px;line-height:1.65;color:#ffffff;">${esc(line)}</td></tr>
  <tr><td style="padding:28px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #333333;">
      <tr><td style="padding:20px 24px 6px 24px;${cell}font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#5e5e5e;">Your portal</td></tr>
      <tr><td style="padding:0 24px 18px 24px;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#ffffff;">${esc(brand)}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr><td style="background-color:#ffffff;border-radius:999px;">
        <a href="${esc(url)}" style="display:inline-block;padding:13px 30px;${cell}font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#000000;text-decoration:none;">Open your portal</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:14px 36px 0 36px;${cell}font-size:12px;color:#5e5e5e;">${esc(url)}</td></tr>
  <tr><td style="padding:32px 36px 0 36px;${cell}font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#5e5e5e;">What is in there</td></tr>
  <tr><td style="padding:16px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">${rows}</table>
  </td></tr>
  <tr><td style="padding:14px 36px 0 36px;${cell}font-size:15px;line-height:1.65;color:#ffffff;">${esc(closing)}</td></tr>
  <tr><td style="padding:30px 36px 32px 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border-top:1px solid #222222;">
      <tr><td style="padding:18px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#ffffff;">Noir au Noir</td></tr>
      <tr><td style="padding:4px 0 0 0;${cell}font-size:12px;line-height:1.7;color:#5e5e5e;">${STUDIO_LINE}<br><a href="mailto:${REPLY_TO}" style="color:#9a9a9a;text-decoration:underline;">${REPLY_TO}</a></td></tr>
    </table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/* Reads any JSON file out of a repo. */
async function readJson(env, repo, path) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/${path}`, {
      headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN },
      cf: { cacheTtl: 30, cacheEverything: true }
    });
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.log("could not read " + path + ":", String(err));
    return null;
  }
}

/* Reads the proposal itself. Used for the brand in a subject line, and
   as the guard on client mail: no proposal, no mail to anybody. */
async function readProposal(env, repo, slug) {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${repo}/main/proposals/${encodeURIComponent(slug)}.json`,
      { headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN }, cf: { cacheTtl: 60, cacheEverything: true } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.log("could not read the proposal:", String(err));
    return null;
  }
}

/* The confirmation the client gets back. Every word of it is written
   here. Nothing they typed is quoted into it, because a mail leaving
   your own domain carrying a stranger's text is how a domain gets
   burned, and the form is reachable by anyone holding the link. */
async function emailClient(env, { proposal, to, name, chosen }) {
  // the shared Resend sender only reaches your own address, so client
  // mail waits until a verified domain of your own is configured
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log("client mail skipped: needs RESEND_API_KEY and a MAIL_FROM on a verified domain");
    return false;
  }
  if (!proposal) {
    console.log("client mail skipped: no such proposal");
    return false;
  }

  const brand = String(proposal.client || "").trim();
  const pack = (proposal.packages || []).find((p) => p.name === chosen) || {};
  const steps = (proposal.process && proposal.process.steps || []).slice(0, 3);
  const first = String(name || "").trim().split(/\s+/)[0];

  const subject = "We have your choice of " + (chosen || "the package");

  const html = clientMailHtml({
    greeting: first ? "Thank you, " + first + "." : "Thank you.",
    line: "We have your choice of <strong style=\"color:#ffffff;\">" + esc(chosen || "the package") +
      "</strong>" + (brand ? " for " + esc(brand) : "") + ". Nothing else is needed from you today.",
    pack: {
      name: chosen || "",
      tag: pack.tag || "",
      price: pack.price || "",
      per: pack.per || ""
    },
    steps,
    closing: "We will be in touch shortly to fix the first date. Reply to this message any time."
  });

  const text = [
    subject,
    "",
    (first ? "Thank you, " + first + "." : "Thank you."),
    "We have your choice of " + (chosen || "the package") + (brand ? " for " + brand : "") + ".",
    "",
    ...steps.map((s, i) => (i + 1) + ". " + (s.title || "") + " " + (s.text || "")),
    "",
    "Noir au Noir",
    REPLY_TO
  ].join("\n");

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        html,
        text
      })
    });
    if (!res.ok) console.log("client mail failed:", res.status, await res.text());
    else console.log("client mail sent");
    return res.ok;
  } catch (err) {
    console.log("client mail error:", String(err));
    return false;
  }
}

function clientMailHtml({ greeting, line, pack, steps, closing }) {
  const cell = "font-family:Arial,Helvetica,sans-serif;";
  const stepRows = steps.map((s, i) => `
    <tr>
      <td width="34" valign="top" style="width:34px;padding:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#5e5e5e;">${String(i + 1).padStart(2, "0")}</td>
      <td valign="top" style="padding:0 0 18px 0;${cell}font-size:14px;line-height:1.6;color:#ffffff;">
        <strong style="color:#ffffff;">${esc(s.title || "")}</strong><br>
        <span style="color:#9a9a9a;">${esc(s.text || "")}</span>
      </td>
    </tr>`).join("");

  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#000000;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background-color:#000000;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;border-collapse:collapse;background-color:#000000;">
  <tr><td style="padding:28px 36px 0 36px;${cell}font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:#9a9a9a;">Noir au Noir</td></tr>
  <tr><td style="padding:24px 36px 0 36px;font-family:Georgia,'Times New Roman',serif;font-size:31px;line-height:1.12;color:#ffffff;">${esc(greeting)}</td></tr>
  <tr><td style="padding:16px 36px 0 36px;${cell}font-size:15px;line-height:1.65;color:#ffffff;">${line}</td></tr>
  ${pack.name ? `<tr><td style="padding:28px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #333333;">
      <tr><td style="padding:22px 24px 6px 24px;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#ffffff;">${esc(pack.name)}</td></tr>
      ${pack.tag ? `<tr><td style="padding:0 24px 4px 24px;${cell}font-size:14px;line-height:1.6;color:#9a9a9a;">${esc(pack.tag)}</td></tr>` : ""}
      ${pack.price ? `<tr><td style="padding:12px 24px 22px 24px;${cell}font-size:14px;color:#ffffff;">${esc(pack.price)} <span style="color:#9a9a9a;">${esc(pack.per || "")}</span></td></tr>` : ""}
    </table>
  </td></tr>` : ""}
  ${stepRows ? `<tr><td style="padding:34px 36px 0 36px;${cell}font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#5e5e5e;">What happens next</td></tr>
  <tr><td style="padding:16px 36px 0 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">${stepRows}</table>
  </td></tr>` : ""}
  <tr><td style="padding:24px 36px 0 36px;${cell}font-size:15px;line-height:1.65;color:#ffffff;">${esc(closing)}</td></tr>
  <tr><td style="padding:30px 36px 32px 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border-top:1px solid #222222;">
      <tr><td style="padding:18px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#ffffff;">Noir au Noir</td></tr>
      <tr><td style="padding:4px 0 0 0;${cell}font-size:12px;line-height:1.7;color:#5e5e5e;">${STUDIO_LINE}<br><a href="mailto:${REPLY_TO}" style="color:#9a9a9a;text-decoration:underline;">${REPLY_TO}</a></td></tr>
    </table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
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
      // a sending only key is allowed to send but not to read domains,
      // so a refusal here is not evidence of anything and must never
      // become a weekly false alarm
      if (res.status === 401 || res.status === 403) {
        notes.push("Mail key present, not checkable (a sending only key cannot be read).");
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

/* Says which mail settings this worker can actually see, and whether
   Resend accepts the key. It reports presence and never a value, so
   opening it gives nothing away. The commonest cause of silence is a
   name typed slightly differently, or a secret added to the wrong
   worker, and neither is visible from the outside without this. */
async function mailSetup(env, cors) {
  const raw = String(env.RESEND_API_KEY || "");
  const key = raw.trim();

  const seen = {
    RESEND_API_KEY: !!env.RESEND_API_KEY,
    MAIL_TO: !!env.MAIL_TO,
    MAIL_FROM: env.MAIL_FROM ? "set" : "not set, using the shared sender"
  };

  // the shape only, never the value: enough to tell a truncated paste
  // from a stray space from something that is not a Resend key at all
  const shape = {
    startsWithRe: key.startsWith("re_"),
    plausibleLength: key.length >= 25 && key.length <= 60,
    hadSpaceOrNewline: raw !== key,
    looksLikeAnEmail: key.includes("@")
  };

  if (!env.RESEND_API_KEY || !env.MAIL_TO) {
    return json({
      sending: false,
      seen,
      shape,
      step: "Add the missing one as a variable on this worker, spelled exactly as above, then deploy."
    }, 200, cors);
  }

  let verdict = "unknown";
  let domains = [];
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { "Authorization": "Bearer " + key }
    });
    // Resend has two kinds of key. A sending only key can post mail but
    // is not allowed to read domains, so a refusal on this call says
    // nothing about whether mail works.
    verdict = res.ok ? "accepted"
      : (res.status === 401 || res.status === 403)
        ? "cannot be read, which is normal for a sending only key"
        : "refused (" + res.status + ")";
    if (res.ok) {
      const body = await res.json();
      domains = (body.data || []).map((d) => d.name + ": " + d.status);
    }
  } catch (err) {
    verdict = "could not reach Resend";
  }

  // settings present and the key well formed is as far as a check can
  // get without actually sending. The proof is a real submission.
  const armed = shape.startsWithRe && shape.plausibleLength && !!env.MAIL_TO;

  return json({
    sending: armed,
    seen,
    key: verdict,
    shape,
    verifiedDomains: domains,
    note: domains.length
      ? "Mail can go to anyone at a verified domain."
      : "No domain verified, so Resend will only deliver to the address the account was opened with."
  }, 200, cors);
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
