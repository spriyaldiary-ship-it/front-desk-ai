// Front Desk browser client. Holds no API keys: it sends its SDP offer to our server,
// which creates the GPT-Live session and runs all booking tools.
const $ = (id) => document.getElementById(id);
const ui = {
  start: $("start"), end: $("end"), mute: $("mute"), status: $("status"), pill: $("state-pill"),
  timer: $("timer"), micHelp: $("mic-help"), transcript: $("transcript"), activity: $("activity"),
  audio: $("remote-audio"), service: $("service"), days: $("days"), slots: $("slots"),
  holds: $("holds"), bookings: $("bookings"), reset: $("reset"),
};
ui.transcript.dataset.empty = "Your conversation will appear here.";
ui.activity.dataset.empty = "Availability checks, holds and bookings will appear here.";
ui.holds.dataset.empty = "No slot on hold.";
ui.bookings.dataset.empty = "No bookings yet — make one by voice.";

let config = null;
let state = { holds: [], bookings: [] };
let grid = null;
let selectedDay = null;
let offered = new Set(); // "YYYY-MM-DD|HH:MM" from the latest availability check

// ---------------- calendar UI ----------------
async function loadConfig() {
  config = await (await fetch("/api/config")).json();
  const b = config.business;
  $("biz-name").textContent = b.name;
  $("biz-meta").textContent = `${b.address} · Today is ${b.today_label} · ${b.timezone}`;
  ui.service.innerHTML = b.services
    .map((s) => `<option value="${s.id}">${s.name} · ${s.minutes} min · ${s.price}</option>`)
    .join("");
  if (!config.hasApiKey) {
    setStatus("Server has no OPENAI_API_KEY yet — you can browse the demo calendar, but calls are disabled.");
    ui.start.disabled = true;
  }
}

async function refreshCalendar() {
  const [g, s] = await Promise.all([
    fetch(`/api/availability?service=${encodeURIComponent(ui.service.value)}`).then((r) => r.json()),
    fetch("/api/state").then((r) => r.json()),
  ]);
  grid = g;
  state = s;
  if (!selectedDay || !grid.days.some((d) => d.date === selectedDay)) selectedDay = grid.days[0]?.date;
  renderGrid();
  renderLists();
}

function renderGrid() {
  ui.days.innerHTML = "";
  for (const d of grid.days) {
    const [weekday, rest] = d.day.split(", ");
    const btn = document.createElement("button");
    btn.className = "day";
    btn.role = "tab";
    btn.setAttribute("aria-selected", String(d.date === selectedDay));
    btn.innerHTML = `${weekday.slice(0, 3)} ${rest}<small>${d.slots.length} open</small>`;
    btn.onclick = () => { selectedDay = d.date; renderGrid(); };
    ui.days.append(btn);
  }
  const day = grid.days.find((d) => d.date === selectedDay);
  const heldHere = new Set(
    state.holds.filter((h) => h.date === selectedDay && h.service === grid.service.name).map((h) => h.start_time),
  );
  ui.slots.innerHTML = "";
  const times = new Map((day?.slots ?? []).map((s) => [s.start_time, s]));
  for (const t of heldHere) if (!times.has(t)) times.set(t, { start_time: t, label: to12(t), staff: [] });
  if (!times.size) {
    ui.slots.innerHTML = `<span class="muted">No open ${grid.service.name.toLowerCase()} times this day.</span>`;
    return;
  }
  for (const s of [...times.values()].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (offered.has(`${selectedDay}|${s.start_time}`)) chip.classList.add("offered");
    if (heldHere.has(s.start_time)) chip.classList.add("held");
    chip.textContent = s.label;
    chip.title = s.staff.length ? `Available with ${s.staff.map((x) => x.name).join(", ")}` : "On hold";
    ui.slots.append(chip);
  }
}

function renderLists() {
  ui.holds.innerHTML = state.holds
    .map(
      (h) => `<div class="item hold"><div class="row"><strong>${esc(h.service)} with ${esc(h.staff)}</strong><span class="id">${h.hold_id}</span></div>
      <div>${esc(h.day)} · ${h.time_label}</div><div class="muted">For ${esc(h.customer_name)} · awaiting spoken “yes” · expires in ${Math.ceil(h.expires_in_seconds / 60)} min</div></div>`,
    )
    .join("");
  ui.bookings.innerHTML = state.bookings
    .map(
      (b) => `<div class="item ${b.status}"><div class="row"><strong>${esc(b.service)} with ${esc(b.staff)}</strong><span class="id">${b.booking_id}</span></div>
      <div>${esc(b.day)} · ${b.time_label}</div><div class="muted">${esc(b.customer_name)}${b.phone ? " · " + esc(b.phone) : ""}${b.status === "cancelled" ? " · cancelled" : ""}</div></div>`,
    )
    .join("");
}

ui.service.onchange = refreshCalendar;
ui.reset.onclick = async () => {
  const r = await fetch("/api/demo/reset", { method: "POST" });
  if (!r.ok) setStatus((await r.json()).error);
  offered.clear();
  refreshCalendar();
};

// ---------------- live server updates ----------------
let refreshQueued = false;
function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refreshCalendar(); }, 150);
}
const stream = new EventSource("/api/stream");
stream.addEventListener("calendar", queueRefresh);
stream.addEventListener("activity", (e) => {
  const a = JSON.parse(e.data);
  if (a.sessionId !== call.sessionId) return;
  addActivity(a);
  if (a.kind === "tool_result" && a.data.name === "check_availability") highlightOffered(a.data.output);
  if (a.kind === "tool_result" && ["prepare_booking", "confirm_booking"].includes(a.data.name) && a.data.output.ok) {
    const item = a.data.output.hold ?? a.data.output.booking;
    if (item) { selectService(item.service); selectedDay = item.date; }
  }
});
stream.addEventListener("session_ended", (e) => {
  const { sessionId } = JSON.parse(e.data);
  if (sessionId === call.sessionId && call.peer) { setStatus("The call has ended."); cleanup(); }
});
setInterval(() => state.holds.length && renderLists(), 30_000); // keep hold countdown fresh

function highlightOffered(out) {
  if (!out?.ok) return;
  offered = new Set();
  const groups = [out, ...(out.days ?? []), ...(out.alternatives ?? [])].filter((g) => g.options);
  for (const g of groups) for (const o of g.options) offered.add(`${g.date}|${o.start_time}`);
  selectService(out.service);
  const first = groups.find((g) => g.options.length);
  if (first) selectedDay = first.date;
  queueRefresh();
}
function selectService(name) {
  const svc = config.business.services.find((s) => s.name === name);
  if (svc && ui.service.value !== svc.id) ui.service.value = svc.id;
}

function addActivity({ kind, text, at }) {
  const li = document.createElement("li");
  li.innerHTML = `<time>${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span class="k-${kind}"></span>`;
  li.lastChild.textContent = text;
  ui.activity.append(li);
  ui.activity.scrollTop = ui.activity.scrollHeight;
}

// ---------------- voice call ----------------
const call = { peer: null, events: null, mic: null, sessionId: null, ready: false, finalized: false, closeTimer: null, clock: null, startedAt: 0, lastRole: null, bubble: null };

function setPhase(phase, label) {
  ui.pill.dataset.state = phase;
  ui.pill.textContent = label;
}
function setStatus(t) { ui.status.textContent = t; }

async function explainMicProblem(err) {
  let msg;
  if (!window.isSecureContext) msg = "Microphone access needs HTTPS or http://localhost. Open the app at http://localhost:3000.";
  else if (!navigator.mediaDevices?.getUserMedia) msg = "This browser does not support microphone capture. Try a recent Chrome, Edge, Safari or Firefox.";
  else if (err?.name === "NotAllowedError" || err?.name === "SecurityError")
    msg = "Microphone permission was blocked. Click the lock/site-settings icon in the address bar, allow the microphone, then press Start again.";
  else if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") msg = "No microphone was found. Connect one and try again.";
  else if (err?.name === "NotReadableError") msg = "Your microphone is in use by another app or tab. Close it and try again.";
  else msg = `Could not start the microphone: ${err?.message ?? err}`;
  ui.micHelp.textContent = msg;
  ui.micHelp.hidden = false;
}

async function micPermissionState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state; // granted | prompt | denied
  } catch {
    return "unknown";
  }
}

ui.start.onclick = async () => {
  ui.start.disabled = true;
  ui.micHelp.hidden = true;
  call.finalized = false;
  call.sessionId = null;
  ui.transcript.innerHTML = "";
  ui.activity.innerHTML = "";
  call.lastRole = null;
  setPhase("connecting", "Connecting");

  // 1) Microphone (must come from this click so browsers show the prompt).
  if ((await micPermissionState()) === "denied") {
    await explainMicProblem({ name: "NotAllowedError" });
    return cleanup();
  }
  setStatus("Waiting for microphone permission…");
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
    call.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    await explainMicProblem(err);
    return cleanup();
  }

  // 2) WebRTC peer + event channel, then exchange SDP through our server.
  try {
    setStatus("Connecting to the front desk…");
    const pc = new RTCPeerConnection();
    call.peer = pc;
    pc.ontrack = (e) => {
      ui.audio.srcObject = new MediaStream([e.track]);
      ui.audio.play().catch(() => setStatus("Your browser blocked audio autoplay — click anywhere on the page to hear the assistant."));
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(pc.connectionState) && !call.finalized) {
        setStatus("Connection lost.");
        hangUpViaServer();
        cleanup();
      }
    };
    for (const track of call.mic.getAudioTracks()) pc.addTrack(track, call.mic);

    const dc = pc.createDataChannel("oai-events");
    call.events = dc;
    dc.onmessage = ({ data }) => onLiveEvent(JSON.parse(data));
    dc.onclose = () => {
      if (!call.finalized && call.peer) { setStatus("Disconnected."); cleanup(); }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription.sdp }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
    call.sessionId = body.session.id;
    await pc.setRemoteDescription({ type: "answer", sdp: body.transport.sdp });
  } catch (err) {
    setStatus(err.message || String(err));
    hangUpViaServer();
    cleanup();
  }
};

function waitForIce(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timed out gathering network candidates.")), 10_000);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
}

function onLiveEvent(ev) {
  switch (ev.type) {
    case "session.started":
      call.ready = true;
      call.startedAt = Date.now();
      call.clock = setInterval(tick, 1000);
      ui.end.disabled = false;
      ui.mute.disabled = false;
      setPhase("live", "Live");
      setStatus("Connected — start talking. Interrupt any time.");
      break;
    case "session.input_transcript.delta":
      appendTranscript("user", ev.delta);
      break;
    case "session.output_transcript.delta":
      appendTranscript("assistant", ev.delta);
      break;
    case "session.closed":
      call.finalized = true;
      setStatus("Call ended. Thanks for trying Front Desk!");
      cleanup();
      break;
    case "error":
      addActivity({ kind: "error", text: ev.error?.message ?? "Session error", at: Date.now() });
      break;
  }
}

function appendTranscript(role, delta) {
  if (!delta) return;
  if (call.lastRole !== role || !call.bubble) {
    call.bubble = document.createElement("div");
    call.bubble.className = `bubble ${role}`;
    call.bubble.innerHTML = `<small>${role === "user" ? "You" : "Front desk"}</small><span></span>`;
    ui.transcript.append(call.bubble);
    call.lastRole = role;
  }
  call.bubble.lastChild.textContent += delta;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

ui.mute.onclick = () => {
  const track = call.mic?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  ui.mute.textContent = track.enabled ? "Mute mic" : "Unmute mic";
  setStatus(track.enabled ? "Microphone on." : "Microphone muted — the assistant can't hear you.");
};

ui.end.onclick = () => {
  if (!call.ready || call.events?.readyState !== "open") return cleanup();
  ui.end.disabled = true;
  setPhase("ending", "Ending");
  setStatus("Finishing the call…");
  // Keep media + events open until session.closed so pending work drains and usage is final.
  call.events.send(JSON.stringify({ type: "session.close" }));
  call.closeTimer = setTimeout(() => {
    setStatus("Call ended (no final confirmation from the server).");
    hangUpViaServer();
    cleanup();
  }, 15_000);
};

function hangUpViaServer() {
  if (call.sessionId && !call.finalized) {
    navigator.sendBeacon(`/api/session/${encodeURIComponent(call.sessionId)}/close`, new Blob([""], { type: "text/plain" }));
  }
}
window.addEventListener("pagehide", hangUpViaServer);

function cleanup() {
  clearTimeout(call.closeTimer);
  clearInterval(call.clock);
  call.mic?.getTracks().forEach((t) => t.stop());
  try { call.events?.close(); } catch {}
  try { call.peer?.close(); } catch {}
  Object.assign(call, { peer: null, events: null, mic: null, ready: false, bubble: null });
  ui.audio.srcObject = null;
  ui.start.disabled = !config?.hasApiKey;
  ui.end.disabled = true;
  ui.mute.disabled = true;
  ui.mute.textContent = "Mute mic";
  setPhase("idle", "Idle");
}

function tick() {
  const s = Math.floor((Date.now() - call.startedAt) / 1000);
  ui.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

document.addEventListener("click", () => ui.audio.srcObject && ui.audio.paused && ui.audio.play().catch(() => {}));

// ---------------- helpers ----------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function to12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h >= 12 ? "PM" : "AM"}`;
}

await loadConfig();
await refreshCalendar();
