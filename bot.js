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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/callback.html', (req, res) => res.sendFile(path.join(__dirname, 'callback.html')));

// API: Fetch Logs
app.get('/api/logs/:guildId', (req, res) => {
    res.json(liveLogs.filter(l => l.guildId === req.params.guildId));
});

// API: Fetch Database Keys
app.get('/api/database/:guildId', async (req, res) => {
    try {
        const data = await redis.hgetall(`commands:${req.params.guildId}`);
        res.json(data);
    } catch (e) { res.status(500).json({}); }
});

app.get('/api/commands/:guildId', async (req, res) => {
    try {
        const commands = await redis.hgetall(`commands:${req.params.guildId}`);
        res.json(Object.values(commands).map(c => JSON.parse(c)));
    } catch (e) { res.json([]); }
});

app.post('/api/save-command', async (req, res) => {
    const { guildId, command } = req.body;
    await redis.hset(`commands:${guildId}`, command.id || Date.now(), JSON.stringify(command));
    res.sendStatus(200);
});

async function executeJS(code, context) {
    const vm = new VM({ timeout: 3000, sandbox: context });
    try { return await vm.run(`(async () => { ${code} })()`); } 
    catch (e) { return `Error: ${e.message}`; }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    try {
        const commands = await redis.hgetall(`commands:${message.guild.id}`);
        for (const id in commands) {
            const cmd = JSON.parse(commands[id]);
            if (message.content.startsWith('!' + cmd.name)) {
                addLog(message.guild.id, `Ran !${cmd.name}`);
                const result = await executeJS(cmd.code, { user: message.author.username });
                message.reply(`\`\`\`\n${result}\n\`\`\``);
                addLog(message.guild.id, `Output: ${result}`);
            }
        }
    } catch(e) {}
});

client.login(config.TOKEN);
app.listen(process.env.PORT || 80, '0.0.0.0');
    
