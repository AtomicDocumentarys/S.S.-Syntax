require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { checkRateLimit } = require('./safety');
const { handleMessage } = require('./commands');
const { loadGlobalState, disableGlobally, isEnabled } = require('./killswitch');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  await loadGlobalState();
  console.log(`✅ Bot ready as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!isEnabled()) return;

  if (message.content === '!emergency stop') {
    await disableGlobally();
    return message.reply("🛑 Global command system disabled.");
  }

  const allowed = await checkRateLimit(message.author.id, message.guild.id);
  if (!allowed) {
    return message.reply("❌ Rate limit exceeded. Try again later.");
  }

  await handleMessage(message);
});

client.login(process.env.TOKEN);
