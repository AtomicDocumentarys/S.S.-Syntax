const { Client, GatewayIntentBits, PermissionsBitField, Collection } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { NodeVM } = require('vm2');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const util = require('util');

// Promisify zlib functions
const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

// --- CONFIGURATION ---
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || (process.env.RAILWAY_STATIC_URL ? `${process.env.RAILWAY_STATIC_URL}/callback` : 'http://localhost:3000/callback');
const REDIS_URL = process.env.REDIS_URL;
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const API_SECRET = process.env.API_SECRET || crypto.randomBytes(32).toString('hex');

// Parse ALLOWED_ORIGINS from environment variable
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
if (ALLOWED_ORIGINS.length === 0 && NODE_ENV === 'development') {
  ALLOWED_ORIGINS.push('http://localhost:3000');
}

// Bot configuration (optional - won't break if not provided)
const BOT_CONFIG = {
  token: TOKEN,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  name: 'S.S. Syntax',
  enabled: !!TOKEN, // Only enable bot if token is provided
  status: {
    ready: false,
    enabled: !!TOKEN,
    error: TOKEN ? null : 'No bot token provided'
  }
};

// --- DATA STRUCTURES ---
const commandCache = new Map();
const sessionCache = new Map();
const cooldowns = new Map();
const executionLogs = new Map();
const guildCache = new Map();

let botClient = null;

// Cleanup intervals
setInterval(() => {
  const now = Date.now();
  for (const [key, expires] of cooldowns.entries()) {
    if (expires < now) cooldowns.delete(key);
  }
  for (const [sessionId, session] of sessionCache.entries()) {
    if (session.expiresAt <= now) sessionCache.delete(sessionId);
  }
  for (const [cacheKey, logs] of executionLogs.entries()) {
    if (logs.length > 1000) executionLogs.set(cacheKey, logs.slice(0, 1000));
  }
  for (const [guildKey, { timestamp }] of guildCache.entries()) {
    if (now - timestamp > 5 * 60 * 1000) guildCache.delete(guildKey);
  }
}, 60000);

// --- ENVIRONMENT VALIDATION ---
console.log('🔍 Environment check:');
console.log(`   NODE_ENV: ${NODE_ENV}`);
console.log(`   PORT: ${PORT}`);
console.log(`   CLIENT_ID: ${CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`   TOKEN: ${TOKEN ? '✅ Set (Bot enabled)' : '⚠️ Missing (Bot disabled)'}`);
console.log(`   REDIS_URL: ${REDIS_URL ? '✅ Set' : '❌ Missing'}`);

// --- EXPRESS APP ---
const app = express();

// === HEALTH CHECK FIRST ===
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'discord-bot-dashboard',
    environment: NODE_ENV,
    version: '2.0.0',
    bot_enabled: BOT_CONFIG.enabled,
    bot_ready: botClient?.status?.ready || false
  });
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  },
  hsts: false
}));

// CORS with origin validation
app.use(cors({
  origin: (origin, callback) => {
    if (!origin && NODE_ENV === 'development') return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🚫 Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// === Redis TLS ===
let redis;
try {
  redis = new Redis(REDIS_URL, {
    tls: REDIS_URL && REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 100, 5000),
    reconnectOnError: (err) => err.message.includes('READONLY')
  });

  redis.on('connect', () => console.log('✅ Redis connected'));
  redis.on('error', (err) => console.error('❌ Redis error:', err.message));
  redis.on('close', () => console.warn('⚠️ Redis connection closed'));
} catch (error) {
  console.error('❌ Failed to create Redis client:', error.message);
  redis = {
    get: async () => null,
    set: async () => 'OK',
    hgetall: async () => ({}),
    hset: async () => 0,
    del: async () => 0,
    setex: async () => 'OK',
    lpush: async () => 0,
    lrange: async () => [],
    ltrim: async () => 'OK',
    on: () => {}
  };
}

// --- MIDDLEWARE ---
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = uuidv4().substring(0, 8);
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logMessage = `${requestId} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 500) console.error(`❌ ${logMessage}`);
    else if (res.statusCode >= 400) console.warn(`⚠️ ${logMessage}`);
    else console.log(`✅ ${logMessage}`);
  });
  req.requestId = requestId;
  next();
});

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- SESSION MANAGEMENT ---
function generateSessionId() {
  const uuid = uuidv4();
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(uuid);
  return `${uuid}:${hmac.digest('hex').substring(0, 16)}`;
}

function verifySessionId(sessionId) {
  const [uuid, signature] = sessionId.split(':');
  if (!uuid || !signature) return false;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(uuid);
  return signature === hmac.digest('hex').substring(0, 16);
}

async function createSession(discordToken, userData, ipAddress) {
  const sessionId = generateSessionId();
  const sessionData = {
    discordToken,
    userData,
    ipAddress,
    createdAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000),
    lastActivity: Date.now()
  };
  await redis.setex(`session:${sessionId}`, 24 * 60 * 60, JSON.stringify(sessionData));
  sessionCache.set(sessionId, sessionData);
  return sessionId;
}

async function validateSession(sessionId, ipAddress) {
  if (!verifySessionId(sessionId)) return null;
  
  // Check memory cache
  if (sessionCache.has(sessionId)) {
    const session = sessionCache.get(sessionId);
    if (session.expiresAt <= Date.now()) {
      sessionCache.delete(sessionId);
      await redis.del(`session:${sessionId}`);
      return null;
    }
    if (NODE_ENV === 'production' && ipAddress && session.ipAddress !== ipAddress) {
      console.warn(`🚨 Session IP mismatch`);
      return null;
    }
    session.lastActivity = Date.now();
    return session;
  }
  
  // Check Redis
  const sessionData = await redis.get(`session:${sessionId}`);
  if (!sessionData) return null;
  
  const session = JSON.parse(sessionData);
  if (session.expiresAt <= Date.now()) {
    await redis.del(`session:${sessionId}`);
    return null;
  }
  
  session.lastActivity = Date.now();
  sessionCache.set(sessionId, session);
  await redis.setex(`session:${sessionId}`, 24 * 60 * 60, JSON.stringify(session));
  return session;
}

// --- DISCORD BOT INITIALIZATION (OPTIONAL) ---
async function initializeBot() {
  if (!BOT_CONFIG.enabled) {
    console.log('⚠️ Bot token not provided - bot functionality disabled');
    console.log('✅ Web dashboard will run independently');
    return;
  }
  
  try {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
      ],
      partials: ['MESSAGE', 'CHANNEL']
    });

    botClient = {
      client,
      config: BOT_CONFIG,
      status: { ready: false, enabled: true, error: null, startedAt: Date.now() }
    };

    // Setup bot events
    client.once('ready', () => {
      console.log(`🤖 ${BOT_CONFIG.name} logged in as ${client.user.tag}`);
      botClient.status.ready = true;
      botClient.status.guilds = client.guilds.cache.size;
      botClient.status.startedAt = Date.now();
      botClient.status.ping = client.ws.ping;
    });

    client.on('messageCreate', async (message) => {
      if (message.author.bot || !message.guild) return;
      
      // Command handling logic here
      const prefix = '!';
      if (!message.content.startsWith(prefix)) return;
      
      const args = message.content.slice(prefix.length).trim().split(/ +/);
      const commandName = args.shift().toLowerCase();
      
      // Load and execute custom commands from Redis
      const commands = await loadGuildCommands(message.guild.id);
      const command = commands.find(cmd => cmd.name === commandName);
      
      if (command) {
        try {
          const sandbox = createSandbox(message);
          const startTime = Date.now();
          await sandbox.run(command.code);
          const executionTime = Date.now() - startTime;
          
          await logCommandExecution(
            message.guild.id,
            message.author.id,
            command.id,
            true,
            null,
            executionTime
          );
        } catch (error) {
          console.error(`Command execution error: ${error.message}`);
          await logCommandExecution(
            message.guild.id,
            message.author.id,
            command.id,
            false,
            error,
            null
          );
        }
      }
    });

    await client.login(BOT_CONFIG.token);
    console.log(`✅ ${BOT_CONFIG.name} login initiated`);
  } catch (error) {
    console.error(`❌ Failed to login ${BOT_CONFIG.name}:`, error.message);
    BOT_CONFIG.status.error = error.message;
  }
}

// --- SANDBOX (Only used if bot is enabled) ---
function createSandbox(message) {
  return new NodeVM({
    timeout: 2000,
    sandbox: {
      message: {
        author: {
          id: message.author.id,
          username: message.author.username,
          bot: message.author.bot
        },
        channel: {
          id: message.channel.id,
          name: message.channel.name,
          send: async (content) => {
            if (typeof content !== 'string') content = String(content);
            if (content.length > 2000) content = content.substring(0, 1997) + '...';
            return message.channel.send(content).catch(console.error);
          }
        },
        guild: message.guild,
        content: message.content,
        reply: (content) => message.reply(content).catch(console.error)
      },
      console: {
        log: (...args) => {
          const logMsg = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
          ).join(' ');
          console.log(`[Command ${message.guild?.id}]`, logMsg);
        }
      }
    },
    require: false,
    eval: false,
    wasm: false,
    wrapper: 'none'
  });
}

// --- COMMAND MANAGEMENT ---
async function loadGuildCommands(guildId) {
  try {
    const cacheKey = `commands:${guildId}`;
    if (guildCache.has(cacheKey)) {
      const cached = guildCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
        return cached.data;
      }
    }
    
    const commands = await redis.hgetall(`commands:${guildId}`);
    const parsedCommands = Object.values(commands)
      .map(c => {
        try { return JSON.parse(c); } catch { return null; }
      })
      .filter(c => c !== null);
    
    guildCache.set(cacheKey, {
      timestamp: Date.now(),
      data: parsedCommands
    });
    
    return parsedCommands;
  } catch (error) {
    console.error('Failed to load commands:', error.message);
    return [];
  }
}

async function logCommandExecution(guildId, userId, commandId, success, error = null, executionTime = null) {
  const logEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    guildId,
    userId,
    commandId,
    success,
    error: error ? error.message : null,
    executionTime
  };
  
  await redis.lpush(`logs:${guildId}`, JSON.stringify(logEntry));
  await redis.ltrim(`logs:${guildId}`, 0, 9999);
}

// --- AUTHENTICATION MIDDLEWARE ---
async function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const sessionId = req.cookies?.sessionId || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null);
    
    if (!sessionId) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const session = await validateSession(sessionId, req.ip);
    
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    req.session = session;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// --- ROUTES ---

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API routes (protected with authentication)
app.get('/api/guilds', authenticateUser, apiLimiter, async (req, res) => {
  try {
    if (!BOT_CONFIG.enabled || !botClient || !botClient.status.ready) {
      return res.json({ 
        guilds: [],
        bot_available: false,
        message: BOT_CONFIG.enabled ? 'Bot is not ready yet' : 'Bot functionality is disabled'
      });
    }
    
    const guilds = await botClient.client.guilds.fetch();
    const guildData = await Promise.all(
      guilds.map(async (guild) => {
        const fullGuild = await guild.fetch();
        return {
          id: fullGuild.id,
          name: fullGuild.name,
          icon: fullGuild.iconURL(),
          memberCount: fullGuild.memberCount,
          owner: fullGuild.ownerId === botClient.client.user.id
        };
      })
    );
    
    res.json({ guilds: guildData, bot_available: true });
  } catch (error) {
    console.error('Failed to fetch guilds:', error);
    res.status(500).json({ error: 'Failed to fetch guilds' });
  }
});

// Get bot status
app.get('/api/status', authenticateUser, apiLimiter, (req, res) => {
  if (!BOT_CONFIG.enabled) {
    return res.json({
      enabled: false,
      ready: false,
      name: BOT_CONFIG.name,
      message: 'Bot functionality is disabled (no token provided)'
    });
  }
  
  if (!botClient) {
    return res.json({
      enabled: true,
      ready: false,
      name: BOT_CONFIG.name,
      message: 'Bot is initializing...',
      error: BOT_CONFIG.status.error
    });
  }
  
  res.json({
    enabled: true,
    ready: botClient.status.ready,
    name: BOT_CONFIG.name,
    uptime: botClient.status.ready ? Date.now() - botClient.status.startedAt : 0,
    guilds: botClient.status.guilds || 0,
    ping: botClient.status.ping || 0,
    message: botClient.status.ready ? 'Bot is online' : 'Bot is connecting...'
  });
});

// Get commands for a guild
app.get('/api/commands/:guildId', authenticateUser, apiLimiter, async (req, res) => {
  try {
    const { guildId } = req.params;
    const commands = await loadGuildCommands(guildId);
    res.json({ 
      commands,
      bot_available: BOT_CONFIG.enabled && botClient?.status?.ready
    });
  } catch (error) {
    console.error('Failed to fetch commands:', error);
    res.status(500).json({ error: 'Failed to fetch commands' });
  }
});

// Create or update a command
app.post('/api/commands/:guildId', authenticateUser, apiLimiter, [
  body('name').isString().trim().notEmpty(),
  body('code').isString().trim().notEmpty(),
  body('description').optional().isString().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { guildId } = req.params;
    const { name, code, description } = req.body;
    const commandId = uuidv4();
    
    const commandData = {
      id: commandId,
      name: name.toLowerCase(),
      code,
      description: description || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await redis.hset(`commands:${guildId}`, commandId, JSON.stringify(commandData));
    
    // Clear cache
    guildCache.delete(`commands:${guildId}`);
    
    res.json({ 
      success: true, 
      command: commandData,
      bot_available: BOT_CONFIG.enabled && botClient?.status?.ready
    });
  } catch (error) {
    console.error('Failed to save command:', error);
    res.status(500).json({ error: 'Failed to save command' });
  }
});

// Delete a command
app.delete('/api/commands/:guildId/:commandId', authenticateUser, apiLimiter, async (req, res) => {
  try {
    const { guildId, commandId } = req.params;
    await redis.hdel(`commands:${guildId}`, commandId);
    
    // Clear cache
    guildCache.delete(`commands:${guildId}`);
    
    res.json({ 
      success: true,
      bot_available: BOT_CONFIG.enabled && botClient?.status?.ready
    });
  } catch (error) {
    console.error('Failed to delete command:', error);
    res.status(500).json({ error: 'Failed to delete command' });
  }
});

// Discord OAuth callback
app.get('/callback', authLimiter, async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).send('No authorization code provided');
    }
    
    // Exchange code for access token
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', 
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        scope: 'identify guilds'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const { access_token, refresh_token } = tokenResponse.data;
    
    // Get user info
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });
    
    // Create session
    const sessionId = await createSession(access_token, userResponse.data, req.ip);
    
    // Set session cookie
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });
    
    // Redirect to dashboard
    res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).send('A
