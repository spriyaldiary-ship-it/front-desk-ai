// Function tools for the Responses backend. They run on THIS server (via the sideband),
// never in the browser, so the frontend cannot fake a confirmation or a booking.
import * as cal from "./calendar.mjs";

export const TOOL_DEFS = [
  {
    type: "function",
    name: "get_business_info",
    description: "Services (ids, durations, prices), staff and which services they offer, opening hours, today's date and the booking window.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "check_availability",
    description:
      "Find open start times. Omit date to get the next few days with openings. Use earliest_time/latest_time for 'morning', 'after 3', etc.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Service id from get_business_info, e.g. haircut" },
        date: { type: "string", description: "YYYY-MM-DD (business-local)" },
        earliest_time: { type: "string", description: "HH:MM 24h" },
        latest_time: { type: "string", description: "HH:MM 24h, latest acceptable START time" },
        staff_id: { type: "string", description: "Optional staff id" },
      },
      required: ["service_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "prepare_booking",
    description:
      "Place a 5-minute HOLD on a specific slot. Does NOT book. Replaces any earlier hold from this call. Returns details to read back to the caller.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        start_time: { type: "string", description: "HH:MM 24h" },
        staff_id: { type: "string", description: "Optional; omit for any available staff" },
        customer_name: { type: "string" },
        phone: { type: "string", description: "Optional" },
        notes: { type: "string", description: "Optional" },
      },
      required: ["service_id", "date", "start_time", "customer_name"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "confirm_booking",
    description:
      "Save the held appointment. Only call after the caller heard the read-back and clearly said yes. The server independently verifies the caller's spoken confirmation.",
    parameters: {
      type: "object",
      properties: { hold_id: { type: "string" } },
      required: ["hold_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "release_hold",
    description: "Release a hold when the caller declines or wants to start over.",
    parameters: {
      type: "object",
      properties: { hold_id: { type: "string" } },
      required: ["hold_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cancel_booking",
    description: "Cancel a booking made earlier in THIS call (e.g. caller changed their mind after confirming). Confirm with the caller first.",
    parameters: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "finish_call",
    description: "The caller is done. The app will hang up after the goodbye finishes playing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

const AFFIRM =
  /\b(yes|yeah|yep|yup|sure|correct|confirm(ed)?|go ahead|book it|sounds (good|great|perfect)|that'?s (right|correct|perfect|fine)|perfect|please do|absolutely|ok(ay)?|do it)\b/gi;
const NEGATE = /\b(no|nope|wait|actually|instead|change|don'?t|not that|hold on|cancel)\b/gi;

function lastIndex(re, text) {
  let idx = -1;
  for (const m of text.matchAll(re)) idx = m.index;
  return idx;
}

/** True if the caller's speech since `sinceMs` ends on a clear yes. */
export function spokenYes(text) {
  const t = String(text || "").toLowerCase();
  const yes = lastIndex(AFFIRM, t);
  return yes >= 0 && yes > lastIndex(NEGATE, t);
}

/**
 * ctx = {
 *   sessionId,
 *   userSpeechSince(ms) -> string,   // caller transcript after a timestamp
 *   transcriptsSeen() -> number,     // how many caller transcript deltas arrived
 *   requireSpokenConfirmation: bool,
 *   onFinish() -> void,
 * }
 */
export function executeTool(name, args, ctx) {
  switch (name) {
    case "get_business_info":
      return { ok: true, ...cal.businessInfo() };
    case "check_availability":
      return cal.checkAvailability(args);
    case "prepare_booking":
      return cal.prepareBooking(ctx.sessionId, args);
    case "confirm_booking": {
      const hold = cal.getHold(args.hold_id);
      if (hold && ctx.requireSpokenConfirmation) {
        if (ctx.transcriptsSeen() > 0) {
          const said = ctx.userSpeechSince(hold.createdAt);
          if (!spokenYes(said)) {
            return {
              ok: false,
              error: "awaiting_spoken_confirmation",
              status: "held_not_booked",
              next_step:
                "The caller has not clearly said yes since the hold was placed. Read back the service, staff, day, date, time and name, ask them to confirm, and call confirm_booking only after a clear yes.",
            };
          }
        } else {
          console.warn("[guard] No caller transcripts received; relying on model confirmation for", args.hold_id);
        }
      }
      return cal.confirmHold(ctx.sessionId, args.hold_id);
    }
    case "release_hold":
      return cal.releaseHold(ctx.sessionId, args.hold_id);
    case "cancel_booking":
      return cal.cancelBooking(ctx.sessionId, args.booking_id);
    case "finish_call":
      ctx.onFinish?.();
      return { ok: true, status: "ending_after_goodbye" };
    default:
      return { ok: false, error: `unknown_tool:${name}` };
  }
}
