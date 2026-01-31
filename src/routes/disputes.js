const express = require('express');
const router = express.Router();
const db = require('../db');
const { nanoid } = require('nanoid');
const { recordReputationEvent, createNotification } = require('../reputation');
const { recordTransaction } = require('./transactions');
const webhooks = require('../webhooks');
const { sanitizeString } = require('../utils/sanitize');

// Get all disputes (with filters)
router.get('/', (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const agent = req.agent; // Optional - shows own disputes if authenticated

  try {
    let query = `
      SELECT d.*,
        t.title as task_title, t.reward as task_reward,
        ra.name as raised_by_name,
        req.name as requester_name,
        wrk.name as worker_name
      FROM disputes d
      JOIN tasks t ON d.task_id = t.id
      JOIN agents ra ON d.raised_by = ra.id
      JOIN agents req ON t.requester_id = req.id
      LEFT JOIN agents wrk ON t.worker_id = wrk.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND d.status = ?';
      params.push(status);
    }

    // If authenticated, optionally filter to own disputes
    if (agent && req.query.mine === 'true') {
      query += ' AND (d.raised_by = ? OR t.requester_id = ? OR t.worker_id = ?)';
      params.push(agent.id, agent.id, agent.id);
    }

    query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(parseInt(limit), 100), parseInt(offset));

    const disputes = db.prepare(query).all(...params);

    res.json({ disputes, count: disputes.length });
  } catch (error) {
    console.error('Disputes error:', error);
    res.status(500).json({ error: 'Failed to get disputes', details: error.message });
  }
});

// Get single dispute
router.get('/:id', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT d.*,
        t.title as task_title, t.description as task_description,
        t.reward as task_reward, t.proof_submitted, t.status as task_status,
        ra.name as raised_by_name, ra.reputation as raised_by_reputation,
        req.id as requester_id, req.name as requester_name, req.reputation as requester_reputation,
        wrk.id as worker_id, wrk.name as worker_name, wrk.reputation as worker_reputation,
        res.name as resolved_by_name
      FROM disputes d
      JOIN tasks t ON d.task_id = t.id
      JOIN agents ra ON d.raised_by = ra.id
      JOIN agents req ON t.requester_id = req.id
      LEFT JOIN agents wrk ON t.worker_id = wrk.id
      LEFT JOIN agents res ON d.resolved_by = res.id
      WHERE d.id = ?
    `);

    const dispute = stmt.get(req.params.id);

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    res.json(dispute);
  } catch (error) {
    console.error('Dispute get error:', error);
    res.status(500).json({ error: 'Failed to get dispute', details: error.message });
  }
});

// Raise a dispute
router.post('/', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { task_id, reason: rawReason, evidence: rawEvidence } = req.body;

  if (!task_id || !rawReason) {
    return res.status(400).json({ error: 'Task ID and reason are required' });
  }

  // Sanitize inputs
  const reason = sanitizeString(rawReason, { maxLength: 2000 });
  const evidence = rawEvidence ? sanitizeString(rawEvidence, { maxLength: 10000 }) : null;

  try {
    // Get the task
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify the agent is involved in the task
    if (task.requester_id !== agent.id && task.worker_id !== agent.id) {
      return res.status(403).json({ error: 'You are not involved in this task' });
    }

    // Check if task is in a disputable status
    if (!['submitted', 'completed'].includes(task.status)) {
      return res.status(400).json({
        error: 'Can only raise disputes on submitted or completed tasks',
        status: task.status
      });
    }

    // Check for existing open dispute
    const existingDispute = db.prepare(
      'SELECT id FROM disputes WHERE task_id = ? AND status = ?'
    ).get(task_id, 'open');

    if (existingDispute) {
      return res.status(400).json({
        error: 'An open dispute already exists for this task',
        dispute_id: existingDispute.id
      });
    }

    const disputeId = `disp_${nanoid(12)}`;

    db.prepare(`
      INSERT INTO disputes (id, task_id, raised_by, reason, evidence)
      VALUES (?, ?, ?, ?, ?)
    `).run(disputeId, task_id, agent.id, reason, evidence || null);

    // Update task status to disputed
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('disputed', task_id);

    // Notify the other party
    const otherPartyId = task.requester_id === agent.id ? task.worker_id : task.requester_id;
    if (otherPartyId) {
      createNotification(otherPartyId, 'dispute',
        'Dispute Raised',
        `A dispute has been raised for task "${task.title}"`,
        { dispute_id: disputeId, task_id }
      );

      webhooks.sendWebhook(otherPartyId, 'dispute.raised', {
        dispute_id: disputeId,
        task_id,
        task_title: task.title,
        raised_by: agent.id,
        reason
      });
    }

    res.status(201).json({
      id: disputeId,
      task_id,
      raised_by: agent.id,
      reason,
      status: 'open',
      message: 'Dispute raised. A moderator will review.'
    });
  } catch (error) {
    console.error('Raise dispute error:', error);
    res.status(500).json({ error: 'Failed to raise dispute', details: error.message });
  }
});

// Add evidence to a dispute
router.post('/:id/evidence', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { evidence: rawEvidence } = req.body;

  if (!rawEvidence) {
    return res.status(400).json({ error: 'Evidence is required' });
  }

  // Sanitize evidence
  const evidence = sanitizeString(rawEvidence, { maxLength: 10000 });

  try {
    const dispute = db.prepare(`
      SELECT d.*, t.requester_id, t.worker_id
      FROM disputes d
      JOIN tasks t ON d.task_id = t.id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    if (dispute.status !== 'open') {
      return res.status(400).json({ error: 'Dispute is not open' });
    }

    // Verify agent is involved
    if (dispute.raised_by !== agent.id &&
        dispute.requester_id !== agent.id &&
        dispute.worker_id !== agent.id) {
      return res.status(403).json({ error: 'You are not involved in this dispute' });
    }

    // Append to existing evidence (JSON array)
    let existingEvidence = [];
    try {
      existingEvidence = JSON.parse(dispute.evidence || '[]');
      if (!Array.isArray(existingEvidence)) {
        existingEvidence = dispute.evidence ? [{ text: dispute.evidence, agent_id: dispute.raised_by }] : [];
      }
    } catch (e) {
      existingEvidence = dispute.evidence ? [{ text: dispute.evidence, agent_id: dispute.raised_by }] : [];
    }

    existingEvidence.push({
      text: evidence,
      agent_id: agent.id,
      timestamp: new Date().toISOString()
    });

    db.prepare('UPDATE disputes SET evidence = ? WHERE id = ?')
      .run(JSON.stringify(existingEvidence), req.params.id);

    res.json({ message: 'Evidence added', evidence_count: existingEvidence.length });
  } catch (error) {
    console.error('Add evidence error:', error);
    res.status(500).json({ error: 'Failed to add evidence', details: error.message });
  }
});

// Resolve a dispute (community voting or moderator decision)
// In this simplified version, either party can accept resolution or a third party can arbitrate
router.post('/:id/resolve', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { decision, resolution } = req.body;

  if (!decision || !['favor_requester', 'favor_worker', 'split', 'cancel'].includes(decision)) {
    return res.status(400).json({
      error: 'Valid decision required: favor_requester, favor_worker, split, or cancel'
    });
  }

  try {
    const dispute = db.prepare(`
      SELECT d.*, t.id as task_id, t.requester_id, t.worker_id, t.reward, t.title as task_title
      FROM disputes d
      JOIN tasks t ON d.task_id = t.id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    if (dispute.status !== 'open') {
      return res.status(400).json({ error: 'Dispute is not open', status: dispute.status });
    }

    // For now, allow resolution by any involved party or by high-reputation agents (arbitrators)
    const isInvolved = [dispute.raised_by, dispute.requester_id, dispute.worker_id].includes(agent.id);
    const isArbitrator = agent.reputation >= 80 && !isInvolved;

    if (!isInvolved && !isArbitrator) {
      return res.status(403).json({
        error: 'Only involved parties or high-reputation arbitrators can resolve disputes'
      });
    }

    // Process the resolution
    let taskStatus = 'cancelled';
    const reward = dispute.reward;

    switch (decision) {
      case 'favor_worker':
        // Pay the worker
        if (dispute.worker_id) {
          db.prepare('UPDATE agents SET credits = credits + ?, tasks_completed = tasks_completed + 1 WHERE id = ?')
            .run(reward, dispute.worker_id);
          recordTransaction(dispute.worker_id, 'task_payment', reward,
            `Task completed (after dispute): ${dispute.task_title}`,
            { taskId: dispute.task_id }
          );
          recordReputationEvent(dispute.worker_id, 'DISPUTE_WON', { taskId: dispute.task_id });
          recordReputationEvent(dispute.requester_id, 'DISPUTE_LOST', { taskId: dispute.task_id });
        }
        taskStatus = 'completed';
        break;

      case 'favor_requester':
        // Refund the requester
        db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?')
          .run(reward, dispute.requester_id);
        recordTransaction(dispute.requester_id, 'refund', reward,
          `Refund (dispute won): ${dispute.task_title}`,
          { taskId: dispute.task_id }
        );
        recordReputationEvent(dispute.requester_id, 'DISPUTE_WON', { taskId: dispute.task_id });
        if (dispute.worker_id) {
          recordReputationEvent(dispute.worker_id, 'DISPUTE_LOST', { taskId: dispute.task_id });
          db.prepare('UPDATE agents SET tasks_failed = tasks_failed + 1 WHERE id = ?')
            .run(dispute.worker_id);
        }
        taskStatus = 'cancelled';
        break;

      case 'split':
        // Split the reward
        const halfReward = Math.floor(reward / 2);
        db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?')
          .run(halfReward, dispute.requester_id);
        recordTransaction(dispute.requester_id, 'refund_partial', halfReward,
          `Partial refund (dispute split): ${dispute.task_title}`,
          { taskId: dispute.task_id }
        );
        if (dispute.worker_id) {
          db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?')
            .run(reward - halfReward, dispute.worker_id);
          recordTransaction(dispute.worker_id, 'task_payment_partial', reward - halfReward,
            `Partial payment (dispute split): ${dispute.task_title}`,
            { taskId: dispute.task_id }
          );
        }
        taskStatus = 'completed';
        break;

      case 'cancel':
        // Full refund to requester, no reputation changes
        db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?')
          .run(reward, dispute.requester_id);
        recordTransaction(dispute.requester_id, 'refund', reward,
          `Refund (dispute cancelled): ${dispute.task_title}`,
          { taskId: dispute.task_id }
        );
        taskStatus = 'cancelled';
        break;
    }

    // Update dispute status
    db.prepare(`
      UPDATE disputes
      SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(resolution || decision, agent.id, req.params.id);

    // Update task status
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskStatus, dispute.task_id);

    // Reward arbitrator
    if (isArbitrator) {
      const arbitrationReward = Math.min(10, Math.floor(reward * 0.05));
      if (arbitrationReward > 0) {
        db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?')
          .run(arbitrationReward, agent.id);
        recordTransaction(agent.id, 'arbitration_reward', arbitrationReward,
          `Arbitration reward: ${dispute.task_title}`,
          { taskId: dispute.task_id }
        );
      }
    }

    // Notify all parties
    const parties = [dispute.requester_id, dispute.worker_id].filter(Boolean);
    for (const partyId of parties) {
      createNotification(partyId, 'dispute_resolved',
        'Dispute Resolved',
        `The dispute for "${dispute.task_title}" has been resolved: ${decision}`,
        { dispute_id: req.params.id, decision }
      );

      webhooks.sendWebhook(partyId, 'dispute.resolved', {
        dispute_id: req.params.id,
        task_id: dispute.task_id,
        decision,
        resolution: resolution || decision
      });
    }

    res.json({
      message: 'Dispute resolved',
      dispute_id: req.params.id,
      decision,
      task_status: taskStatus
    });
  } catch (error) {
    console.error('Resolve dispute error:', error);
    res.status(500).json({ error: 'Failed to resolve dispute', details: error.message });
  }
});

module.exports = router;
