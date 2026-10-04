// Offline smoke test: calendar + tools + sideband event flow with a fake OpenAI socket.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as cal from "../lib/calendar.mjs";
import { executeTool, spokenYes, TOOL_DEFS } from "../lib/tools.mjs";
import { LiveSideband } from "../lib/sideband.mjs";
import { liveInstructions, backendInstructions } from "../lib/prompts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- availability ---
const avail = cal.checkAvailability({ service_id: "haircut" });
assert.ok(avail.ok && avail.days.length > 0, "should find upcoming haircut days");
const day = avail.days[0];
const slot = day.options[0];
console.log(`✓ availability: ${day.day} first ${slot.label} (${slot.staff.map((s) => s.name).join(", ")})`);

assert.equal(cal.checkAvailability({ service_id: "nope" }).error, "unknown_service");
assert.equal(cal.checkAvailability({ service_id: "facial", staff_id: "maya" }).error, "staff_does_not_offer_service");
console.log("✓ validation errors");

// --- confirmation guard ---
assert.equal(spokenYes("yes please"), true);
assert.equal(spokenYes("yeah that's right"), true);
assert.equal(spokenYes("yes, actually wait, make it friday"), false);
assert.equal(spokenYes("no thanks"), false);
assert.equal(spokenYes("hmm let me think"), false);
console.log("✓ spoken-yes detection");

// --- sideband end-to-end with a fake socket ---
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  server(msg) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}
const fake = new FakeSocket();
const activity = [];
let closedReason = null;
const sb = new LiveSideband({
  sessionId: "live_test",
  apiKey: "sk-test",
  executeTool,
  emit: (kind, text) => activity.push(`${kind}: ${text}`),
  onClosed: (r) => (closedReason = r),
  socketFactory: () => fake,
}).connect();

const D = "item_deleg_1";
const call = (id, name, args) => ({
  type: "response.event",
  delegation_id: D,
  event: { type: "response.output_item.done", item: { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } },
});
const lifecycle = (type, id) => ({ type: "response.event", delegation_id: D, event: { type, response: { id, output: [] } } });

// 1) Hold a slot
fake.server({ type: "session.delegation.created", delegation: { id: D, target: "responses" } });
fake.server(lifecycle("response.created", "resp_1"));
fake.server(call("call_1", "prepare_booking", { service_id: "haircut", date: day.date, start_time: slot.start_time, customer_name: "Priya" }));
fake.server(lifecycle("response.completed", "resp_1"));
await sleep(20);
let outs = fake.sent.filter((e) => e.type === "response.item.create");
assert.equal(outs.length, 1);
const holdOut = JSON.parse(outs[0].item.output);
assert.equal(holdOut.status, "held_not_booked");
assert.equal(fake.sent.at(-1).type, "response.create", "must continue backend after results");
console.log(`✓ hold placed: ${holdOut.hold.hold_id}, function result + response.create sent`);

// 2) Try to confirm before the caller said yes → blocked
fake.server({ type: "session.input_transcript.delta", delta: "Hmm, let me think. " });
fake.server(lifecycle("response.created", "resp_2"));
fake.server(call("call_2", "confirm_booking", { hold_id: holdOut.hold.hold_id }));
fake.server(lifecycle("response.completed", "resp_2"));
await sleep(20);
outs = fake.sent.filter((e) => e.type === "response.item.create");
assert.equal(JSON.parse(outs.at(-1).item.output).error, "awaiting_spoken_confirmation");
assert.equal(cal.snapshot().bookings.length, 0);
console.log("✓ booking blocked until the caller says yes");

// 3) Caller changes mind: new hold supersedes the old one
const alt = day.options[1] ?? avail.days[1].options[0];
const altDate = day.options[1] ? day.date : avail.days[1].date;
fake.server({ type: "session.input_transcript.delta", delta: "Actually, make it later. " });
fake.server(lifecycle("response.created", "resp_3"));
fake.server(call("call_3", "prepare_booking", { service_id: "haircut", date: altDate, start_time: alt.start_time, customer_name: "Priya" }));
fake.server(lifecycle("response.completed", "resp_3"));
await sleep(20);
const hold2 = JSON.parse(fake.sent.filter((e) => e.type === "response.item.create").at(-1).item.output);
assert.deepEqual(hold2.superseded_holds, [holdOut.hold.hold_id]);
assert.equal(cal.snapshot().holds.length, 1);
console.log(`✓ preference change: ${holdOut.hold.hold_id} replaced by ${hold2.hold.hold_id}`);

// 4) Caller says yes → confirmed
await sleep(5);
fake.server({ type: "session.input_transcript.delta", delta: "Yes, that's right, book it." });
fake.server(lifecycle("response.created", "resp_4"));
fake.server(call("call_4", "confirm_booking", { hold_id: hold2.hold.hold_id }));
fake.server(lifecycle("response.completed", "resp_4"));
fake.server(lifecycle("response.done", "resp_4")); // duplicate terminal event must not double-submit
await sleep(20);
const conf = JSON.parse(fake.sent.filter((e) => e.type === "response.item.create").at(-1).item.output);
assert.equal(conf.status, "confirmed");
assert.equal(fake.sent.filter((e) => e.type === "response.create").length, 4);
assert.equal(cal.snapshot().bookings.length, 1);
assert.equal(cal.snapshot().holds.length, 0);
console.log(`✓ confirmed ${conf.booking.booking_id}: ${conf.booking.service} with ${conf.booking.staff}, ${conf.booking.day} ${conf.booking.time_label}`);

// 5) Slot is no longer offered
const after = cal.checkAvailability({ service_id: "haircut", date: altDate, staff_id: conf.booking.staff.toLowerCase() });
assert.ok(!after.options.some((o) => o.start_time === alt.start_time), "booked slot must disappear for that stylist");
console.log("✓ booked slot removed from availability");

// 6) finish_call → session.close after goodbye goes quiet
sb.lastOutputAt = 0;
fake.server(lifecycle("response.created", "resp_5"));
fake.server(call("call_5", "finish_call", {}));
fake.server(lifecycle("response.completed", "resp_5"));
await sleep(3300);
assert.ok(fake.sent.some((e) => e.type === "session.close"), "should send session.close");
fake.server({ type: "session.closed", usage: {} });
assert.equal(closedReason, "session_closed");
console.log("✓ finish_call closes the voice session");

// --- payload sanity ---
assert.ok(TOOL_DEFS.every((t) => t.type === "function" && t.parameters.type === "object"));
assert.ok(liveInstructions().length < 4000 && backendInstructions().includes("Date lookup"));
console.log("✓ prompts + tool schemas\n\nAll smoke tests passed.");
process.exit(0);
