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

// --- CONFIGURATION & VALIDATION ---
const requiredEnvVars = ['TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'REDIS_URL'];
requiredEnvVars.forEach(key => {
    if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        process.exit(1);
    }
});
console.log('✅ Environment variables validated');

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

// --- GLOBAL STATE ---
const rateLimit = new Map();
const prefixCache = new Map();
const commandStats = new Map();
const errorLog = [];

// --- EVENT HANDLERS ---
redis.on('connect', () => console.log('✅ Redis connected successfully'));
redis.on('error', (err) => console.error('❌ Redis Error:', err));

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
    errorLog.push(`Unhandled rejection: ${error.message}`);
});

// --- MIDDLEWARE ---
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true
}));
app.use(express.static('.'));

// Request logging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - ${req.ip}`);
    next();
});

// --- AUTHENTICATION MIDDLEWARE ---
const authenticateUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No authorization token provided' });
        }
        
        const token = authHeader.replace('Bearer ', '');
        
        const response = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        req.user = response.data;
        req.token = token;
        next();
    } catch (e) {
        console.error('Authentication error:', e.message);
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// --- GUILD ACCESS VERIFICATION ---
const verifyGuildAccess = async (req, res, next) => {
    const guildId = req.params.guildId || req.body.guildId;
    
    if (!guildId) {
        return res.status(400).json({ error: 'Guild ID required' });
    }
    
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found or bot not in guild' });
        }
        
        const member = await guild.members.fetch(req.user.id).catch(() => null);
        if (!member) {
            return res.status(403).json({ error: 'You are not a member of this guild' });
        }
        
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return res.status(403).json({ error: 'Insufficient permissions (Manage Server required)' });
        }
        
        req.guild = guild;
        next();
    } catch (e) {
        console.error('Guild access verification error:', e.message);
        res.status(403).json({ error: 'Unable to verify guild access' });
    }
};

// --- DATABASE FUNCTIONS ---
const dbFunctions = {
    async get(key) {
        try {
            const val = await redis.get(`db:${key}`);
            return val ? JSON.parse(val) : null;
        } catch (e) {
            console.error('DB get error:', e);
            return null;
        }
    },
    async set(key, value) {
        try {
            await redis.set(`db:${key}`, JSON.stringify(value));
            return value;
        } catch (e) {
            console.error('DB set error:', e);
            throw e;
        }
    },
    async add(key, amount) {
        try {
            const val = Number(await redis.get(`db:${key}`) || 0);
            const newVal = val + Number(amount);
            await redis.set(`db:${key}`, newVal);
            return newVal;
        } catch (e) {
            console.error('DB add error:', e);
            throw e;
        }
    },
    async sub(key, amount) {
        try {
            const val = Number(await redis.get(`db:${key}`) || 0);
            const newVal = val - Number(amount);
            await redis.set(`db:${key}`, newVal);
            return newVal;
        } catch (e) {
            console.error('DB sub error:', e);
            throw e;
        }
    },
    async delete(key) {
        try {
            await redis.del(`db:${key}`);
            return true;
        } catch (e) {
            console.error('DB delete error:', e);
            throw e;
        }
    },
    async list(prefix = '') {
        try {
            const keys = await redis.keys(`db:${prefix}*`);
            const values = await Promise.all(keys.map(k => redis.get(k)));
            return values.map((v, i) => ({ 
                key: keys[i].replace('db:', ''), 
                value: v ? JSON.parse(v) : null 
            }));
        } catch (e) {
            console.error('DB list error:', e);
            return [];
        }
    },
    async count() {
        try {
            const keys = await redis.keys('db:*');
            return keys.length;
        } catch (e) {
            console.error('DB count error:', e);
            return 0;
        }
    }
};

// --- UTILITY FUNCTIONS ---
function checkRateLimit(userId, cmdId, cooldown = 2000) {
    const key = `${userId}:${cmdId}`;
    const now = Date.now();
    
    if (!rateLimit.has(key)) {
        rateLimit.set(key, 0);
    }
    
    const lastUsed = rateLimit.get(key);
    
    if (lastUsed > 0 && now - lastUsed < cooldown) {
        return false;
    }
    
    rateLimit.set(key, now);
    return true;
}

async function getPrefix(guildId) {
    if (prefixCache.has(guildId)) {
        return prefixCache.get(guildId);
    }
    
    try {
        const prefix = await redis.get(`prefix:${guildId}`) || '!';
        prefixCache.set(guildId, prefix);
        return prefix;
    } catch (e) {
        console.error('Get prefix error:', e);
        return '!';
    }
}

function updateCommandStats(guildId, cmdId) {
    const key = `${guildId}:${cmdId}`;
    if (!commandStats.has(key)) {
        commandStats.set(key, { uses: 0, lastUsed: null });
    }
    
    const stats = commandStats.get(key);
    stats.uses++;
    stats.lastUsed = new Date().toISOString();
}

async function cleanupTempFile(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    } catch (e) {
        console.error('Cleanup error:', e);
    }
}

// --- API ROUTES ---

// User Info
app.get('/api/user-me', authenticateUser, async (req, res) => {
    try {
        res.json(req.user);
    } catch (e) {
        console.error('User fetch error:', e.message);
        res.status(500).json({ error: 'Failed to fetch user info' });
    }
});

// Mutual Servers
app.get('/api/mutual-servers', authenticateUser, async (req, res) => {
    try {
        const response = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${req.token}` }
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

// Guild Meta Data
app.get('/api/guild-meta/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const guild = req.guild;
        res.json({
            roles: guild.roles.cache
                .filter(r => !r.managed && r.id !== guild.id)
                .map(r => ({ 
                    id: r.id, 
                    name: r.name, 
                    color: r.hexColor 
                })),
            channels: guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ 
                    id: c.id, 
                    name: c.name, 
                    type: c.type 
                }))
        });
    } catch (e) {
        console.error('Guild meta error:', e.message);
        res.status(500).json({ roles: [], channels: [] });
    }
});

// Commands Management
app.get('/api/commands/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const commands = await redis.hgetall(`commands:${req.params.guildId}`);
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

app.post('/api/save-command', 
    authenticateUser,
    verifyGuildAccess,
    [
        body('command.trigger').isString().trim().isLength({ min: 1, max: 100 }),
        body('command.code').isString().trim().isLength({ max: 5000 }),
        body('command.lang').isIn(['JavaScript', 'Python', 'Go']),
        body('command.type').isIn(['Command (prefix)', 'Exact Match', 'Starts with']),
        body('command.category').optional().isString().trim().isLength({ max: 50 }),
        body('command.cooldown').optional().isInt({ min: 0, max: 60000 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const { guildId, command } = req.body;
            const count = await redis.hlen(`commands:${guildId}`);
            
            if (!command.isEdit && count >= 100) {
                return res.status(403).json({ error: 'Command limit reached (100 commands max)' });
            }
            
            if (!command.id || typeof command.id !== 'string') {
                command.id = crypto.randomUUID();
            }
            
            command.trigger = command.trigger.trim();
            command.code = command.code.trim();
            command.category = command.category ? command.category.trim() : 'General';
            command.cooldown = command.cooldown || 2000;
            command.createdBy = req.user.id;
            command.createdAt = command.createdAt || new Date().toISOString();
            command.updatedAt = new Date().toISOString();
            
            await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
            res.json({ success: true, message: 'Command saved successfully', id: command.id });
        } catch (e) {
            console.error('Save command error:', e.message);
            errorLog.push(`Save command error: ${e.message}`);
            res.status(500).json({ error: 'Failed to save command' });
        }
    }
);

app.delete('/api/command/:guildId/:cmdId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        await redis.hdel(`commands:${req.params.guildId}`, req.params.cmdId);
        res.json({ success: true, message: 'Command deleted successfully' });
    } catch (e) {
        console.error('Delete command error:', e.message);
        errorLog.push(`Delete command error: ${e.message}`);
        res.status(500).json({ error: 'Failed to delete command' });
    }
});

// Settings Management
app.get('/api/settings/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const prefix = await redis.get(`prefix:${req.params.guildId}`) || '!';
        res.json({ prefix });
    } catch (e) {
        console.error('Settings fetch error:', e.message);
        res.status(500).json({ prefix: '!' });
    }
});

app.post('/api/settings/:guildId', 
    authenticateUser,
    verifyGuildAccess,
    [
        body('prefix').isString().trim().isLength({ min: 1, max: 5 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            await redis.set(`prefix:${req.params.guildId}`, req.body.prefix);
            prefixCache.set(req.params.guildId, req.body.prefix);
            res.json({ success: true, message: 'Settings saved successfully' });
        } catch (e) {
            console.error('Settings save error:', e.message);
            errorLog.push(`Settings save error: ${e.message}`);
            res.status(500).json({ error: 'Failed to save settings' });
        }
    }
);

// Database Management
app.get('/api/db/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const count = await redis.hlen(`db:${req.params.guildId}`);
        if (count >= 1000) {
            return res.status(403).json({ error: 'Database limit reached (1000 entries max)' });
        }
        
        const entries = await redis.hgetall(`db:${req.params.guildId}`);
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

app.post('/api/db/:guildId', 
    authenticateUser,
    verifyGuildAccess,
    [
        body('key').isString().trim().isLength({ min: 1, max: 100 }),
        body('value').notEmpty()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const count = await redis.hlen(`db:${req.params.guildId}`);
            if (count >= 1000) {
                return res.status(403).json({ error: 'Database limit reached' });
            }
            
            await redis.hset(`db:${req.params.guildId}`, req.body.key, JSON.stringify(req.body.value));
            res.json({ success: true, message: 'Entry saved successfully' });
        } catch (e) {
            console.error('DB save error:', e.message);
            errorLog.push(`DB save error: ${e.message}`);
            res.status(500).json({ error: 'Failed to save entry' });
        }
    }
);

app.delete('/api/db/:guildId/:key', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        await redis.hdel(`db:${req.params.guildId}`, req.params.key);
        res.json({ success: true, message: 'Entry deleted successfully' });
    } catch (e) {
        console.error('DB delete error:', e.message);
        errorLog.push(`DB delete error: ${e.message}`);
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

// Webhooks Management
app.get('/api/webhooks/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        const webhooks = await redis.hgetall(`webhooks:${req.params.guildId}`);
        const parsedWebhooks = {};
        
        for (const [key, value] of Object.entries(webhooks)) {
            try {
                parsedWebhooks[key] = JSON.parse(value);
            } catch {
                parsedWebhooks[key] = value;
            }
        }
        
        res.json(parsedWebhooks);
    } catch (e) {
        console.error('Webhooks fetch error:', e.message);
        res.status(500).json({});
    }
});

app.post('/api/webhooks/:guildId', 
    authenticateUser,
    verifyGuildAccess,
    [
        body('name').isString().trim().isLength({ min: 1, max: 100 }),
        body('url').isURL(),
        body('events').isArray(),
        body('secret').optional().isString().trim()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const { name, url, events, secret } = req.body;
            const webhookId = crypto.randomUUID();
            
            const webhookData = {
                id: webhookId,
                name,
                url,
                events,
                secret: secret || crypto.randomBytes(16).toString('hex'),
                createdAt: new Date().toISOString(),
                createdBy: req.user.id
            };
            
            await redis.hset(`webhooks:${req.params.guildId}`, webhookId, JSON.stringify(webhookData));
            res.json({ success: true, message: 'Webhook created successfully', id: webhookId });
        } catch (e) {
            console.error('Webhook create error:', e.message);
            errorLog.push(`Webhook create error: ${e.message}`);
            res.status(500).json({ error: 'Failed to create webhook' });
        }
    }
);

app.put('/api/webhooks/:guildId/:webhookId', 
    authenticateUser,
    verifyGuildAccess,
    [
        body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
        body('url').optional().isURL(),
        body('events').optional().isArray(),
        body('secret').optional().isString().trim()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const existing = await redis.hget(`webhooks:${req.params.guildId}`, req.params.webhookId);
            if (!existing) {
                return res.status(404).json({ error: 'Webhook not found' });
            }
            
            const webhookData = JSON.parse(existing);
            const updates = req.body;
            
            // Update fields
            Object.keys(updates).forEach(key => {
                if (updates[key] !== undefined) {
                    webhookData[key] = updates[key];
                }
            });
            
            webhookData.updatedAt = new Date().toISOString();
            
            await redis.hset(`webhooks:${req.params.guildId}`, req.params.webhookId, JSON.stringify(webhookData));
            res.json({ success: true, message: 'Webhook updated successfully' });
        } catch (e) {
            console.error('Webhook update error:', e.message);
            errorLog.push(`Webhook update error: ${e.message}`);
            res.status(500).json({ error: 'Failed to update webhook' });
        }
    }
);

app.delete('/api/webhooks/:guildId/:webhookId', authenticateUser, verifyGuildAccess, async (req, res) => {
    try {
        await redis.hdel(`webhooks:${req.params.guildId}`, req.params.webhookId);
        res.json({ success: true, message: 'Webhook deleted successfully' });
    } catch (e) {
        console.error('Webhook delete error:', e.message);
        errorLog.push(`Webhook delete error: ${e.message}`);
        res.status(500).json({ error: 'Failed to delete webhook' });
    }
});

// Webhook Test Endpoint
app.post('/api/webhooks/:guildId/:webhookId/test', 
    authenticateUse
