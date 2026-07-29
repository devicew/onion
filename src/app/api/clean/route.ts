import { deleteMessagesFromChannel } from "@/lib/cleaner";
import { releaseJob, tryAcquireJob } from "@/lib/jobs";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  checkRateLimit,
  getClientIp,
  isAllowedOrigin,
  parseCookieHeader,
  readJsonLimited,
  safeClientError,
  validateCsrf,
  validateChannelId,
  validateDiscordToken,
  validateOptionalAccessCode,
} from "@/lib/security";

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
  if (!isAllowedOrigin(request)) {
    return jsonError("Origem não autorizada.", 403);
  }

  const cookies = parseCookieHeader(request.headers.get("cookie"));
  if (!validateCsrf(request, cookies)) {
    return jsonError("CSRF rejeitado.", 403);
  }

  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId || sessionId.length < 20) {
    return jsonError("Sessão inválida. Recarregue a página.", 401);
  }

  const ip = getClientIp(request);

  const ipLimit = checkRateLimit(`ip:${ip}`, 8, 15 * 60 * 1000);
  if (!ipLimit.ok) {
    return jsonError("Muitas tentativas. Aguarde e tente novamente.", 429, {
      "Retry-After": String(ipLimit.retryAfterSec),
    });
  }

  const sessionLimit = checkRateLimit(`sid:${sessionId}`, 5, 15 * 60 * 1000);
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

  if (!validateOptionalAccessCode(record.accessCode)) {
    return jsonError("Não autorizado.", 401);
  }

  const modeRaw = typeof record.mode === "string" ? record.mode.trim() : "dm";
  const mode = modeRaw === "guild" ? "guild" : "dm";

  // Copy then drop immediately from the record reference surface
  let token = typeof record.token === "string" ? record.token.trim() : "";
  const channelId =
    typeof record.channelId === "string" ? record.channelId.trim() : "";

  // Prevent accidental retention on the parsed object
  record.token = undefined;
  delete record.token;

  if (!token || !validateDiscordToken(token)) {
    token = "";
    return jsonError("Credenciais inválidas.", 400);
  }

  if (!channelId || !validateChannelId(channelId)) {
    token = "";
    return jsonError("ID do canal inválido.", 400);
  }

  const slot = tryAcquireJob(sessionId);
  if (!slot.ok) {
    token = "";
    return jsonError(
      "Já existe uma limpeza em andamento nesta sessão (ou o servidor está ocupado).",
      429,
    );
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), Number(process.env.CLEAN_TIMEOUT_MS ?? 240_000));

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
      } catch (err) {
        controller.enqueue(
          encode({ type: "error", error: safeClientError(err) }),
        );
      } finally {
        authToken = null;
        clearTimeout(timeout);
        releaseJob(slot.jobId);
        controller.close();
      }
    },
    cancel() {
      abort.abort();
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
      // Help clients know CSRF header name without leaking secrets
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
