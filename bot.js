const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { VM } = require('vm2');
const Redis = require('ioredis');
const path = require('path');
const axios = require('axios');
const config = require('./config');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
let liveLogs = [];

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '.')));

function addLog(guildId, message) {
    liveLogs.push({ guildId, timestamp: new Date().toLocaleTimeString(), message });
    if (liveLogs.length > 50) liveLogs.shift();
}

// API: Mutual Servers
app.get('/api/mutual-servers', async (req, res) => {
    const authHeader = req.headers.authorization;
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: authHeader }
        });
        const mutual = response.data.filter(g => (BigInt(g.permissions) & 0x8n) && client.guilds.cache.has(g.id));
        res.json(mutual);
    } catch (e) { res.status(500).send("Sync Error"); }
});

// API: Save Command with Advanced Metadata
app.post('/api/save-command', async (req, res) => {
    const { guildId, command } = req.body;
    await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
    res.sendStatus(200);
});

// --- COMMAND ENGINE WITH TRIGGER TYPES ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const commands = await redis.hgetall(`commands:${message.guild.id}`);
    for (const id in commands) {
        const cmd = JSON.parse(commands[id]);
        const prefix = cmd.prefix || "!";
        const content = message.content;
        let triggered = false;

        switch (cmd.type) {
            case "Command (prefix)":
                if (content.startsWith(prefix + cmd.trigger)) triggered = true;
                break;
            case "Starts with":
                if (content.startsWith(cmd.trigger)) triggered = true;
                break;
            case "Contains":
                if (content.includes(cmd.trigger)) triggered = true;
                break;
            case "Exact Match":
                if (content === cmd.trigger) triggered = true;
                break;
            case "Regex":
                try { if (new RegExp(cmd.trigger).test(content)) triggered = true; } catch(e){}
                break;
        }

        if (triggered) {
            // Check Role Requirements
            if (cmd.roles?.length > 0 && !message.member.roles.cache.some(r => cmd.roles.includes(r.id))) continue;
            // Check Channel Requirements
            if (cmd.channels?.length > 0 && !cmd.channels.includes(message.channel.id)) continue;

            const db = {
                set: async (k, v) => await redis.hset(`userdata:${message.guild.id}`, k, JSON.stringify(v)),
                get: async (k) => JSON.parse(await redis.hget(`userdata:${message.guild.id}`, k) || "null"),
                del: async (k) => await redis.hdel(`userdata:${message.guild.id}`, k)
            };

            const vm = new VM({ timeout: 3000, sandbox: { db, message, reply: (t) => message.reply(t) } });
            try { await vm.run(`(async () => { ${cmd.code} })()`); } catch (e) { addLog(message.guild.id, e.message); }
        }
    }
});

client.login(config.TOKEN);
app.listen(process.env.PORT || 80);
                     
