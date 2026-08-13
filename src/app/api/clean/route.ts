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
  validateCleanDirection,
  validateCleanMode,
  validateCsrf,
  validateDiscordToken,
} from "@/lib/security";
import { readSessionId, SESSION_COOKIE } from "@/lib/session";
import { abortVoiceWatch } from "@/lib/voice-sessions";
import { deleteMessagesFromChannel } from "@/lib/cleaner";

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

  const mode = validateCleanMode(record.mode);
  if (!mode) {
    return jsonError("Modo inválido.", 400);
  }

  const direction = validateCleanDirection(record.direction);
  if (!direction) {
    return jsonError("Direção inválida.", 400);
  }

  let token = typeof record.token === "string" ? record.token.trim() : "";
  const channelId =
    typeof record.channelId === "string" ? record.channelId.trim() : "";

  record.token = undefined;
  delete record.token;

  if (!token || !validateDiscordToken(token)) {
    token = "";
    await enforceRateLimit("tokenFingerprint", `bad:${ip}`);
    return jsonError("Credenciais inválidas.", 400);
  }

  if (!channelId || !validateChannelId(channelId)) {
    token = "";
    return jsonError("ID do canal inválido.", 400);
  }

  const fp = tokenFingerprint(token);
  const tokenLimit = await enforceRateLimit("tokenFingerprint", fp);
  if (!tokenLimit.ok) {
    token = "";
    return jsonError("Muitas tentativas. Aguarde e tente novamente.", 429, {
      "Retry-After": String(tokenLimit.retryAfterSec),
    });
  }

  const jobAttempt = await enforceRateLimit("jobCreate", sessionId);
  if (!jobAttempt.ok) {
    token = "";
    return jsonError("Muitas tentativas. Aguarde e tente novamente.", 429, {
      "Retry-After": String(jobAttempt.retryAfterSec),
    });
  }

  // Free any stuck voice-watch / previous clean slot for this browser session
  abortVoiceWatch(sessionId);
  releaseSessionJobs(sessionId);

  let slot = tryAcquireJob(sessionId, channelId, mode);
  if (!slot.ok) {
    releaseSessionJobs(sessionId);
    slot = tryAcquireJob(sessionId, channelId, mode);
  }
  if (!slot.ok) {
    token = "";
    logJob({
      jobId: `rej-${sessionId.slice(0, 8)}`,
      status: "rejected",
      reason: slot.reason,
      mode,
      durationMs: Date.now() - startedAt,
    });
    return jsonError("Servidor ocupado. Tente novamente em instantes.", 429);
  }

  const abort = new AbortController();
  // Align with Vercel maxDuration (~300s); client can Continuar afterwards
  const timeout = setTimeout(() => abort.abort("timeout"), 290_000);

  logJob({
    jobId: slot.jobId,
    status: "start",
    mode,
  });

  const stream = new ReadableStream({
    async start(controller) {
      let authToken: string | null = token;
      token = "";

      try {
        controller.enqueue(encode({ type: "start" }));

        const result = await deleteMessagesFromChannel(
          authToken as string,
          channelId,
          {
            mode,
            direction,
            signal: abort.signal,
            onProgress: (info) => {
              controller.enqueue(
                encode({
                  type: "progress",
                  phase: info.phase,
                  totalDeleted: info.totalDeleted,
                  total: info.total,
                  remaining: info.remaining,
                  percent: info.percent,
                }),
              );
            },
          },
        );

        controller.enqueue(
          encode({
            type: "done",
            ok: true,
            totalDeleted: result.totalDeleted,
            total: result.total,
            percent: 100,
          }),
        );

        logJob({
          jobId: slot.jobId,
          status: "done",
          mode,
          durationMs: Date.now() - startedAt,
          totalDeleted: result.totalDeleted,
          totalFound: result.total,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        if (raw === "PAUSADO") {
          controller.enqueue(
            encode({
              type: "paused",
              error: "Limpeza pausada.",
            }),
          );
          logJob({
            jobId: slot.jobId,
            status: "done",
            mode,
            durationMs: Date.now() - startedAt,
            reason: "paused",
          });
        } else if (raw === "TEMPO_LIMITE") {
          controller.enqueue(
            encode({
              type: "partial",
              error:
                "Tempo da sessão esgotado. Continue para seguir apagando.",
            }),
          );
          logJob({
            jobId: slot.jobId,
            status: "done",
            mode,
            durationMs: Date.now() - startedAt,
            reason: "timeout_partial",
          });
        } else {
          controller.enqueue(
            encode({ type: "error", error: safeClientError(err) }),
          );
          logJob({
            jobId: slot.jobId,
            status: "error",
            mode,
            durationMs: Date.now() - startedAt,
            reason: "job_failed",
          });
        }
      } finally {
        authToken = null;
        clearTimeout(timeout);
        releaseJob(slot.jobId);
        controller.close();
      }
    },
    cancel() {
      abort.abort("pause");
      clearTimeout(timeout);
      releaseJob(slot.jobId);
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

export function PUT() {
  return jsonError("Método não permitido.", 405);
}

export function DELETE() {
  return jsonError("Método não permitido.", 405);
}

export function PATCH() {
  return jsonError("Método não permitido.", 405);
}
