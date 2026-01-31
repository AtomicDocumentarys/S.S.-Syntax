const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const { VM } = require('vm2');
const Redis = require('ioredis');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// 1. Initialize Discord Bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// 2. Setup Express & Socket.io Server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Prevents CORS crashes
});

// 3. Setup Redis with Auto-Reconnect
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

redis.on('error', (err) => console.error('Redis Error:', err));
redis.on('connect', () => console.log('Successfully connected to Redis.'));

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '.')));

// --- LIVE LOGGING SYSTEM ---
function sendLog(guildId, message) {
    if (guildId) {
        io.to(guildId).emit('log', { 
            timestamp: new Date().toLocaleTimeString(), 
            message 
        });
    }
}

io.on('connection', (socket) => {
    socket.on('join-server', (guildId) => {
        if (guildId) {
            socket.join(guildId);
            console.log(`Socket joined room: ${guildId}`);
        }
    });
});

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/callback.html', (req, res) => res.sendFile(path.join(__dirname, 'callback.html')));

// API: Fetch Commands
app.get('/api/commands/:guildId', async (req, res) => {
    try {
        const commands = await redis.hgetall(`commands:${req.params.guildId}`);
        const list = Object.values(commands).map(c => JSON.parse(c));
        res.json(list);
    } catch (e) {
        res.status(500).json([]);
    }
});

// API: Save Command
app.post('/api/save-command', async (req, res) => {
    try {
        const { guildId, command } = req.body;
        if (!guildId || !command.name) return res.status(400).send("Invalid Data");
        await redis.hset(`commands:${guildId}`, command.id || Date.now(), JSON.stringify(command));
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// API: Auth Exchange
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
        const response = await axios.post('https://discord.com/api/oauth2/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        res.json({ access_token: response.data.access_token });
    } catch (e) {
        res.status(500).json({ error: "Auth Exchange Failed" });
    }
});

// --- BOT LOGIC ---
async function executeJS(code, context) {
    const vm = new VM({ timeout: 3000, sandbox: context });
    try {
        return await vm.run(`(async () => { ${code} })()`);
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    try {
        const commands = await redis.hgetall(`commands:${message.guild.id}`);
        for (const id in commands) {
            const cmd = JSON.parse(commands[id]);
            if (message.content.startsWith('!' + cmd.name)) {
                sendLog(message.guild.id, `Executing !${cmd.name} for ${message.author.username}`);
                const result = await executeJS(cmd.code, { 
                    user: message.author.username, 
                    content: message.content 
                });
                message.reply(`\`\`\`\n${result}\n\`\`\``);
                sendLog(message.guild.id, `Output: ${result}`);
            }
        }
    } catch (e) {
        console.error("Message Handler Error:", e);
    }
});

// --- STARTUP ---
client.on('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}`);
});

client.login(config.TOKEN).catch(err => {
    console.error("Discord Login Failed:", err);
    process.exit(1); // Crash purposefully so Railway restarts it
});

const PORT = process.env.PORT || 80;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Web Server running on port ${PORT}`);
});
         
