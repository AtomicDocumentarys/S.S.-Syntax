const { Client, GatewayIntentBits } = require('discord.js');
const { VM } = require('vm2');
const Redis = require('ioredis');

// Initialize
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

const redis = new Redis();
const commandCooldowns = new Map();

// Safety Constants
const MAX_COMMANDS_PER_SERVER = 100;
const MAX_COMMAND_LENGTH = 20000;
const RATE_LIMIT = {
  USER: { MAX: 10, WINDOW: 60000 }, // 10 commands/min per user
  GUILD: { MAX: 100, WINDOW: 60000 } // 100 commands/min per guild
};

// Sandbox Config
const sandbox = new VM({
  timeout: 3000,
  sandbox: {
    allowedModules: ['axios', 'moment'],
    console: { log: (...args) => client.logger.info(...args) }
  }
});

// Load Commands from DB
async function loadCommands(guildId) {
  return redis.hgetall(`commands:${guildId}`);
}

// Rate Limit Check
function checkRateLimit(userId, guildId) {
  const userKey = `ratelimit:user:${userId}`;
  const guildKey = `ratelimit:guild:${guildId}`;
  
  const userCount = redis.incr(userKey);
  const guildCount = redis.incr(guildKey);
  
  if (userCount > RATE_LIMIT.USER.MAX || guildCount > RATE_LIMIT.GUILD.MAX) {
    return false;
  }
  
  if (userCount === 1) redis.pexpire(userKey, RATE_LIMIT.USER.WINDOW);
  if (guildCount === 1) redis.pexpire(guildKey, RATE_LIMIT.GUILD.WINDOW);
  
  return true;
}

// Command Execution
async function executeCommand(code, context) {
  try {
    return await sandbox.run(`(async () => { ${code} })()`, context);
  } catch (err) {
    client.logger.error(`Execution error: ${err}`);
    return "⚠️ Command execution failed (sandbox violation)";
  }
}

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  
  // Check rate limits
  if (!checkRateLimit(message.author.id, message.guild.id)) {
    return message.reply("❌ Rate limit exceeded. Try again later.");
  }
  
  // Process command...
});
                                      
