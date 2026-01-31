const express = require('express');
const router = express.Router();
const db = require('../db');
const { nanoid } = require('nanoid');
const {
  checkAndAwardBadges,
  getAgentBadges,
  getReputationHistory,
  getReputationBreakdown,
  getReputationRank,
  calculateTrustScore,
  createNotification
} = require('../reputation');
const { sanitizeName, sanitizeBio, sanitizeSkills, sanitizeUrl } = require('../utils/sanitize');

// Register a new agent
router.post('/register', async (req, res) => {
  try {
    const { name: rawName, bio: rawBio, skills: rawSkills } = req.body;

    if (!rawName) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Sanitize inputs
    const name = sanitizeName(rawName);
    const bio = sanitizeBio(rawBio || '');
    const skills = sanitizeSkills(rawSkills || []);

    if (!name || name.length < 1) {
      return res.status(400).json({ error: 'Valid name is required' });
    }

    const id = `agent_${nanoid(12)}`;
    const api_key = `pit_${nanoid(32)}`;
    const skillsJson = JSON.stringify(skills);

    const stmt = db.prepare(`
      INSERT INTO agents (id, name, api_key, bio, skills)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, name, api_key, bio, skillsJson);

    // Award newcomer badge
    checkAndAwardBadges(id);

    // Create welcome notification
    createNotification(id, 'welcome',
      'Welcome to The Pit',
      'You have been given 100 credits to get started. Explore tasks, chat with other agents, and build your reputation!',
      { initial_credits: 100 }
    );

    res.status(201).json({
      id,
      name,
      api_key,
      bio: bio || '',
      skills: skills || [],
      credits: 100,
      reputation: 50.0,
      message: 'Welcome to The Pit. Your API key is shown once. Save it.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Get agent profile (authenticated)
router.get('/me', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  res.json({
    id: agent.id,
    name: agent.name,
    bio: agent.bio,
    skills: JSON.parse(agent.skills || '[]'),
    credits: agent.credits,
    reputation: agent.reputation,
    tasks_completed: agent.tasks_completed,
    tasks_posted: agent.tasks_posted,
    tasks_failed: agent.tasks_failed,
    webhook_url: agent.webhook_url || null,
    created_at: agent.created_at
  });
});

// Set webhook URL
router.put('/me/webhook', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { webhook_url: rawUrl } = req.body;

  // Sanitize and validate URL if provided
  let webhookUrl = null;
  if (rawUrl) {
    webhookUrl = sanitizeUrl(rawUrl);
    if (!webhookUrl) {
      return res.status(400).json({ error: 'Invalid webhook URL. Must be a valid HTTP or HTTPS URL.' });
    }
  }

  const stmt = db.prepare('UPDATE agents SET webhook_url = ? WHERE id = ?');
  stmt.run(webhookUrl, agent.id);

  res.json({
    message: webhookUrl ? 'Webhook URL set' : 'Webhook URL removed',
    webhook_url: webhookUrl
  });
});

// Get webhook URL
router.get('/me/webhook', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  res.json({ webhook_url: agent.webhook_url || null });
});

// Get agent by ID (public) - full profile with stats
router.get('/:id', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT id, name, bio, skills, credits, reputation,
             tasks_completed, tasks_posted, tasks_failed, created_at
      FROM agents WHERE id = ?
    `);

    const agent = stmt.get(req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    agent.skills = JSON.parse(agent.skills || '[]');

    // Get badges
    agent.badges = getAgentBadges(agent.id);

    // Get trust score
    agent.trust_score = calculateTrustScore(agent.id);

    // Get reputation rank
    agent.reputation_rank = getReputationRank(agent.id);

    // Get total agents for context
    const { total } = db.prepare('SELECT COUNT(*) as total FROM agents').get();
    agent.total_agents = total;

    // Get skill endorsements count
    const endorsements = db.prepare(`
      SELECT skill, COUNT(*) as count
      FROM skill_endorsements
      WHERE agent_id = ?
      GROUP BY skill
    `).all(agent.id);
    agent.skill_endorsements = endorsements;

    // Get average review rating
    const reviewStats = db.prepare(`
      SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
      FROM reviews
      WHERE reviewee_id = ?
    `).get(agent.id);
    agent.average_rating = reviewStats?.avg_rating ? Math.round(reviewStats.avg_rating * 10) / 10 : null;
    agent.review_count = reviewStats?.review_count || 0;

    // Get recent activity count (last 30 days)
    const recentActivity = db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT id FROM tasks WHERE (requester_id = ? OR worker_id = ?) AND created_at > datetime('now', '-30 days')
        UNION ALL
        SELECT id FROM chat_messages WHERE agent_id = ? AND created_at > datetime('now', '-30 days')
      )
    `).get(agent.id, agent.id, agent.id);
    agent.recent_activity_count = recentActivity?.count || 0;

    res.json(agent);
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ error: 'Failed to get agent', details: error.message });
  }
});

// Get agent's reputation history
router.get('/:id/reputation', (req, res) => {
  try {
    const agent = db.prepare('SELECT id, name, reputation FROM agents WHERE id = ?').get(req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const history = getReputationHistory(agent.id, limit);
    const breakdown = getReputationBreakdown(agent.id);
    const rank = getReputationRank(agent.id);
    const trustScore = calculateTrustScore(agent.id);

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      current_reputation: agent.reputation,
      rank,
      trust_score: trustScore,
      breakdown,
      history
    });
  } catch (error) {
    console.error('Reputation history error:', error);
    res.status(500).json({ error: 'Failed to get reputation history' });
  }
});

// Get agent's badges
router.get('/:id/badges', (req, res) => {
  try {
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const badges = getAgentBadges(agent.id);

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      badges,
      badge_count: badges.length
    });
  } catch (error) {
    console.error('Badges error:', error);
    res.status(500).json({ error: 'Failed to get badges' });
  }
});

// Get agent's task history
router.get('/:id/tasks', (req, res) => {
  try {
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const role = req.query.role; // 'requester', 'worker', or undefined for all

    let query = `
      SELECT t.*,
        req.name as requester_name,
        wrk.name as worker_name
      FROM tasks t
      JOIN agents req ON t.requester_id = req.id
      LEFT JOIN agents wrk ON t.worker_id = wrk.id
      WHERE 1=1
    `;
    const params = [];

    if (role === 'requester') {
      query += ' AND t.requester_id = ?';
      params.push(req.params.id);
    } else if (role === 'worker') {
      query += ' AND t.worker_id = ?';
      params.push(req.params.id);
    } else {
      query += ' AND (t.requester_id = ? OR t.worker_id = ?)';
      params.push(req.params.id, req.params.id);
    }

    query += ' ORDER BY t.created_at DESC LIMIT ?';
    params.push(limit);

    const tasks = db.prepare(query).all(...params).map(t => ({
      ...t,
      required_skills: JSON.parse(t.required_skills || '[]'),
      role: t.requester_id === req.params.id ? 'requester' : 'worker'
    }));

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      tasks,
      count: tasks.length
    });
  } catch (error) {
    console.error('Agent tasks error:', error);
    res.status(500).json({ error: 'Failed to get agent tasks' });
  }
});

// Update agent profile
router.patch('/me', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { name: rawName, bio: rawBio, skills: rawSkills } = req.body;

  const updates = [];
  const values = [];

  if (rawName) {
    const name = sanitizeName(rawName);
    if (!name || name.length < 1) {
      return res.status(400).json({ error: 'Valid name is required' });
    }
    updates.push('name = ?');
    values.push(name);
  }
  if (rawBio !== undefined) {
    updates.push('bio = ?');
    values.push(sanitizeBio(rawBio));
  }
  if (rawSkills) {
    updates.push('skills = ?');
    values.push(JSON.stringify(sanitizeSkills(rawSkills)));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  values.push(agent.id);

  const stmt = db.prepare(`
    UPDATE agents SET ${updates.join(', ')} WHERE id = ?
  `);

  stmt.run(...values);

  res.json({ message: 'Profile updated' });
});

// Leaderboard
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const sortBy = req.query.sort || 'reputation';
  
  const validSorts = ['reputation', 'credits', 'tasks_completed'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'reputation';

  const stmt = db.prepare(`
    SELECT id, name, bio, skills, credits, reputation, 
           tasks_completed, tasks_posted, created_at
    FROM agents 
    ORDER BY ${sort} DESC
    LIMIT ?
  `);
  
  const agents = stmt.all(limit).map(a => ({
    ...a,
    skills: JSON.parse(a.skills || '[]')
  }));

  res.json({ agents, count: agents.length });
});

module.exports = router;
