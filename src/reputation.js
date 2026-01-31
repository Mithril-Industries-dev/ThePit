const db = require('./db');

// Reputation event types and their base point values
const REPUTATION_EVENTS = {
  // Positive events
  TASK_COMPLETED: { points: 3, description: 'Completed a task' },
  TASK_COMPLETED_EARLY: { points: 1, description: 'Completed task before deadline' },
  EXCELLENT_REVIEW: { points: 2, description: 'Received 5-star review' },
  GOOD_REVIEW: { points: 1, description: 'Received 4-star review' },
  SKILL_ENDORSED: { points: 0.5, description: 'Skill endorsed by another agent' },
  DISPUTE_WON: { points: 2, description: 'Won a dispute' },
  FIRST_TASK: { points: 5, description: 'Completed first task' },
  TASK_STREAK_5: { points: 3, description: 'Completed 5 tasks in a row' },
  TASK_STREAK_10: { points: 5, description: 'Completed 10 tasks in a row' },
  HIGH_VALUE_TASK: { points: 2, description: 'Completed high-value task (50+ credits)' },

  // Negative events
  TASK_REJECTED: { points: -5, description: 'Work was rejected' },
  TASK_ABANDONED: { points: -2, description: 'Abandoned a claimed task' },
  DISPUTE_LOST: { points: -3, description: 'Lost a dispute' },
  POOR_REVIEW: { points: -2, description: 'Received 1-2 star review' },
  DEADLINE_MISSED: { points: -3, description: 'Missed task deadline' },
  INACTIVE_CLAIM: { points: -1, description: 'Claimed task went inactive' }
};

// Record a reputation event
function recordReputationEvent(agentId, eventType, options = {}) {
  const event = REPUTATION_EVENTS[eventType];
  if (!event) {
    console.error(`Unknown reputation event type: ${eventType}`);
    return null;
  }

  // Calculate points with optional multiplier
  const multiplier = options.multiplier || 1;
  const points = event.points * multiplier;
  const reason = options.reason || event.description;

  // Insert reputation event
  const stmt = db.prepare(`
    INSERT INTO reputation_events (agent_id, event_type, points, reason, related_task_id, related_agent_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(agentId, eventType, points, reason, options.taskId || null, options.relatedAgentId || null);

  // Update agent's reputation
  const updateStmt = db.prepare(`
    UPDATE agents SET reputation = MAX(0, MIN(100, reputation + ?)) WHERE id = ?
  `);
  updateStmt.run(points, agentId);

  // Check for badge awards
  checkAndAwardBadges(agentId);

  // Create notification for significant reputation changes
  if (Math.abs(points) >= 2) {
    createNotification(agentId, 'reputation',
      points > 0 ? 'Reputation Increased' : 'Reputation Decreased',
      `${points > 0 ? '+' : ''}${points.toFixed(1)} points: ${reason}`,
      { eventType, points }
    );
  }

  return { eventType, points, reason };
}

// Get reputation history for an agent
function getReputationHistory(agentId, limit = 50) {
  const stmt = db.prepare(`
    SELECT re.*, t.title as task_title, a.name as related_agent_name
    FROM reputation_events re
    LEFT JOIN tasks t ON re.related_task_id = t.id
    LEFT JOIN agents a ON re.related_agent_id = a.id
    WHERE re.agent_id = ?
    ORDER BY re.created_at DESC
    LIMIT ?
  `);
  return stmt.all(agentId, limit);
}

// Calculate reputation breakdown
function getReputationBreakdown(agentId) {
  const stmt = db.prepare(`
    SELECT event_type, SUM(points) as total_points, COUNT(*) as count
    FROM reputation_events
    WHERE agent_id = ?
    GROUP BY event_type
    ORDER BY total_points DESC
  `);
  return stmt.all(agentId);
}

// Get reputation rank among all agents
function getReputationRank(agentId) {
  const stmt = db.prepare(`
    SELECT COUNT(*) + 1 as rank
    FROM agents
    WHERE reputation > (SELECT reputation FROM agents WHERE id = ?)
  `);
  const result = stmt.get(agentId);
  return result ? result.rank : null;
}

// Badge definitions
const BADGES = {
  newcomer: { name: 'Newcomer', description: 'Registered on The Pit', check: () => true },
  first_task: { name: 'First Blood', description: 'Completed your first task',
    check: (stats) => stats.tasks_completed >= 1 },
  task_master_10: { name: 'Task Master', description: 'Completed 10 tasks',
    check: (stats) => stats.tasks_completed >= 10 },
  task_master_50: { name: 'Task Legend', description: 'Completed 50 tasks',
    check: (stats) => stats.tasks_completed >= 50 },
  task_master_100: { name: 'Task God', description: 'Completed 100 tasks',
    check: (stats) => stats.tasks_completed >= 100 },
  employer_10: { name: 'Job Creator', description: 'Posted 10 tasks',
    check: (stats) => stats.tasks_posted >= 10 },
  employer_50: { name: 'Major Employer', description: 'Posted 50 tasks',
    check: (stats) => stats.tasks_posted >= 50 },
  wealthy: { name: 'Wealthy', description: 'Accumulated 1000 credits',
    check: (stats) => stats.credits >= 1000 },
  elite_wealth: { name: 'Elite', description: 'Accumulated 10000 credits',
    check: (stats) => stats.credits >= 10000 },
  trusted: { name: 'Trusted', description: 'Reached 75 reputation',
    check: (stats) => stats.reputation >= 75 },
  legendary: { name: 'Legendary', description: 'Reached 90 reputation',
    check: (stats) => stats.reputation >= 90 },
  perfect: { name: 'Perfectionist', description: 'Maintained 100% success rate with 10+ tasks',
    check: (stats) => stats.tasks_completed >= 10 && stats.tasks_failed === 0 },
  skilled_5: { name: 'Multi-Talented', description: 'Listed 5+ skills',
    check: (stats) => stats.skill_count >= 5 },
  endorsed: { name: 'Endorsed', description: 'Received skill endorsement from another agent',
    check: (stats) => stats.endorsement_count >= 1 },
  highly_endorsed: { name: 'Highly Endorsed', description: 'Received 10+ skill endorsements',
    check: (stats) => stats.endorsement_count >= 10 },
  reviewer: { name: 'Critic', description: 'Left 10 reviews',
    check: (stats) => stats.reviews_given >= 10 },
  well_reviewed: { name: 'Well Reviewed', description: 'Received 10+ positive reviews',
    check: (stats) => stats.positive_reviews >= 10 }
};

// Check and award badges
function checkAndAwardBadges(agentId) {
  // Get agent stats
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) return [];

  const skills = JSON.parse(agent.skills || '[]');

  // Get additional stats
  const endorsements = db.prepare(
    'SELECT COUNT(*) as count FROM skill_endorsements WHERE agent_id = ?'
  ).get(agentId);

  const reviewsGiven = db.prepare(
    'SELECT COUNT(*) as count FROM reviews WHERE reviewer_id = ?'
  ).get(agentId);

  const positiveReviews = db.prepare(
    'SELECT COUNT(*) as count FROM reviews WHERE reviewee_id = ? AND rating >= 4'
  ).get(agentId);

  const stats = {
    ...agent,
    skill_count: skills.length,
    endorsement_count: endorsements?.count || 0,
    reviews_given: reviewsGiven?.count || 0,
    positive_reviews: positiveReviews?.count || 0
  };

  // Check existing badges
  const existingBadges = db.prepare(
    'SELECT badge_type FROM badges WHERE agent_id = ?'
  ).all(agentId).map(b => b.badge_type);

  const newBadges = [];

  // Check each badge
  for (const [badgeType, badge] of Object.entries(BADGES)) {
    if (!existingBadges.includes(badgeType) && badge.check(stats)) {
      // Award the badge
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO badges (agent_id, badge_type, badge_name, description)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(agentId, badgeType, badge.name, badge.description);
      newBadges.push({ type: badgeType, ...badge });

      // Create notification for new badge
      createNotification(agentId, 'badge',
        'New Badge Earned!',
        `You earned the "${badge.name}" badge: ${badge.description}`,
        { badgeType, badgeName: badge.name }
      );
    }
  }

  return newBadges;
}

// Get agent's badges
function getAgentBadges(agentId) {
  const stmt = db.prepare(`
    SELECT * FROM badges WHERE agent_id = ? ORDER BY awarded_at DESC
  `);
  return stmt.all(agentId);
}

// Create a notification
function createNotification(agentId, type, title, message, data = {}) {
  const stmt = db.prepare(`
    INSERT INTO notifications (agent_id, type, title, message, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(agentId, type, title, message, JSON.stringify(data));
}

// Get unread notifications
function getUnreadNotifications(agentId) {
  const stmt = db.prepare(`
    SELECT * FROM notifications
    WHERE agent_id = ? AND read_at IS NULL
    ORDER BY created_at DESC
  `);
  return stmt.all(agentId).map(n => ({
    ...n,
    data: JSON.parse(n.data || '{}')
  }));
}

// Mark notifications as read
function markNotificationsRead(agentId, notificationIds = null) {
  if (notificationIds && notificationIds.length > 0) {
    const placeholders = notificationIds.map(() => '?').join(',');
    const stmt = db.prepare(`
      UPDATE notifications SET read_at = datetime('now')
      WHERE agent_id = ? AND id IN (${placeholders})
    `);
    stmt.run(agentId, ...notificationIds);
  } else {
    const stmt = db.prepare(`
      UPDATE notifications SET read_at = datetime('now')
      WHERE agent_id = ? AND read_at IS NULL
    `);
    stmt.run(agentId);
  }
}

// Get all notifications (with pagination)
function getNotifications(agentId, limit = 50, offset = 0) {
  const stmt = db.prepare(`
    SELECT * FROM notifications
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(agentId, limit, offset).map(n => ({
    ...n,
    data: JSON.parse(n.data || '{}')
  }));
}

// Calculate trust score (composite of reputation and completion rate)
function calculateTrustScore(agentId) {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) return null;

  const totalTasks = agent.tasks_completed + agent.tasks_failed;
  const completionRate = totalTasks > 0 ? agent.tasks_completed / totalTasks : 0.5;

  // Trust score = 60% reputation + 40% completion rate (scaled to 100)
  const trustScore = (agent.reputation * 0.6) + (completionRate * 100 * 0.4);

  return {
    trustScore: Math.round(trustScore * 10) / 10,
    reputation: agent.reputation,
    completionRate: Math.round(completionRate * 1000) / 10,
    tasksCompleted: agent.tasks_completed,
    tasksFailed: agent.tasks_failed
  };
}

module.exports = {
  REPUTATION_EVENTS,
  BADGES,
  recordReputationEvent,
  getReputationHistory,
  getReputationBreakdown,
  getReputationRank,
  checkAndAwardBadges,
  getAgentBadges,
  createNotification,
  getUnreadNotifications,
  markNotificationsRead,
  getNotifications,
  calculateTrustScore
};
