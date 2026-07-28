/** Security helpers — server-side only. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

const TOKEN_PATTERN =
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const rateMap = new Map<string, { count: number; resetAt: number }>();

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function checkRateLimit(
  key: string,
  limit = 5,
  windowMs = 15 * 60 * 1000,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const current = rateMap.get(key);

  if (!current || now >= current.resetAt) {
    rateMap.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (current.count >= limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  rateMap.set(key, current);
  return { ok: true };
}

export function isAllowedOrigin(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const allowed = new Set<string>([`http://${host}`, `https://${host}`]);

  const extra = process.env.ALLOWED_ORIGINS?.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  extra?.forEach((v) => allowed.add(v));

  if (origin) {
    try {
      const url = new URL(origin);
      return allowed.has(`${url.protocol}//${url.host}`);
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      const url = new URL(referer);
      return allowed.has(`${url.protocol}//${url.host}`);
    } catch {
      return false;
    }
  }

  return false;
}

export function validateChannelId(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}

export function validateDiscordToken(value: string): boolean {
  if (value.length < 50 || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  const parts = value.split(".");
  if (parts.length < 3) return false;
  return parts.every((part) => part.length >= 3);
}

export function redactSecrets(input: string): string {
  return input
    .replace(TOKEN_PATTERN, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/token["']?\s*[:=]\s*["']?[^"'&\s]+/gi, "token=[REDACTED]");
}

export function safeClientError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Falha ao processar a solicitação.";

  const cleaned = redactSecrets(raw).trim();

  const known: Array<[RegExp, string]> = [
    [/invalid token/i, "Credenciais inválidas."],
    [/credenciais inválidas/i, "Credenciais inválidas."],
    [/token/i, "Credenciais inválidas."],
    [/login|autenticação/i, "Falha na autenticação."],
    [/rate.?limit|too many|muitas tentativas/i, "Muitas tentativas. Aguarde e tente novamente."],
    [/não encontrado|not found|unknown/i, "Canal ou usuário não encontrado."],
    [/DM válida|Group DM/i, "O ID informado não é uma DM válida."],
  ];

  for (const [pattern, message] of known) {
    if (pattern.test(cleaned)) return message;
  }

  return "Não foi possível concluir a operação.";
}

export function assertBodySize(request: Request, maxBytes = 8_192): boolean {
  const length = request.headers.get("content-length");
  if (!length) return true;
  const size = Number(length);
  if (!Number.isFinite(size) || size < 0) return false;
  return size <= maxBytes;
}
