"use client";

import { useEffect } from "react";

const SECRET_PATTERN =
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;

function maskSecret(value: string, visible = 5): string {
  if (!value) return "";
  if (value.length <= visible) return "*".repeat(Math.min(value.length, 8));
  return `${value.slice(0, visible)}${"*".repeat(4)}`;
}

function sanitizeArg(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(SECRET_PATTERN, (m) => maskSecret(m))
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/token["']?\s*[:=]\s*["']?[^"'&\s]+/gi, "token=[REDACTED]")
      .replace(/onion_sid=["']?[^;"'\s]+/gi, "onion_sid=[REDACTED]")
      .replace(/onion_csrf=["']?[^;"'\s]+/gi, "onion_csrf=[REDACTED]");
  }

  if (value instanceof Error) {
    return new Error(String(sanitizeArg(value.message)));
  }

  if (value && typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (SECRET_PATTERN.test(json)) return "[REDACTED_OBJECT]";
    } catch {
      return "[UNSERIALIZABLE]";
    }
  }

  return value;
}

function wrapConsoleMethod(
  method: "log" | "info" | "warn" | "error" | "debug",
) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    if (process.env.NODE_ENV === "production") return;
    original(...args.map(sanitizeArg));
  };
}

export function ConsoleGuard() {
  useEffect(() => {
    wrapConsoleMethod("log");
    wrapConsoleMethod("info");
    wrapConsoleMethod("warn");
    wrapConsoleMethod("error");
    wrapConsoleMethod("debug");
  }, []);

  return null;
}
