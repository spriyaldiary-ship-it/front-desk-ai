// Server-side "sideband" WebSocket attached to a GPT-Live WebRTC session.
// It executes the Responses backend's function calls privately on this server,
// records caller transcripts (for the confirmation guard), and closes the session.
import WebSocket from "ws";

const DEFAULT_FACTORY = (url, opts) => new WebSocket(url, opts);
const TERMINAL = new Set(["response.completed", "response.done", "response.incomplete", "response.failed"]);
const PROGRESS = {
  check_availability: "Checking the calendar for open times. Nothing has been booked.",
  prepare_booking: "Placing a temporary hold on the chosen time. Nothing is booked yet.",
  confirm_booking: "Saving the booking now. Do not say it is confirmed until the result arrives.",
};

export class LiveSideband {
  constructor({ sessionId, apiKey, executeTool, emit, onClosed, requireSpokenConfirmation = true, socketFactory }) {
    this.sessionId = sessionId;
    this.apiKey = apiKey;
    this.executeTool = executeTool;
    this.emit = emit ?? (() => {});
    this.onClosed = onClosed ?? (() => {});
    this.requireSpokenConfirmation = requireSpokenConfirmation;
    this.socketFactory = socketFactory ?? DEFAULT_FACTORY;
    this.outbox = [];
    this.seq = 0;
    this.userSpeech = []; // [{ at, text }]
    this.lastOutputAt = 0;
    this.tasks = new Map(); // delegation_id -> { responseId, text, calls: Map(call_id -> promise), finished:Set }
    this.closed = false;
    this.closeRequested = false;
  }

  connect() {
    const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(this.sessionId)}/attach`;
    this.ws = this.socketFactory(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    this.ws.on("open", () => {
      this.emit("system", "Server attached to the live session (tools run here).");
      for (const m of this.outbox.splice(0)) this.ws.send(m);
    });
    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handle(msg).catch((err) => this.emit("error", `Handler error: ${err.message}`));
    });
    this.ws.on("error", (err) => this.emit("error", `Sideband error: ${err.message}`));
    this.ws.on("close", () => this.finalize("sideband_closed"));
    return this;
  }

  send(event) {
    const payload = JSON.stringify({ event_id: `fd_${++this.seq}`, ...event });
    if (this.ws?.readyState === 1) this.ws.send(payload);
    else if (!this.closed) this.outbox.push(payload);
  }

  // ---- context for tools ----
  toolContext() {
    return {
      sessionId: this.sessionId,
      requireSpokenConfirmation: this.requireSpokenConfirmation,
      transcriptsSeen: () => this.userSpeech.length,
      userSpeechSince: (ms) =>
        this.userSpeech
          .filter((s) => s.at >= ms)
          .map((s) => s.text)
          .join(""),
      onFinish: () => this.closeAfterGoodbye(),
    };
  }

  task(delegationId) {
    if (!this.tasks.has(delegationId)) {
      this.tasks.set(delegationId, { responseId: null, text: "", calls: new Map(), finished: new Set() });
    }
    return this.tasks.get(delegationId);
  }

  async handle(msg) {
    switch (msg.type) {
      case "session.input_transcript.delta":
        if (msg.delta) this.userSpeech.push({ at: Date.now(), text: msg.delta });
        break;
      case "session.output_transcript.delta":
        this.lastOutputAt = Date.now();
        break;
      case "session.delegation.created":
        this.emit("delegation", "Assistant asked the backend for help.", { delegation_id: msg.delegation?.id });
        break;
      case "response.event":
        await this.handleResponseEvent(msg.delegation_id, msg.event ?? {});
        break;
      case "session.closed":
        this.emit("system", "Voice session closed.", { usage: msg.usage ?? null });
        this.finalize("session_closed");
        break;
      case "error":
        this.emit("error", msg.error?.message ?? "Live session error", msg.error);
        break;
      default:
        break;
    }
  }

  async handleResponseEvent(delegationId, ev) {
    const task = this.task(delegationId);
    switch (ev.type) {
      case "response.created":
        task.responseId = ev.response?.id ?? null;
        task.text = "";
        break;
      case "response.output_text.delta":
        task.text += ev.delta ?? "";
        break;
      case "response.output_item.done": {
        const item = ev.item;
        if (item?.type === "function_call" && !task.calls.has(item.call_id)) {
          task.calls.set(item.call_id, this.runTool(item));
        }
        break;
      }
      default:
        if (TERMINAL.has(ev.type)) await this.continueResponse(delegationId, task, ev);
    }
  }

  async runTool(item) {
    let args = {};
    try {
      args = item.arguments ? JSON.parse(item.arguments) : {};
    } catch {
      return { call_id: item.call_id, output: { ok: false, error: "invalid_json_arguments" } };
    }
    this.emit("tool_call", `Backend → ${item.name}`, { name: item.name, args });
    if (PROGRESS[item.name]) {
      this.send({ type: "session.thinking.append", delegation_id: null, content: PROGRESS[item.name] });
    }
    let output;
    try {
      output = await this.executeTool(item.name, args, this.toolContext());
    } catch (err) {
      output = { ok: false, error: "tool_failed", message: err.message };
    }
    this.emit("tool_result", `${item.name} → ${output.ok ? output.status ?? "ok" : output.error}`, {
      name: item.name,
      output,
    });
    return { call_id: item.call_id, output };
  }

  async continueResponse(delegationId, task, ev) {
    const key = task.responseId ?? ev.response?.id ?? "unknown";
    if (task.finished.has(key)) return;
    task.finished.add(key);

    if (task.text.trim()) this.emit("backend_text", task.text.trim(), { delegation_id: delegationId });
    task.text = "";

    if (!task.calls.size) return;
    const results = await Promise.all(task.calls.values());
    task.calls.clear();
    if (this.closed) return;

    // Return every pending function result, then explicitly continue the backend response.
    for (const r of results) {
      this.send({
        type: "response.item.create",
        item: { type: "function_call_output", call_id: r.call_id, output: JSON.stringify(r.output) },
      });
    }
    this.send({ type: "response.create" });
  }

  /** Hang up once the assistant's goodbye has finished (no output for ~2.5s), max 20s. */
  closeAfterGoodbye() {
    if (this.closeRequested) return;
    this.emit("system", "Caller is finished — closing after the goodbye.");
    const started = Date.now();
    const timer = setInterval(() => {
      const quiet = Date.now() - Math.max(this.lastOutputAt, started) > 2500;
      if (this.closed || quiet || Date.now() - started > 20_000) {
        clearInterval(timer);
        this.requestClose();
      }
    }, 500);
  }

  requestClose() {
    if (this.closed || this.closeRequested) return;
    this.closeRequested = true;
    this.send({ type: "session.close" });
    // If session.closed never arrives, release resources anyway.
    setTimeout(() => this.finalize("close_timeout"), 15_000).unref?.();
  }

  finalize(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
    this.onClosed(reason);
  }
}
