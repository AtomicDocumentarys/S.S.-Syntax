const express = require('express');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// --- CONFIGURATION ---
const TOKEN = process.env.TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const REDIRECT_URI = process.env.REDIRECT_URI || (process.env.RAILWAY_STATIC_URL ? `${process.env.RAILWAY_STATIC_URL}/callback` : 'http://localhost:3000/callback');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Parse ALLOWED_ORIGINS from environment variable
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
if (ALLOWED_ORIGINS.length === 0 && NODE_ENV === 'development') {
  ALLOWED_ORIGINS.push('http://localhost:3000');
}

// --- EXPRESS APP ---
const app = express();

// === HEALTH CHECK FIRST ===
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'discord-bot-dashboard',
    environment: NODE_ENV,
    version: '2.0.0',
    bot_enabled: !!TOKEN
  });
});

// Security middleware
app.use(helmet());

// CORS with origin validation
app.use(cors({
  origin: (origin, callback) => {
    if (!origin && NODE_ENV === 'development') {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.length === 0) {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// === Redis Connection ===
let redis;
try {
  redis = new Redis(REDIS_URL, {
    tls: REDIS_URL && REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 100, 5000)
  });

  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error', (err) => console.error('Redis error:', err.message));
  redis.on('close', () => console.log('Redis connection closed'));
} catch (error) {
  console.error('Failed to create Redis client:', error.message);
  // Create a mock redis client
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
    hdel: async () => 0,
    on: () => {}
  };
}

// --- MIDDLEWARE ---
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = crypto.randomBytes(4).toString('hex');
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${requestId} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
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
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now().toString(36);
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(randomBytes + timestamp);
  return `${randomBytes}:${timestamp}:${hmac.digest('hex').substring(0, 16)}`;
}

function verifySessionId(sessionId) {
  const parts = sessionId.split(':');
  if (parts.length !== 3) return false;
  
  const [randomBytes, timestamp, signature] = parts;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(randomBytes + timestamp);
  
  // Check if signature matches
  if (signature !== hmac.digest('hex').substring(0, 16)) {
    return false;
  }
  
  return true;
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
  return sessionId;
}

async function validateSession(sessionId, ipAddress) {
  if (!verifySessionId(sessionId)) return null;
  
  // Check Redis
  const sessionData = await redis.get(`session:${sessionId}`);
  if (!sessionData) return null;
  
  const session = JSON.parse(sessionData);
  if (session.expiresAt <= Date.now()) {
    await redis.del(`session:${sessionId}`);
    return null;
  }
  
  if (NODE_ENV === 'production' && ipAddress && session.ipAddress !== ipAddress) {
    console.log('Session IP mismatch');
    return null;
  }
  
  session.lastActivity = Date.now();
  await redis.setex(`session:${sessionId}`, 24 * 60 * 60, JSON.stringify(session));
  return session;
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

// --- COMMAND MANAGEMENT ---
async function loadGuildCommands(guildId) {
  try {
    const commands = await redis.hgetall(`commands:${guildId}`);
    if (!commands || Object.keys(commands).length === 0) return [];
    
    const parsedCommands = Object.values(commands)
      .map(c => {
        try { 
          return JSON.parse(c); 
        } catch (e) { 
          console.log('Failed to parse command:', e.message);
          return null; 
        }
      })
      .filter(c => c !== null);
    
    return parsedCommands;
  } catch (error) {
    console.log('Failed to load commands:', error.message);
    return [];
  }
}

async function saveGuildCommand(guildId, commandId, commandData) {
  try {
    await redis.hset(`commands:${guildId}`, commandId, JSON.stringify(commandData));
    return true;
  } catch (error) {
    console.log('Failed to save command:', error.message);
    return false;
  }
}

async function deleteGuildCommand(guildId, commandId) {
  try {
    await redis.hdel(`commands:${guildId}`, commandId);
    return true;
  } catch (error) {
    console.log('Failed to delete command:', error.message);
    return false;
  }
}

// --- ROUTES ---

// Dashboard route
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Get bot status
app.get('/api/status', (req, res) => {
  return res.json({
    enabled: !!TOKEN,
    ready: false,
    name: 'S.S. Syntax',
    message: TOKEN ? 'Bot token provided but not initialized' : 'Bot functionality is disabled (no token provided)'
  });
});

// Get commands for a guild
app.get('/api/commands/:guildId', authenticateUser, apiLimiter, async (req, res) => {
  try {
    const { guildId } = req.params;
    const commands = await loadGuildCommands(guildId);
    return res.json({ 
      success: true,
      commands,
      bot_available: !!TOKEN
    });
  } catch (error) {
    console.error('Failed to fetch commands:', error);
    return res.status(500).json({ error: 'Failed to fetch commands' });
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
    const commandId = crypto.randomBytes(16).toString('hex');
    
    const commandData = {
      id: commandId,
      name: name.toLowerCase(),
      code,
      description: description || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    const success = await saveGuildCommand(guildId, commandId, commandData);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to save command' });
    }
    
    return res.json({ 
      success: true, 
      command: commandData,
      bot_available: !!TOKEN
    });
  } catch (error) {
    console.error('Failed to save command:', error);
    return res.status(500).json({ error: 'Failed to save command' });
  }
});

// Delete a command
app.delete('/api/commands/:guildId/:commandId', authenticateUser, apiLimiter, async (req, res) => {
  try {
    const { guildId, commandId } = req.params;
    const success = await deleteGuildCommand(guildId, commandId);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete command' });
    }
    
    return res.json({ 
      success: true,
      bot_available: !!TOKEN
    });
  } catch (error) {
    console.error('Failed to delete command:', error);
    return res.status(500).json({ error: 'Failed to delete command' });
  }
});

// Discord OAuth callback - FIXED THE INCOMPLETE STRING HERE
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
        code: code,
        redirect_uri: REDIRECT_URI,
        scope: 'identify guilds'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const { access_token } = tokenResponse.data;
    
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
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    return res.status(500).send('Authentication failed');
  }
});

// Login endpoint (returns OAuth URL)
app.get('/api/login', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).json({ error: 'Client ID not configured' });
  }
  
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  return res.json({ url: discordAuthUrl });
});

// Logout endpoint
app.post('/api/logout', authenticateUser, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionId = req.cookies?.sessionId || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null);
    
    if (sessionId) {
      await redis.del(`session:${sessionId}`);
    }
    
    res.clearCookie('sessionId');
    return res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ error: 'Failed to logout' });
  }
});

// User info endpoint
app.get('/api/user', authenticateUser, async (req, res) => {
  try {
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${req.session.discordToken}`
      }
    });
    
    return res.json({ 
      success: true,
      user: userResponse.data,
      bot_available: !!TOKEN
    });
  } catch (error) {
    console.error('Failed to fetch user info:', error);
    return res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

// Get user guilds
app.get('/api/user/guilds', authenticateUser, apiLimiter, async (req, res) => {
  try {
    const guildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: {
        Authorization: `Bearer ${req.session.discordToken}`
      }
    });
    
    // Filter to only guilds where user has admin permissions
    const adminGuilds = guildsResponse.data.filter(guild => {
      const permissions = BigInt(guild.permissions);
      // ADMINISTRATOR permission or MANAGE_GUILD
      return (permissions & 0x8n) === 0x8n || (permissions & 0x20n) === 0x20n;
    }).map(guild => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      permissions: guild.permissions
    }));
    
    return res.json({ 
      success: true,
      guilds: adminGuilds,
      bot_available: !!TOKEN
    });
  } catch (error) {
    console.error('Failed to fetch user guilds:', error);
    return res.status(500).json({ error: 'Failed to fetch user guilds' });
  }
});

// Test endpoint to verify Redis connection
app.get('/api/test/redis', async (req, res) => {
  try {
    const testKey = `test:${Date.now()}`;
    await redis.set(testKey, 'test-value', 'EX', 10);
    const value = await redis.get(testKey);
    await redis.del(testKey);
    
    return res.json({ 
      success: true, 
      message: 'Redis connection working',
      testValue: value
    });
  } catch (error) {
    console.error('Redis test failed:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Redis connection failed',
      message: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  return res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

// --- SERVER STARTUP ---
async function startServer() {
  try {
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${NODE_ENV}`);
      console.log(`Dashboard available at: http://localhost:${PORT}/dashboard`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down');
  process.exit(0);
});

// Start the application
startServer();
