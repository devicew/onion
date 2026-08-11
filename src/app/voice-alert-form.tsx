"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./cleaner-form.module.css";
import alertStyles from "./voice-alert-form.module.css";

type AlertItem = {
  id: string;
  kind: "join" | "move" | "already";
  username?: string;
  guildName: string;
  channelName: string;
  channelId: string;
  guildId: string;
  at: number;
};

type Status =
  | { kind: "idle" }
  | { kind: "watching" }
  | { kind: "error"; message: string };

const SAFE_ERROR = "Não foi possível concluir a operação.";
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

function kindLabel(kind: AlertItem["kind"]) {
  if (kind === "already") return "Já está em call";
  if (kind === "move") return "Trocou de canal";
  return "Entrou na call";
}

function formatTime(at: number) {
  try {
    return new Date(at).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function VoiceAlertForm() {
  const tokenRef = useRef<HTMLInputElement>(null);
  const resumeTokenRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const autoContinueRef = useRef(true);

  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [watchingLabel, setWatchingLabel] = useState("");

  useEffect(() => {
    return () => {
      autoContinueRef.current = false;
      abortRef.current?.abort("pause");
      resumeTokenRef.current = "";
      clearInput(tokenRef.current);
    };
  }, []);

  function stopWatch() {
    autoContinueRef.current = false;
    abortRef.current?.abort("pause");
  }

  async function runWatchBatch(authToken: string, signal: AbortSignal) {
    const csrf = readCookie(CSRF_COOKIE);
    const body = JSON.stringify({
      token: authToken,
      userId: userId.trim(),
    });

    const response = await fetch("/api/voice-watch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        [CSRF_HEADER]: csrf,
      },
      cache: "no-store",
      credentials: "same-origin",
      body,
      signal,
    });

    if (!response.ok || !response.body) {
      let message = SAFE_ERROR;
      try {
        const data = await response.json();
        if (typeof data?.error === "string" && data.error.length < 120) {
          message = data.error;
        }
      } catch {
        // keep
      }
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome: "stopped" | "partial" | "done" | "error" = "done";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === "ready") {
          if (event.alreadyInCall === true) {
            setWatchingLabel("Amigo já está em call — observando mudanças");
          } else {
            setWatchingLabel(
              "Ainda não está em call — observando em tempo real…",
            );
          }
        }

        if (event.type === "alert") {
          const item: AlertItem = {
            id: `${event.at}-${event.channelId}-${Math.random().toString(36).slice(2, 7)}`,
            kind: (event.kind as AlertItem["kind"]) || "join",
            username:
              typeof event.username === "string" ? event.username : undefined,
            guildName:
              typeof event.guildName === "string"
                ? event.guildName
                : "Servidor",
            channelName:
              typeof event.channelName === "string"
                ? event.channelName
                : "Canal",
            channelId:
              typeof event.channelId === "string" ? event.channelId : "",
            guildId: typeof event.guildId === "string" ? event.guildId : "",
            at: typeof event.at === "number" ? event.at : Date.now(),
          };
          setAlerts((prev) => {
            // avoid duplicate "already" for same channel
            if (
              item.kind === "already" &&
              prev.some(
                (p) =>
                  p.kind === "already" &&
                  p.channelId === item.channelId &&
                  p.guildId === item.guildId,
              )
            ) {
              return prev;
            }
            return [item, ...prev].slice(0, 40);
          });
          setWatchingLabel(
            item.kind === "already"
              ? `Já em call · ${item.channelName} (${item.guildName})`
              : `${item.username || "Amigo"} · ${item.channelName}`,
          );

          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            try {
              const prefix =
                item.kind === "already"
                  ? "Já está em call"
                  : item.kind === "move"
                    ? "Trocou de canal"
                    : "Entrou na call";
              new Notification("Onion · alerta de call", {
                body: `${prefix}: ${item.username || "Amigo"} em ${item.channelName} (${item.guildName})`,
              });
            } catch {
              // ignore
            }
          }
        }

        if (event.type === "stopped") outcome = "stopped";
        if (event.type === "partial") outcome = "partial";
        if (event.type === "done") outcome = "done";
        if (event.type === "error") {
          outcome = "error";
          throw new Error(
            typeof event.error === "string" ? event.error : SAFE_ERROR,
          );
        }
      }
    }

    return outcome;
  }

  async function startWatch(authToken: string) {
    resumeTokenRef.current = authToken;
    if (tokenRef.current) tokenRef.current.value = "";
    autoContinueRef.current = true;
    setStatus({ kind: "watching" });
    setWatchingLabel("Conectando…");

    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      try {
        await Notification.requestPermission();
      } catch {
        // optional
      }
    }

    try {
      for (let round = 0; round < 200 && autoContinueRef.current; round++) {
        const abort = new AbortController();
        abortRef.current = abort;
        const outcome = await runWatchBatch(authToken, abort.signal);
        abortRef.current = null;

        if (!autoContinueRef.current || outcome === "stopped") {
          setStatus({ kind: "idle" });
          setWatchingLabel("");
          break;
        }
        if (outcome === "partial") {
          setWatchingLabel("Reconectando observação…");
          continue;
        }
        // done unexpectedly — reconnect while user still wants watch
        if (autoContinueRef.current) {
          setWatchingLabel("Reconectando observação…");
          continue;
        }
        setStatus({ kind: "idle" });
        break;
      }
    } catch (err) {
      abortRef.current = null;
      if (err instanceof DOMException && err.name === "AbortError") {
        setStatus({ kind: "idle" });
        setWatchingLabel("");
        return;
      }
      resumeTokenRef.current = "";
      setStatus({
        kind: "error",
        message:
          err instanceof Error && err.message.length < 120
            ? err.message
            : SAFE_ERROR,
      });
      setWatchingLabel("");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fromInput = tokenRef.current?.value.trim() ?? "";
    const authToken = fromInput || resumeTokenRef.current;
    if (!authToken || !userId.trim()) {
      setStatus({
        kind: "error",
        message: "Preencha o token e o ID do usuário.",
      });
      return;
    }
    await startWatch(authToken);
  }

  const isWatching = status.kind === "watching";
  const fieldsLocked = isWatching;

  return (
    <form
      className={styles.form}
      onSubmit={onSubmit}
      autoComplete="off"
      data-form-type="other"
    >
      <label className={styles.field}>
        <span className={styles.label}>Token da sua conta</span>
        <input
          ref={tokenRef}
          className={styles.input}
          type="password"
          name="onion-auth"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Cole o token aqui"
          required={!resumeTokenRef.current}
          disabled={fieldsLocked}
        />
        <span className={styles.helper}>
          Usado só para observar calls em servidores que sua conta enxerga.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>ID do amigo</span>
        <input
          className={styles.input}
          type="text"
          name="onion-friend"
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ID do usuário do Discord"
          value={userId}
          onChange={(e) => setUserId(e.target.value.replace(/\D/g, ""))}
          required
          disabled={fieldsLocked}
        />
        <span className={styles.helper}>
          Quando ele entrar em um canal de voz, o alerta aparece aqui.
        </span>
      </label>

      <div className={styles.actions}>
        {!isWatching ? (
          <button className={styles.submit} type="submit">
            Começar alerta
          </button>
        ) : (
          <button
            className={styles.pauseBtn}
            type="button"
            onClick={stopWatch}
          >
            Parar alerta
          </button>
        )}
      </div>

      {isWatching && (
        <p className={alertStyles.live}>
          <span className={alertStyles.liveDot} aria-hidden />
          {watchingLabel || "Observando…"}
        </p>
      )}

      {alerts.length > 0 && (
        <div className={alertStyles.list} aria-live="polite">
          {alerts.map((item) => (
            <article key={item.id} className={alertStyles.card}>
              <div className={alertStyles.cardTop}>
                <span className={alertStyles.badge}>{kindLabel(item.kind)}</span>
                <time className={alertStyles.time}>{formatTime(item.at)}</time>
              </div>
              <p className={alertStyles.title}>
                {item.username || "Amigo"} · {item.channelName}
              </p>
              <p className={alertStyles.meta}>
                Servidor: {item.guildName}
              </p>
              <p className={alertStyles.meta}>
                Canal: {item.channelName}
              </p>
            </article>
          ))}
        </div>
      )}

      <div className={styles.status} aria-live="polite">
        {status.kind === "error" && (
          <p className={styles.error}>{status.message}</p>
        )}
      </div>
    </form>
  );
}
