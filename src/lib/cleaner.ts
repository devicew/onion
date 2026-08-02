/** Prevent accidental client bundling of Discord auth logic. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { Client } = require("discord.js-selfbot-v13");

export type CleanMode = "dm" | "guild";
/** newest = bottom→top (recent first); oldest = top→bottom (oldest first) */
export type CleanDirection = "newest" | "oldest";

export type CleanProgress = {
  phase: "scanning" | "deleting";
  totalDeleted: number;
  total: number;
  remaining: number;
  percent: number;
};

const MAX_MESSAGES = 2000;
const MAX_SCAN_PAGES = 40;
const JOB_TIMEOUT_MS = 240_000;
const DELETE_DELAY_MS = 1400;
const FETCH_DELAY_MS = 700;
const MAX_OPERATION_MESSAGES = MAX_MESSAGES;

const GUILD_TEXT_TYPES = new Set([
  "GUILD_TEXT",
  "GUILD_NEWS",
  "GUILD_VOICE",
  "GUILD_STAGE_VOICE",
  "GUILD_NEWS_THREAD",
  "GUILD_PUBLIC_THREAD",
  "GUILD_PRIVATE_THREAD",
  "GUILD_FORUM",
  "GUILD_MEDIA",
]);

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithJitter(baseMs: number) {
  const jitter = Math.floor(Math.random() * 400);
  return Math.max(250, baseMs + jitter);
}

function getOldestMessageId(messages: {
  keys: () => IterableIterator<string>;
}): string | null {
  let oldest: string | null = null;
  for (const id of messages.keys()) {
    if (!oldest || BigInt(id) < BigInt(oldest)) oldest = id;
  }
  return oldest;
}

function sortMessagesByDirection(messages: any[], direction: CleanDirection) {
  messages.sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    if (left === right) return 0;
    if (direction === "oldest") {
      return left < right ? -1 : 1;
    }
    // newest first
    return left > right ? -1 : 1;
  });
}

async function resolveDmChannel(client: any, id: string) {
  try {
    const channel = await client.channels.fetch(id);
    if (channel) return channel;
  } catch {
    // may be a user id
  }

  try {
    const user = await client.users.fetch(id);
    return await user.createDM();
  } catch {
    throw new Error("Canal ou usuário não encontrado.");
  }
}

async function resolveGuildChannel(client: any, id: string) {
  try {
    const channel = await client.channels.fetch(id);
    if (channel) return channel;
  } catch {
    throw new Error("Canal do servidor não encontrado.");
  }
  throw new Error("Canal do servidor não encontrado.");
}

function isPrivateDm(channel: any) {
  return channel?.type === "DM" || channel?.type === "GROUP_DM";
}

function isGuildTextCapable(channel: any) {
  if (!channel) return false;
  if (typeof channel.type === "string" && GUILD_TEXT_TYPES.has(channel.type)) {
    return true;
  }
  return Boolean(channel.guildId || channel.guild) && Boolean(channel.messages);
}

function assertDmParticipation(client: any, channel: any) {
  const me = client.user?.id;
  if (!me) throw new Error("Falha na autenticação.");

  if (channel.type === "DM") {
    // 1:1 DM — recipient exists and we are the account that opened it
    if (!channel.recipient && !channel.recipientId) {
      throw new Error("O ID informado não é uma DM válida.");
    }
    return;
  }

  if (channel.type === "GROUP_DM") {
    const recipients = channel.recipients;
    if (recipients?.cache?.has?.(me) || recipients?.has?.(me)) return;
    // Some builds expose recipients as Collection/Map/array
    if (Array.isArray(recipients) && recipients.some((u: any) => u?.id === me)) {
      return;
    }
    // If we successfully fetched the channel with this token, treat as OK
    // but require messages API present.
    if (channel.messages) return;
    throw new Error("Sem permissão para apagar mensagens neste canal.");
  }
}

function assertGuildAccess(client: any, channel: any) {
  const me = client.user;
  if (!me) throw new Error("Falha na autenticação.");

  if (!channel.messages) {
    throw new Error("Este canal não permite limpeza de mensagens.");
  }

  // permissionsFor is available on guild channels in discord.js
  try {
    const perms = channel.permissionsFor?.(me);
    if (perms) {
      const canView =
        typeof perms.has === "function"
          ? perms.has("VIEW_CHANNEL")
          : true;
      const canRead =
        typeof perms.has === "function"
          ? perms.has("READ_MESSAGE_HISTORY")
          : true;
      if (!canView || !canRead) {
        throw new Error("Sem permissão para ler mensagens neste canal.");
      }
    }
  } catch (err: any) {
    if (err?.message?.includes("Sem permissão")) throw err;
    // If permissionsFor fails, fall through to probe fetch
  }
}

async function probeChannelReadable(channel: any) {
  try {
    const probe = await channel.messages.fetch({ limit: 1 });
    void probe;
  } catch (err: any) {
    const code = err?.code ?? err?.httpStatus;
    if (code === 50001 || code === 50013 || code === 403) {
      throw new Error("Sem permissão para ler mensagens neste canal.");
    }
    throw new Error("Canal do servidor não encontrado.");
  }
}

function assertNotTimedOut(startedAt: number) {
  if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
    throw new Error("Operação excedeu o tempo limite.");
  }
}

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

/**
 * Deletes ONLY messages authored by the account that owns `token`.
 * Channel access is verified on the backend after login — never trust the client.
 */
export async function deleteMessagesFromChannel(
  token: string,
  channelId: string,
  options: {
    mode?: CleanMode;
    direction?: CleanDirection;
    batchSize?: number;
    onProgress?: (info: CleanProgress) => void;
    signal?: AbortSignal;
  } = {},
) {
  const mode: CleanMode = options.mode === "guild" ? "guild" : "dm";
  const direction: CleanDirection =
    options.direction === "oldest" ? "oldest" : "newest";
  const batchSize = Math.min(options.batchSize ?? 100, 100);
  const onProgress = options.onProgress;
  const signal = options.signal;
  const startedAt = Date.now();

  const client = new Client({ checkUpdate: false });
  let authToken: string | null = token;

  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error("Operação cancelada.");
    assertNotTimedOut(startedAt);
  };

  try {
    throwIfAborted();
    try {
      await client.login(authToken as string);
      await waitUntilReady(client);
    } catch {
      throw new Error("Credenciais inválidas.");
    } finally {
      authToken = null;
    }

    // Token belongs to whoever successfully logged in — that is the only identity we trust.
    if (!client.user?.id) throw new Error("Falha na autenticação.");
    const selfId: string = client.user.id;

    throwIfAborted();
    const channel =
      mode === "guild"
        ? await resolveGuildChannel(client, channelId)
        : await resolveDmChannel(client, channelId);

    if (!channel) {
      throw new Error("Canal ou usuário não encontrado.");
    }

    if (mode === "dm") {
      if (!isPrivateDm(channel)) {
        throw new Error("O ID informado não é uma DM válida.");
      }
      assertDmParticipation(client, channel);
    } else {
      if (!isGuildTextCapable(channel)) {
        throw new Error(
          "O ID não é um canal de texto/voz de servidor válido.",
        );
      }
      assertGuildAccess(client, channel);
    }

    // Backend probe: channel must be readable with THIS account
    await probeChannelReadable(channel);

    // —— Phase 1: collect ONLY messages authored by selfId ——
    const myMessages: any[] = [];
    let beforeId: string | undefined;
    let pages = 0;
    const seenCursors = new Set<string>();

    onProgress?.({
      phase: "scanning",
      totalDeleted: 0,
      total: 0,
      remaining: 0,
      percent: 0,
    });

    while (pages < MAX_SCAN_PAGES && myMessages.length < MAX_OPERATION_MESSAGES) {
      throwIfAborted();
      pages += 1;

      const fetchOptions: { limit: number; before?: string } = {
        limit: batchSize,
      };
      if (beforeId) fetchOptions.before = beforeId;

      let messages: any;
      try {
        messages = await channel.messages.fetch(fetchOptions);
      } catch (err: any) {
        const code = err?.code ?? err?.httpStatus;
        if (code === 50001 || code === 50013 || code === 403) {
          throw new Error("Sem permissão para ler mensagens neste canal.");
        }
        throw new Error("Canal do servidor não encontrado.");
      }

      if (!messages || messages.size === 0) break;

      const oldestId = getOldestMessageId(messages);
      if (!oldestId) break;
      if (beforeId && oldestId === beforeId) break;
      if (seenCursors.has(oldestId)) break;
      seenCursors.add(oldestId);

      for (const msg of messages.values()) {
        // Hard ownership check — never delete another author's message
        if (msg.author?.id === selfId) {
          myMessages.push(msg);
          if (myMessages.length >= MAX_OPERATION_MESSAGES) break;
        }
      }

      onProgress?.({
        phase: "scanning",
        totalDeleted: 0,
        total: myMessages.length,
        remaining: myMessages.length,
        percent: Math.min(30, Math.round((pages / MAX_SCAN_PAGES) * 30)),
      });

      if (messages.size < batchSize) break;
      beforeId = oldestId;
      await sleep(delayWithJitter(FETCH_DELAY_MS));
    }

    const total = myMessages.length;

    if (total === 0) {
      onProgress?.({
        phase: "deleting",
        totalDeleted: 0,
        total: 0,
        remaining: 0,
        percent: 100,
      });
      return { ok: true as const, totalDeleted: 0, total: 0, selfId };
    }

    // Order deletes to match Discord chat: top=oldest, bottom=newest
    sortMessagesByDirection(myMessages, direction);

    // —— Phase 2: delete with REAL percent (deleted / total) ——
    onProgress?.({
      phase: "deleting",
      totalDeleted: 0,
      total,
      remaining: total,
      percent: 0,
    });

    let totalDeleted = 0;
    let permissionFailures = 0;

    for (let i = 0; i < myMessages.length; i++) {
      throwIfAborted();
      const msg = myMessages[i];
      myMessages[i] = null;

      // Re-check authorship before every delete
      if (!msg || msg.author?.id !== selfId) {
        continue;
      }

      try {
        await msg.delete();
        totalDeleted++;
        permissionFailures = 0;
      } catch (err: any) {
        const code = err?.code ?? err?.httpStatus;
        if (code === 50013 || code === 50001 || code === 403) {
          permissionFailures++;
          if (permissionFailures >= 3 && totalDeleted === 0) {
            throw new Error("Sem permissão para apagar mensagens neste canal.");
          }
        }
      }

      const remaining = Math.max(total - (i + 1), 0);
      onProgress?.({
        phase: "deleting",
        totalDeleted,
        total,
        remaining,
        percent: Math.min(100, Math.round(((i + 1) / total) * 100)),
      });

      await sleep(delayWithJitter(DELETE_DELAY_MS));
    }

    myMessages.length = 0;

    onProgress?.({
      phase: "deleting",
      totalDeleted,
      total,
      remaining: 0,
      percent: 100,
    });

    return { ok: true as const, totalDeleted, total, selfId };
  } finally {
    authToken = null;
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }
}
