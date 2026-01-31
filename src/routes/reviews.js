const express = require('express');
const router = express.Router();
const db = require('../db');
const { recordReputationEvent, createNotification } = require('../reputation');
const { sanitizeString, sanitizeInt } = require('../utils/sanitize');

// Get reviews for an agent
router.get('/agent/:agentId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const reviewType = req.query.type; // 'as_worker' or 'as_requester'

  try {
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    let query = `
      SELECT r.*,
        t.title as task_title,
        rev.name as reviewer_name, rev.reputation as reviewer_reputation
      FROM reviews r
      JOIN tasks t ON r.task_id = t.id
      JOIN agents rev ON r.reviewer_id = rev.id
      WHERE r.reviewee_id = ?
    `;
    const params = [req.params.agentId];

    if (reviewType) {
      query += ' AND r.review_type = ?';
      params.push(reviewType);
    }

    query += ' ORDER BY r.created_at DESC LIMIT ?';
    params.push(limit);

    const reviews = db.prepare(query).all(...params);

    // Calculate averages
    const stats = db.prepare(`
      SELECT
        review_type,
        AVG(rating) as average_rating,
        COUNT(*) as review_count
      FROM reviews
      WHERE reviewee_id = ?
      GROUP BY review_type
    `).all(req.params.agentId);

    const statsMap = {};
    for (const s of stats) {
      statsMap[s.review_type] = {
        average_rating: Math.round(s.average_rating * 10) / 10,
        review_count: s.review_count
      };
    }

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      reviews,
      stats: statsMap,
      total_reviews: reviews.length
    });
  } catch (error) {
    console.error('Reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews', details: error.message });
  }
});

// Get reviews for a task
router.get('/task/:taskId', (req, res) => {
  try {
    const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(req.params.taskId);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const reviews = db.prepare(`
      SELECT r.*,
        rev.name as reviewer_name, rev.reputation as reviewer_reputation,
        ree.name as reviewee_name, ree.reputation as reviewee_reputation
      FROM reviews r
      JOIN agents rev ON r.reviewer_id = rev.id
      JOIN agents ree ON r.reviewee_id = ree.id
      WHERE r.task_id = ?
      ORDER BY r.created_at DESC
    `).all(req.params.taskId);

    res.json({
      task_id: task.id,
      task_title: task.title,
      reviews
    });
  } catch (error) {
    console.error('Task reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews', details: error.message });
  }
});

// Submit a review for a completed task
router.post('/', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { task_id, rating, comment: rawComment } = req.body;

  if (!task_id || !rating) {
    return res.status(400).json({ error: 'Task ID and rating are required' });
  }

  const ratingNum = sanitizeInt(rating, { min: 1, max: 5 });
  if (ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  // Sanitize comment
  const comment = rawComment ? sanitizeString(rawComment, { maxLength: 2000 }) : null;

  try {
    // Get the task
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'completed') {
      return res.status(400).json({ error: 'Can only review completed tasks', status: task.status });
    }

    // Determine who is reviewing whom
    let revieweeId, reviewType;

    if (task.requester_id === agent.id) {
      // Requester reviewing worker
      revieweeId = task.worker_id;
      reviewType = 'as_worker';
    } else if (task.worker_id === agent.id) {
      // Worker reviewing requester
      revieweeId = task.requester_id;
      reviewType = 'as_requester';
    } else {
      return res.status(403).json({ error: 'You are not involved in this task' });
    }

    // Check for existing review
    const existing = db.prepare(`
      SELECT id FROM reviews WHERE task_id = ? AND reviewer_id = ?
    `).get(task_id, agent.id);

    if (existing) {
      return res.status(400).json({ error: 'You have already reviewed this task' });
    }

    // Create review
    db.prepare(`
      INSERT INTO reviews (task_id, reviewer_id, reviewee_id, rating, comment, review_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(task_id, agent.id, revieweeId, ratingNum, comment, reviewType);

    // Award/penalize reputation based on rating
    if (ratingNum === 5) {
      recordReputationEvent(revieweeId, 'EXCELLENT_REVIEW', {
        taskId: task_id,
        relatedAgentId: agent.id
      });
    } else if (ratingNum === 4) {
      recordReputationEvent(revieweeId, 'GOOD_REVIEW', {
        taskId: task_id,
        relatedAgentId: agent.id
      });
    } else if (ratingNum <= 2) {
      recordReputationEvent(revieweeId, 'POOR_REVIEW', {
        taskId: task_id,
        relatedAgentId: agent.id
      });
    }

    // Notify reviewee
    const revieweeName = db.prepare('SELECT name FROM agents WHERE id = ?').get(revieweeId)?.name;
    createNotification(revieweeId, 'review',
      `New ${ratingNum}-Star Review`,
      `${agent.name} left you a ${ratingNum}-star review for "${task.title}"`,
      { task_id, rating: ratingNum, reviewer_id: agent.id }
    );

    res.status(201).json({
      message: 'Review submitted',
      task_id,
      reviewee_id: revieweeId,
      rating: ratingNum,
      review_type: reviewType
    });
  } catch (error) {
    console.error('Submit review error:', error);
    res.status(500).json({ error: 'Failed to submit review', details: error.message });
  }
});

// Get pending reviews (tasks you haven't reviewed yet)
router.get('/pending', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // Get completed tasks where agent was requester or worker but hasn't reviewed
    const tasks = db.prepare(`
      SELECT t.*,
        req.name as requester_name,
        wrk.name as worker_name
      FROM tasks t
      JOIN agents req ON t.requester_id = req.id
      LEFT JOIN agents wrk ON t.worker_id = wrk.id
      WHERE t.status = 'completed'
      AND (t.requester_id = ? OR t.worker_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM reviews r WHERE r.task_id = t.id AND r.reviewer_id = ?
      )
      ORDER BY t.completed_at DESC
    `).all(agent.id, agent.id, agent.id);

    const pendingReviews = tasks.map(t => ({
      task_id: t.id,
      task_title: t.title,
      completed_at: t.completed_at,
      review_for: t.requester_id === agent.id ? 'worker' : 'requester',
      reviewee_id: t.requester_id === agent.id ? t.worker_id : t.requester_id,
      reviewee_name: t.requester_id === agent.id ? t.worker_name : t.requester_name
    }));

    res.json({ pending_reviews: pendingReviews, count: pendingReviews.length });
  } catch (error) {
    console.error('Pending reviews error:', error);
    res.status(500).json({ error: 'Failed to get pending reviews' });
  }
});

module.exports = router;
