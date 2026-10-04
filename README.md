# Front Desk — voice booking with OpenAI GPT-Live

Callers book appointments by voice at a sample business (**Brightside Salon & Spa**) with a built-in demo calendar. GPT-Live handles the conversation (full duplex — callers can interrupt any time) while a **Responses backend** checks availability and makes bookings. No external calendar or database needed.

## Run it (≈2 minutes)

1. Node.js **22.6+**.
2. Create an API key at <https://platform.openai.com/api-keys> (project key with GPT-Live access).
3. ```bash
   cp .env.example .env      # paste your key into OPENAI_API_KEY
   npm install
   npm start                 # → http://localhost:3000
   ```
4. Open **http://localhost:3000** (localhost or HTTPS is required for the microphone), press **Start call**, allow the mic.

Try: *"I need a haircut Thursday afternoon"* → *"Actually, Friday morning with Maya"* → *"Yes, book it"* → *"That's all, thanks."*

`npm test` runs an offline smoke test (no key needed) covering availability, holds, preference changes, the confirmation guard, function-result submission and hang-up.

## How it works

```
Browser ──WebRTC audio + data channel──▶ GPT-Live (gpt-live-1)
   │  SDP offer                               │ delegates tasks
   ▼                                          ▼
server.mjs ──POST /v1/live/sessions──▶  Responses backend (gpt-6-luna)
   │                                          │ function calls
   └──── sideband WS /live/sessions/{id}/attach ◀┘
         runs tools against the demo calendar, returns results,
         records caller transcript, closes the session
```

| Requirement | Implementation |
|---|---|
| Keep talking while backend works | GPT-Live keeps the conversation going during delegation; the server also sends `session.thinking.append` progress ("checking the calendar, nothing booked yet") so it never claims results early. |
| Interruptions / changed preferences | Full-duplex barge-in is native to GPT-Live. `prepare_booking` places a 5-min **hold**; a new hold automatically **supersedes** the old one, so "actually Friday" never leaves stale holds. |
| Confirm before saving | Two-step hold → confirm. The server **independently verifies** the caller said a clear "yes" (from the live transcript) after the hold before `confirm_booking` saves — the model alone can't book. |
| Show times and bookings | Right panel: 7-day availability per service, times the assistant just offered (green), current hold (amber), confirmed bookings. Updates live via Server-Sent Events. |
| Credentials server-side | API key only in `.env`. Browser gets just the session ID + SDP answer. Its data channel is restricted to sending `session.close` only — it cannot inject tool results. |
| Microphone permissions | Requested from the Start click; clear guidance for denied, missing, busy, or insecure-origin cases; mute toggle. |
| Close the session | "End call" sends `session.close` and waits for `session.closed`. Saying goodbye triggers `finish_call`, which hangs up once the farewell finishes. Tab close / connection loss → server closes via sideband. Holds are released on close. |

## Files

- `server.mjs` — Express server, session creation, SSE, close endpoints
- `lib/sideband.mjs` — executes backend function calls, transcript guard, graceful close
- `lib/tools.mjs` — tool schemas + execution
- `lib/calendar.mjs` — sample business, seeded demo calendar, holds/bookings
- `lib/prompts.mjs` — live (conversation) and backend (business rules) prompts
- `public/` — UI

## Customize

- **Business**: edit `BUSINESS` in `lib/calendar.mjs` (services, staff, hours, timezone).
- **Models/voice**: `LIVE_MODEL`, `BACKEND_MODEL`, `BACKEND_REASONING`, `LIVE_VOICE` in `.env`.
- **Real calendar**: replace the functions in `lib/calendar.mjs` (same signatures) with Google/Outlook/your DB calls.

## Before production

- Add user authentication and rate limiting to `/api/session` (only an origin check and a concurrent-call cap exist now).
- Persist bookings (they're in memory; restart = reset).
- Add an `OpenAI-Safety-Identifier` header per end user when creating sessions.
- Treat the "yes" detector as a safety net, not legal consent — tune `AFFIRM`/`NEGATE` in `lib/tools.mjs` for your callers' languages.
