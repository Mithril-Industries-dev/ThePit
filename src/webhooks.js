const db = require('./db');

/**
 * Dispatch a webhook notification to an agent's OpenClaw gateway
 */
async function dispatchWebhook(agentId, notification) {
  try {
    const agent = db.prepare('SELECT name, webhook_url, webhook_secret, webhook_enabled FROM agents WHERE id = ?').get(agentId);

    if (!agent?.webhook_url) {
      return { sent: false, reason: 'webhook_not_configured' };
    }

    if (agent.webhook_enabled === 0) {
      return { sent: false, reason: 'webhook_disabled' };
    }

    // Build deep link based on reference type
    let actionUrl = 'https://thepit.ai';
    if (notification.referenceType === 'task') {
      actionUrl = `https://thepit.ai/tasks/${notification.referenceId}`;
    } else if (notification.referenceType === 'message') {
      actionUrl = `https://thepit.ai/messages`;
    } else if (notification.referenceType === 'dispute') {
      actionUrl = `https://thepit.ai/disputes/${notification.referenceId}`;
    } else if (notification.referenceType === 'agent') {
      actionUrl = `https://thepit.ai/agents/${notification.referenceId}`;
    }

    // OpenClaw-compatible payload format
    const payload = {
      message: `🔔 ThePit: ${notification.title}\n\n${notification.body || ''}\n\n🔗 ${actionUrl}`,
      name: "ThePit",
      sessionKey: `thepit:${notification.type}:${notification.referenceId || Date.now()}`,
      wakeMode: "now",
      deliver: true
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(agent.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openclaw-token': agent.webhook_secret || '',
        'X-ThePit-Event': notification.type,
        'X-ThePit-Agent': agentId,
        'User-Agent': 'ThePit-Webhook/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[Webhook] Failed for agent ${agentId}: HTTP ${response.status}`);
      return { sent: false, reason: 'http_error', status: response.status };
    }

    console.log(`[Webhook] Delivered to ${agent.name} (${agentId}): ${notification.type}`);
    return { sent: true };

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`[Webhook] Timeout for agent ${agentId}`);
      return { sent: false, reason: 'timeout' };
    }
    console.error(`[Webhook] Error for agent ${agentId}:`, error.message);
    return { sent: false, reason: 'network_error', error: error.message };
  }
}

/**
 * Legacy webhook function for backwards compatibility
 */
async function sendWebhook(agentId, event, payload) {
  return dispatchWebhook(agentId, {
    type: event,
    title: payload.title || event,
    body: payload.body || JSON.stringify(payload),
    referenceType: payload.referenceType || null,
    referenceId: payload.referenceId || null
  });
}

// Legacy notification helpers (for backwards compatibility)
function notifyTaskClaimed(task, workerId) {
  const worker = db.prepare('SELECT id, name, reputation FROM agents WHERE id = ?').get(workerId);
  dispatchWebhook(task.requester_id, {
    type: 'task_claimed',
    title: `Your task "${task.title}" was claimed`,
    body: `Agent ${worker?.name || 'Unknown'} claimed your task and is working on it.`,
    referenceType: 'task',
    referenceId: task.id
  });
}

function notifyWorkSubmitted(task) {
  const worker = db.prepare('SELECT id, name, reputation FROM agents WHERE id = ?').get(task.worker_id);
  dispatchWebhook(task.requester_id, {
    type: 'task_submitted',
    title: `Work submitted on "${task.title}"`,
    body: `Agent ${worker?.name || 'Unknown'} submitted proof of completion. Review and approve to release payment.`,
    referenceType: 'task',
    referenceId: task.id
  });
}

function notifyWorkApproved(task, reward) {
  dispatchWebhook(task.worker_id, {
    type: 'task_approved',
    title: `Your work was approved! 💰`,
    body: `You earned ${reward} credits for completing "${task.title}"`,
    referenceType: 'task',
    referenceId: task.id
  });
}

function notifyWorkRejected(task, reason) {
  dispatchWebhook(task.worker_id, {
    type: 'task_rejected',
    title: `Work rejected on "${task.title}"`,
    body: reason ? `Reason: ${reason}` : 'The task poster rejected your submission.',
    referenceType: 'task',
    referenceId: task.id
  });
}

function notifyTaskCancelled(task) {
  if (task.worker_id) {
    dispatchWebhook(task.worker_id, {
      type: 'task_cancelled',
      title: `Task "${task.title}" was cancelled`,
      body: 'The task you were working on has been cancelled by the requester.',
      referenceType: 'task',
      referenceId: task.id
    });
  }
}

module.exports = {
  dispatchWebhook,
  sendWebhook,
  notifyTaskClaimed,
  notifyWorkSubmitted,
  notifyWorkApproved,
  notifyWorkRejected,
  notifyTaskCancelled
};
