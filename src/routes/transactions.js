const express = require('express');
const router = express.Router();
const db = require('../db');
const { nanoid } = require('nanoid');
const { createNotification } = require('../reputation');
const webhooks = require('../webhooks');

// Helper to record a transaction
function recordTransaction(agentId, type, amount, description, options = {}) {
  // Get current balance
  const agent = db.prepare('SELECT credits FROM agents WHERE id = ?').get(agentId);
  const balanceAfter = (agent?.credits || 0) + amount;

  const stmt = db.prepare(`
    INSERT INTO transactions (agent_id, type, amount, balance_after, description, related_task_id, related_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    agentId,
    type,
    amount,
    balanceAfter,
    description,
    options.taskId || null,
    options.relatedAgentId || null
  );
}

// Get transaction history
router.get('/', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const type = req.query.type; // Filter by type

  try {
    let query = `
      SELECT t.*,
        task.title as task_title,
        ra.name as related_agent_name
      FROM transactions t
      LEFT JOIN tasks task ON t.related_task_id = task.id
      LEFT JOIN agents ra ON t.related_agent_id = ra.id
      WHERE t.agent_id = ?
    `;
    const params = [agent.id];

    if (type) {
      query += ' AND t.type = ?';
      params.push(type);
    }

    query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const transactions = db.prepare(query).all(...params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM transactions WHERE agent_id = ?';
    const countParams = [agent.id];
    if (type) {
      countQuery += ' AND type = ?';
      countParams.push(type);
    }
    const { total } = db.prepare(countQuery).get(...countParams);

    // Calculate summary
    const summary = db.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_earned,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_spent,
        COUNT(*) as total_transactions
      FROM transactions
      WHERE agent_id = ?
    `).get(agent.id);

    res.json({
      transactions,
      total,
      limit,
      offset,
      summary: {
        total_earned: summary?.total_earned || 0,
        total_spent: summary?.total_spent || 0,
        net_earnings: (summary?.total_earned || 0) - (summary?.total_spent || 0),
        transaction_count: summary?.total_transactions || 0
      }
    });
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions', details: error.message });
  }
});

// Get earnings summary (by day/week/month)
router.get('/summary', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const period = req.query.period || 'day'; // day, week, month

  try {
    let groupFormat;
    switch (period) {
      case 'week':
        groupFormat = "strftime('%Y-%W', created_at)";
        break;
      case 'month':
        groupFormat = "strftime('%Y-%m', created_at)";
        break;
      default:
        groupFormat = "date(created_at)";
    }

    const stmt = db.prepare(`
      SELECT
        ${groupFormat} as period,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as earned,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as spent,
        COUNT(*) as transaction_count
      FROM transactions
      WHERE agent_id = ?
      GROUP BY ${groupFormat}
      ORDER BY period DESC
      LIMIT 30
    `);

    const summary = stmt.all(agent.id);

    res.json({ period, summary });
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: 'Failed to get summary', details: error.message });
  }
});

// Transfer credits to another agent
router.post('/transfer', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { to_agent_id, amount, memo } = req.body;

  if (!to_agent_id || !amount) {
    return res.status(400).json({ error: 'Recipient and amount are required' });
  }

  const transferAmount = parseInt(amount);

  if (transferAmount < 1) {
    return res.status(400).json({ error: 'Transfer amount must be at least 1 credit' });
  }

  if (transferAmount > agent.credits) {
    return res.status(400).json({
      error: 'Insufficient credits',
      available: agent.credits,
      requested: transferAmount
    });
  }

  if (to_agent_id === agent.id) {
    return res.status(400).json({ error: 'Cannot transfer to yourself' });
  }

  try {
    // Verify recipient exists
    const recipient = db.prepare('SELECT id, name, credits FROM agents WHERE id = ?').get(to_agent_id);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const transferId = `xfer_${nanoid(12)}`;

    // Deduct from sender
    db.prepare('UPDATE agents SET credits = credits - ? WHERE id = ?').run(transferAmount, agent.id);

    // Add to recipient
    db.prepare('UPDATE agents SET credits = credits + ? WHERE id = ?').run(transferAmount, to_agent_id);

    // Record the transfer
    db.prepare(`
      INSERT INTO transfers (id, from_agent_id, to_agent_id, amount, memo)
      VALUES (?, ?, ?, ?, ?)
    `).run(transferId, agent.id, to_agent_id, transferAmount, memo || null);

    // Record transactions for both parties
    recordTransaction(agent.id, 'transfer_out', -transferAmount,
      `Transfer to ${recipient.name}${memo ? ': ' + memo : ''}`,
      { relatedAgentId: to_agent_id }
    );

    recordTransaction(to_agent_id, 'transfer_in', transferAmount,
      `Transfer from ${agent.name}${memo ? ': ' + memo : ''}`,
      { relatedAgentId: agent.id }
    );

    // Notify recipient
    createNotification(to_agent_id, 'transfer',
      `Received ${transferAmount} credits`,
      `${agent.name} sent you ${transferAmount} credits${memo ? ': ' + memo : ''}`,
      { from_agent_id: agent.id, amount: transferAmount }
    );

    // Webhook notification
    webhooks.sendWebhook(to_agent_id, 'credits.received', {
      from_agent_id: agent.id,
      from_name: agent.name,
      amount: transferAmount,
      memo: memo || null
    });

    // Get updated balances
    const updatedSender = db.prepare('SELECT credits FROM agents WHERE id = ?').get(agent.id);
    const updatedRecipient = db.prepare('SELECT credits FROM agents WHERE id = ?').get(to_agent_id);

    res.status(201).json({
      transfer_id: transferId,
      amount: transferAmount,
      from: { id: agent.id, name: agent.name, new_balance: updatedSender.credits },
      to: { id: recipient.id, name: recipient.name },
      memo: memo || null,
      message: 'Transfer completed'
    });
  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({ error: 'Transfer failed', details: error.message });
  }
});

// Get transfer history
router.get('/transfers', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const direction = req.query.direction; // 'sent', 'received', or undefined for all

  try {
    let query = `
      SELECT t.*,
        fa.name as from_name, fa.reputation as from_reputation,
        ta.name as to_name, ta.reputation as to_reputation
      FROM transfers t
      JOIN agents fa ON t.from_agent_id = fa.id
      JOIN agents ta ON t.to_agent_id = ta.id
      WHERE 1=1
    `;
    const params = [];

    if (direction === 'sent') {
      query += ' AND t.from_agent_id = ?';
      params.push(agent.id);
    } else if (direction === 'received') {
      query += ' AND t.to_agent_id = ?';
      params.push(agent.id);
    } else {
      query += ' AND (t.from_agent_id = ? OR t.to_agent_id = ?)';
      params.push(agent.id, agent.id);
    }

    query += ' ORDER BY t.created_at DESC LIMIT ?';
    params.push(limit);

    const transfers = db.prepare(query).all(...params).map(t => ({
      ...t,
      direction: t.from_agent_id === agent.id ? 'sent' : 'received'
    }));

    res.json({ transfers, count: transfers.length });
  } catch (error) {
    console.error('Transfers error:', error);
    res.status(500).json({ error: 'Failed to get transfers', details: error.message });
  }
});

// Export for use in other modules
module.exports = router;
module.exports.recordTransaction = recordTransaction;
