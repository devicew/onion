import { deleteMessagesFromChannel } from "@/lib/cleaner";
import {
  assertBodySize,
  checkRateLimit,
  getClientIp,
  isAllowedOrigin,
  safeClientError,
  validateChannelId,
  validateDiscordToken,
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
  if (!assertBodySize(request)) {
    return jsonError("Requisição muito grande.", 413);
  }

  if (!isAllowedOrigin(request)) {
    return jsonError("Origem não autorizada.", 403);
  }

  const ip = getClientIp(request);
  const limited = checkRateLimit(`clean:${ip}`, 5, 15 * 60 * 1000);
  if (!limited.ok) {
    return jsonError("Muitas tentativas. Aguarde e tente novamente.", 429, {
      "Retry-After": String(limited.retryAfterSec),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Corpo da requisição inválido.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Corpo da requisição inválido.", 400);
  }

  const record = body as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const channelId =
    typeof record.channelId === "string" ? record.channelId.trim() : "";

  // Drop unexpected fields — never trust extra payload data
  if (!token || !validateDiscordToken(token)) {
    return jsonError("Credenciais inválidas.", 400);
  }

  if (!channelId || !validateChannelId(channelId)) {
    return jsonError("ID do canal inválido.", 400);
  }

  const stream = new ReadableStream({
    async start(controller) {
      let authToken = token;

      try {
        controller.enqueue(encode({ type: "start" }));

        const result = await deleteMessagesFromChannel(authToken, channelId, {
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
        });

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
        authToken = "";
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-cache, no-transform",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
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
