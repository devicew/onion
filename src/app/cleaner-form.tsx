"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./cleaner-form.module.css";

type CleanMode = "dm" | "guild";

type Status =
  | { kind: "idle" }
  | {
      kind: "loading";
      phase: "scanning" | "deleting";
      percent: number;
      totalDeleted: number;
      total: number;
      remaining: number;
    }
  | {
      kind: "success";
      percent: number;
      totalDeleted: number;
      total: number;
    }
  | { kind: "error"; message: string };

const SAFE_ERROR = "Não foi possível concluir a operação.";
const SUCCESS_VISIBLE_MS = 3000;
const CSRF_COOKIE = "onion_csrf";
const CSRF_HEADER = "x-onion-csrf";

const EXTRA_OPTIONS = [
  {
    id: "guild" as const,
    title: "CL em servidor",
    description: "Limpa suas mensagens em canal de texto ou chat de voz.",
    available: true,
  },
  {
    id: "friends" as const,
    title: "CL em amigos",
    description: "Em breve.",
    available: false,
  },
  {
    id: "groups" as const,
    title: "CL em grupos",
    description: "Em breve.",
    available: false,
  },
  {
    id: "export" as const,
    title: "Exportar histórico",
    description: "Em breve.",
    available: false,
  },
];

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

export function CleanerForm() {
  const tokenRef = useRef<HTMLInputElement>(null);
  const [channelId, setChannelId] = useState("");
  const [mode, setMode] = useState<CleanMode>("dm");
  const [moreOpen, setMoreOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      clearInput(tokenRef.current);
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const tokenInput = tokenRef.current;
    const authToken = tokenInput?.value.trim() ?? "";
    const targetChannelId = channelId.trim();

    clearInput(tokenInput);

    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    setStatus({
      kind: "loading",
      phase: "scanning",
      percent: 0,
      totalDeleted: 0,
      total: 0,
      remaining: 0,
    });

    const csrf = readCookie(CSRF_COOKIE);
    let requestBody: string | null = JSON.stringify({
      token: authToken,
      channelId: targetChannelId,
      mode,
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
        setStatus({ kind: "error", message });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishedOk = false;
      let sawError = false;

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
            phase?: "scanning" | "deleting";
            totalDeleted?: number;
            total?: number;
            remaining?: number;
            percent?: number;
            error?: string;
          };

          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "progress") {
            const phase = event.phase ?? "deleting";
            const totalDeleted = event.totalDeleted ?? 0;
            const total = event.total ?? 0;
            const remaining =
              event.remaining ?? Math.max(total - totalDeleted, 0);
            const percent =
              phase === "deleting" && total > 0
                ? Math.max(
                    0,
                    Math.min(
                      100,
                      event.percent ??
                        Math.round((totalDeleted / total) * 100),
                    ),
                  )
                : 0;

            setStatus({
              kind: "loading",
              phase,
              percent,
              totalDeleted,
              total,
              remaining,
            });
          }

          if (event.type === "done") {
            finishedOk = true;
            setStatus({
              kind: "success",
              percent: 100,
              totalDeleted: event.totalDeleted ?? 0,
              total: event.total ?? event.totalDeleted ?? 0,
            });

            if (successTimerRef.current) clearTimeout(successTimerRef.current);
            successTimerRef.current = setTimeout(() => {
              setStatus({ kind: "idle" });
              successTimerRef.current = null;
            }, SUCCESS_VISIBLE_MS);
          }

          if (event.type === "error") {
            sawError = true;
            setStatus({
              kind: "error",
              message:
                typeof event.error === "string" && event.error.length < 120
                  ? event.error
                  : SAFE_ERROR,
            });
          }
        }
      }

      if (!finishedOk && !sawError) {
        setStatus({ kind: "error", message: SAFE_ERROR });
      }
    } catch {
      requestBody = null;
      setStatus({
        kind: "error",
        message: "Falha de conexão com o servidor.",
      });
    } finally {
      requestBody = null;
      clearInput(tokenInput);
    }
  }

  const showProgress = status.kind === "loading";
  const percent = status.kind === "loading" ? status.percent : 0;
  const totalDeleted = status.kind === "loading" ? status.totalDeleted : 0;
  const total = status.kind === "loading" ? status.total : 0;
  const remaining = status.kind === "loading" ? status.remaining : 0;

  const isSuccess = status.kind === "success";
  const isLoading = status.kind === "loading";
  const fieldsLocked = isLoading || isSuccess;
  const isGuild = mode === "guild";

  return (
    <form
      className={styles.form}
      onSubmit={onSubmit}
      autoComplete="off"
      data-form-type="other"
    >
      <div className={styles.modeBar}>
        <button
          type="button"
          className={`${styles.modeChip} ${!isGuild ? styles.modeChipActive : ""}`}
          onClick={() => setMode("dm")}
          disabled={fieldsLocked}
        >
          CL em DM
        </button>
        {isGuild && (
          <button
            type="button"
            className={`${styles.modeChip} ${styles.modeChipActive}`}
            onClick={() => setMode("guild")}
            disabled={fieldsLocked}
          >
            CL em servidor
          </button>
        )}
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
          placeholder="Cole o token aqui"
          required
          disabled={fieldsLocked}
        />
        <span className={styles.helper}>
          O token é usado só nesta requisição e limpo da tela ao enviar.
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

      {showProgress && (
        <div className={styles.progressBlock}>
          <div className={styles.progressMeta}>
            <span>
              {status.phase === "scanning"
                ? "Mapeando mensagens…"
                : "Removendo mensagens…"}
            </span>
            <span>{percent}%</span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className={styles.progressFill}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className={styles.progressCount}>
            {status.phase === "scanning"
              ? "Contando suas mensagens no canal"
              : total > 0
                ? `${totalDeleted} / ${total} · ${remaining} restante${remaining === 1 ? "" : "s"}`
                : `${totalDeleted} removida${totalDeleted === 1 ? "" : "s"}`}
          </p>
        </div>
      )}

      <div className={styles.status} aria-live="polite">
        {status.kind === "error" && (
          <p className={styles.error}>{status.message}</p>
        )}
      </div>

      <div className={styles.moreOptions}>
        <button
          type="button"
          className={styles.moreToggle}
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          disabled={fieldsLocked}
        >
          <span>Mais opções</span>
          <span className={`${styles.moreChevron} ${moreOpen ? styles.moreChevronOpen : ""}`}>
            ▾
          </span>
        </button>

        {moreOpen && (
          <div className={styles.moreList}>
            {EXTRA_OPTIONS.map((option) => {
              const active = option.available && mode === "guild" && option.id === "guild";
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.moreItem} ${active ? styles.moreItemActive : ""} ${
                    !option.available ? styles.moreItemDisabled : ""
                  }`}
                  disabled={!option.available || fieldsLocked}
                  onClick={() => {
                    if (!option.available) return;
                    if (option.id === "guild") {
                      setMode("guild");
                      setMoreOpen(false);
                    }
                  }}
                >
                  <span className={styles.moreItemTitle}>
                    {option.title}
                    {!option.available && (
                      <span className={styles.soon}>Em breve</span>
                    )}
                  </span>
                  <span className={styles.moreItemDesc}>{option.description}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </form>
  );
}
