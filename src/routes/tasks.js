const express = require('express');
const router = express.Router();
const db = require('../db');
const { nanoid } = require('nanoid');
const webhooks = require('../webhooks');
const { recordReputationEvent, createNotification, checkAndAwardBadges } = require('../reputation');
const { recordTransaction } = require('./transactions');
const { sanitizeTitle, sanitizeDescription, sanitizeSkills, sanitizeProof, sanitizeInt } = require('../utils/sanitize');

// Helper to log task events
function logTaskEvent(taskId, agentId, action, details = null) {
  const stmt = db.prepare(`
    INSERT INTO task_log (task_id, agent_id, action, details)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(taskId, agentId, action, details);
}

// List tasks (with filters)
router.get('/', (req, res) => {
  const { status, skill, min_reward, max_reward, requester_id, sort = 'created_at', limit = 50, offset = 0 } = req.query;

  let query = `
    SELECT t.*, req.name as requester_name, req.reputation as requester_reputation,
           wrk.name as worker_name, wrk.reputation as worker_reputation
    FROM tasks t
    JOIN agents req ON t.requester_id = req.id
    LEFT JOIN agents wrk ON t.worker_id = wrk.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    // Support comma-separated status values
    const statuses = status.split(',').map(s => s.trim());
    const placeholders = statuses.map(() => '?').join(',');
    query += ` AND t.status IN (${placeholders})`;
    params.push(...statuses);
  }

  if (skill) {
    // Sanitize skill parameter to prevent injection in LIKE pattern
    const sanitizedSkill = skill.replace(/[%_"\\]/g, '');
    query += ' AND t.required_skills LIKE ?';
    params.push(`%"${sanitizedSkill}"%`);
  }

  if (min_reward) {
    query += ' AND t.reward >= ?';
    params.push(parseInt(min_reward));
  }

  if (max_reward) {
    query += ' AND t.reward <= ?';
    params.push(parseInt(max_reward));
  }

  if (requester_id) {
    query += ' AND t.requester_id = ?';
    params.push(requester_id);
  }

  // Sorting
  const validSorts = {
    'created_at': 't.created_at DESC',
    'reward_high': 't.reward DESC',
    'reward_low': 't.reward ASC',
    'deadline': 't.deadline ASC NULLS LAST'
  };
  const orderBy = validSorts[sort] || validSorts['created_at'];
  query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  params.push(Math.min(parseInt(limit), 100), parseInt(offset));

  const tasks = db.prepare(query).all(...params).map(t => ({
    ...t,
    required_skills: JSON.parse(t.required_skills || '[]')
  }));

  // Get total count for pagination
  let countQuery = 'SELECT COUNT(*) as total FROM tasks t WHERE 1=1';
  const countParams = [];
  if (status) {
    const statuses = status.split(',').map(s => s.trim());
    const placeholders = statuses.map(() => '?').join(',');
    countQuery += ` AND t.status IN (${placeholders})`;
    countParams.push(...statuses);
  }
  if (skill) {
    const sanitizedSkill = skill.replace(/[%_"\\]/g, '');
    countQuery += ' AND t.required_skills LIKE ?';
    countParams.push(`%"${sanitizedSkill}"%`);
  }
  if (min_reward) {
    countQuery += ' AND t.reward >= ?';
    countParams.push(parseInt(min_reward));
  }
  if (max_reward) {
    countQuery += ' AND t.reward <= ?';
    countParams.push(parseInt(max_reward));
  }
  if (requester_id) {
    countQuery += ' AND t.requester_id = ?';
    countParams.push(requester_id);
  }

  const { total } = db.prepare(countQuery).get(...countParams);

  res.json({ tasks, total, limit: parseInt(limit), offset: parseInt(offset) });
});

// Get single task with full details
router.get('/:id', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT t.*,
        req.name as requester_name, req.reputation as requester_reputation,
        wrk.name as worker_name, wrk.reputation as worker_reputation
      FROM tasks t
      JOIN agents req ON t.requester_id = req.id
      LEFT JOIN agents wrk ON t.worker_id = wrk.id
      WHERE t.id = ?
    `);
    const task = stmt.get(req.params.id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    task.required_skills = JSON.parse(task.required_skills || '[]');

    // Get task history
    const logStmt = db.prepare(`
      SELECT tl.*, a.name as agent_name
      FROM task_log tl
      LEFT JOIN agents a ON tl.agent_id = a.id
      WHERE tl.task_id = ?
      ORDER BY tl.created_at ASC
    `);
    task.history = logStmt.all(req.params.id);

    // Get reviews for this task
    task.reviews = db.prepare(`
      SELECT r.*, rev.name as reviewer_name, ree.name as reviewee_name
      FROM reviews r
      JOIN agents rev ON r.reviewer_id = rev.id
      JOIN agents ree ON r.reviewee_id = ree.id
      WHERE r.task_id = ?
    `).all(req.params.id);

    // Check for disputes
    task.disputes = db.prepare(`
      SELECT d.*, ra.name as raised_by_name
      FROM disputes d
      JOIN agents ra ON d.raised_by = ra.id
      WHERE d.task_id = ?
    `).all(req.params.id);

    res.json(task);
  } catch (error) {
    console.error('Get task error:', error);
    res.status(500).json({ error: 'Failed to get task', details: error.message });
  }
});

// Create a new task (requires auth)
router.post('/', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const {
    title: rawTitle,
    description: rawDescription,
    reward: rawReward,
    required_skills: rawSkills,
    proof_required: rawProofRequired,
    deadline
  } = req.body;

  if (!rawTitle || !rawDescription || !rawReward) {
    return res.status(400).json({ error: 'Title, description, and reward are required' });
  }

  // Sanitize inputs
  const title = sanitizeTitle(rawTitle);
  const description = sanitizeDescription(rawDescription);
  const reward = sanitizeInt(rawReward, { min: 1, max: 1000000 });
  const required_skills = sanitizeSkills(rawSkills || []);
  const proof_required = ['text', 'url', 'file'].includes(rawProofRequired) ? rawProofRequired : 'text';

  if (!title || title.length < 1) {
    return res.status(400).json({ error: 'Valid title is required' });
  }

  if (!description || description.length < 1) {
    return res.status(400).json({ error: 'Valid description is required' });
  }

  if (reward < 1) {
    return res.status(400).json({ error: 'Reward must be at least 1 credit' });
  }

  if (agent.credits < reward) {
    return res.status(400).json({ error: 'Insufficient credits', credits: agent.credits, reward });
  }

  const id = `task_${nanoid(12)}`;
  const skillsJson = JSON.stringify(required_skills);

  // Deduct credits from requester (escrow)
  const updateCredits = db.prepare('UPDATE agents SET credits = credits - ?, tasks_posted = tasks_posted + 1 WHERE id = ?');
  updateCredits.run(reward, agent.id);

  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, description, requester_id, reward, required_skills, proof_required, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, title, description, agent.id, reward, skillsJson, proof_required, deadline || null);

  logTaskEvent(id, agent.id, 'created', `Reward: ${reward} credits`);

  // Record transaction
  recordTransaction(agent.id, 'task_escrow', -reward,
    `Escrowed for task: ${title}`,
    { taskId: id }
  );

  // Check for badges
  checkAndAwardBadges(agent.id);

  res.status(201).json({
    id,
    title,
    description,
    requester_id: agent.id,
    reward,
    required_skills,
    proof_required,
    deadline,
    status: 'open',
    message: 'Task posted. Credits escrowed.'
  });
});

// Claim a task
router.post('/:id/claim', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const task = stmt.get(req.params.id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (task.status !== 'open') {
    return res.status(400).json({ error: 'Task is not open', status: task.status });
  }

  if (task.requester_id === agent.id) {
    return res.status(400).json({ error: 'Cannot claim your own task' });
  }

  const update = db.prepare(`
    UPDATE tasks
    SET status = 'claimed', worker_id = ?, claimed_at = datetime('now')
    WHERE id = ? AND status = 'open'
  `);

  update.run(agent.id, req.params.id);

  // Verify the claim was successful
  const verify = db.prepare('SELECT status, worker_id FROM tasks WHERE id = ?');
  const updated = verify.get(req.params.id);

  if (!updated || updated.status !== 'claimed' || updated.worker_id !== agent.id) {
    return res.status(409).json({ error: 'Task was claimed by another agent' });
  }

  logTaskEvent(req.params.id, agent.id, 'claimed');

  // Create notification for requester
  createNotification(task.requester_id, 'task_claimed',
    'Task Claimed',
    `Your task "${task.title}" has been claimed by ${agent.name}`,
    { task_id: req.params.id, worker_id: agent.id, worker_name: agent.name }
  );

  // Notify requester via webhook
  webhooks.notifyTaskClaimed(task, agent.id);

  res.json({
    message: 'Task claimed. Get to work.',
    task_id: req.params.id,
    deadline: task.deadline
  });
});

// Submit work
router.post('/:id/submit', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { proof: rawProof } = req.body;
  if (!rawProof) {
    return res.status(400).json({ error: 'Proof of completion required' });
  }

  // Sanitize proof
  const proof = sanitizeProof(rawProof);

  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const task = stmt.get(req.params.id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (task.worker_id !== agent.id) {
    return res.status(403).json({ error: 'You are not the worker for this task' });
  }

  if (task.status !== 'claimed') {
    return res.status(400).json({ error: 'Task is not in claimed status', status: task.status });
  }

  const update = db.prepare(`
    UPDATE tasks
    SET status = 'submitted', proof_submitted = ?, submitted_at = datetime('now')
    WHERE id = ?
  `);

  update.run(proof, req.params.id);

  logTaskEvent(req.params.id, agent.id, 'submitted', proof.substring(0, 200));

  // Notify requester via webhook
  const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  webhooks.notifyWorkSubmitted(updatedTask);

  res.json({
    message: 'Work submitted. Awaiting validation.',
    task_id: req.params.id
  });
});

// Validate (approve) submitted work
router.post('/:id/validate', (req, res) => {
  try {
    const agent = req.agent;
    if (!agent) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { approved, reason } = req.body;
    if (approved === undefined) {
      return res.status(400).json({ error: 'Approval decision required' });
    }

    const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    const task = stmt.get(req.params.id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (task.requester_id !== agent.id) {
    return res.status(403).json({ error: 'Only the requester can validate' });
  }

  if (task.status !== 'submitted') {
    return res.status(400).json({ error: 'Task is not in submitted status', status: task.status });
  }

  if (approved) {
    // Pay the worker
    const payWorker = db.prepare('UPDATE agents SET credits = credits + ?, tasks_completed = tasks_completed + 1 WHERE id = ?');
    payWorker.run(task.reward, task.worker_id);

    // Mark task complete
    const update = db.prepare(`
      UPDATE tasks
      SET status = 'completed', completed_at = datetime('now')
      WHERE id = ?
    `);
    update.run(req.params.id);

    logTaskEvent(req.params.id, agent.id, 'approved', reason || 'Work accepted');

    // Record transaction for worker
    recordTransaction(task.worker_id, 'task_payment', task.reward,
      `Payment for task: ${task.title}`,
      { taskId: req.params.id, relatedAgentId: task.requester_id }
    );

    // Record reputation events
    recordReputationEvent(task.worker_id, 'TASK_COMPLETED', {
      taskId: req.params.id,
      relatedAgentId: task.requester_id
    });

    // Bonus for high-value tasks
    if (task.reward >= 50) {
      recordReputationEvent(task.worker_id, 'HIGH_VALUE_TASK', {
        taskId: req.params.id,
        reason: `Completed high-value task (${task.reward} credits)`
      });
    }

    // Check for first task badge and streaks
    const worker = db.prepare('SELECT tasks_completed FROM agents WHERE id = ?').get(task.worker_id);
    if (worker && worker.tasks_completed === 1) {
      recordReputationEvent(task.worker_id, 'FIRST_TASK', { taskId: req.params.id });
    }

    // Check for badges
    checkAndAwardBadges(task.worker_id);

    // Create notification for worker
    createNotification(task.worker_id, 'payment',
      'Payment Received',
      `You earned ${task.reward} credits for completing "${task.title}"`,
      { task_id: req.params.id, amount: task.reward }
    );

    // Notify worker via webhook
    webhooks.notifyWorkApproved(task, task.reward);

    res.json({
      message: 'Task completed. Worker paid.',
      task_id: req.params.id,
      reward_paid: task.reward
    });
  } else {
    // Reject - return to open status, refund requester
    const refund = db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?');
    refund.run(task.reward, task.requester_id);

    // Update worker stats
    db.prepare('UPDATE agents SET tasks_failed = tasks_failed + 1 WHERE id = ?').run(task.worker_id);

    // Reset task
    const update = db.prepare(`
      UPDATE tasks
      SET status = 'open', worker_id = NULL, claimed_at = NULL, submitted_at = NULL, proof_submitted = NULL
      WHERE id = ?
    `);
    update.run(req.params.id);

    logTaskEvent(req.params.id, agent.id, 'rejected', reason || 'Work rejected');

    // Record transaction for requester (escrow returned to available credits)
    recordTransaction(task.requester_id, 'escrow_release', task.reward,
      `Task reopened, escrow maintained: ${task.title}`,
      { taskId: req.params.id }
    );

    // Record reputation event for worker
    recordReputationEvent(task.worker_id, 'TASK_REJECTED', {
      taskId: req.params.id,
      relatedAgentId: task.requester_id,
      reason: reason || 'Work rejected'
    });

    // Create notification for worker
    createNotification(task.worker_id, 'rejection',
      'Work Rejected',
      `Your work on "${task.title}" was rejected: ${reason || 'No reason provided'}`,
      { task_id: req.params.id, reason }
    );

    // Notify worker via webhook
    webhooks.notifyWorkRejected(task, reason);

    res.json({
      message: 'Work rejected. Task reopened.',
      task_id: req.params.id,
      reason: reason || 'No reason provided'
    });
  }
  } catch (error) {
    console.error('Validate error:', error);
    res.status(500).json({ error: 'Validation failed', details: error.message });
  }
});

// Abandon a claimed task
router.post('/:id/abandon', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const task = stmt.get(req.params.id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (task.worker_id !== agent.id) {
    return res.status(403).json({ error: 'You are not the worker for this task' });
  }

  if (task.status !== 'claimed') {
    return res.status(400).json({ error: 'Can only abandon claimed tasks', status: task.status });
  }

  // Reset task to open
  const update = db.prepare(`
    UPDATE tasks
    SET status = 'open', worker_id = NULL, claimed_at = NULL
    WHERE id = ?
  `);
  update.run(req.params.id);

  logTaskEvent(req.params.id, agent.id, 'abandoned');

  // Record reputation penalty
  recordReputationEvent(agent.id, 'TASK_ABANDONED', {
    taskId: req.params.id,
    relatedAgentId: task.requester_id
  });

  // Notify requester
  createNotification(task.requester_id, 'task_abandoned',
    'Task Abandoned',
    `${agent.name} abandoned your task "${task.title}". It is now open again.`,
    { task_id: req.params.id }
  );

  res.json({
    message: 'Task abandoned. Reputation penalty applied.',
    task_id: req.params.id
  });
});

// Cancel a task (requester only, only if unclaimed)
router.post('/:id/cancel', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const task = stmt.get(req.params.id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (task.requester_id !== agent.id) {
    return res.status(403).json({ error: 'Only the requester can cancel' });
  }

  if (task.status !== 'open') {
    return res.status(400).json({ error: 'Can only cancel open tasks', status: task.status });
  }

  // Refund credits
  const refund = db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?');
  refund.run(task.reward, agent.id);

  // Mark cancelled
  const update = db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`);
  update.run(req.params.id);

  logTaskEvent(req.params.id, agent.id, 'cancelled');

  // Record transaction
  recordTransaction(agent.id, 'refund', task.reward,
    `Task cancelled: ${task.title}`,
    { taskId: req.params.id }
  );

  res.json({
    message: 'Task cancelled. Credits refunded.',
    task_id: req.params.id,
    refunded: task.reward
  });
});

// Get recommended tasks for an agent based on their skills
router.get('/recommended/for-me', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const skills = JSON.parse(agent.skills || '[]');
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    // Get open tasks that match agent's skills
    let tasks = [];

    if (skills.length > 0) {
      // Build query to match any of the agent's skills
      // Sanitize skills to prevent LIKE injection
      const sanitizedSkills = skills.map(s => s.replace(/[%_"\\]/g, '').toLowerCase());
      const skillConditions = sanitizedSkills.map(() => `t.required_skills LIKE ?`).join(' OR ');
      const skillParams = sanitizedSkills.map(s => `%"${s}"%`);

      tasks = db.prepare(`
        SELECT t.*, req.name as requester_name, req.reputation as requester_reputation
        FROM tasks t
        JOIN agents req ON t.requester_id = req.id
        WHERE t.status = 'open'
        AND t.requester_id != ?
        AND (${skillConditions} OR t.required_skills = '[]')
        ORDER BY t.reward DESC
        LIMIT ?
      `).all(agent.id, ...skillParams, limit);
    } else {
      // No skills listed, show tasks with no skill requirements
      tasks = db.prepare(`
        SELECT t.*, req.name as requester_name, req.reputation as requester_reputation
        FROM tasks t
        JOIN agents req ON t.requester_id = req.id
        WHERE t.status = 'open'
        AND t.requester_id != ?
        AND (t.required_skills = '[]' OR t.required_skills IS NULL)
        ORDER BY t.reward DESC
        LIMIT ?
      `).all(agent.id, limit);
    }

    res.json({
      tasks: tasks.map(t => ({
        ...t,
        required_skills: JSON.parse(t.required_skills || '[]')
      })),
      count: tasks.length,
      agent_skills: skills
    });
  } catch (error) {
    console.error('Recommended tasks error:', error);
    res.status(500).json({ error: 'Failed to get recommendations', details: error.message });
  }
});

module.exports = router;
