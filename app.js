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
    // read through the relay: it is authenticated, so visitors never
    // run into GitHub's limit for anonymous requests
    const res = await fetch(`${CONFIG.submitUrl}/ideas?site=${encodeURIComponent(CONFIG.site)}`, {
      cache: "no-store"
    });
    if (!res.ok) throw new Error("relay " + res.status);
    const { ideas } = await res.json();

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

function card({ text, author, image, audio }) {
  const el = document.createElement("article");
  el.className = "idea-card";
  el.innerHTML = `
    ${image ? `<img class="idea-image" src="${esc(image)}" alt="" loading="lazy">` : ""}
    ${text ? `<p class="idea-body">${esc(text.slice(0, 300))}</p>` : ""}
    ${audio ? `<audio class="idea-audio" controls preload="none" src="${esc(audio)}"></audio>` : ""}
    <div class="idea-meta"><span>by ${esc(author)}</span></div>
  `;
  return el;
}

/* ============ FORM ============ */

function setupForm() {
  const form = $("idea-form");
  form.hidden = false;
  setupPicker();
  setupRecorder();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("form-msg");
    const btn = $("idea-submit");
    const idea = $("idea-text").value.trim();
    const name = $("idea-name").value.trim();

    // a voice message alone is a complete idea
    if (idea.length < 10 && !pendingAudio) {
      msg.textContent = "Give it a few more words, or record a voice message.";
      return;
    }

    btn.disabled = true;
    msg.textContent = (pendingImage || pendingAudio) ? "Sending..." : "Sending...";

    try {
      const payload = { site: CONFIG.site, idea, name, website: $("idea-website").value };
      if (pendingImage) payload.image = { type: "image/jpeg", data: pendingImage };
      if (pendingAudio) payload.audio = { type: pendingAudio.type, data: pendingAudio.data };

      const res = await fetch(CONFIG.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("relay " + res.status);

      msg.textContent = "Got it! Your idea is on the wall.";
      const shownImage = pendingImage ? "data:image/jpeg;base64," + pendingImage : "";
      const shownAudio = pendingAudio ? `data:${pendingAudio.type};base64,${pendingAudio.data}` : "";
      form.reset();
      clearPicture();
      clearRecording();

      const status = $("idea-status");
      if (status) status.remove();
      $("idea-grid").prepend(card({
        text: idea, author: name || "anonymous", image: shownImage, audio: shownAudio
      }));
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

/* ============ VOICE MESSAGE ============ */

// {type, data} of the recording waiting to be sent
let pendingAudio = null;
let recorder = null;
let recTimer = null;
const MAX_SECONDS = 60;

function setupRecorder() {
  // only offer it where the browser can actually record
  const canRecord = typeof MediaRecorder !== "undefined" &&
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!canRecord) return;

  $("voice-field").hidden = false;
  $("rec-start").addEventListener("click", startRecording);
  $("rec-stop").addEventListener("click", stopRecording);
  $("rec-clear").addEventListener("click", () => {
    clearRecording();
    $("form-msg").textContent = "";
  });
}

/* iPhones record through a "phone call" audio path that throws away
   everything above roughly 4 kHz, which is why voice notes came out
   muffled no matter how high the bitrate went. That path stays active
   while ANY of these three processing features is on, so all three have
   to be off to get the full range microphone. */
async function openMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } catch (err) {
    // some devices refuse to hand over an unprocessed microphone
    if (err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw err;
  }
}

function pickAudioType() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startRecording() {
  const msg = $("form-msg");
  try {
    const stream = await openMicrophone();

    const mimeType = pickAudioType();
    // AAC (what iPhones produce) needs a lot more room than Opus to sound
    // decent. Even the high end here fits a minute inside the upload cap.
    const bitrate = mimeType.includes("mp4") || mimeType.includes("aac") ? 128000 : 64000;
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: bitrate } : undefined);

    const chunks = [];
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) chunks.push(e.data);
    });

    recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      $("rec-start").hidden = false;
      $("rec-stop").hidden = true;

      const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : "audio/webm" });
      // the browser tags it with codec details the relay does not need
      const type = blob.type.split(";")[0];
      const data = await blobToBase64(blob);

      if (data.length > 2900000) {
        clearRecording();
        $("form-msg").textContent = "That recording is too long to send. Try a shorter one.";
        return;
      }

      pendingAudio = { type, data };
      $("rec-preview").src = URL.createObjectURL(blob);
      $("rec-preview").hidden = false;
      $("rec-clear").hidden = false;
      $("rec-status").textContent = "Recorded " + formatTime(recordedSeconds);
    });

    recorder.start();
    recordedSeconds = 0;
    $("rec-start").hidden = true;
    $("rec-stop").hidden = false;
    $("rec-preview").hidden = true;
    $("rec-status").textContent = "Recording 0:00";
    msg.textContent = "";

    recTimer = setInterval(() => {
      recordedSeconds++;
      $("rec-status").textContent = "Recording " + formatTime(recordedSeconds);
      if (recordedSeconds >= MAX_SECONDS) stopRecording();
    }, 1000);
  } catch (err) {
    console.error("recording failed:", err);
    msg.textContent = err && err.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow it in your browser to record."
      : "Could not start recording on this device.";
  }
}

let recordedSeconds = 0;

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function clearRecording() {
  pendingAudio = null;
  clearInterval(recTimer);
  const preview = $("rec-preview");
  if (preview.src.startsWith("blob:")) URL.revokeObjectURL(preview.src);
  preview.hidden = true;
  preview.removeAttribute("src");
  $("rec-clear").hidden = true;
  $("rec-start").hidden = false;
  $("rec-stop").hidden = true;
  $("rec-status").textContent = "Nothing recorded";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function formatTime(s) {
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/* ============ HELPERS ============ */

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

