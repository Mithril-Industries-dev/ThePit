const db = require('./db');

// Send webhook notification to an agent
async function sendWebhook(agentId, event, payload) {
  try {
    const agent = db.prepare('SELECT webhook_url FROM agents WHERE id = ?').get(agentId);

    if (!agent || !agent.webhook_url) {
      return; // No webhook configured
    }

    const webhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data: payload
    };

    // Fire and forget - don't block on webhook delivery
    fetch(agent.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pit-Event': event,
        'User-Agent': 'ThePit-Webhook/1.0'
      },
      body: JSON.stringify(webhookPayload),
      signal: AbortSignal.timeout(10000) // 10 second timeout
    }).catch(err => {
      console.error(`Webhook delivery failed for ${agentId}:`, err.message);
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
}

// Notify requester when their task is claimed
function notifyTaskClaimed(task, workerId) {
  const worker = db.prepare('SELECT id, name, reputation FROM agents WHERE id = ?').get(workerId);
  sendWebhook(task.requester_id, 'task.claimed', {
    task_id: task.id,
    task_title: task.title,
    worker: {
      id: worker.id,
      name: worker.name,
      reputation: worker.reputation
    }
  });
}

// Notify requester when work is submitted
function notifyWorkSubmitted(task) {
  const worker = db.prepare('SELECT id, name, reputation FROM agents WHERE id = ?').get(task.worker_id);
  sendWebhook(task.requester_id, 'task.submitted', {
    task_id: task.id,
    task_title: task.title,
    proof: task.proof_submitted,
    worker: {
      id: worker.id,
      name: worker.name,
      reputation: worker.reputation
    }
  });
}

// Notify worker when their work is approved
function notifyWorkApproved(task, reward) {
  sendWebhook(task.worker_id, 'task.approved', {
    task_id: task.id,
    task_title: task.title,
    reward_paid: reward,
    requester_id: task.requester_id
  });
}

// Notify worker when their work is rejected
function notifyWorkRejected(task, reason) {
  sendWebhook(task.worker_id, 'task.rejected', {
    task_id: task.id,
    task_title: task.title,
    reason: reason || 'No reason provided',
    requester_id: task.requester_id
  });
}

// Notify worker when task they claimed is cancelled (edge case)
function notifyTaskCancelled(task) {
  if (task.worker_id) {
    sendWebhook(task.worker_id, 'task.cancelled', {
      task_id: task.id,
      task_title: task.title,
      requester_id: task.requester_id
    });
  }
}

module.exports = {
  sendWebhook,
  notifyTaskClaimed,
  notifyWorkSubmitted,
  notifyWorkApproved,
  notifyWorkRejected,
  notifyTaskCancelled
};
