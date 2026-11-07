import { randomUUID } from "node:crypto";

type Operation = "frame" | "heartbeat";
export type AgentHttpStage =
  | "handler" | "device_auth" | "request_body" | "session_lookup"
  | "session_authorization" | "frame_write" | "authorization"
  | "runtime_write" | "presence_write" | "license_lookup" | "license_evaluation"
  | "license_state_write" | "sessions_lookup" | "session_cleanup" | "session_status_lookup"
  | "commands_lookup" | "commands_dispatch" | "notification_write";
type Outcome =
  | "ok" | "unauthorized" | "device_lookup_unavailable" | "invalid_frame"
  | "session_lookup_unavailable" | "not_found" | "video_only_session" | "not_active"
  | "session_authorization_unavailable" | "frame_write_failed" | "authorization_unavailable"
  | "invalid_runtime_report" | "runtime_reporting_unavailable" | "retired_or_stale_process"
  | "presence_write_failed" | "license_unavailable" | "license_state_write_failed"
  | "sessions_unavailable" | "session_cleanup_failed" | "notification_failed"
  | "invalid_observed_session" | "handler_exception";

const REQUEST_ID = "x-connectlive-request-id";
const WINDOW_MS = 60_000;
const MAX_PROBLEM_LOGS = 6;
// Fixed-cardinality state: never key this by a device, session, address or header.
const budgets = {
  frame: { start: -Infinity, emitted: 0, suppressed: 0, healthyAt: -Infinity },
  heartbeat: { start: -Infinity, emitted: 0, suppressed: 0, healthyAt: -Infinity },
};

type Entry = {
  scope: "agent_http"; operation: Operation; request_id: string;
  event: "complete" | "slow" | "aborted"; status: number;
  outcome: Outcome | "pending" | "client_aborted";
  elapsed_ms: number; stage: AgentHttpStage; stage_ms: number;
  stages_ms: Partial<Record<AgentHttpStage, number>>;
  suppressed: number;
};
// This imported TanStack server does not use the scaffold's Express logger.
// Accept only this closed metadata shape, never an Error/Request/Supabase row.
const logger = {
  info: (entry: Entry) => console.info(JSON.stringify(entry)),
  warn: (entry: Entry) => console.warn(JSON.stringify(entry)),
};
const millis = (value: number) => Math.min(86_400_000, Math.max(0, Math.round(value)));

export class AgentHttpTrace {
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stage: AgentHttpStage = "handler";
  private outcome: Outcome = "ok";
  private readonly timings: Partial<Record<AgentHttpStage, number>> = {};
  private readonly id: string;

  constructor(private readonly operation: Operation, request: Request) {
    const supplied = request.headers.get(REQUEST_ID);
    // IDs are random per-attempt correlation only, never device/session IDs.
    this.id = supplied && /^clh-[0-9a-f]{32}$/.test(supplied)
      ? supplied : `clh-${randomUUID().replaceAll("-", "")}`;
  }

  async step<T>(stage: AgentHttpStage, work: () => PromiseLike<T>): Promise<T> {
    this.stage = stage;
    this.stageStarted = performance.now();
    try { return await work(); }
    finally {
      this.timings[stage] = millis((this.timings[stage] ?? 0) + performance.now() - this.stageStarted);
    }
  }

  respond(response: Response, outcome: Outcome): Response {
    this.outcome = outcome;
    return response;
  }

  finish(response: Response): Response {
    response.headers.set(REQUEST_ID, this.id);
    response.headers.set("x-connectlive-server-ms", String(millis(performance.now() - this.started)));
    response.headers.set("x-connectlive-stage", this.stage);
    response.headers.set("x-connectlive-outcome", this.outcome);
    this.emit("complete", response.status);
    return response;
  }

  emit(event: Entry["event"], status = 0): void {
    // A logger must never change a request's result or its authority decisions.
    try {
      const now = performance.now();
      const elapsed = millis(now - this.started);
      const problem = event !== "complete" || status >= 400 ||
        this.outcome !== "ok" || elapsed >= (this.operation === "frame" ? 2_000 : 10_000);
      const budget = budgets[this.operation];
      if (problem) {
        if (now - budget.start >= WINDOW_MS) { budget.start = now; budget.emitted = 0; }
        if (budget.emitted >= MAX_PROBLEM_LOGS) {
          budget.suppressed = Math.min(1_000_000_000, budget.suppressed + 1);
          return;
        }
        budget.emitted++;
      } else {
        if (now - budget.healthyAt < WINDOW_MS) return;
        budget.healthyAt = now;
      }
      const entry: Entry = {
        scope: "agent_http", operation: this.operation, request_id: this.id,
        event, status, outcome: event === "slow" ? "pending" :
          event === "aborted" ? "client_aborted" : this.outcome,
        elapsed_ms: elapsed, stage: this.stage, stage_ms: millis(now - this.stageStarted),
        stages_ms: { ...this.timings }, suppressed: budget.suppressed,
      };
      budget.suppressed = 0;
      if (problem) logger.warn(entry); else logger.info(entry);
    } catch { /* Diagnostics cannot grant authority or fail a heartbeat. */ }
  }
}

/** Observe, never retry or extend deadlines. No request/response bodies are inspected. */
export async function withAgentHttpDiagnostics(
  request: Request, operation: Operation, run: (trace: AgentHttpTrace) => Promise<Response>,
): Promise<Response> {
  const trace = new AgentHttpTrace(operation, request);
  // One slow checkpoint (not an interval), including when an upstream call never resolves.
  const slow = setTimeout(() => trace.emit("slow"), operation === "frame" ? 2_000 : 10_000);
  slow.unref?.();
  const onAbort = () => trace.emit("aborted");
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.signal.aborted) onAbort();
    return trace.finish(await run(trace));
  } catch {
    // Suppress framework logging of raw upstream errors, URLs and SQL details.
    return trace.finish(trace.respond(
      Response.json({ error: "agent_request_failed" }, { status: 500 }), "handler_exception",
    ));
  } finally {
    clearTimeout(slow);
    request.signal.removeEventListener("abort", onAbort);
  }
}
