/** In-process job concurrency. No token storage. Server-only. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

import { createHash } from "crypto";

type LocalJob = {
  sessionId: string;
  fingerprint: string;
  startedAt: number;
};

const localJobs = new Map<string, LocalJob>();
const sessionLocalCount = new Map<string, number>();

const MAX_GLOBAL_JOBS = 12;
const MAX_SESSION_JOBS = 1;
const JOB_TTL_MS = 240_000 + 60_000;

export function jobFingerprint(
  sessionId: string,
  channelId: string,
  mode: string,
): string {
  return createHash("sha256")
    .update(`${sessionId}|${channelId}|${mode}`)
    .digest("hex")
    .slice(0, 32);
}

function purgeLocal(now = Date.now()) {
  for (const [id, job] of localJobs) {
    if (now - job.startedAt > JOB_TTL_MS) {
      releaseJob(id);
    }
  }
}

export function tryAcquireJob(
  sessionId: string,
  channelId: string,
  mode: string,
): { ok: true; jobId: string } | { ok: false; reason: string } {
  purgeLocal();
  const fingerprint = jobFingerprint(sessionId, channelId, mode);

  for (const job of localJobs.values()) {
    if (job.fingerprint === fingerprint) {
      return { ok: false, reason: "duplicate" };
    }
  }

  if (localJobs.size >= MAX_GLOBAL_JOBS) {
    return { ok: false, reason: "global_full" };
  }

  const current = sessionLocalCount.get(sessionId) ?? 0;
  if (current >= MAX_SESSION_JOBS) {
    return { ok: false, reason: "session_busy" };
  }

  const jobId = `${sessionId.slice(0, 12)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  localJobs.set(jobId, {
    sessionId,
    fingerprint,
    startedAt: Date.now(),
  });
  sessionLocalCount.set(sessionId, current + 1);
  return { ok: true, jobId };
}

export function releaseJob(jobId: string): void {
  const job = localJobs.get(jobId);
  if (!job) return;
  localJobs.delete(jobId);
  const current = sessionLocalCount.get(job.sessionId) ?? 0;
  if (current <= 1) sessionLocalCount.delete(job.sessionId);
  else sessionLocalCount.set(job.sessionId, current - 1);
}
