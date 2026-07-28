const { Client } = require('discord.js-selfbot-v13');

async function resolveChannel(client, id) {
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
    throw new Error(`Não foi possível achar canal nem usuário com ID ${id}.`);
  }
}

function isPrivateDm(channel) {
  return channel?.type === 'DM' || channel?.type === 'GROUP_DM';
}

async function deleteMessagesFromChannel(token, channelId, options = {}) {
  const batchSize = options.batchSize ?? 100;
  const onProgress = options.onProgress;

  const client = new Client({ checkUpdate: false });
  await client.login(token.trim());

  if (!client.user) throw new Error('Falha no login. Verifique o token.');

  const channel = await resolveChannel(client, channelId.trim());
  if (!isPrivateDm(channel)) {
    throw new Error(`O ID não é DM/Group DM (tipo: ${channel.type}).`);
  }

  const myMessages = [];
  let lastMessageId = undefined;

  while (true) {
    const fetchOptions = { limit: batchSize };
    if (lastMessageId) fetchOptions.before = lastMessageId;

    const messages = await channel.messages.fetch(fetchOptions);
    if (messages.size === 0) break;

    for (const msg of messages.values()) {
      if (msg.author?.id === client.user.id) myMessages.push(msg);
    }

    lastMessageId = messages.last().id;
    onProgress?.({
      phase: 'scanning',
      totalDeleted: 0,
      total: 0,
      remaining: 0,
      percent: 0,
      channelId: channel.id,
    });

    if (messages.size < batchSize) break;
  }

  const total = myMessages.length;
  let totalDeleted = 0;

  for (const msg of myMessages) {
    try {
      await msg.delete();
      totalDeleted++;
    } catch {
      // ignore
    }

    onProgress?.({
      phase: 'deleting',
      totalDeleted,
      total,
      remaining: Math.max(total - totalDeleted, 0),
      percent: total ? Math.round((totalDeleted / total) * 100) : 100,
      channelId: channel.id,
    });
  }

  await client.destroy();
  return { ok: true, totalDeleted, channelId: channel.id, total };
}

module.exports = { deleteMessagesFromChannel, resolveChannel, isPrivateDm };
