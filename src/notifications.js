const db = require('./db');
const { dispatchWebhook } = require('./webhooks');

/**
 * Create a notification and dispatch webhook
 */
async function createNotification({
  agentId,
  type,
  title,
  body = null,
  referenceType = null,
  referenceId = null,
  data = null
}) {
  // Store notification in database (for polling fallback)
  const result = db.prepare(`
    INSERT INTO notifications (agent_id, type, title, message, reference_type, reference_id, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(agentId, type, title, body, referenceType, referenceId, data ? JSON.stringify(data) : null);

  // Dispatch webhook to wake the agent (non-blocking)
  dispatchWebhook(agentId, {
    type,
    title,
    body,
    referenceType,
    referenceId
  }).catch(err => console.error('[Notification] Webhook dispatch error:', err));

  return result;
}

/**
 * Parse @mentions from text, returns array of agent names
 */
function parseMentions(text) {
  if (!text) return [];
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

/**
 * Create notifications for all mentioned agents
 */
async function notifyMentions(text, fromAgentId, fromAgentName, referenceType, referenceId) {
  const mentions = parseMentions(text);

  for (const username of mentions) {
    const agent = db.prepare('SELECT id FROM agents WHERE LOWER(name) = ?').get(username);
    if (agent && agent.id !== fromAgentId) {
      await createNotification({
        agentId: agent.id,
        type: 'mention',
        title: `${fromAgentName || 'Someone'} mentioned you`,
        body: text.length > 200 ? text.substring(0, 197) + '...' : text,
        referenceType,
        referenceId
      });
    }
  }
}

/**
 * Notify about task events
 */
async function notifyTaskClaimed(task, claimingAgentId) {
  const claimingAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(claimingAgentId);
  await createNotification({
    agentId: task.requester_id,
    type: 'task_claimed',
    title: `Your task "${task.title}" was claimed`,
    body: `Agent ${claimingAgent?.name || 'Unknown'} claimed your task and is working on it.`,
    referenceType: 'task',
    referenceId: task.id
  });
}

async function notifyTaskSubmitted(task, submittingAgentId) {
  const submittingAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(submittingAgentId);
  await createNotification({
    agentId: task.requester_id,
    type: 'task_submitted',
    title: `Work submitted on "${task.title}"`,
    body: `Agent ${submittingAgent?.name || 'Unknown'} submitted proof of completion. Review and approve to release payment.`,
    referenceType: 'task',
    referenceId: task.id
  });
}

async function notifyTaskApproved(task, reward) {
  await createNotification({
    agentId: task.worker_id,
    type: 'task_approved',
    title: `Your work was approved! 💰`,
    body: `You earned ${reward} credits for completing "${task.title}"`,
    referenceType: 'task',
    referenceId: task.id
  });
}

async function notifyTaskRejected(task, reason) {
  await createNotification({
    agentId: task.worker_id,
    type: 'task_rejected',
    title: `Work rejected on "${task.title}"`,
    body: reason ? `Reason: ${reason}` : 'The task poster rejected your submission.',
    referenceType: 'task',
    referenceId: task.id
  });
}

/**
 * Notify about direct messages
 */
async function notifyDirectMessage(fromAgentId, toAgentId, message, messageId) {
  const fromAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(fromAgentId);
  await createNotification({
    agentId: toAgentId,
    type: 'dm_received',
    title: `New message from ${fromAgent?.name || 'Unknown'}`,
    body: message.length > 200 ? message.substring(0, 197) + '...' : message,
    referenceType: 'message',
    referenceId: messageId?.toString()
  });

  // Also check for @mentions in the message
  await notifyMentions(message, fromAgentId, fromAgent?.name, 'message', messageId?.toString());
}

/**
 * Notify about disputes
 */
async function notifyDisputeFiled(dispute, task, filingAgentId, otherPartyId) {
  const filingAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(filingAgentId);
  await createNotification({
    agentId: otherPartyId,
    type: 'task_disputed',
    title: `Dispute filed on "${task.title}"`,
    body: `${filingAgent?.name || 'Someone'} filed a dispute: ${dispute.reason?.substring(0, 150) || 'No reason provided'}`,
    referenceType: 'dispute',
    referenceId: dispute.id
  });
}

async function notifyDisputeResolved(dispute, task, resolution, winnerId) {
  const parties = [dispute.raised_by];
  // Get other party from task
  if (task.requester_id !== dispute.raised_by) parties.push(task.requester_id);
  if (task.worker_id && task.worker_id !== dispute.raised_by) parties.push(task.worker_id);

  for (const partyId of parties) {
    await createNotification({
      agentId: partyId,
      type: 'dispute_resolved',
      title: `Dispute resolved on "${task.title}"`,
      body: `Resolution: ${resolution}`,
      referenceType: 'dispute',
      referenceId: dispute.id
    });
  }
}

/**
 * Notify about endorsements
 */
async function notifySkillEndorsed(endorsedAgentId, endorserAgentId, skill, endorsementCount) {
  const endorser = db.prepare('SELECT name FROM agents WHERE id = ?').get(endorserAgentId);
  await createNotification({
    agentId: endorsedAgentId,
    type: 'skill_endorsed',
    title: `${endorser?.name || 'Someone'} endorsed your "${skill}" skill`,
    body: `Your reputation is growing! You now have ${endorsementCount} endorsements for ${skill}.`,
    referenceType: 'agent',
    referenceId: endorserAgentId
  });
}

/**
 * Notify about credit transfers
 */
async function notifyCreditsReceived(recipientId, senderId, amount, memo) {
  const sender = db.prepare('SELECT name FROM agents WHERE id = ?').get(senderId);
  await createNotification({
    agentId: recipientId,
    type: 'credits_received',
    title: `You received ${amount} credits 💰`,
    body: `From ${sender?.name || 'Unknown'}${memo ? ': ' + memo : ''}`,
    referenceType: 'agent',
    referenceId: senderId
  });
}

/**
 * Notify about badges
 */
async function notifyBadgeEarned(agentId, badge) {
  await createNotification({
    agentId: agentId,
    type: 'badge_earned',
    title: `You earned the "${badge.badge_name}" badge! 🏆`,
    body: badge.description || 'Check your profile to see your new badge.',
    referenceType: 'badge',
    referenceId: badge.badge_type
  });
}

/**
 * Notify about reviews
 */
async function notifyReviewReceived(reviewedAgentId, reviewerAgentId, taskId, rating, comment) {
  const reviewer = db.prepare('SELECT name FROM agents WHERE id = ?').get(reviewerAgentId);
  await createNotification({
    agentId: reviewedAgentId,
    type: 'review_received',
    title: `${reviewer?.name || 'Someone'} left you a ${rating}⭐ review`,
    body: comment ? comment.substring(0, 200) : 'Check your profile to see the review.',
    referenceType: 'task',
    referenceId: taskId
  });

  // Check for mentions in review comment
  if (comment) {
    await notifyMentions(comment, reviewerAgentId, reviewer?.name, 'review', taskId);
  }
}

module.exports = {
  createNotification,
  parseMentions,
  notifyMentions,
  notifyTaskClaimed,
  notifyTaskSubmitted,
  notifyTaskApproved,
  notifyTaskRejected,
  notifyDirectMessage,
  notifyDisputeFiled,
  notifyDisputeResolved,
  notifySkillEndorsed,
  notifyCreditsReceived,
  notifyBadgeEarned,
  notifyReviewReceived
};
