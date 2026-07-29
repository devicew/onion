/** Server-only security helpers. Never import from client components. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const CSRF_COOKIE = "onion_csrf";
export const SESSION_COOKIE = "onion_sid";
export const CSRF_HEADER = "x-onion-csrf";

const TOKEN_PATTERN =
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const rateMap = new Map<string, { count: number; resetAt: number }>();

export function createRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Only trust forwarded IP headers when behind a known proxy (e.g. Vercel). */
export function getClientIp(request: Request): string {
  const trustProxy =
    process.env.TRUST_PROXY === "1" || process.env.VERCEL === "1";

  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
      return parts[0] || "unknown";
    }
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  return "direct";
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
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

export function getAppOrigins(): Set<string> {
  const configured = process.env.APP_ORIGIN?.trim();
  const extras = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const origins = new Set<string>(extras);

  if (configured) {
    origins.add(configured.replace(/\/$/, ""));
  }

  // Vercel injects these automatically on deploy
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    origins.add(`https://${vercelUrl.replace(/^https?:\/\//, "")}`);
  }

  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) {
    origins.add(`https://${vercelProd.replace(/^https?:\/\//, "")}`);
  }

  if (origins.size === 0 && process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }

  return origins;
}

export function isAllowedOrigin(request: Request): boolean {
  const allowed = getAppOrigins();
  if (allowed.size === 0) return false;

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      return allowed.has(`${url.protocol}//${url.host}`);
    } catch {
      return false;
    }
  }

  // Same-origin form posts should send Origin in modern browsers.
  // Reject missing Origin for credential-bearing API calls.
  return false;
}

export function validateChannelId(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}

export function validateDiscordToken(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 50 || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  if (value.length > 180) return false;
  const parts = value.split(".");
  if (parts.length < 3 || parts.length > 3) return false;
  return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part) && part.length >= 3);
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
    [/invalid token|credenciais inválidas/i, "Credenciais inválidas."],
    [/token/i, "Credenciais inválidas."],
    [/login|autenticação/i, "Falha na autenticação."],
    [/rate.?limit|too many|muitas tentativas/i, "Muitas tentativas. Aguarde e tente novamente."],
    [/não encontrado|not found|unknown channel/i, "Canal ou usuário não encontrado."],
    [/DM válida|Group DM/i, "O ID informado não é uma DM válida."],
    [/canal de texto\/voz|servidor válido|não permite limpeza/i, "Canal de servidor inválido."],
    [/missing permissions|missing access|forbidden|50013|50001/i, "Sem permissão para apagar mensagens neste canal."],
    [/limite|timeout|tempo esgotado/i, "Operação excedeu o limite permitido."],
    [/código de acesso|access code/i, "Código de acesso inválido."],
  ];

  for (const [pattern, message] of known) {
    if (pattern.test(cleaned)) return message;
  }

  return "Não foi possível concluir a operação.";
}

export async function readJsonLimited(
  request: Request,
  maxBytes = 8_192,
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string }
> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const size = Number(lengthHeader);
    if (!Number.isFinite(size) || size < 0 || size > maxBytes) {
      return { ok: false, status: 413, error: "Requisição muito grande." };
    }
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return { ok: false, status: 413, error: "Requisição muito grande." };
  }

  try {
    const text = new TextDecoder("utf-8").decode(buffer);
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Corpo da requisição inválido." };
  }
}

export function parseCookieHeader(
  cookieHeader: string | null,
): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

export function validateCsrf(
  request: Request,
  cookies: Record<string, string>,
): boolean {
  const header = request.headers.get(CSRF_HEADER)?.trim() ?? "";
  const cookie = cookies[CSRF_COOKIE]?.trim() ?? "";
  if (!header || !cookie) return false;
  if (header.length < 24 || cookie.length < 24) return false;
  return safeEqual(header, cookie);
}

/** Optional shared access code for multi-user gate (not Discord token).
 * Only enforced when REQUIRE_ACCESS_CODE=1 AND ONION_ACCESS_CODE is set.
 */
export function validateOptionalAccessCode(provided: unknown): boolean {
  if (process.env.REQUIRE_ACCESS_CODE !== "1") return true;

  const required = process.env.ONION_ACCESS_CODE?.trim();
  if (!required) return true;
  if (typeof provided !== "string" || !provided.trim()) return false;
  return safeEqual(provided.trim(), required);
}

export function wipeString(value: string): void {
  // Best-effort: JS strings are immutable; caller must drop references.
  void value;
}
