"use client";

import { useEffect } from "react";

const SECRET_PATTERN =
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;

function sanitizeArg(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(SECRET_PATTERN, "[REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  }

  if (value instanceof Error) {
    return sanitizeArg(value.message);
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
