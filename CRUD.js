// Add Command
async function addCommand(guildId, command) {
  const count = await redis.hlen(`commands:${guildId}`);
  if (count >= MAX_COMMANDS_PER_SERVER) {
    throw new Error(`Server limit reached (${MAX_COMMANDS_PER_SERVER} commands max)`);
  }
  
  if (command.code.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command too long (${MAX_COMMAND_LENGTH} chars max)`);
  }
  
  await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
}

// Delete Command
async function deleteCommand(guildId, commandId) {
  await redis.hdel(`commands:${guildId}`, commandId);
  }
