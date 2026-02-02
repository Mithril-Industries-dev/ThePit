const express = require('express');
const router = express.Router();
const db = require('../db');
const { getUnreadNotifications, markNotificationsRead, getNotifications } = require('../reputation');

// Get all notifications (with pagination)
router.get('/', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const unreadOnly = req.query.unread === 'true';
  const since = req.query.since;
  const type = req.query.type;

  try {
    let query = `
      SELECT * FROM notifications
      WHERE agent_id = ?
    `;
    const params = [agent.id];

    if (unreadOnly) {
      query += ' AND read_at IS NULL';
    }

    if (since) {
      query += ' AND created_at > ?';
      params.push(since);
    }

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const notifications = db.prepare(query).all(...params).map(n => ({
      ...n,
      data: n.data ? JSON.parse(n.data) : null
    }));

    // Get unread count
    const { count: unread_count } = db.prepare(`
      SELECT COUNT(*) as count FROM notifications
      WHERE agent_id = ? AND read_at IS NULL
    `).get(agent.id);

    res.json({
      notifications,
      count: notifications.length,
      unread_count,
      limit,
      offset
    });
  } catch (error) {
    console.error('Notifications error:', error);
    res.status(500).json({ error: 'Failed to get notifications', details: error.message });
  }
});

// Get unread count only
router.get('/unread/count', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM notifications
      WHERE agent_id = ? AND read_at IS NULL
    `).get(agent.id);

    res.json({ unread_count: result?.count || 0 });
  } catch (error) {
    console.error('Unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// Mark notifications as read
router.post('/read', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { notification_ids } = req.body;

  try {
    if (notification_ids && Array.isArray(notification_ids) && notification_ids.length > 0) {
      // Mark specific notifications as read
      const placeholders = notification_ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE notifications SET read_at = datetime('now')
        WHERE agent_id = ? AND id IN (${placeholders}) AND read_at IS NULL
      `).run(agent.id, ...notification_ids);
    } else {
      // Mark all as read
      db.prepare(`
        UPDATE notifications SET read_at = datetime('now')
        WHERE agent_id = ? AND read_at IS NULL
      `).run(agent.id);
    }

    res.json({ message: 'Notifications marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// Delete old notifications
router.delete('/old', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const daysOld = parseInt(req.query.days) || 30;

  try {
    db.prepare(`
      DELETE FROM notifications
      WHERE agent_id = ? AND read_at IS NOT NULL
      AND created_at < datetime('now', '-' || ? || ' days')
    `).run(agent.id, daysOld);

    res.json({ message: `Deleted notifications older than ${daysOld} days` });
  } catch (error) {
    console.error('Delete notifications error:', error);
    res.status(500).json({ error: 'Failed to delete notifications' });
  }
});

module.exports = router;
