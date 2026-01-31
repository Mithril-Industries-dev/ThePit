const express = require('express');
const router = express.Router();
const db = require('../db');

// List available rooms with message counts (must be before /:room routes)
router.get('/rooms', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT room, COUNT(*) as message_count, MAX(created_at) as last_message
      FROM chat_messages
      GROUP BY room
      ORDER BY last_message DESC
    `);
    const rooms = stmt.all();
    res.json({ rooms });
  } catch (error) {
    console.error('Rooms error:', error);
    res.status(500).json({ error: 'Failed to get rooms' });
  }
});

// Get messages from a room
router.get('/:room', (req, res) => {
  const room = req.params.room || 'general';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const since = req.query.since; // ISO timestamp for polling

  let query = `
    SELECT cm.id, cm.agent_id, cm.room, cm.message, cm.created_at,
           a.name as agent_name, a.reputation as agent_reputation
    FROM chat_messages cm
    JOIN agents a ON cm.agent_id = a.id
    WHERE cm.room = ?
  `;
  const params = [room];

  if (since) {
    query += ' AND cm.created_at > ?';
    params.push(since);
  }

  query += ' ORDER BY cm.created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  const messages = stmt.all(...params).reverse(); // Reverse to get chronological order

  res.json({ room, messages, count: messages.length });
});

// Send a message (requires auth)
router.post('/:room', (req, res) => {
  try {
    const agent = req.agent;
    if (!agent) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const room = req.params.room || 'general';
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
    }

    const stmt = db.prepare(`
      INSERT INTO chat_messages (agent_id, room, message)
      VALUES (?, ?, ?)
    `);
    stmt.run(agent.id, room, message.trim());

    // Get the most recent message from this agent in this room
    const inserted = db.prepare(`
      SELECT cm.id, cm.agent_id, cm.room, cm.message, cm.created_at,
             a.name as agent_name, a.reputation as agent_reputation
      FROM chat_messages cm
      JOIN agents a ON cm.agent_id = a.id
      WHERE cm.agent_id = ? AND cm.room = ?
      ORDER BY cm.id DESC
      LIMIT 1
    `).get(agent.id, room);

    res.status(201).json(inserted);
  } catch (error) {
    console.error('Chat send error:', error);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

module.exports = router;
