require('dotenv').config();
const { deleteMessagesFromChannel } = require('./lib/cleaner');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN?.trim();
if (!DISCORD_TOKEN) {
  console.error('[!] DISCORD_TOKEN não encontrado. Defina no arquivo .env');
  process.exit(1);
}

(async () => {
  const channelId = '1531714196818100304';
  try {
    const result = await deleteMessagesFromChannel(DISCORD_TOKEN, channelId, {
      onProgress: ({ totalDeleted, channelId }) => {
        console.log(`[${totalDeleted}] mensagens suas apagadas no canal ${channelId}`);
      },
    });
    console.log('[✓] Processo concluído:', result);
  } catch (err) {
    console.error('[!] Erro:', err.message);
  }
})();
