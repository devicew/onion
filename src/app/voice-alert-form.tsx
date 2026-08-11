"use client";

import { useEffect, useRef, useState } from "react";
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

/** Never allow token/IDs to linger in the address bar. */
function stripSensitiveQuery() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const keys = [
    "onion-auth",
    "onion-friend",
    "onion-friend-id",
    "token",
    "userId",
  ];
  let dirty = false;
  for (const key of keys) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      dirty = true;
    }
  }
  if (dirty || url.search.length > 0) {
    // Drop any leftover query on this page — alerts never use query auth
    window.history.replaceState({}, "", url.pathname);
  }
}

export function VoiceAlertForm() {
  const tokenRef = useRef<HTMLInputElement>(null);
  const resumeTokenRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const autoContinueRef = useRef(false);
  const runningRef = useRef(false);

  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [watchingLabel, setWatchingLabel] = useState("");

  useEffect(() => {
    stripSensitiveQuery();
    return () => {
      autoContinueRef.current = false;
      runningRef.current = false;
      abortRef.current?.abort("pause");
      resumeTokenRef.current = "";
      clearInput(tokenRef.current);
    };
  }, []);

  function stopWatch() {
    autoContinueRef.current = false;
    runningRef.current = false;
    abortRef.current?.abort("pause");
    setStatus({ kind: "idle" });
    setWatchingLabel("");
  }

  async function runWatchBatch(
    authToken: string,
    friendId: string,
    signal: AbortSignal,
  ): Promise<"stopped" | "partial" | "done"> {
    const csrf = readCookie(CSRF_COOKIE);
    if (!csrf) {
      throw new Error("Sessão inválida. Recarregue a página.");
    }

    const response = await fetch("/api/voice-watch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        [CSRF_HEADER]: csrf,
      },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        token: authToken,
        userId: friendId,
      }),
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
    let outcome: "stopped" | "partial" | "done" = "done";
    let sawReady = false;

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

        if (event.type === "start") {
          setWatchingLabel("Conectando ao Discord…");
        }

        if (event.type === "ready") {
          sawReady = true;
          if (tokenRef.current) tokenRef.current.value = "";
          if (event.alreadyInCall === true) {
            setWatchingLabel("Amigo já está em call — observando mudanças");
          } else {
            setWatchingLabel(
              "Alerta ativo — aguardando o amigo entrar em call…",
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
          throw new Error(
            typeof event.error === "string" ? event.error : SAFE_ERROR,
          );
        }
      }
    }

    if (!sawReady && outcome === "done") {
      throw new Error("Não foi possível iniciar o alerta. Tente novamente.");
    }

    return outcome;
  }

  async function startWatch() {
    if (runningRef.current) return;

    const authToken =
      tokenRef.current?.value.trim() || resumeTokenRef.current;
    const friendId = userId.trim();

    if (!authToken || !friendId) {
      setStatus({
        kind: "error",
        message: "Preencha o token e o ID do usuário.",
      });
      return;
    }

    stripSensitiveQuery();
    resumeTokenRef.current = authToken;
    autoContinueRef.current = true;
    runningRef.current = true;
    setStatus({ kind: "watching" });
    setWatchingLabel("Conectando…");
    setAlerts([]);

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
      while (autoContinueRef.current && runningRef.current) {
        const abort = new AbortController();
        abortRef.current = abort;

        let outcome: "stopped" | "partial" | "done";
        try {
          outcome = await runWatchBatch(authToken, friendId, abort.signal);
        } catch (err) {
          abortRef.current = null;
          if (err instanceof DOMException && err.name === "AbortError") {
            break;
          }
          throw err;
        }

        abortRef.current = null;

        if (!autoContinueRef.current || !runningRef.current) break;

        if (outcome === "stopped") {
          // Replaced/stopped unexpectedly — leave idle with token restored
          break;
        }

        if (outcome === "partial" || outcome === "done") {
          setWatchingLabel("Reconectando observação…");
          continue;
        }
      }

      if (tokenRef.current && !tokenRef.current.value) {
        tokenRef.current.value = authToken;
      }
      setStatus({ kind: "idle" });
      if (!autoContinueRef.current) {
        setWatchingLabel("");
      } else {
        setWatchingLabel("");
      }
    } catch (err) {
      if (tokenRef.current) tokenRef.current.value = authToken;
      resumeTokenRef.current = authToken;
      setStatus({
        kind: "error",
        message:
          err instanceof Error && err.message.length < 120
            ? err.message
            : SAFE_ERROR,
      });
      setWatchingLabel("");
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }

  const isWatching = status.kind === "watching";
  const fieldsLocked = isWatching;

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>Token da sua conta</span>
        <input
          ref={tokenRef}
          className={styles.input}
          type="password"
          // no name → never appears in URL if something submits
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Cole o token aqui"
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
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ID do usuário do Discord"
          value={userId}
          onChange={(e) => setUserId(e.target.value.replace(/\D/g, ""))}
          disabled={fieldsLocked}
        />
        <span className={styles.helper}>
          Quando ele entrar em um canal de voz, o alerta aparece aqui.
        </span>
      </label>

      <div className={styles.actions}>
        {!isWatching ? (
          <button
            className={styles.submit}
            type="button"
            onClick={() => void startWatch()}
          >
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
              <p className={alertStyles.meta}>Servidor: {item.guildName}</p>
              <p className={alertStyles.meta}>Canal: {item.channelName}</p>
            </article>
          ))}
        </div>
      )}

      <div className={styles.status} aria-live="polite">
        {status.kind === "error" && (
          <p className={styles.error}>{status.message}</p>
        )}
      </div>
    </div>
  );
}
