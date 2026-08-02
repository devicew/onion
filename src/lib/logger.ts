/** Safe structured logging — never logs tokens, cookies, or secrets. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

import { redactSecrets } from "./security";

export type JobLogEvent = {
  jobId: string;
  status: "start" | "done" | "error" | "rejected";
  durationMs?: number;
  totalDeleted?: number;
  totalFound?: number;
  mode?: string;
  reason?: string;
};

export function logJob(event: JobLogEvent): void {
  const payload = {
    scope: "onion.job",
    ts: new Date().toISOString(),
    jobId: event.jobId.slice(0, 64),
    status: event.status,
    durationMs: event.durationMs,
    totalDeleted: event.totalDeleted,
    totalFound: event.totalFound,
    mode: event.mode,
    reason: event.reason ? redactSecrets(event.reason).slice(0, 80) : undefined,
  };

  // Structured JSON only — secrets already redacted upstream
  console.info(JSON.stringify(payload));
}
