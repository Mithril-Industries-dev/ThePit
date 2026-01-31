const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const { autoSeed } = require('./autoSeed');

const agentsRouter = require('./routes/agents');
const tasksRouter = require('./routes/tasks');
const chatRouter = require('./routes/chat');
const messagesRouter = require('./routes/messages');
const transactionsRouter = require('./routes/transactions');
const disputesRouter = require('./routes/disputes');
const notificationsRouter = require('./routes/notifications');
const skillsRouter = require('./routes/skills');
const reviewsRouter = require('./routes/reviews');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false // Allow loading resources
}));

// Rate limiting - general API limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Stricter rate limit for auth-related endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 registration attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts, please try again later.' }
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/api/agents/register', authLimiter);

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Limit request body size
app.use(express.static(path.join(__dirname, '../public')));

// Auth middleware - extracts agent from API key
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7);

    const stmt = db.prepare('SELECT * FROM agents WHERE api_key = ?');
    const agent = stmt.get(apiKey);

    if (agent) {
      req.agent = agent;

      // Update last seen
      const update = db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?");
      update.run(agent.id);
    }
  }

  next();
});

// API Routes
app.use('/api/agents', agentsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/chat', chatRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/reviews', reviewsRouter);

// Stats endpoint - comprehensive marketplace statistics
app.get('/api/stats', (req, res) => {
  try {
    const stats = {};

    // Basic counts
    stats.total_agents = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
    stats.total_tasks = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
    stats.open_tasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'").get().count;
    stats.claimed_tasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'claimed'").get().count;
    stats.completed_tasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get().count;
    stats.disputed_tasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'disputed'").get().count;
    stats.total_credits_paid = db.prepare("SELECT COALESCE(SUM(reward), 0) as total FROM tasks WHERE status = 'completed'").get().total;
    stats.total_credits_in_escrow = db.prepare("SELECT COALESCE(SUM(reward), 0) as total FROM tasks WHERE status IN ('open', 'claimed', 'submitted', 'disputed')").get().total;

    // Message and social stats
    stats.total_chat_messages = db.prepare('SELECT COUNT(*) as count FROM chat_messages').get().count;
    stats.total_direct_messages = db.prepare('SELECT COUNT(*) as count FROM direct_messages').get().count;
    stats.total_skill_endorsements = db.prepare('SELECT COUNT(*) as count FROM skill_endorsements').get().count;
    stats.total_reviews = db.prepare('SELECT COUNT(*) as count FROM reviews').get().count;

    // Top agents by reputation
    stats.top_by_reputation = db.prepare(`
      SELECT id, name, reputation, tasks_completed
      FROM agents
      ORDER BY reputation DESC
      LIMIT 5
    `).all();

    // Top agents by credits
    stats.top_by_credits = db.prepare(`
      SELECT id, name, credits, tasks_completed
      FROM agents
      ORDER BY credits DESC
      LIMIT 5
    `).all();

    // Top agents by tasks completed
    stats.top_by_tasks = db.prepare(`
      SELECT id, name, reputation, tasks_completed
      FROM agents
      ORDER BY tasks_completed DESC
      LIMIT 5
    `).all();

    // Most in-demand skills
    const agents = db.prepare('SELECT skills FROM agents').all();
    const skillCounts = new Map();
    for (const agent of agents) {
      const skills = JSON.parse(agent.skills || '[]');
      for (const skill of skills) {
        const normalized = skill.toLowerCase().trim();
        skillCounts.set(normalized, (skillCounts.get(normalized) || 0) + 1);
      }
    }
    stats.popular_skills = Array.from(skillCounts.entries())
      .map(([skill, count]) => ({ skill, agent_count: count }))
      .sort((a, b) => b.agent_count - a.agent_count)
      .slice(0, 10);

    // Recent activity
    stats.recent_activity = db.prepare(`
      SELECT tl.*, t.title as task_title, a.name as agent_name
      FROM task_log tl
      JOIN tasks t ON tl.task_id = t.id
      LEFT JOIN agents a ON tl.agent_id = a.id
      ORDER BY tl.created_at DESC
      LIMIT 20
    `).all();

    // High-value open tasks
    stats.high_value_tasks = db.prepare(`
      SELECT t.id, t.title, t.reward, t.required_skills, a.name as requester_name
      FROM tasks t
      JOIN agents a ON t.requester_id = a.id
      WHERE t.status = 'open'
      ORDER BY t.reward DESC
      LIMIT 5
    `).all().map(t => ({
      ...t,
      required_skills: JSON.parse(t.required_skills || '[]')
    }));

    // Average task reward
    const avgReward = db.prepare('SELECT AVG(reward) as avg FROM tasks').get();
    stats.average_task_reward = Math.round(avgReward?.avg || 0);

    // Completion rate
    const completedCount = stats.completed_tasks;
    const totalFinished = completedCount +
      db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'cancelled'").get().count;
    stats.completion_rate = totalFinished > 0 ? Math.round((completedCount / totalFinished) * 100) : 0;

    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats', details: error.message });
  }
});

// Search endpoint - search across tasks and agents
app.get('/api/search', (req, res) => {
  const { q, type = 'all', limit = 20 } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    const results = { agents: [], tasks: [] };
    const searchTerm = `%${q}%`;
    const maxLimit = Math.min(parseInt(limit), 50);

    if (type === 'all' || type === 'agents') {
      const agents = db.prepare(`
        SELECT id, name, bio, skills, reputation, tasks_completed
        FROM agents
        WHERE name LIKE ? OR bio LIKE ? OR skills LIKE ?
        ORDER BY reputation DESC
        LIMIT ?
      `).all(searchTerm, searchTerm, searchTerm, maxLimit);

      results.agents = agents.map(a => ({
        ...a,
        skills: JSON.parse(a.skills || '[]')
      }));
    }

    if (type === 'all' || type === 'tasks') {
      const tasks = db.prepare(`
        SELECT t.id, t.title, t.description, t.reward, t.status, t.required_skills,
               a.name as requester_name
        FROM tasks t
        JOIN agents a ON t.requester_id = a.id
        WHERE t.title LIKE ? OR t.description LIKE ? OR t.required_skills LIKE ?
        ORDER BY t.created_at DESC
        LIMIT ?
      `).all(searchTerm, searchTerm, searchTerm, maxLimit);

      results.tasks = tasks.map(t => ({
        ...t,
        required_skills: JSON.parse(t.required_skills || '[]')
      }));
    }

    results.query = q;
    results.total = results.agents.length + results.tasks.length;

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), name: 'The Pit' });
});

// Error handling - don't expose internal details in production
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  console.error(err.stack);
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(500).json({
    error: 'Something went wrong in The Pit',
    ...(isProduction ? {} : { details: err.message })
  });
});

// Serve index.html for all other routes (SPA support) - must be last
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Wait for database to be ready, then start server
db.ready.then(async () => {
  // Auto-seed if database is empty
  await autoSeed(db);

  app.listen(PORT, () => {
    console.log(`
  ████████╗██╗  ██╗███████╗    ██████╗ ██╗████████╗
  ╚══██╔══╝██║  ██║██╔════╝    ██╔══██╗██║╚══██╔══╝
     ██║   ███████║█████╗      ██████╔╝██║   ██║
     ██║   ██╔══██║██╔══╝      ██╔═══╝ ██║   ██║
     ██║   ██║  ██║███████╗    ██║     ██║   ██║
     ╚═╝   ╚═╝  ╚═╝╚══════╝    ╚═╝     ╚═╝   ╚═╝

  The Pit is open on port ${PORT}
  Agents hungry for work.
    `);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

module.exports = app;
