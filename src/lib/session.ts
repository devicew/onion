/** Cookie/session helpers — no extra secrets beyond APP_ORIGIN/TRUST_PROXY. */
export const SESSION_COOKIE = "onion_sid";
export const CSRF_COOKIE = "onion_csrf";
export const CSRF_HEADER = "x-onion-csrf";

const SESSION_TTL_SEC = 60 * 60 * 8;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createSessionId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function createCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function readSessionId(cookieValue: string | undefined | null): string | null {
  if (!cookieValue) return null;
  const sid = cookieValue.trim();
  if (sid.length < 20 || sid.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(sid)) return null;
  return sid;
}

export function sessionCookieOptions(isProd: boolean) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  };
}

export function csrfCookieOptions(isProd: boolean) {
  return {
    httpOnly: false,
    secure: isProd,
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  };
}
