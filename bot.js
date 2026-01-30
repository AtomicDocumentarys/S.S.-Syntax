client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // 1. Fetch all triggers for this server from Redis
    const serverCommands = await redis.hgetall(`commands:${message.guild.id}`);
    
    for (const cmdId in serverCommands) {
        const cmd = JSON.parse(serverCommands[cmdId]);
        
        // 2. CHECK TRIGGERS (Like YAGPDB)
        let triggered = false;
        if (cmd.type === 'prefix' && message.content.startsWith(cmd.prefix + cmd.name)) triggered = true;
        if (cmd.type === 'message' && message.content.toLowerCase().includes(cmd.trigger.toLowerCase())) triggered = true;
        // Add more: regex, startsWith, etc.

        if (triggered) {
            // 3. EXECUTE VIA SANDBOX
            // Pass the message/user context into the VM
            const result = await executeRemoteCode(cmd.code, cmd.language, {
                user: message.author,
                channel: message.channel,
                content: message.content
            });
            if (result) message.reply(result);
        }
    }
});
