const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { VM } = require('vm2'); // For JS
const { exec } = require('child_process'); // For Python/Go
const Redis = require('ioredis');
const axios = require('axios');
const config = require('./config');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const app = express();
const redis = new Redis(process.env.REDIS_URL);

app.use(bodyParser.json());
app.use(express.static('.'));

// --- MUTUAL SERVER & DATA FETCHING ---
app.get('/api/mutual-servers', async (req, res) => {
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: req.headers.authorization }
        });
        const mutual = response.data.filter(g => (BigInt(g.permissions) & 0x8n) && client.guilds.cache.has(g.id));
        res.json(mutual);
    } catch (e) { res.status(500).send("Sync Error"); }
});

// Fetch channels and roles for the selectors
app.get('/api/guild-meta/:guildId', (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).send("Guild not found");
    res.json({
        channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })),
        roles: guild.roles.cache.map(r => ({ id: r.id, name: r.name }))
    });
});

// --- COMMAND EXECUTION ENGINE ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const commands = await redis.hgetall(`commands:${message.guild.id}`);
    
    for (const id in commands) {
        const cmd = JSON.parse(commands[id]);
        let triggered = false;
        const cleanContent = message.content.toLowerCase();

        // Trigger Logic like YAGPDB
        if (cmd.type === "Command (prefix)") {
            if (message.content.startsWith((cmd.prefix || "!") + cmd.trigger)) triggered = true;
        } else if (cmd.type === "Starts with") {
            if (cleanContent.startsWith(cmd.trigger.toLowerCase())) triggered = true;
        } else if (cmd.type === "Contains") {
            if (cleanContent.includes(cmd.trigger.toLowerCase())) triggered = true;
        }

        if (triggered) {
            // Check Restrictions
            if (cmd.roles?.length && !message.member.roles.cache.some(r => cmd.roles.includes(r.id))) continue;
            if (cmd.channels?.length && !cmd.channels.includes(message.channel.id)) continue;

            if (cmd.lang === "JavaScript") {
                const vm = new VM({ timeout: 2000, sandbox: { message, reply: (t) => message.reply(t) } });
                try { await vm.run(cmd.code); } catch(e) {}
            }
            // Python/Go would use exec() logic here
        }
    }
});

client.login(config.TOKEN);
app.listen(process.env.PORT || 80);
