/** Prevent accidental client bundling of Discord auth logic. */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

const { Client } = require("discord.js-selfbot-v13");

export type CleanProgress = {
  phase: "scanning" | "deleting";
  totalDeleted: number;
  total: number;
  remaining: number;
  percent: number;
};

async function resolveChannel(client: any, id: string) {
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

function isPrivateDm(channel: any) {
  return channel?.type === "DM" || channel?.type === "GROUP_DM";
}

export async function deleteMessagesFromChannel(
  token: string,
  channelId: string,
  options: {
    batchSize?: number;
    onProgress?: (info: CleanProgress) => void;
  } = {},
) {
  const batchSize = options.batchSize ?? 100;
  const onProgress = options.onProgress;

  const client = new Client({ checkUpdate: false });

  try {
    await client.login(token);
  } catch {
    throw new Error("Credenciais inválidas.");
  }

  if (!client.user) throw new Error("Falha na autenticação.");

  const channel = await resolveChannel(client, channelId);
  if (!isPrivateDm(channel)) {
    throw new Error("O ID informado não é uma DM válida.");
  }

  const myMessages: any[] = [];
  let lastMessageId: string | undefined;

  try {
    while (true) {
      const fetchOptions: { limit: number; before?: string } = {
        limit: batchSize,
      };
      if (lastMessageId) fetchOptions.before = lastMessageId;

      const messages = await channel.messages.fetch(fetchOptions);
      if (messages.size === 0) break;

      for (const msg of messages.values()) {
        if (msg.author?.id === client.user.id) {
          myMessages.push(msg);
        }
      }

      lastMessageId = messages.last().id;
      onProgress?.({
        phase: "scanning",
        totalDeleted: 0,
        total: 0,
        remaining: 0,
        percent: 0,
      });

      if (messages.size < batchSize) break;
    }

    const total = myMessages.length;

    if (total === 0) {
      return { ok: true as const, totalDeleted: 0, total: 0 };
    }

    onProgress?.({
      phase: "deleting",
      totalDeleted: 0,
      total,
      remaining: total,
      percent: 0,
    });

    let totalDeleted = 0;

    for (const msg of myMessages) {
      try {
        await msg.delete();
        totalDeleted++;
      } catch {
        // ignore already-deleted / rate-limit noise
      }

      const remaining = Math.max(total - totalDeleted, 0);
      const percent = Math.min(100, Math.round((totalDeleted / total) * 100));

      onProgress?.({
        phase: "deleting",
        totalDeleted,
        total,
        remaining,
        percent,
      });
    }

    return { ok: true as const, totalDeleted, total };
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore destroy errors
    }
  }
}
