"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./cleaner-form.module.css";

export type CleanMode = "dm" | "guild";
export type CleanDirection = "newest" | "oldest";

type Status =
  | { kind: "idle" }
  | {
      kind: "loading";
      percent: number;
      totalDeleted: number;
    }
  | {
      kind: "paused";
      totalDeleted: number;
      message: string;
    }
  | {
      kind: "success";
      percent: number;
      totalDeleted: number;
      total: number;
    }
  | { kind: "error"; message: string };

type RunOutcome = "done" | "paused" | "partial" | "error";

const SAFE_ERROR = "Não foi possível concluir a operação.";
const SUCCESS_VISIBLE_MS = 3000;
const CSRF_COOKIE = "onion_csrf";
const CSRF_HEADER = "x-onion-csrf";

function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return "";
  return decodeURIComponent(match.slice(name.length + 1));
}

function clearInput(input: HTMLInputElement | null) {
  if (!input) return;
  input.value = "";
}

export function CleanerForm({ mode = "dm" }: { mode?: CleanMode }) {
  const tokenRef = useRef<HTMLInputElement>(null);
  /** Kept only while a job can be resumed (pause / timeout). Cleared on success/unmount. */
  const resumeTokenRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const sessionDeletedRef = useRef(0);

  const [channelId, setChannelId] = useState("");
  const [direction, setDirection] = useState<CleanDirection>("oldest");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGuild = mode === "guild";

  useEffect(() => {
    const tokenInput = tokenRef.current;
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      abortRef.current?.abort("pause");
      resumeTokenRef.current = "";
      clearInput(tokenInput);
    };
  }, []);

  function pauseClean() {
    abortRef.current?.abort("pause");
  }

  async function runCleanBatch(
    authToken: string,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const targetChannelId = channelId.trim();
    const csrf = readCookie(CSRF_COOKIE);
    let requestBody: string | null = JSON.stringify({
      token: authToken,
      channelId: targetChannelId,
      mode,
      direction,
    });

    try {
      const response = await fetch("/api/clean", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          [CSRF_HEADER]: csrf,
        },
        cache: "no-store",
        credentials: "same-origin",
        body: requestBody,
        signal,
      });

      requestBody = null;

      if (!response.ok || !response.body) {
        let message = SAFE_ERROR;
        try {
          const data = await response.json();
          if (typeof data?.error === "string" && data.error.length < 120) {
            message = data.error;
          }
        } catch {
          // keep default
        }
        resumeTokenRef.current = "";
        setStatus({ kind: "error", message });
        return "error";
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let outcome: RunOutcome | null = null;
      let lastDeleted = sessionDeletedRef.current;
      let batchBase = sessionDeletedRef.current;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let event: {
            type?: string;
            totalDeleted?: number;
            percent?: number;
            error?: string;
          };

          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "progress") {
            const batchDeleted = event.totalDeleted ?? 0;
            const totalDeleted = batchBase + batchDeleted;
            lastDeleted = totalDeleted;
            const percent = Math.max(
              0,
              Math.min(
                99,
                typeof event.percent === "number" ? event.percent : 0,
              ),
            );
            setStatus({ kind: "loading", percent, totalDeleted });
          }

          if (event.type === "done") {
            const batchDeleted = event.totalDeleted ?? 0;
            lastDeleted = batchBase + batchDeleted;
            outcome = "done";
          }

          if (event.type === "paused") {
            sessionDeletedRef.current = lastDeleted;
            outcome = "paused";
          }

          if (event.type === "partial") {
            sessionDeletedRef.current = lastDeleted;
            outcome = "partial";
          }

          if (event.type === "error") {
            resumeTokenRef.current = "";
            sessionDeletedRef.current = 0;
            setStatus({
              kind: "error",
              message:
                typeof event.error === "string" && event.error.length < 120
                  ? event.error
                  : SAFE_ERROR,
            });
            outcome = "error";
          }
        }
      }

      if (outcome === "done") {
        sessionDeletedRef.current = 0;
        resumeTokenRef.current = "";
        setStatus({
          kind: "success",
          percent: 100,
          totalDeleted: lastDeleted,
          total: lastDeleted,
        });
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => {
          setStatus({ kind: "idle" });
          successTimerRef.current = null;
        }, SUCCESS_VISIBLE_MS);
        return "done";
      }

      if (outcome === "paused") {
        setStatus({
          kind: "paused",
          totalDeleted: lastDeleted,
          message: "Limpeza pausada. Clique em Continuar para retomar.",
        });
        return "paused";
      }

      if (outcome === "partial") {
        setStatus({
          kind: "loading",
          percent: 99,
          totalDeleted: lastDeleted,
        });
        return "partial";
      }

      if (outcome === "error") return "error";

      if (signal.aborted) {
        sessionDeletedRef.current = lastDeleted;
        setStatus({
          kind: "paused",
          totalDeleted: lastDeleted,
          message: "Limpeza pausada. Clique em Continuar para retomar.",
        });
        return "paused";
      }

      resumeTokenRef.current = "";
      setStatus({ kind: "error", message: SAFE_ERROR });
      return "error";
    } catch (err) {
      requestBody = null;
      if (err instanceof DOMException && err.name === "AbortError") {
        setStatus({
          kind: "paused",
          totalDeleted: sessionDeletedRef.current,
          message: "Limpeza pausada. Clique em Continuar para retomar.",
        });
        return "paused";
      }
      resumeTokenRef.current = "";
      setStatus({
        kind: "error",
        message: "Falha de conexão com o servidor.",
      });
      return "error";
    }
  }

  /** Keeps going automatically until history is exhausted (or user pauses). */
  async function runClean(authToken: string) {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    const targetChannelId = channelId.trim();
    if (!authToken || !targetChannelId) {
      setStatus({ kind: "error", message: "Preencha token e ID do canal." });
      return;
    }

    resumeTokenRef.current = authToken;
    if (tokenRef.current) tokenRef.current.value = "";

    setStatus({
      kind: "loading",
      percent: 0,
      totalDeleted: sessionDeletedRef.current,
    });

    // Auto-continue across serverless time limits until finished
    for (let round = 0; round < 500; round++) {
      const abort = new AbortController();
      abortRef.current = abort;

      const outcome = await runCleanBatch(authToken, abort.signal);
      abortRef.current = null;

      if (outcome === "partial") {
        // Seamless restart — no user click
        continue;
      }
      break;
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const fromInput = tokenRef.current?.value.trim() ?? "";
    const authToken = fromInput || resumeTokenRef.current;
    if (fromInput) sessionDeletedRef.current = 0;

    await runClean(authToken);
  }

  async function onContinue() {
    const authToken = resumeTokenRef.current;
    if (!authToken) {
      setStatus({
        kind: "error",
        message: "Cole o token novamente para continuar.",
      });
      return;
    }
    await runClean(authToken);
  }

  const showProgress = status.kind === "loading";
  const percent = status.kind === "loading" ? status.percent : 0;
  const totalDeleted =
    status.kind === "loading" || status.kind === "paused"
      ? status.totalDeleted
      : status.kind === "success"
        ? status.totalDeleted
        : 0;

  const isSuccess = status.kind === "success";
  const isLoading = status.kind === "loading";
  const isPaused = status.kind === "paused";
  const fieldsLocked = isLoading || isSuccess;

  return (
    <form
      className={styles.form}
      onSubmit={onSubmit}
      autoComplete="off"
      data-form-type="other"
    >
      <div
        className={styles.directionChips}
        role="radiogroup"
        aria-label="Ordem da limpeza"
      >
        <button
          type="button"
          className={`${styles.directionChip} ${
            direction === "oldest" ? styles.directionChipActive : ""
          }`}
          aria-pressed={direction === "oldest"}
          title="De cima pra baixo"
          disabled={fieldsLocked}
          onClick={() => setDirection("oldest")}
        >
          ↓
        </button>
        <button
          type="button"
          className={`${styles.directionChip} ${
            direction === "newest" ? styles.directionChipActive : ""
          }`}
          aria-pressed={direction === "newest"}
          title="De baixo pra cima"
          disabled={fieldsLocked}
          onClick={() => setDirection("newest")}
        >
          ↑
        </button>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Token da conta</span>
        <input
          ref={tokenRef}
          className={styles.input}
          type="password"
          name="onion-auth"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          placeholder={
            isPaused
              ? "Token guardado para continuar (ou cole de novo)"
              : "Cole o token aqui"
          }
          required={!isPaused}
          disabled={fieldsLocked}
        />
        <span className={styles.helper}>
          O token fica só nesta sessão para pausar e é apagado ao concluir.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>
          {isGuild ? "ID do canal do servidor" : "ID do canal"}
        </span>
        <input
          className={styles.input}
          type="text"
          name="onion-channel"
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={
            isGuild
              ? "ID do canal de texto ou chat de voz"
              : "ID do canal ou do usuário"
          }
          value={channelId}
          onChange={(e) => setChannelId(e.target.value.replace(/\D/g, ""))}
          required
          disabled={fieldsLocked}
        />
        <span className={styles.helper}>
          {isGuild
            ? "Canal de texto, anúncio ou chat de texto de um canal de voz."
            : "Aceita ID da DM ou ID do usuário."}
        </span>
      </label>

      <div className={styles.actions}>
        {!isPaused && (
          <button
            className={`${styles.submit} ${isSuccess ? styles.submitSuccess : ""}`}
            type="submit"
            disabled={fieldsLocked}
          >
            <span className={styles.submitInner}>
              {isSuccess && (
                <svg
                  className={styles.submitCheck}
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              <span className={styles.submitLabel}>
                {isSuccess
                  ? "Concluído"
                  : isLoading
                    ? "Limpando…"
                    : isGuild
                      ? "Limpar canal"
                      : "Limpar mensagens"}
              </span>
            </span>
          </button>
        )}

        {isLoading && (
          <button
            className={styles.pauseBtn}
            type="button"
            onClick={pauseClean}
          >
            Pausar
          </button>
        )}

        {isPaused && (
          <>
            <button
              className={styles.submit}
              type="button"
              onClick={onContinue}
            >
              Continuar limpeza
            </button>
            <button
              className={styles.pauseBtn}
              type="button"
              onClick={() => {
                resumeTokenRef.current = "";
                sessionDeletedRef.current = 0;
                clearInput(tokenRef.current);
                setStatus({ kind: "idle" });
              }}
            >
              Cancelar
            </button>
          </>
        )}
      </div>

      {(showProgress || isPaused) && (
        <div className={styles.progressBlock}>
          <div className={styles.progressMeta}>
            <span>{isPaused ? "Pausado" : "Removendo mensagens…"}</span>
            <span>{isPaused ? "—" : `${percent}%`}</span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={isPaused ? undefined : percent}
          >
            <div
              className={styles.progressFill}
              style={{ width: isPaused ? "100%" : `${percent}%` }}
            />
          </div>
          <p className={styles.progressCount}>
            {`${totalDeleted} removida${totalDeleted === 1 ? "" : "s"}`}
          </p>
        </div>
      )}

      <div className={styles.status} aria-live="polite">
        {status.kind === "error" && (
          <p className={styles.error}>{status.message}</p>
        )}
        {status.kind === "paused" && (
          <p className={styles.error}>{status.message}</p>
        )}
      </div>
    </form>
  );
}
