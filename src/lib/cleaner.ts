/** Prevent accidental client bundling of Discord auth logic. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { Client } = require("discord.js-selfbot-v13");

export type CleanMode = "dm" | "guild";
/** newest = bottom→top; oldest = top→bottom */
export type CleanDirection = "newest" | "oldest";

export type CleanProgress = {
  phase: "deleting";
  totalDeleted: number;
  total: number;
  remaining: number;
  percent: number;
};

/** Soft safety only — real stop is empty history. Client auto-continues on timeout. */
const MAX_PAGES_PER_JOB = 100_000;
const JOB_TIMEOUT_MS = 290_000;
/** Steady pace to avoid Discord 429 spikes (DM + servidor). */
const DELETE_DELAY_MS = 750;
const FETCH_DELAY_MS = 280;

function delayWithJitter(baseMs: number) {
  const jitter = Math.floor(Math.random() * 180);
  return Math.max(200, baseMs + jitter);
}

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

function getOldestMessageId(messages: {
  keys: () => IterableIterator<string>;
}): string | null {
  let oldest: string | null = null;
  for (const id of messages.keys()) {
    if (!oldest || BigInt(id) < BigInt(oldest)) oldest = id;
  }
  return oldest;
}

function getNewestMessageId(messages: {
  keys: () => IterableIterator<string>;
}): string | null {
  let newest: string | null = null;
  for (const id of messages.keys()) {
    if (!newest || BigInt(id) > BigInt(newest)) newest = id;
  }
  return newest;
}

function sortByIdAsc(messages: any[]) {
  messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

function sortByIdDesc(messages: any[]) {
  messages.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
}

function retryAfterMs(err: any): number | null {
  const retry =
    err?.retryAfter ??
    err?.retry_after ??
    err?.data?.retry_after ??
    err?.rawError?.retry_after;
  if (typeof retry === "number" && Number.isFinite(retry)) {
    return Math.max(50, Math.ceil(retry * 1000));
  }
  const code = err?.code ?? err?.httpStatus;
  if (code === 429) return 1000;
  return null;
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
    if (!channel.recipient && !channel.recipientId) {
      throw new Error("O ID informado não é uma DM válida.");
    }
    return;
  }

  if (channel.type === "GROUP_DM") {
    const recipients = channel.recipients;
    if (recipients?.cache?.has?.(me) || recipients?.has?.(me)) return;
    if (Array.isArray(recipients) && recipients.some((u: any) => u?.id === me)) {
      return;
    }
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

  try {
    const perms = channel.permissionsFor?.(me);
    if (perms) {
      const canView =
        typeof perms.has === "function" ? perms.has("VIEW_CHANNEL") : true;
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
  }
}

async function probeChannelReadable(channel: any) {
  try {
    await channel.messages.fetch({ limit: 1 });
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
    throw new Error("TEMPO_LIMITE");
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

async function fetchPage(
  channel: any,
  opts: { limit: number; before?: string; after?: string },
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await channel.messages.fetch(opts);
    } catch (err: any) {
      const wait = retryAfterMs(err);
      if (wait != null) {
        await sleep(wait);
        continue;
      }
      const code = err?.code ?? err?.httpStatus;
      if (code === 50001 || code === 50013 || code === 403) {
        throw new Error("Sem permissão para ler mensagens neste canal.");
      }
      throw new Error("Canal do servidor não encontrado.");
    }
  }
  throw new Error("Muitas tentativas. Aguarde e tente novamente.");
}

function ownFromPage(messages: any, selfId: string): any[] {
  const mine: any[] = [];
  for (const msg of messages.values()) {
    if (msg.author?.id === selfId) mine.push(msg);
  }
  return mine;
}

async function deleteOne(
  msg: any,
  selfId: string,
  state: { permissionFailures: number; totalDeleted: number },
) {
  if (!msg || msg.author?.id !== selfId) return false;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await msg.delete();
      state.totalDeleted += 1;
      state.permissionFailures = 0;
      return true;
    } catch (err: any) {
      const wait = retryAfterMs(err);
      if (wait != null) {
        await sleep(wait);
        continue;
      }
      const code = err?.code ?? err?.httpStatus;
      if (code === 50013 || code === 50001 || code === 403) {
        state.permissionFailures += 1;
        if (state.permissionFailures >= 3 && state.totalDeleted === 0) {
          throw new Error("Sem permissão para apagar mensagens neste canal.");
        }
        return false;
      }
      // Unknown/transient — retry briefly once more path
      if (attempt < 2) {
        await sleep(150);
        continue;
      }
      return false;
    }
  }
  return false;
}

function reportProgress(
  onProgress: ((info: CleanProgress) => void) | undefined,
  state: { totalDeleted: number },
  remainingInBatch: number,
) {
  onProgress?.({
    phase: "deleting",
    totalDeleted: state.totalDeleted,
    total: state.totalDeleted + remainingInBatch,
    remaining: remainingInBatch,
    percent: Math.min(
      99,
      5 + Math.floor(Math.log10(state.totalDeleted + 1) * 30),
    ),
  });
}

/**
 * Deletes ONLY messages authored by the account that owns `token`.
 * Starts deleting on the first page — no pre-scan. No artificial delays.
 * Stops only when the channel history has no more of your messages (or timeout/pause).
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
    if (signal?.aborted) {
      const reason = (signal as AbortSignal & { reason?: unknown }).reason;
      throw new Error(reason === "timeout" ? "TEMPO_LIMITE" : "PAUSADO");
    }
    assertNotTimedOut(startedAt);
  };

  const state = { permissionFailures: 0, totalDeleted: 0 };

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

    if (!client.user?.id) throw new Error("Falha na autenticação.");
    const selfId: string = client.user.id;

    throwIfAborted();
    const channel =
      mode === "guild"
        ? await resolveGuildChannel(client, channelId)
        : await resolveDmChannel(client, channelId);

    if (!channel) throw new Error("Canal ou usuário não encontrado.");

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

    await probeChannelReadable(channel);

    onProgress?.({
      phase: "deleting",
      totalDeleted: 0,
      total: 0,
      remaining: 0,
      percent: 1,
    });

    if (direction === "oldest") {
      await cleanOldestFirst(channel, selfId, batchSize, {
        throwIfAborted,
        onProgress,
        state,
      });
    } else {
      await cleanNewestFirst(channel, selfId, batchSize, {
        throwIfAborted,
        onProgress,
        state,
      });
    }

    onProgress?.({
      phase: "deleting",
      totalDeleted: state.totalDeleted,
      total: state.totalDeleted,
      remaining: 0,
      percent: 100,
    });

    return {
      ok: true as const,
      totalDeleted: state.totalDeleted,
      total: state.totalDeleted,
      selfId,
      exhausted: true,
    };
  } finally {
    authToken = null;
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }
}

async function cleanNewestFirst(
  channel: any,
  selfId: string,
  batchSize: number,
  ctx: {
    throwIfAborted: () => void;
    onProgress?: (info: CleanProgress) => void;
    state: { permissionFailures: number; totalDeleted: number };
  },
) {
  let beforeId: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();

  while (pages < MAX_PAGES_PER_JOB) {
    ctx.throwIfAborted();
    pages += 1;

    const messages = await fetchPage(channel, {
      limit: batchSize,
      before: beforeId,
    });

    if (!messages || messages.size === 0) break;

    const oldestId = getOldestMessageId(messages);
    if (!oldestId) break;
    if (beforeId && oldestId === beforeId) break;
    if (seenCursors.has(oldestId)) break;
    seenCursors.add(oldestId);

    const mine = ownFromPage(messages, selfId);
    sortByIdDesc(mine);

    for (let i = 0; i < mine.length; i++) {
      ctx.throwIfAborted();
      await deleteOne(mine[i], selfId, ctx.state);
      mine[i] = null;
      reportProgress(ctx.onProgress, ctx.state, mine.length - i - 1);
      await sleep(delayWithJitter(DELETE_DELAY_MS));
    }

    if (messages.size < batchSize) break;
    beforeId = oldestId;
    await sleep(delayWithJitter(FETCH_DELAY_MS));
  }
}

async function cleanOldestFirst(
  channel: any,
  selfId: string,
  batchSize: number,
  ctx: {
    throwIfAborted: () => void;
    onProgress?: (info: CleanProgress) => void;
    state: { permissionFailures: number; totalDeleted: number };
  },
) {
  // Start at the beginning of channel history (no locate/scan phase)
  let afterId = "0";
  let pages = 0;
  const seenAfter = new Set<string>();

  while (pages < MAX_PAGES_PER_JOB) {
    ctx.throwIfAborted();
    pages += 1;

    const messages = await fetchPage(channel, {
      limit: batchSize,
      after: afterId,
    });

    if (!messages || messages.size === 0) break;

    const newestId = getNewestMessageId(messages);
    if (!newestId) break;
    if (seenAfter.has(`${afterId}:${newestId}`)) break;
    seenAfter.add(`${afterId}:${newestId}`);

    const mine = ownFromPage(messages, selfId);
    sortByIdAsc(mine);

    for (let i = 0; i < mine.length; i++) {
      ctx.throwIfAborted();
      await deleteOne(mine[i], selfId, ctx.state);
      mine[i] = null;
      reportProgress(ctx.onProgress, ctx.state, mine.length - i - 1);
      await sleep(delayWithJitter(DELETE_DELAY_MS));
    }

    if (messages.size < batchSize) break;
    afterId = newestId;
    await sleep(delayWithJitter(FETCH_DELAY_MS));
  }
}
