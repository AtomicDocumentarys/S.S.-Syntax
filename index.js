const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { body, validationResult } = require('express-validator');

// --- CONFIGURATION ---
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REDIS_URL = process.env.REDIS_URL;
const PORT = process.env.PORT || 3000;

// Check required environment variables
const requiredEnvVars = ['TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'REDIS_URL'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars);
  process.exit(1);
}

console.log('✅ Environment variables validated');

// --- DISCORD CLIENT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// --- EXPRESS APP ---
const app = express();

// --- REDIS CONNECTION ---
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: false
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// --- MIDDLEWARE ---
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

app.use(cors({
  origin: '*',
  credentials: true
}));

// Serve static files
app.use(express.static(__dirname));

// Request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// --- AUTHENTICATION MIDDLEWARE ---
async function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    
    const response = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });
    
    req.user = response.data;
    req.token = token;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- GUILD ACCESS VERIFICATION ---
async function verifyGuildAccess(req, res, next) {
  const guildId = req.params.guildId || req.body.guildId;
  
  if (!guildId) {
    return res.status(400).json({ error: 'Guild ID required' });
  }
  
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }
    
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) {
      return res.status(403).json({ error: 'Not a member of this guild' });
    }
    
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    
    req.guild = guild;
    next();
  } catch (error) {
    console.error('Guild verification error:', error.message);
    res.status(403).json({ error: 'Unable to verify access' });
  }
}

// --- ROUTES ---

// Config endpoint (safe to expose client ID for OAuth)
app.get('/api/config', (req, res) => {
  res.json({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    botInvite: `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`
  });
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({
      status: 'ok',
      bot: client.isReady() ? 'online' : 'offline',
      redis: 'connected'
    });
  } catch (error) {
    res.json({
      status: 'degraded',
      bot: client.isReady() ? 'online' : 'offline',
      redis: 'disconnected'
    });
  }
});

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// OAuth callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
    return res.redirect(oauthUrl);
  }
  
  try {
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );
    
    const token = tokenResponse.data.access_token;
    res.redirect(`/?token=${token}`);
  } catch (error) {
    console.error('OAuth error:', error.message);
    res.redirect('/?error=auth_failed');
  }
});

// User info
app.get('/api/user-me', authenticateUser, (req, res) => {
  res.json(req.user);
});

// Mutual servers
app.get('/api/mutual-servers', authenticateUser, async (req, res) => {
  try {
    const response = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.token}` },
      timeout: 5000
    });
    
    const mutual = response.data.filter(g => {
      try {
        return (BigInt(g.permissions) & 0x20n) === 0x20n && client.guilds.cache.has(g.id);
      } catch {
        return false;
      }
    });
    
    res.json(mutual);
  } catch (error) {
    console.error('Mutual servers error:', error.message);
    res.status(500).json([]);
  }
});

// Guild metadata
app.get('/api/guild-meta/:guildId', authenticateUser, verifyGuildAccess, (req, res) => {
  try {
    const guild = req.guild;
    res.json({
      roles: guild.roles.cache
        .filter(r => !r.managed && r.id !== guild.id)
        .map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
      channels: guild.channels.cache
        .filter(c => c.type === 0)
        .map(c => ({ id: c.id, name: c.name, type: c.type }))
    });
  } catch (error) {
    console.error('Guild meta error:', error.message);
    res.status(500).json({ roles: [], channels: [] });
  }
});

// Get commands
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
  } catch (error) {
    console.error('Get commands error:', error.message);
    res.status(500).json([]);
  }
});

// Save command
app.post('/api/save-command',
  authenticateUser,
  verifyGuildAccess,
  [
    body('command.trigger').isString().trim().isLength({ min: 1, max: 100 }),
    body('command.code').isString().trim().isLength({ max: 5000 }),
    body('command.lang').isIn(['JavaScript', 'Python', 'Go'])
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
        return res.status(403).json({ error: 'Command limit reached (100 max)' });
      }
      
      if (!command.id) {
        command.id = crypto.randomUUID();
      }
      
      command.trigger = command.trigger.trim();
      command.code = command.code.trim();
      command.category = command.category || 'General';
      command.cooldown = command.cooldown || 2000;
      command.createdBy = req.user.id;
      command.updatedAt = new Date().toISOString();
      
      await redis.hset(`commands:${guildId}`, command.id, JSON.stringify(command));
      res.json({ success: true, message: 'Command saved', id: command.id });
    } catch (error) {
      console.error('Save command error:', error.message);
      res.status(500).json({ error: 'Failed to save command' });
    }
  }
);

// Delete command
app.delete('/api/command/:guildId/:cmdId', authenticateUser, verifyGuildAccess, async (req, res) => {
  try {
    await redis.hdel(`commands:${req.params.guildId}`, req.params.cmdId);
    res.json({ success: true, message: 'Command deleted' });
  } catch (error) {
    console.error('Delete command error:', error.message);
    res.status(500).json({ error: 'Failed to delete command' });
  }
});

// Get settings
app.get('/api/settings/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
  try {
    const prefix = await redis.get(`prefix:${req.params.guildId}`) || '!';
    res.json({ prefix });
  } catch (error) {
    console.error('Get settings error:', error.message);
    res.status(500).json({ prefix: '!' });
  }
});

// Save settings
app.post('/api/settings/:guildId',
  authenticateUser,
  verifyGuildAccess,
  [body('prefix').isString().trim().isLength({ min: 1, max: 5 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      await redis.set(`prefix:${req.params.guildId}`, req.body.prefix);
      res.json({ success: true, message: 'Settings saved' });
    } catch (error) {
      console.error('Save settings error:', error.message);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  }
);

// Get database
app.get('/api/db/:guildId', authenticateUser, verifyGuildAccess, async (req, res) => {
  try {
    const entries = await redis.hgetall(`db:${req.params.guildId}`);
    const parsed = {};
    
    for (const [key, value] of Object.entries(entries)) {
      try {
        parsed[key] = JSON.parse(value);
      } catch {
        parsed[key] = value;
      }
    }
    
    res.json(parsed);
  } catch (error) {
    console.error('Get DB error:', error.message);
    res.status(500).json({});
  }
});

// Save database entry
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
        return res.status(403).json({ error: 'Database limit reached (1000 max)' });
      }
      
      await redis.hset(`db:${req.params.guildId}`, req.body.key, JSON.stringify(req.body.value));
      res.json({ success: true, message: 'Entry saved' });
    } catch (error) {
      console.error('Save DB error:', error.message);
      res.status(500).json({ error: 'Failed to save entry' });
    }
  }
);

// Delete database entry
app.delete('/api/db/:guildId/:key', authenticateUser, verifyGuildAccess, async (req, res) => {
  try {
    await redis.hdel(`db:${req.params.guildId}`, req.params.key);
    res.json({ success: true, message: 'Entry deleted' });
  } catch (error) {
    console.error('Delete DB error:', error.message);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// System status
app.get('/api/status', async (req, res) => {
  try {
    const redisStatus = await redis.ping() === 'PONG' ? '🟢 Connected' : '🔴 Disconnected';
    const botStatus = client.isReady() ? '🟢 Online' : '🔴 Offline';
    
    res.json({
      bot: botStatus,
      redis: redisStatus,
      uptime: Math.floor(process.uptime() / 60) + ' minutes',
      guilds: client.guilds.cache.size,
      errors: []
    });
  } catch (error) {
    res.status(500).json({
      bot: '🔴 Offline',
      redis: '🔴 Disconnected',
      uptime: '0 minutes',
      guilds: 0,
      errors: []
    });
  }
});

// --- MESSAGE HANDLER ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  
  try {
    const commands = await redis.hgetall(`commands:${message.guild.id}`);
    const prefix = await redis.get(`prefix:${message.guild.id}`) || '!';
    
    for (const id in commands) {
      const cmd = JSON.parse(commands[id]);
      const content = message.content.toLowerCase();
      let match = false;
      
      if (cmd.type === "Command (prefix)" && content.startsWith(prefix + cmd.trigger.toLowerCase())) {
        match = true;
      } else if (cmd.type === "Exact Match" && content === cmd.trigger.toLowerCase()) {
        match = true;
      } else if (cmd.type === "Starts with" && content.startsWith(cmd.trigger.toLowerCase())) {
        match = true;
      }
      
      if (match && cmd.lang === 'JavaScript') {
        try {
          // Simple eval for now - replace with vm2 or isolated-vm in production
          const reply = (text) => message.reply(text);
          eval(cmd.code);
        } catch (error) {
          console.error('Command execution error:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Message handler error:', error.message);
  }
});

// --- DISCORD BOT EVENTS ---
client.once('ready', () => {
  console.log(`🤖 Bot logged in as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} guilds`);
});

client.on('error', (error) => {
  console.error('Discord client error:', error.message);
});

// --- ERROR HANDLING ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGTERM', async () => {
  console.log('⚠️ SIGTERM received, shutting down...');
  client.destroy();
  redis.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('⚠️ SIGINT received, shutting down...');
  client.destroy();
  redis.disconnect();
  process.exit(0);
});

// --- START SERVER ---
async function start() {
  try {
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
    
    // Login to Discord
    await client.login(TOKEN);
    console.log('✅ Bot logged in successfully');
    
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

start();
  
