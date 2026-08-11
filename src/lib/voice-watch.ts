/** Server-only: watch a friend's voice joins with the observer account token. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { Client } = require("discord.js-selfbot-v13");

export type VoiceAlertEvent = {
  kind: "join" | "move" | "already";
  userId: string;
  username?: string;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  at: number;
};

const WATCH_TIMEOUT_MS = 290_000;

async function waitUntilReady(client: any) {
  if (client.readyAt || client.user) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Falha na autenticação."));
    }, 30_000);
    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function channelLabel(channel: any, fallbackId?: string): string {
  if (channel?.name) return channel.name;
  if (fallbackId) return `Canal ${fallbackId}`;
  return "Canal desconhecido";
}

async function resolveVoiceChannel(state: any): Promise<{
  guild: any;
  channel: any;
  channelId: string;
} | null> {
  const guild = state?.guild;
  const channelId = state?.channelId || state?.channel?.id;
  if (!guild?.id || !channelId) return null;

  let channel = state.channel;
  if (!channel) {
    channel =
      guild.channels?.cache?.get?.(channelId) ||
      (await guild.channels.fetch(channelId).catch(() => null));
  }
  if (!channel) {
    return { guild, channel: { id: channelId, name: null }, channelId };
  }
  return { guild, channel, channelId };
}

/**
 * Connects with the observer token and streams voice alerts for targetUserId
 * until aborted or timeout.
 * - Instantly reports if already in a voice channel
 * - Then keeps listening for join/move
 */
export async function watchFriendVoice(
  token: string,
  targetUserId: string,
  options: {
    onReady?: (info: {
      observerId: string;
      targetUserId: string;
      alreadyInCall: boolean;
    }) => void;
    onAlert?: (alert: VoiceAlertEvent) => void;
    signal?: AbortSignal;
  } = {},
) {
  const client = new Client({ checkUpdate: false });
  let authToken: string | null = token;
  const startedAt = Date.now();

  const throwIfStopped = () => {
    if (options.signal?.aborted) {
      const reason = (options.signal as AbortSignal & { reason?: unknown }).reason;
      throw new Error(reason === "timeout" ? "TEMPO_LIMITE" : "PAUSADO");
    }
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
      throw new Error("TEMPO_LIMITE");
    }
  };

  try {
    throwIfStopped();
    try {
      await client.login(authToken as string);
      await waitUntilReady(client);
    } catch {
      throw new Error("Credenciais inválidas.");
    } finally {
      authToken = null;
    }

    if (!client.user?.id) throw new Error("Falha na autenticação.");

    let targetTag = targetUserId;
    try {
      const user = await client.users.fetch(targetUserId);
      targetTag = user?.tag || user?.username || targetUserId;
    } catch {
      // still watchable by ID
    }

    const emitFromState = async (
      kind: VoiceAlertEvent["kind"],
      state: any,
    ) => {
      const resolved = await resolveVoiceChannel(state);
      if (!resolved) return;

      options.onAlert?.({
        kind,
        userId: targetUserId,
        username: targetTag,
        guildId: resolved.guild.id,
        guildName: resolved.guild.name || "Servidor",
        channelId: resolved.channelId,
        channelName: channelLabel(resolved.channel, resolved.channelId),
        at: Date.now(),
      });
    };

    // Listen FIRST so joins during the initial scan are not missed
    const onVoice = (oldState: any, newState: any) => {
      void (async () => {
        try {
          const uid =
            newState?.id ||
            newState?.member?.id ||
            oldState?.id ||
            oldState?.member?.id;
          if (uid !== targetUserId) return;

          const wasIn = Boolean(oldState?.channelId);
          const nowIn = Boolean(newState?.channelId);

          if (!wasIn && nowIn) {
            await emitFromState("join", newState);
            return;
          }

          if (
            wasIn &&
            nowIn &&
            oldState.channelId !== newState.channelId
          ) {
            await emitFromState("move", newState);
          }
        } catch {
          // ignore handler errors
        }
      })();
    };

    client.on("voiceStateUpdate", onVoice);

    // Instant scan: already in a call?
    let alreadyInCall = false;
    const guilds = [...client.guilds.cache.values()];

    await Promise.all(
      guilds.map(async (guild: any) => {
        throwIfStopped();

        // Fast path: voice state cache
        const cachedState = guild.voiceStates?.cache?.get?.(targetUserId);
        if (cachedState?.channelId) {
          alreadyInCall = true;
          await emitFromState("already", cachedState);
          return;
        }

        // Fallback: fetch member voice
        try {
          const member = await guild.members.fetch(targetUserId);
          if (member?.voice?.channelId) {
            alreadyInCall = true;
            await emitFromState("already", member.voice);
          }
        } catch {
          // not mutual / can't fetch
        }
      }),
    );

    options.onReady?.({
      observerId: client.user.id,
      targetUserId,
      alreadyInCall,
    });

    // Keep listening until stop/timeout
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => {
        cleanup();
        const reason = (options.signal as AbortSignal & { reason?: unknown })
          ?.reason;
        reject(new Error(reason === "timeout" ? "TEMPO_LIMITE" : "PAUSADO"));
      };

      const timer = setInterval(() => {
        try {
          throwIfStopped();
        } catch (err) {
          cleanup();
          reject(err);
        }
      }, 2000);

      const cleanup = () => {
        clearInterval(timer);
        options.signal?.removeEventListener("abort", onAbort);
        client.removeListener("voiceStateUpdate", onVoice);
      };

      if (options.signal?.aborted) {
        cleanup();
        reject(new Error("PAUSADO"));
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    authToken = null;
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }
}
