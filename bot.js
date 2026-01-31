const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { VM } = require('vm2');
const Redis = require('ioredis');
const { exec } = require('child_process');
const fs = require('fs');
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
// Railway provides REDIS_URL automatically when you add the Redis service
const redis = new Redis(process.env.REDIS_URL); 

app.use(bodyParser.json());
app.use(express.static('dashboard'));

// --- OAUTH2 EXCHANGE ---
app.post('/api/auth/exchange', async (req, res) => {
    const { code } = req.body;
    try {
        const params = new URLSearchParams();
        params.append('client_id', config.CLIENT_ID);
        params.append('client_secret', config.CLIENT_SECRET);
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', config.REDIRECT_URI);

        const response = await axios.post('https://discord.com/api/oauth2/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        res.json({ access_token: response.data.access_token });
    } catch (error) {
        console.error("Auth Error:", error.response?.data || error.message);
        res.status(500).json({ error: 'Auth failed' });
    }
});

// --- COMMAND SAVING ---
app.post('/api/save-command', async (req, res) => {
    const { guildId, command } = req.body;
    await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
    res.sendStatus(200);
});

// --- EXECUTION ENGINE ---
async function executeCode(lang, code, context) {
    const timeout = 3000;
    const ctxString = JSON.stringify(context).replace(/'/g, "\\'");

    if (lang === 'js') {
        const vm = new VM({ timeout, sandbox: context });
        try { return await vm.run(`(async () => { ${code} })()`); } 
        catch (e) { return e.message; }
    }

    if (lang === 'py') {
        return new Promise(resolve => {
            const pyScript = `import json\ncontext = json.loads('${ctxString}')\n${code}`;
            fs.writeFileSync('temp.py', pyScript);
            exec('python3 temp.py', { timeout }, (err, stdout, stderr) => {
                resolve(stdout || stderr || "Execution finished.");
            });
        });
    }

    if (lang === 'go') {
        return new Promise(resolve => {
            const goScript = `package main\nimport "fmt"\nfunc main() {\n ${code} \n}`;
            fs.writeFileSync('temp.go', goScript);
            exec('go run temp.go', { timeout }, (err, stdout, stderr) => {
                resolve(stdout || stderr || "Execution finished.");
            });
        });
    }
}

// --- BOT LISTENER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const commands = await redis.hgetall(`commands:${message.guild.id}`);
    
    for (const id in commands) {
        const cmd = JSON.parse(commands[id]);
        let triggered = false;
        if (cmd.type === 'prefix' && message.content.startsWith((cmd.trigger || '!') + cmd.name)) triggered = true;
        if (cmd.type === 'message' && message.content.includes(cmd.trigger)) triggered = true;

        if (triggered) {
            const output = await executeCode(cmd.language, cmd.code, {
                user: message.author.username,
                content: message.content
            });
            message.reply(`\`\`\`\n${output}\n\`\`\``);
        }
    }
});

client.login(config.TOKEN);

// RAILWAY PORT BINDING
const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 S.S. Syntax Online on Port ${PORT}`));
