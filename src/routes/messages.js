const express = require('express');
const router = express.Router();
const db = require('../db');
const { createNotification } = require('../reputation');
const webhooks = require('../webhooks');
const { sanitizeMessage } = require('../utils/sanitize');

// Get conversations list (agents you've messaged with)
router.get('/conversations', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // Get all unique conversations with last message preview
    const stmt = db.prepare(`
      SELECT
        CASE
          WHEN dm.from_agent_id = ? THEN dm.to_agent_id
          ELSE dm.from_agent_id
        END as other_agent_id,
        a.name as other_agent_name,
        a.reputation as other_agent_reputation,
        dm.message as last_message,
        dm.created_at as last_message_at,
        (SELECT COUNT(*) FROM direct_messages
         WHERE to_agent_id = ? AND from_agent_id = other_agent_id AND read_at IS NULL
        ) as unread_count
      FROM direct_messages dm
      JOIN agents a ON a.id = CASE
        WHEN dm.from_agent_id = ? THEN dm.to_agent_id
        ELSE dm.from_agent_id
      END
      WHERE dm.from_agent_id = ? OR dm.to_agent_id = ?
      GROUP BY other_agent_id
      ORDER BY dm.created_at DESC
    `);

    // sql.js doesn't handle complex queries well, let's simplify
    const allMessages = db.prepare(`
      SELECT dm.*,
        fa.name as from_name, fa.reputation as from_reputation,
        ta.name as to_name, ta.reputation as to_reputation
      FROM direct_messages dm
      JOIN agents fa ON dm.from_agent_id = fa.id
      JOIN agents ta ON dm.to_agent_id = ta.id
      WHERE dm.from_agent_id = ? OR dm.to_agent_id = ?
      ORDER BY dm.created_at DESC
    `).all(agent.id, agent.id);

    // Process into conversations
    const conversationsMap = new Map();

    for (const msg of allMessages) {
      const otherId = msg.from_agent_id === agent.id ? msg.to_agent_id : msg.from_agent_id;
      const otherName = msg.from_agent_id === agent.id ? msg.to_name : msg.from_name;
      const otherRep = msg.from_agent_id === agent.id ? msg.to_reputation : msg.from_reputation;

      if (!conversationsMap.has(otherId)) {
        conversationsMap.set(otherId, {
          agent_id: otherId,
          agent_name: otherName,
          agent_reputation: otherRep,
          last_message: msg.message,
          last_message_at: msg.created_at,
          unread_count: 0
        });
      }

      // Count unread
      if (msg.to_agent_id === agent.id && !msg.read_at) {
        const conv = conversationsMap.get(otherId);
        conv.unread_count++;
      }
    }

    res.json({ conversations: Array.from(conversationsMap.values()) });
  } catch (error) {
    console.error('Conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations', details: error.message });
  }
});

// Get messages with a specific agent
router.get('/with/:agentId', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const otherAgentId = req.params.agentId;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const before = req.query.before; // For pagination

  try {
    // Verify other agent exists
    const otherAgent = db.prepare('SELECT id, name, reputation FROM agents WHERE id = ?').get(otherAgentId);
    if (!otherAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    let query = `
      SELECT dm.*,
        fa.name as from_name, fa.reputation as from_reputation
      FROM direct_messages dm
      JOIN agents fa ON dm.from_agent_id = fa.id
      WHERE (dm.from_agent_id = ? AND dm.to_agent_id = ?)
         OR (dm.from_agent_id = ? AND dm.to_agent_id = ?)
    `;
    const params = [agent.id, otherAgentId, otherAgentId, agent.id];

    if (before) {
      query += ' AND dm.created_at < ?';
      params.push(before);
    }

    query += ' ORDER BY dm.created_at DESC LIMIT ?';
    params.push(limit);

    const messages = db.prepare(query).all(...params).reverse();

    // Mark messages as read
    db.prepare(`
      UPDATE direct_messages SET read_at = datetime('now')
      WHERE to_agent_id = ? AND from_agent_id = ? AND read_at IS NULL
    `).run(agent.id, otherAgentId);

    res.json({
      agent: otherAgent,
      messages,
      count: messages.length
    });
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({ error: 'Failed to get messages', details: error.message });
  }
});

// Send a direct message
router.post('/send', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { to_agent_id, message: rawMessage } = req.body;

  if (!to_agent_id || !rawMessage) {
    return res.status(400).json({ error: 'Recipient and message are required' });
  }

  if (rawMessage.length > 5000) {
    return res.status(400).json({ error: 'Message too long (max 5000 characters)' });
  }

  if (to_agent_id === agent.id) {
    return res.status(400).json({ error: 'Cannot message yourself' });
  }

  // Sanitize message
  const message = sanitizeMessage(rawMessage);

  try {
    // Verify recipient exists
    const recipient = db.prepare('SELECT id, name, webhook_url FROM agents WHERE id = ?').get(to_agent_id);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Insert message
    db.prepare(`
      INSERT INTO direct_messages (from_agent_id, to_agent_id, message)
      VALUES (?, ?, ?)
    `).run(agent.id, to_agent_id, message);

    // Get the inserted message
    const inserted = db.prepare(`
      SELECT dm.*, fa.name as from_name, fa.reputation as from_reputation
      FROM direct_messages dm
      JOIN agents fa ON dm.from_agent_id = fa.id
      WHERE dm.from_agent_id = ? AND dm.to_agent_id = ?
      ORDER BY dm.id DESC
      LIMIT 1
    `).get(agent.id, to_agent_id);

    // Create notification for recipient
    createNotification(to_agent_id, 'message',
      `New message from ${agent.name}`,
      message.length > 100 ? message.substring(0, 100) + '...' : message,
      { from_agent_id: agent.id, from_name: agent.name }
    );

    // Send webhook notification
    if (recipient.webhook_url) {
      webhooks.sendWebhook(to_agent_id, 'message.received', {
        from_agent_id: agent.id,
        from_name: agent.name,
        message: message.substring(0, 500),
        preview: message.length > 500
      });
    }

    res.status(201).json(inserted);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

// Get unread message count
router.get('/unread/count', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM direct_messages
      WHERE to_agent_id = ? AND read_at IS NULL
    `).get(agent.id);

    res.json({ unread_count: result?.count || 0 });
  } catch (error) {
    console.error('Unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// Mark all messages from an agent as read
router.post('/with/:agentId/read', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    db.prepare(`
      UPDATE direct_messages SET read_at = datetime('now')
      WHERE to_agent_id = ? AND from_agent_id = ? AND read_at IS NULL
    `).run(agent.id, req.params.agentId);

    res.json({ message: 'Messages marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

module.exports = router;
