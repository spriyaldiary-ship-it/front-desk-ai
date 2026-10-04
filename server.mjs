// Front Desk — voice booking with OpenAI GPT-Live + a Responses backend.
// The OpenAI API key never leaves this server.
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as cal from "./lib/calendar.mjs";
import { TOOL_DEFS, executeTool } from "./lib/tools.mjs";
import { liveInstructions, backendInstructions } from "./lib/prompts.mjs";
import { LiveSideband } from "./lib/sideband.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.OPENAI_API_KEY;
const LIVE_MODEL = process.env.LIVE_MODEL || "gpt-live-1";
const BACKEND_MODEL = process.env.BACKEND_MODEL || "gpt-6-luna";
const VOICE = process.env.LIVE_VOICE || "marin";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3);
const REQUIRE_SPOKEN_CONFIRMATION = process.env.REQUIRE_SPOKEN_CONFIRMATION !== "false";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.text({ type: "text/plain", limit: "1kb" }));
app.use(express.static(resolve("public")));

const sessions = new Map(); // sessionId -> LiveSideband

// ---------- live UI updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}
cal.calendarEvents.on("changed", (e) => broadcast("calendar", e));

app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`event: hello\ndata: {}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ---------- read-only demo data ----------
app.get("/api/config", (_req, res) =>
  res.json({ business: cal.businessInfo(), hasApiKey: Boolean(API_KEY), liveModel: LIVE_MODEL, backendModel: BACKEND_MODEL }),
);
app.get("/api/state", (_req, res) => res.json(cal.snapshot()));
app.get("/api/availability", (req, res) => res.json(cal.availabilityGrid(String(req.query.service || ""), 7)));

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

app.post("/api/demo/reset", (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "Unexpected origin" });
  if (sessions.size) return res.status(409).json({ error: "End the active call before resetting the demo calendar." });
  cal.resetDemo();
  res.json({ ok: true });
});

// ---------- create a GPT-Live WebRTC session ----------
// Local demo: add real authentication + rate limiting before exposing this publicly.
app.post("/api/session", async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "Unexpected request origin" });
  const sdp = req.body?.sdp;
  if (typeof sdp !== "string" || !sdp.trim() || sdp.length > 60_000) {
    return res.status(400).json({ error: "An SDP offer is required" });
  }
  if (!API_KEY) return res.status(503).json({ error: "Set OPENAI_API_KEY in .env on the server, then restart." });
  if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: "Too many active calls. Try again shortly." });

  const body = {
    session: {
      model: LIVE_MODEL,
      instructions: liveInstructions(),
      audio: { output: { voice: VOICE } },
      // The browser may only hang up; everything else (tool results, context) comes from this server.
      client: { data_channel: { allowed_client_events: ["session.close"] } },
      delegation: {
        type: "responses",
        responses: {
          model: BACKEND_MODEL,
          instructions: backendInstructions(),
          tools: TOOL_DEFS,
          tool_choice: "auto",
          parallel_tool_calls: false, // hold → confirm must be sequential
          reasoning: { effort: process.env.BACKEND_REASONING || "low" },
          text: { verbosity: "low" },
        },
      },
    },
    transport: { type: "webrtc", sdp },
  };

  let result;
  try {
    const r = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("Live session creation failed", r.status, text.slice(0, 500));
      let detail = "";
      try {
        detail = JSON.parse(text)?.error?.message ?? "";
      } catch {}
      return res.status(r.status === 401 ? 502 : r.status).json({ error: `Live session creation failed (${r.status}). ${detail}`.trim() });
    }
    result = JSON.parse(text);
  } catch (err) {
    console.error("Live session request error", err);
    return res.status(502).json({ error: "Could not reach OpenAI from the server." });
  }

  const sessionId = result?.session?.id;
  if (!sessionId || !result?.transport?.sdp) return res.status(502).json({ error: "Unexpected response from OpenAI." });

  const emit = (kind, text, data = {}) => broadcast("activity", { sessionId, kind, text, data, at: Date.now() });
  const sideband = new LiveSideband({
    sessionId,
    apiKey: API_KEY,
    executeTool,
    emit,
    requireSpokenConfirmation: REQUIRE_SPOKEN_CONFIRMATION,
    onClosed: (reason) => {
      sessions.delete(sessionId);
      cal.releaseSessionHolds(sessionId);
      broadcast("session_ended", { sessionId, reason });
    },
  }).connect();
  sessions.set(sessionId, sideband);

  // Return only what the browser needs: the session id and SDP answer.
  res.status(201).json({ session: { id: sessionId }, transport: { type: "webrtc", sdp: result.transport.sdp } });
});

// Fallback hang-up (tab closing, lost data channel). Accepts JSON or a sendBeacon text body.
app.post("/api/session/:id/close", (req, res) => {
  if (!sameOrigin(req)) return res.status(403).end();
  sessions.get(req.params.id)?.requestClose();
  res.status(202).json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Front Desk running at http://localhost:${PORT}`);
  if (!API_KEY) console.log("⚠  OPENAI_API_KEY is not set — the calendar UI works, voice calls will not.");
});

function shutdown() {
  for (const s of sessions.values()) s.requestClose();
  setTimeout(() => process.exit(0), sessions.size ? 3000 : 0);
  server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
