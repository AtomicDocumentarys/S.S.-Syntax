const { redis } = require('./database');
const { RATE_LIMIT, MAX_COMMAND_LENGTH } = require('./config');

const dangerousPatterns = [
  /process\.exit/,
  /child_process/,
  /fs\./,
  /while\s*\(\s*true\s*\)/,
  /for\s*\(\s*;\s*;\s*\)/,
];

function validateCode(code) {
  if (code.length > MAX_COMMAND_LENGTH) throw new Error("Command too long");
  if (dangerousPatterns.some(r => r.test(code))) {
    throw new Error("Dangerous code detected");
  }
}

async function checkRateLimit(userId, guildId) {
  const userKey = `ratelimit:user:${userId}`;
  const guildKey = `ratelimit:guild:${guildId}`;

  const userCount = await redis.incr(userKey);
  const guildCount = await redis.incr(guildKey);

  if (userCount === 1) await redis.pexpire(userKey, RATE_LIMIT.USER.WINDOW);
  if (guildCount === 1) await redis.pexpire(guildKey, RATE_LIMIT.GUILD.WINDOW);

  return userCount <= RATE_LIMIT.USER.MAX &&
         guildCount <= RATE_LIMIT.GUILD.MAX;
}

async function setCooldown(commandId, userId, cooldown) {
  await redis.setex(`cooldown:${commandId}:${userId}`, cooldown, '1');
}

async function isOnCooldown(commandId, userId) {
  return await redis.exists(`cooldown:${commandId}:${userId}`);
}

module.exports = {
  validateCode,
  checkRateLimit,
  setCooldown,
  isOnCooldown
};
