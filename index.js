const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- CONFIGURATION ---
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || (process.env.RAILWAY_STATIC_URL ? `${process.env.RAILWAY_STATIC_URL}/callback` : 'http://localhost:3000/callback');
const REDIS_URL = process.env.REDIS_URL;
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Parse ALLOWED_ORIGINS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
if (ALLOWED_ORIGINS.length === 0 && NODE_ENV === 'development') {
  ALLOWED_ORIGINS.push('http://localhost:3000');
}

// --- EXPRESS APP ---
const app = express();

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'discord-bot-dashboard'
  });
});

// CORS
app.use(cors({
  origin: (origin, callback) => {
    if (!origin && NODE_ENV === 'development') return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Body parsing
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- REDIS ---
const redis = new Redis(REDIS_URL, {
  tls: REDIS_URL && REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  maxRetriesPerRequest: 3
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// --- DISCORD CLIENT ---
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let botReady = false;

discordClient.once('ready', () => {
  botReady = true;
  console.log(`🤖 Bot logged in as ${discordClient.user.tag}`);
  console.log(`📊 Serving ${discordClient.guilds.cache.size} guilds`);
});

discordClient.on('error', (error) => {
  console.error('❌ Discord error:', error.message);
});

// --- SESSION MANAGEMENT ---
async function createSession(userData, ip) {
  const sessionId = uuidv4();
  const sessionData = {
    user: userData,
    ip,
    createdAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000)
  };
  
  await redis.setex(`session:${sessionId}`, 24 * 60 * 60, JSON.stringify(sessionData));
  return sessionId;
}

async function getSession(sessionId) {
  const sessionData = await redis.get(`session:${sessionId}`);
  if (!sessionData) return null;
  
  const session = JSON.parse(sessionData);
  if (session.expiresAt <= Date.now()) {
    await redis.del(`session:${sessionId}`);
    return null;
  }
  
  return session;
}

// Authentication middleware
async function requireAuth(req, res, next) {
  const sessionId = req.cookies?.sessionId || req.headers.authorization?.replace('Bearer ', '');
  
  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const session = await getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }
  
  req.user = session.user;
  req.sessionId = sessionId;
  next();
}

// --- ROUTES FOR index.html ---

// OAuth Login
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const scopes = ['identify', 'guilds'];
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes.join('%20')}&state=${state}`;
  res.redirect(url);
});

// OAuth Callback
app.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).send('No code provided');
    }
    
    // Exchange code for token
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    
    const { access_token, token_type } = tokenResponse.data;
    
    // Get user info
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { authorization: `${token_type} ${access_token}` },
    });
    
    const user = userResponse.data;
    
    // Create session
    const sessionId = await createSession(user, req.ip);
    
    // Set cookie
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000
    });
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(500).send('Login failed. Please try again.');
  }
});

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Get current user
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// API: Get bot's guilds
app.get('/api/guilds', requireAuth, (req, res) => {
  if (!botReady) {
    return res.status(503).json({ error: 'Bot not ready' });
  }
  
  const guilds = discordClient.guilds.cache.map(guild => ({
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL(),
    memberCount: guild.memberCount,
    owner: guild.ownerId === req.user.id
  }));
  
  res.json({ guilds });
});

// API: Get commands for a guild
app.get('/api/commands/:guildId', requireAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    const commands = await redis.hgetall(`commands:${guildId}`);
    
    const parsedCommands = Object.values(commands || {}).map(cmd => {
      try {
        return JSON.parse(cmd);
      } catch {
        return null;
      }
    }).filter(cmd => cmd !== null);
    
    res.json({ commands: parsedCommands });
  } catch (error) {
    console.error('Error fetching commands:', error);
    res.status(500).json({ error: 'Failed to fetch commands' });
  }
});

// API: Create/update command
app.post('/api/commands/:guildId', requireAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    const { name, code, description } = req.body;
    
    if (!name || !code) {
      return res.status(400).json({ error: 'Name and code are required' });
    }
    
    const commandId = uuidv4();
    const commandData = {
      id: commandId,
      name,
      code,
      description: description || '',
      createdAt: new Date().toISOString(),
      createdBy: req.user.id
    };
    
    await redis.hset(`commands:${guildId}`, commandId, JSON.stringify(commandData));
    
    res.json({
      success: true,
      command: commandData,
      message: 'Command saved successfully'
    });
  } catch (error) {
    console.error('Error saving command:', error);
    res.status(500).json({ error: 'Failed to save command' });
  }
});

// API: Delete command
app.delete('/api/commands/:guildId/:commandId', requireAuth, async (req, res) => {
  try {
    const { guildId, commandId } = req.params;
    await redis.hdel(`commands:${guildId}`, commandId);
    
    res.json({
      success: true,
      message: 'Command deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting command:', error);
    res.status(500).json({ error: 'Failed to delete command' });
  }
});

// API: Execute command (simulated)
app.post('/api/execute/:guildId', requireAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    const { code } = req.body;
    
    if (!botReady) {
      return res.status(503).json({ error: 'Bot not ready' });
    }
    
    const guild = discordClient.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }
    
    // Find a text channel
    const channel = guild.channels.cache.find(ch => 
      ch.isTextBased() && ch.permissionsFor(discordClient.user).has('SendMessages')
    );
    
    if (!channel) {
      return res.status(400).json({ error: 'No suitable channel found' });
    }
    
    // Simple execution - just send the code as message
    try {
      await channel.send(`**Test Execution**\n\`\`\`js\n${code.substring(0, 1900)}\n\`\`\``);
      
      res.json({
        success: true,
        message: 'Command executed in Discord'
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message,
        message: 'Failed to send to Discord'
      });
    }
  } catch (error) {
    console.error('Error executing command:', error);
    res.status(500).json({ error: 'Failed to execute command' });
  }
});

// API: Logout
app.get('/api/logout', (req, res) => {
  const sessionId = req.cookies?.sessionId;
  if (sessionId) {
    redis.del(`session:${sessionId}`).catch(() => {});
  }
  
  res.clearCookie('sessionId');
  res.json({ success: true, message: 'Logged out' });
});

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- START SERVER ---
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Server running on port ${PORT}
🌐 Environment: ${NODE_ENV}
🔗 Health: http://localhost:${PORT}/health
🔗 Login: http://localhost:${PORT}/login
  `);
});

// Start Discord bot in background
setTimeout(() => {
  if (!TOKEN) {
    console.log('⚠️  No Discord token provided - bot disabled');
    return;
  }
  
  discordClient.login(TOKEN).then(() => {
    console.log('✅ Discord bot login initiated');
  }).catch(error => {
    console.error('❌ Discord login failed:', error.message);
    console.log('⚠️  Server continues without bot features');
  });
}, 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  server.close(() => {
    discordClient.destroy();
    console.log('✅ Clean shutdown complete');
    process.exit(0);
  });
});
