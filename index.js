const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { NodeVM } = require('vm2');
const { exec } = require('child_process');
const fs = require('fs');
const Redis = require('ioredis');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { body, validationResult } = require('express-validator');

// Configuration
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'https://official-sssyntax-website-production.up.railway.app/callback';
const REDIS_URL = process.env.REDIS_URL;

// Check environment variables
if (!TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REDIS_URL) {
    console.error('Missing environment variables');
    console.error('TOKEN:', TOKEN ? 'OK' : 'MISSING');
    console.error('CLIENT_ID:', CLIENT_ID ? 'OK' : 'MISSING');
    console.error('CLIENT_SECRET:', CLIENT_SECRET ? 'OK' : 'MISSING');
    console.error('REDIS_URL:', REDIS_URL ? 'OK' : 'MISSING');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const app = express();
const redis = new Redis(REDIS_URL);

// Global state
const rateLimit = new Map();
const errorLog = [];

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.static('.'));

// Request logging
app.use((req, res, next) => {
    console.log(req.method + ' ' + req.path);
    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// OAuth Callback
app.get('/callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.redirect('/?error=no_code');
        
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', 
            new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            }), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );
        
        const { access_token } = tokenResponse.data;
        res.redirect('/?token=' + access_token);
    } catch (error) {
        console.error('OAuth error:', error.message);
        res.redirect('/?error=auth_failed');
    }
});

// Authentication middleware
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token' });
        }
        
        const token = authHeader.replace('Bearer ', '');
        const response = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: 'Bearer ' + token }
        });
        
        req.user = response.data;
        req.token = token;
        next();
    } catch (e) {
        console.error('Auth error:', e.message);
        res.status(401).json({ error: 'Invalid token' });
    }
}

// Guild access verification
async function verifyGuildAccess(req, res, next) {
    const guildId = req.params.guildId || req.body.guildId;
    if (!guildId) return res.status(400).json({ error: 'Guild ID required' });
    
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        
        const member = await guild.members.fetch(req.user.id).catch(() => null);
        if (!member || !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        req.guild = guild;
        next();
    } catch (e) {
        console.error('Guild access error:', e.message);
        res.status(403).json({ error: 'Access failed' });
    }
}

// Utility functions
function checkRateLimit(userId, cmdId, cooldown = 2000) {
    const key = userId + ':' + cmdId;
    const now = Date.now();
    if (!rateLimit.has(key)) rateLimit.set(key, 0);
    
    const lastUsed = rateLimit.get(key);
    if (lastUsed > 0 && now - lastUsed < cooldown) return false;
    
    rateLimit.set(key, now);
    return true;
}

async function cleanupTempFile(filepath) {
    try {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (e) {
        console.error('Cleanup error:', e);
    }
}

// API Routes

// User Info
app.get('/api/user-me', authenticateUser, async (req, res) => {
    res.json(req.user);
});

// Mutual Servers
app.get('/api/mutual-servers', authenticateUser, async (req, res) => {
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: 'Bearer ' + req.token }
        });
        
        const mutual = response.data.filter(g => {
            try {
                return (BigInt(g.permissions) & 0x20n) === 0x20n && client.guilds.cache.has(g.id);
            } catch {
                return false;
            }
        });
        
        res.json(mutual);
    } catch (e) {
        console.error('Mutual servers error:', e.message);
        res.status(500).json([]);
    }
});

// Commands Management
app.get('/api/commands/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const commands = await redis.hgetall('commands:' + req.params.guildId);
        const cmdList = Object.values(commands).map(c => {
            try {
                return JSON.parse(c);
            } catch {
                return null;
            }
        }).filter(c => c !== null);
        
        res.json(cmdList);
    } catch (e) {
        console.error('Commands fetch error:', e.message);
        res.status(500).json([]);
    }
});

app.post('/api/save-command', authenticateUser, verifyGuildAccess, [
    body('command.trigger').isString().trim().isLength({ min: 1, max: 100 }),
    body('command.code').isString().trim().isLength({ max: 5000 }),
    body('command.lang').isIn(['JavaScript', 'Python', 'Go']),
    body('command.type').isIn(['Command (prefix)', 'Exact Match', 'Starts with'])
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
        
        const { guildId, command } = req.body;
        const count = await redis.hlen('commands:' + guildId);
        
        if (!command.isEdit && count >= 100) {
            return res.status(403).json({ error: 'Command limit reached' });
        }
        
        if (!command.id) command.id = crypto.randomUUID();
        
        command.createdBy = req.user.id;
        command.createdAt = command.createdAt || new Date().toISOString();
        command.updatedAt = new Date().toISOString();
        
        await redis.hset('commands:' + guildId, command.id, JSON.stringify(command));
        res.json({ success: true, message: 'Command saved', id: command.id });
    } catch (e) {
        console.error('Save command error:', e.message);
        res.status(500).json({ error: 'Failed to save command' });
    }
});

app.delete('/api/command/:guildId/:cmdId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        await redis.hdel('commands:' + req.params.guildId, req.params.cmdId);
        res.json({ success: true, message: 'Command deleted' });
    } catch (e) {
        console.error('Delete command error:', e.message);
        res.status(500).json({ error: 'Failed to delete command' });
    }
});

// Settings Management
app.get('/api/settings/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const prefix = await redis.get('prefix:' + req.params.guildId) || '!';
        res.json({ prefix });
    } catch (e) {
        console.error('Settings fetch error:', e.message);
        res.json({ prefix: '!' });
    }
});

app.post('/api/settings/:guildId', authenticateUser, verifyGuildAccess, [
    body('prefix').isString().trim().isLength({ min: 1, max: 5 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
        
        await redis.set('prefix:' + req.params.guildId, req.body.prefix);
        res.json({ success: true, message: 'Settings saved' });
    } catch (e) {
        console.error('Settings save error:', e.message);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Database Management
app.get('/api/db/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const entries = await redis.hgetall('db:' + req.params.guildId);
        const parsedEntries = {};
        
        for (const [key, value] of Object.entries(entries)) {
            try {
                parsedEntries[key] = JSON.parse(value);
            } catch {
                parsedEntries[key] = value;
            }
        }
        
        res.json(parsedEntries);
    } catch (e) {
        console.error('DB fetch error:', e.message);
        res.status(500).json({});
    }
});

app.post('/api/db/:guildId', authenticateUser, verifyGuildAccess, [
    body('key').isString().trim().isLength({ min: 1, max: 100 }),
    body('value').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
        
        await redis.hset('db:' + req.params.guildId, req.body.key, JSON.stringify(req.body.value));
        res.json({ success: true, message: 'Entry saved' });
    } catch (e) {
        console.error('DB save error:', e.message);
        res.status(500).json({ error: 'Failed to save entry' });
    }
});

app.delete('/api/db/:guildId/:key', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        await redis.hdel('db:' + req.params.guildId, req.params.key);
        res.json({ success: true, message: 'Entry deleted' });
    } catch (e) {
        console.error('DB delete error:', e.message);
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

// System Status
app.get('/api/status', async (req, res) => {
    try {
        const botStatus = client.readyAt ? '🟢 Online' : '🔴 Offline';
        const redisStatus = await redis.ping() === 'PONG' ? '🟢 Connected' : '🔴 Disconnected';
        const uptime = process.uptime();
        
        res.json({
            bot: botStatus,
            redis: redisStatus,
            uptime: Math.floor(uptime / 60) + ' minutes',
            guilds: client.guilds.cache.size,
            errors: errorLog.slice(-10),
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
        });
    } catch (e) {
        console.error('Status check error:', e.message);
        res.json({
            bot: '🔴 Offline',
            redis: '🔴 Disconnected',
            uptime: '0 minutes',
            guilds: 0,
            errors: errorLog.slice(-10),
            memory: '0 MB'
        });
    }
});

// Command Testing
app.post('/api/test-command', authenticateUser, [
    body('code').isString().trim().isLength({ max: 5000 }),
    body('lang').isIn(['JavaScript', 'Python', 'Go'])
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
        
        const { code, lang } = req.body;
        let output = '';
        
        if (lang === 'JavaScript') {
            const vm = new NodeVM({
                timeout: 3000,
                sandbox: {
                    console: { 
                        log: (msg) => { output += msg + '\n'; } 
                    }
                },
                require: { 
                    external: false, 
                    builtin: ['*'] 
                }
            });
            
            try {
                vm.run(code);
                res.json({ output: output || 'No output' });
            } catch (e) {
                res.json({ output: 'Error: ' + e.message });
            }
        } else if (lang === 'Python') {
            const randomId = crypto.randomUUID();
            const tempFile = path.join(__dirname, 'temp_' + randomId + '.py');
            
            try {
                fs.writeFileSync(tempFile, code);
                exec('timeout 5 python3 ' + tempFile, (error, stdout, stderr) => {
                    output = stdout || stderr || 'No output';
                    cleanupTempFile(tempFile);
                    res.json({ output });
                });
            } catch (e) {
                cleanupTempFile(tempFile);
                res.json({ output: 'Error: ' + e.message });
            }
        } else if (lang === 'Go') {
            const randomId = crypto.randomUUID();
            const tempFile = path.join(__dirname, 'temp_' + randomId + '.go');
            
            try {
                fs.writeFileSync(tempFile, code);
                exec('timeout 5 go run ' + tempFile, (error, stdout, stderr) => {
                    output = stdout || stderr || 'No output';
                    cleanupTempFile(tempFile);
                    res.json({ output });
                });
            } catch (e) {
                cleanupTempFile(tempFile);
                res.json({ output: 'Error: ' + e.message });
            }
        }
    } catch (e) {
        console.error('Test command error:', e.message);
        res.status(500).json({ output: 'Server Error' });
    }
});

// Discord Message Handler
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    try {
        const guildId = message.guild?.id;
        if (!guildId) return;
        
        const prefix = await redis.get('prefix:' + guildId) || '!';
        const commands = await redis.hgetall('commands:' + guildId);
        
        for (const cmdData of Object.values(commands)) {
            try {
                const command = JSON.parse(cmdData);
                let matches = false;
                
                if (command.type === 'Command (prefix)') {
                    matches = message.content.startsWith(prefix + command.trigger);
                } else if (command.type === 'Exact Match') {
                    matches = message.content === command.trigger;
                } else if (command.type === 'Starts with') {
                    matches = message.content.startsWith(command.trigger);
                }
                
                if (matches) {
                    if (!checkRateLimit(message.author.id, command.id, command.cooldown || 2000)) {
                        return message.reply('⏰ Please wait before using this command again!');
                    }
                    
                    if (command.lang === 'JavaScript') {
                        const vm = new NodeVM({
                            timeout: 5000,
                            sandbox: {
                                message: message,
                                args: message.content.split(' ').slice(1),
                                prefix: prefix
                            },
                            require: {
                                external: false,
                                builtin: ['*']
                            }
                        });
                        
                        try {
                            const result = vm.run(command.code);
                            if (result && typeof result === 'string') {
                                message.reply(result);
                            }
                        } catch (error) {
                            message.reply('❌ Command execution error');
                        }
                    }
                    break;
                }
            } catch (cmdError) {
                console.error('Command parsing error:', cmdError);
            }
        }
    } catch (error) {
        console.error('Message handler error:', error);
    }
});

// Discord Bot Events
client.once('ready', () => {
    console.log('✅ Bot logged in as ' + client.user.tag);
    console.log('📊 Serving ' + client.guilds.cache.size + ' guilds');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🌐 Dashboard running on port ' + PORT);
    console.log('🔗 Bot starting...');
});

// Login bot
client.login(TOKEN).catch(error => {
    console.error('❌ Bot login failed:', error);
    process.exit(1);
});

// Error handling
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    errorLog.push('Server error: ' + err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

console.log('✅ Server starting...');
