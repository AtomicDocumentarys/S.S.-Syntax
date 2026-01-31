const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { VM } = require('vm2');
const { exec } = require('child_process');
const fs = require('fs');
const Redis = require('ioredis');
const axios = require('axios');
const config = require('./config');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const app = express();
const redis = new Redis(process.env.REDIS_URL);
app.use(bodyParser.json());
app.use(express.static('.'));

// --- EXECUTION ENGINES ---
async function runPython(code) {
    return new Promise((resolve) => {
        const escapedCode = code.replace(/"/g, '\\"');
        exec(`python3 -c "${escapedCode}"`, (error, stdout, stderr) => {
            if (error) resolve(`Error: ${stderr || error.message}`);
            resolve(stdout);
        });
    });
}

async function runGo(code) {
    return new Promise((resolve) => {
        const filename = `temp_${Date.now()}.go`;
        fs.writeFileSync(filename, code);
        exec(`go run ${filename}`, (error, stdout, stderr) => {
            if (fs.existsSync(filename)) fs.unlinkSync(filename);
            if (error) resolve(`Error: ${stderr || error.message}`);
            resolve(stdout);
        });
    });
}

// --- API ROUTES ---
app.get('/api/mutual-servers', async (req, res) => {
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: req.headers.authorization }
        });
        const mutual = response.data.filter(g => {
            const hasPerms = (BigInt(g.permissions) & 0x8n) || (BigInt(g.permissions) & 0x20n);
            return hasPerms && client.guilds.cache.has(g.id);
        });
        res.json(mutual);
    } catch (e) { res.status(500).send("Sync Error"); }
});

app.get('/api/guild-meta/:guildId', async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).send("Guild not found");
    res.json({
        channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })),
        roles: guild.roles.cache.map(r => ({ id: r.id, name: r.name }))
    });
});

app.post('/api/save-command', async (req, res) => {
    const { guildId, command } = req.body;
    await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
    res.sendStatus(200);
});

// --- MESSAGE HANDLER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const commands = await redis.hgetall(`commands:${message.guild.id}`);
    for (const id in commands) {
        const cmd = JSON.parse(commands[id]);
        let triggered = false;
        const content = message.content;
        const prefix = cmd.prefix || "!";

        if (cmd.type === "Command (prefix)") {
            if (content.startsWith(prefix + cmd.trigger)) triggered = true;
        } else if (cmd.type === "Starts with") {
            if (content.toLowerCase().startsWith(cmd.trigger.toLowerCase())) triggered = true;
        } else if (cmd.type === "Contains") {
            if (content.toLowerCase().includes(cmd.trigger.toLowerCase())) triggered = true;
        } else if (cmd.type === "Regex (Case Insensitive)") {
            const re = new RegExp(cmd.trigger, 'i');
            if (re.test(content)) triggered = true;
        }

        if (triggered) {
            if (cmd.roles?.length && !message.member.roles.cache.some(r => cmd.roles.includes(r.id))) continue;
            if (cmd.channels?.length && !cmd.channels.includes(message.channel.id)) continue;

            try {
                if (cmd.lang === "JavaScript") {
                    const vm = new VM({ timeout: 2000, sandbox: { message, reply: (t) => message.reply(t) } });
                    await vm.run(cmd.code);
                } else if (cmd.lang === "Python") {
                    const out = await runPython(cmd.code);
                    if (out) message.reply(out);
                } else if (cmd.lang === "Golang") {
                    const out = await runGo(cmd.code);
                    if (out) message.reply(out);
                }
            } catch (err) { message.reply(`Runtime Error: ${err.message}`); }
        }
    }
});

client.on('ready', () => console.log(`Bot Online: ${client.user.tag}`));
client.login(process.env.TOKEN || config.TOKEN);
app.listen(process.env.PORT || 80, '0.0.0.0');
                                  
