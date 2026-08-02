/** In-memory rate limits (no extra env vars). Server-only. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

export type RateLimitResult =
  | { ok: true; remaining?: number }
  | { ok: false; retryAfterSec: number };

type MemoryBucket = { count: number; resetAt: number };
const memoryMap = new Map<string, MemoryBucket>();

const LIMITS = {
  cleanIp: { requests: 8, windowMs: 15 * 60 * 1000 },
  cleanSession: { requests: 5, windowMs: 15 * 60 * 1000 },
  tokenFingerprint: { requests: 4, windowMs: 15 * 60 * 1000 },
  jobCreate: { requests: 6, windowMs: 10 * 60 * 1000 },
} as const;

export type RateLimitKind = keyof typeof LIMITS;

export async function enforceRateLimit(
  kind: RateLimitKind,
  identifier: string,
): Promise<RateLimitResult> {
  const safeId = identifier.slice(0, 128) || "unknown";
  const cfg = LIMITS[kind];
  const key = `${kind}:${safeId}`;
  const now = Date.now();

  if (memoryMap.size > 5_000) {
    for (const [k, v] of memoryMap) {
      if (now >= v.resetAt) memoryMap.delete(k);
    }
  }

  const current = memoryMap.get(key);
  if (!current || now >= current.resetAt) {
    memoryMap.set(key, { count: 1, resetAt: now + cfg.windowMs });
    return { ok: true, remaining: cfg.requests - 1 };
  }

  if (current.count >= cfg.requests) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  memoryMap.set(key, current);
  return { ok: true, remaining: cfg.requests - current.count };
}
