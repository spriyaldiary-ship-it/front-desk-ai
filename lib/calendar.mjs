// Demo business + in-memory calendar. No external integrations.
// All dates are business-local "YYYY-MM-DD" strings; times are minutes from midnight.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const calendarEvents = new EventEmitter();

export const BUSINESS = {
  name: "Brightside Salon & Spa",
  tagline: "Demo business — bookings live only in this server's memory",
  timezone: process.env.BUSINESS_TIMEZONE || "Asia/Kolkata",
  address: "12 Demo Street (sample address)",
  // 0 = Sunday … 6 = Saturday. null = closed.
  hours: {
    0: null,
    1: ["10:00", "19:00"],
    2: ["10:00", "19:00"],
    3: ["10:00", "19:00"],
    4: ["10:00", "20:00"],
    5: ["10:00", "20:00"],
    6: ["09:00", "17:00"],
  },
  services: [
    { id: "haircut", name: "Haircut & Style", minutes: 45, price: "₹600" },
    { id: "color", name: "Hair Colour", minutes: 90, price: "₹2,400" },
    { id: "facial", name: "Signature Facial", minutes: 60, price: "₹1,500" },
    { id: "consult", name: "Free Consultation", minutes: 15, price: "Free" },
  ],
  staff: [
    { id: "maya", name: "Maya", services: ["haircut", "color", "consult"] },
    { id: "arjun", name: "Arjun", services: ["haircut", "facial", "consult"] },
    { id: "lena", name: "Lena", services: ["color", "facial", "consult"] },
  ],
};

const HOLD_MS = 5 * 60_000;
const STEP = 30; // offer start times on the half hour
const WINDOW_DAYS = 14;

let bookings = [];
let holds = [];
let bookingSeq = 1000;

// ---------- time helpers ----------
export function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
export const toHHMM = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export function to12h(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
export function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function nowMinutesLocal() {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return toMin(s);
}
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export function describeDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date)) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}
function hoursFor(date) {
  const h = BUSINESS.hours[weekday(date)];
  return h ? [toMin(h[0]), toMin(h[1])] : null;
}

export const getService = (id) =>
  BUSINESS.services.find((s) => s.id === String(id ?? "").toLowerCase().trim());
export const getStaff = (id) =>
  BUSINESS.staff.find((s) => s.id === String(id ?? "").toLowerCase().trim());

// ---------- deterministic demo seed ----------
function hash(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function resetDemo() {
  bookings = [];
  holds = [];
  bookingSeq = 1000;
  const today = todayLocal();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const date = addDays(today, i);
    const hrs = hoursFor(date);
    if (!hrs) continue;
    for (const staff of BUSINESS.staff) {
      for (let t = hrs[0]; t < hrs[1]; t += STEP) {
        const roll = hash(`${date}|${staff.id}|${t}`) % 100;
        if (roll >= 32) continue;
        const len = roll < 12 ? 60 : 30;
        if (t + len > hrs[1] || !isFree(staff.id, date, t, t + len)) continue;
        bookings.push({
          id: `SEED-${bookings.length}`,
          source: "seed",
          status: "confirmed",
          staffId: staff.id,
          date,
          start: t,
          end: t + len,
        });
      }
    }
  }
  changed("reset");
}

function changed(reason) {
  calendarEvents.emit("changed", { reason, at: Date.now() });
}

// ---------- availability ----------
function activeHolds() {
  const now = Date.now();
  return holds.filter((h) => h.expiresAt > now);
}
function isFree(staffId, date, start, end, ignoreHoldId) {
  const overlaps = (x) => x.staffId === staffId && x.date === date && x.start < end && start < x.end;
  if (bookings.some((b) => b.status === "confirmed" && overlaps(b))) return false;
  return !activeHolds().some((h) => h.id !== ignoreHoldId && overlaps(h));
}

function slotsForDay(service, date, { staffId, earliest, latest } = {}) {
  const hrs = hoursFor(date);
  if (!hrs) return [];
  let from = hrs[0];
  if (date === todayLocal()) {
    const soon = nowMinutesLocal() + 30;
    from = Math.max(from, Math.ceil(soon / STEP) * STEP);
  }
  if (earliest != null) from = Math.max(from, Math.ceil(earliest / STEP) * STEP);
  const lastStart = Math.min(hrs[1] - service.minutes, latest ?? Infinity);
  const team = BUSINESS.staff.filter(
    (s) => s.services.includes(service.id) && (!staffId || s.id === staffId),
  );
  const out = [];
  for (let t = from; t <= lastStart; t += STEP) {
    const free = team.filter((s) => isFree(s.id, date, t, t + service.minutes));
    if (free.length) {
      out.push({
        start_time: toHHMM(t),
        label: to12h(t),
        staff: free.map((s) => ({ id: s.id, name: s.name })),
      });
    }
  }
  return out;
}

export function checkAvailability({ service_id, date, earliest_time, latest_time, staff_id }) {
  const service = getService(service_id);
  if (!service) return { ok: false, error: "unknown_service", services: BUSINESS.services.map((s) => s.id) };
  if (staff_id && !getStaff(staff_id)) return { ok: false, error: "unknown_staff" };
  if (staff_id && !getStaff(staff_id).services.includes(service.id)) {
    return { ok: false, error: "staff_does_not_offer_service", staff: getStaff(staff_id).name };
  }
  const today = todayLocal();
  const opts = {
    staffId: staff_id ? getStaff(staff_id).id : undefined,
    earliest: earliest_time ? toMin(earliest_time) : null,
    latest: latest_time ? toMin(latest_time) : null,
  };

  const summarize = (d, list, max) => ({
    date: d,
    day: describeDate(d),
    options: list.slice(0, max),
    more_available: Math.max(0, list.length - max),
  });

  if (date) {
    if (!isValidDate(date)) return { ok: false, error: "invalid_date", expected: "YYYY-MM-DD" };
    if (date < today || date > addDays(today, WINDOW_DAYS - 1)) {
      return { ok: false, error: "outside_booking_window", window: [today, addDays(today, WINDOW_DAYS - 1)] };
    }
    const list = slotsForDay(service, date, opts);
    const result = {
      ok: true,
      service: service.name,
      minutes: service.minutes,
      closed: !hoursFor(date),
      ...summarize(date, list, 6),
    };
    if (!list.length) {
      result.alternatives = [];
      for (let i = 1; i < WINDOW_DAYS && result.alternatives.length < 2; i++) {
        const d = addDays(date, i);
        if (d > addDays(today, WINDOW_DAYS - 1)) break;
        const l = slotsForDay(service, d, opts);
        if (l.length) result.alternatives.push(summarize(d, l, 3));
      }
    }
    return result;
  }

  const days = [];
  for (let i = 0; i < WINDOW_DAYS && days.length < 3; i++) {
    const d = addDays(today, i);
    const l = slotsForDay(service, d, opts);
    if (l.length) days.push(summarize(d, l, 4));
  }
  return { ok: true, service: service.name, minutes: service.minutes, days };
}

// ---------- holds & bookings ----------
const publicHold = (h) => ({
  hold_id: h.id,
  service: getService(h.serviceId).name,
  staff: getStaff(h.staffId).name,
  date: h.date,
  day: describeDate(h.date),
  start_time: toHHMM(h.start),
  time_label: to12h(h.start),
  customer_name: h.customerName,
  phone: h.phone || null,
  expires_in_seconds: Math.max(0, Math.round((h.expiresAt - Date.now()) / 1000)),
});
const publicBooking = (b) => ({
  booking_id: b.id,
  service: getService(b.serviceId).name,
  staff: getStaff(b.staffId).name,
  date: b.date,
  day: describeDate(b.date),
  start_time: toHHMM(b.start),
  time_label: to12h(b.start),
  customer_name: b.customerName,
  phone: b.phone || null,
  notes: b.notes || null,
});

export function getHold(id) {
  return activeHolds().find((h) => h.id === id);
}

export function prepareBooking(sessionId, args) {
  const service = getService(args.service_id);
  if (!service) return { ok: false, error: "unknown_service" };
  if (!isValidDate(args.date)) return { ok: false, error: "invalid_date", expected: "YYYY-MM-DD" };
  const start = toMin(args.start_time);
  if (start == null) return { ok: false, error: "invalid_time", expected: "HH:MM (24h)" };
  const name = String(args.customer_name ?? "").trim();
  if (!name) return { ok: false, error: "missing_customer_name", next_step: "Ask the caller for their name." };

  const available = slotsForDay(service, args.date, { earliest: start, latest: start });
  const slot = available.find((s) => s.start_time === toHHMM(start));
  let staffId = args.staff_id ? getStaff(args.staff_id)?.id : undefined;
  if (args.staff_id && !staffId) return { ok: false, error: "unknown_staff" };
  if (!slot || (staffId && !slot.staff.some((s) => s.id === staffId))) {
    return {
      ok: false,
      error: "slot_unavailable",
      next_step: "Tell the caller that time just became unavailable and offer nearby times.",
      nearby: checkAvailability({ service_id: service.id, date: args.date, staff_id: staffId }).options ?? [],
    };
  }
  staffId ??= slot.staff[0].id;

  // A new hold supersedes any earlier hold from this call (the caller changed their mind).
  const superseded = holds.filter((h) => h.sessionId === sessionId).map((h) => h.id);
  holds = holds.filter((h) => h.sessionId !== sessionId);

  const hold = {
    id: `HOLD-${randomUUID().slice(0, 6).toUpperCase()}`,
    sessionId,
    serviceId: service.id,
    staffId,
    date: args.date,
    start,
    end: start + service.minutes,
    customerName: name,
    phone: String(args.phone ?? "").trim(),
    notes: String(args.notes ?? "").trim(),
    createdAt: Date.now(),
    expiresAt: Date.now() + HOLD_MS,
  };
  holds.push(hold);
  changed("hold");
  return {
    ok: true,
    status: "held_not_booked",
    hold: publicHold(hold),
    superseded_holds: superseded,
    next_step:
      "Read these details back to the caller and ask for a clear yes. Call confirm_booking only after they confirm. If they change anything, call prepare_booking again with the new details.",
  };
}

export function confirmHold(sessionId, holdId) {
  const hold = getHold(holdId);
  if (!hold || hold.sessionId !== sessionId) {
    return { ok: false, error: "hold_not_found_or_expired", next_step: "Check availability again and place a new hold." };
  }
  if (!isFree(hold.staffId, hold.date, hold.start, hold.end, hold.id)) {
    holds = holds.filter((h) => h.id !== hold.id);
    changed("hold_lost");
    return { ok: false, error: "slot_unavailable" };
  }
  const booking = {
    id: `BK-${++bookingSeq}`,
    source: "voice",
    status: "confirmed",
    sessionId,
    serviceId: hold.serviceId,
    staffId: hold.staffId,
    date: hold.date,
    start: hold.start,
    end: hold.end,
    customerName: hold.customerName,
    phone: hold.phone,
    notes: hold.notes,
    createdAt: Date.now(),
  };
  bookings.push(booking);
  holds = holds.filter((h) => h.id !== hold.id);
  changed("booked");
  return { ok: true, status: "confirmed", booking: publicBooking(booking) };
}

export function releaseHold(sessionId, holdId) {
  const before = holds.length;
  holds = holds.filter((h) => !(h.id === holdId && h.sessionId === sessionId));
  if (holds.length !== before) changed("hold_released");
  return { ok: true, released: before !== holds.length };
}

export function releaseSessionHolds(sessionId) {
  const before = holds.length;
  holds = holds.filter((h) => h.sessionId !== sessionId);
  if (holds.length !== before) changed("session_closed");
}

export function cancelBooking(sessionId, bookingId) {
  const b = bookings.find((x) => x.id === String(bookingId ?? "").toUpperCase() && x.source === "voice");
  if (!b) return { ok: false, error: "booking_not_found" };
  if (b.sessionId !== sessionId) return { ok: false, error: "can_only_cancel_bookings_made_in_this_call" };
  if (b.status === "cancelled") return { ok: true, status: "already_cancelled" };
  b.status = "cancelled";
  changed("cancelled");
  return { ok: true, status: "cancelled", booking_id: b.id };
}

// ---------- UI views ----------
export function businessInfo() {
  const today = todayLocal();
  const hours = Object.entries(BUSINESS.hours).map(([d, h]) => ({
    day: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d],
    hours: h ? `${to12h(toMin(h[0]))}–${to12h(toMin(h[1]))}` : "Closed",
  }));
  return {
    name: BUSINESS.name,
    tagline: BUSINESS.tagline,
    address: BUSINESS.address,
    timezone: BUSINESS.timezone,
    today,
    today_label: describeDate(today),
    booking_window_days: WINDOW_DAYS,
    hours,
    services: BUSINESS.services,
    staff: BUSINESS.staff.map((s) => ({
      id: s.id,
      name: s.name,
      services: s.services.map((id) => getService(id).name),
    })),
  };
}

export function availabilityGrid(serviceId, days = 7) {
  const service = getService(serviceId) ?? BUSINESS.services[0];
  const today = todayLocal();
  const out = [];
  for (let i = 0; i < WINDOW_DAYS && out.length < days; i++) {
    const date = addDays(today, i);
    if (!hoursFor(date)) continue;
    out.push({ date, day: describeDate(date), slots: slotsForDay(service, date) });
  }
  return { service, days: out };
}

export function snapshot() {
  return {
    today: todayLocal(),
    holds: activeHolds().map((h) => ({ ...publicHold(h), session_id: h.sessionId })),
    bookings: bookings
      .filter((b) => b.source === "voice")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((b) => ({ ...publicBooking(b), status: b.status, session_id: b.sessionId })),
  };
}

// Expire stale holds so the UI and availability stay accurate.
setInterval(() => {
  const now = Date.now();
  const before = holds.length;
  holds = holds.filter((h) => h.expiresAt > now);
  if (holds.length !== before) changed("hold_expired");
}, 10_000).unref();

resetDemo();
