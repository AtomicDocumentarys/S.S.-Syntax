const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { VM } = require('vm2');
const Redis = require('ioredis');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379'); 

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '.')));

// --- DASHBOARD ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/callback.html', (req, res) => res.sendFile(path.join(__dirname, 'callback.html')));

// --- API: BOT SERVER CHECK ---
app.get('/api/check-bot/:guildId', (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: "Bot not in server" });
    res.json({ success: true });
});

// --- API: FETCH COMMANDS ---
app.get('/api/commands/:guildId', async (req, res) => {
    const commands = await redis.hgetall(`commands:${req.params.guildId}`);
    res.json(Object.values(commands).map(c => JSON.parse(c)));
});

// --- API: DELETE COMMAND ---
app.post('/api/delete-command', async (req, res) => {
    const { guildId, commandId } = req.body;
    await redis.hdel(`commands:${guildId}`, commandId);
    res.json({ success: true });
});

// --- API: DIAGNOSTICS (TEST CODE) ---
app.post('/api/test-code', async (req, res) => {
    const { language, code } = req.body;
    try {
        const result = await executeCode(language, code, { user: "Tester", content: "!test" });
        if (result && result.includes("Error")) throw new Error(result);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// --- API: OAUTH2 ---
app.post('/api/auth/exchange', async (req, res) => {
    const { code } = req.body;
    try {
        const params = new URLSearchParams({
            client_id: config.CLIENT_ID,
            client_secret: config.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: config.REDIRECT_URI
        });
        const response = await axios.post('https://discord.com/api/oauth2/token', params);
        res.json({ access_token: response.data.access_token });
    } catch (error) {
        res.status(500).json({ error: 'Auth failed' });
    }
});

// --- SAVE COMMAND ---
app.post('/api/save-command', async (req, res) => {
    const { guildId, command } = req.body;
    await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
    res.sendStatus(200);
});

// --- EXECUTION ENGINE ---
async function executeCode(lang, code, context) {
    const timeout = 3000;
    if (lang === 'js') {
        const vm = new VM({ timeout, sandbox: context });
        try { return await vm.run(`(async () => { ${code} })()`); } 
        catch (e) { return `JS Error: ${e.message}`; }
    }
    // Python/Go execution logic goes here...
}

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const commands = await redis.hgetall(`commands:${message.guild.id}`);
    for (const id in commands) {
        const cmd = JSON.parse(commands[id]);
        if (message.content.startsWith('!' + cmd.name)) {
            const out = await executeCode(cmd.language, cmd.code, { user: message.author.username });
            message.reply(`\`\`\`\n${out}\n\`\`\``);
        }
    }
});

client.login(config.TOKEN);
app.listen(process.env.PORT || 80, '0.0.0.0');
         
