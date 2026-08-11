import { releaseJob, releaseSessionJobs, tryAcquireJob } from "@/lib/jobs";
import { logJob } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  CSRF_HEADER,
  getClientIp,
  isAllowedOrigin,
  parseCookieHeader,
  readJsonLimited,
  safeClientError,
  tokenFingerprint,
  validateChannelId,
  validateCsrf,
  validateDiscordToken,
} from "@/lib/security";
import { readSessionId, SESSION_COOKIE } from "@/lib/session";
import { clearVoiceWatch, replaceVoiceWatch } from "@/lib/voice-sessions";
import { watchFriendVoice } from "@/lib/voice-watch";

export const runtime = "nodejs";
export const maxDuration = 300;

function encode(data: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(data)}\n`);
}

function jsonError(message: string, status: number, extra?: HeadersInit) {
  return Response.json(
    { ok: false, error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...extra,
      },
    },
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  if (!isAllowedOrigin(request)) {
    return jsonError("Origem não autorizada.", 403);
  }

  const cookies = parseCookieHeader(request.headers.get("cookie"));
  if (!validateCsrf(request, cookies)) {
    return jsonError("CSRF rejeitado.", 403);
  }

  const sessionId = readSessionId(cookies[SESSION_COOKIE]);
  if (!sessionId) {
    return jsonError("Sessão inválida. Recarregue a página.", 401);
  }

  const ip = getClientIp(request);

  const ipLimit = await enforceRateLimit("cleanIp", ip);
  if (!ipLimit.ok) {
    return jsonError("Muitas tentativas. Aguarde e tente novamente.", 429, {
      "Retry-After": String(ipLimit.retryAfterSec),
    });
  }

  const sessionLimit = await enforceRateLimit("cleanSession", sessionId);
  if (!sessionLimit.ok) {
    return jsonError("Limite da sessão atingido. Aguarde e tente novamente.", 429, {
      "Retry-After": String(sessionLimit.retryAfterSec),
    });
  }

  const parsed = await readJsonLimited(request, 8_192);
  if (!parsed.ok) {
    return jsonError(parsed.error, parsed.status);
  }

  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return jsonError("Corpo da requisição inválido.", 400);
  }

  const record = parsed.data as Record<string, unknown>;

  let token = typeof record.token === "string" ? record.token.trim() : "";
  const userId =
    typeof record.userId === "string" ? record.userId.trim() : "";

  record.token = undefined;
  delete record.token;

  if (!token || !validateDiscordToken(token)) {
    token = "";
    return jsonError("Credenciais inválidas.", 400);
  }

  if (!userId || !validateChannelId(userId)) {
    token = "";
    return jsonError("ID do usuário inválido.", 400);
  }

  const fp = tokenFingerprint(token);
  const tokenLimit = await enforceRateLimit("tokenFingerprint", fp);
  if (!tokenLimit.ok) {
    token = "";
    return jsonError("Muitas tentativas. Aguarde e tente novamente.", 429, {
      "Retry-After": String(tokenLimit.retryAfterSec),
    });
  }

  // Replace any previous watch on this browser session (reload / new friend ID)
  const abort = new AbortController();
  replaceVoiceWatch(sessionId, abort, "pending");
  releaseSessionJobs(sessionId);

  let slot = tryAcquireJob(sessionId, `voice:${userId}`, "voice");
  if (!slot.ok) {
    releaseSessionJobs(sessionId);
    slot = tryAcquireJob(sessionId, `voice:${userId}`, "voice");
  }
  if (!slot.ok) {
    token = "";
    clearVoiceWatch(sessionId, "pending");
    return jsonError("Servidor ocupado. Tente novamente em instantes.", 429);
  }

  replaceVoiceWatch(sessionId, abort, slot.jobId);

  return startVoiceStream({
    abort,
    jobId: slot.jobId,
    token,
    userId,
    sessionId,
    startedAt,
  });
}

function startVoiceStream(args: {
  abort: AbortController;
  jobId: string;
  token: string;
  userId: string;
  sessionId: string;
  startedAt: number;
}) {
  const { abort, jobId, userId, sessionId, startedAt } = args;
  let token = args.token;
  const timeout = setTimeout(() => abort.abort("timeout"), 290_000);

  logJob({
    jobId,
    status: "start",
    mode: "voice",
  });

  const stream = new ReadableStream({
    async start(controller) {
      let authToken: string | null = token;
      token = "";

      try {
        controller.enqueue(encode({ type: "start" }));

        await watchFriendVoice(authToken as string, userId, {
          signal: abort.signal,
          onReady: (info) => {
            controller.enqueue(
              encode({
                type: "ready",
                observerId: info.observerId,
                targetUserId: info.targetUserId,
                alreadyInCall: info.alreadyInCall,
              }),
            );
          },
          onAlert: (alert) => {
            controller.enqueue(
              encode({
                type: "alert",
                kind: alert.kind,
                userId: alert.userId,
                username: alert.username,
                guildId: alert.guildId,
                guildName: alert.guildName,
                channelId: alert.channelId,
                channelName: alert.channelName,
                at: alert.at,
              }),
            );
          },
        });

        controller.enqueue(encode({ type: "done" }));
        logJob({
          jobId,
          status: "done",
          mode: "voice",
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        if (raw === "PAUSADO") {
          controller.enqueue(encode({ type: "stopped" }));
          logJob({
            jobId,
            status: "done",
            mode: "voice",
            durationMs: Date.now() - startedAt,
            reason: "stopped",
          });
        } else if (raw === "TEMPO_LIMITE") {
          controller.enqueue(encode({ type: "partial" }));
          logJob({
            jobId,
            status: "done",
            mode: "voice",
            durationMs: Date.now() - startedAt,
            reason: "timeout_partial",
          });
        } else {
          controller.enqueue(
            encode({ type: "error", error: safeClientError(err) }),
          );
          logJob({
            jobId,
            status: "error",
            mode: "voice",
            durationMs: Date.now() - startedAt,
            reason: "job_failed",
          });
        }
      } finally {
        authToken = null;
        clearTimeout(timeout);
        clearVoiceWatch(sessionId, jobId);
        releaseJob(jobId);
        controller.close();
      }
    },
    cancel() {
      abort.abort("pause");
      clearTimeout(timeout);
      clearVoiceWatch(sessionId, jobId);
      releaseJob(jobId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-cache, no-transform",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Expose-Headers": CSRF_HEADER,
    },
  });
}

export function GET() {
  return jsonError("Método não permitido.", 405);
}
