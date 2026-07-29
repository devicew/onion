/** In-process session/job limits. No token storage. Server-only. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

type JobSlot = {
  sessionId: string;
  startedAt: number;
};

const activeJobs = new Map<string, JobSlot>();
const sessionActiveCount = new Map<string, number>();

const MAX_GLOBAL_JOBS = Number(process.env.MAX_GLOBAL_JOBS ?? 20);
const MAX_SESSION_JOBS = Number(process.env.MAX_SESSION_JOBS ?? 1);

export function tryAcquireJob(sessionId: string): { ok: true; jobId: string } | { ok: false } {
  // purge stale (>10 min)
  const now = Date.now();
  for (const [id, job] of activeJobs) {
    if (now - job.startedAt > 10 * 60 * 1000) {
      releaseJob(id);
    }
  }

  if (activeJobs.size >= MAX_GLOBAL_JOBS) return { ok: false };

  const current = sessionActiveCount.get(sessionId) ?? 0;
  if (current >= MAX_SESSION_JOBS) return { ok: false };

  const jobId = `${sessionId}:${now}:${Math.random().toString(36).slice(2, 10)}`;
  activeJobs.set(jobId, { sessionId, startedAt: now });
  sessionActiveCount.set(sessionId, current + 1);
  return { ok: true, jobId };
}

export function releaseJob(jobId: string): void {
  const job = activeJobs.get(jobId);
  if (!job) return;
  activeJobs.delete(jobId);
  const current = sessionActiveCount.get(job.sessionId) ?? 0;
  if (current <= 1) sessionActiveCount.delete(job.sessionId);
  else sessionActiveCount.set(job.sessionId, current - 1);
}
