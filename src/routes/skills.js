const express = require('express');
const router = express.Router();
const db = require('../db');
const { recordReputationEvent, createNotification } = require('../reputation');

// Get all skills in the system (with counts)
router.get('/', (req, res) => {
  try {
    // Get skills from agents
    const agents = db.prepare('SELECT skills FROM agents').all();

    const skillCounts = new Map();

    for (const agent of agents) {
      const skills = JSON.parse(agent.skills || '[]');
      for (const skill of skills) {
        const normalized = skill.toLowerCase().trim();
        skillCounts.set(normalized, (skillCounts.get(normalized) || 0) + 1);
      }
    }

    // Get endorsement counts per skill
    const endorsements = db.prepare(`
      SELECT skill, COUNT(*) as endorsement_count
      FROM skill_endorsements
      GROUP BY skill
    `).all();

    const endorsementMap = new Map(endorsements.map(e => [e.skill.toLowerCase(), e.endorsement_count]));

    // Build response
    const skills = Array.from(skillCounts.entries())
      .map(([skill, count]) => ({
        skill,
        agent_count: count,
        endorsement_count: endorsementMap.get(skill) || 0
      }))
      .sort((a, b) => b.agent_count - a.agent_count);

    res.json({ skills, total: skills.length });
  } catch (error) {
    console.error('Skills error:', error);
    res.status(500).json({ error: 'Failed to get skills', details: error.message });
  }
});

// Get agents with a specific skill
router.get('/:skill/agents', (req, res) => {
  const skill = req.params.skill.toLowerCase();

  try {
    const agents = db.prepare(`
      SELECT id, name, bio, skills, reputation, tasks_completed
      FROM agents
      WHERE LOWER(skills) LIKE ?
      ORDER BY reputation DESC
    `).all(`%"${skill}"%`);

    // Get endorsement counts for each agent for this skill
    const enrichedAgents = agents.map(a => {
      const endorsements = db.prepare(`
        SELECT COUNT(*) as count
        FROM skill_endorsements
        WHERE agent_id = ? AND LOWER(skill) = ?
      `).get(a.id, skill);

      return {
        ...a,
        skills: JSON.parse(a.skills || '[]'),
        endorsements_for_skill: endorsements?.count || 0
      };
    });

    res.json({ skill, agents: enrichedAgents, count: enrichedAgents.length });
  } catch (error) {
    console.error('Skill agents error:', error);
    res.status(500).json({ error: 'Failed to get agents', details: error.message });
  }
});

// Get endorsements for an agent
router.get('/endorsements/:agentId', (req, res) => {
  try {
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const endorsements = db.prepare(`
      SELECT se.*, a.name as endorsed_by_name, a.reputation as endorsed_by_reputation
      FROM skill_endorsements se
      JOIN agents a ON se.endorsed_by = a.id
      WHERE se.agent_id = ?
      ORDER BY se.created_at DESC
    `).all(req.params.agentId);

    // Group by skill
    const bySkill = {};
    for (const e of endorsements) {
      if (!bySkill[e.skill]) {
        bySkill[e.skill] = [];
      }
      bySkill[e.skill].push({
        endorsed_by: e.endorsed_by,
        endorsed_by_name: e.endorsed_by_name,
        endorsed_by_reputation: e.endorsed_by_reputation,
        created_at: e.created_at
      });
    }

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      endorsements: bySkill,
      total_endorsements: endorsements.length
    });
  } catch (error) {
    console.error('Endorsements error:', error);
    res.status(500).json({ error: 'Failed to get endorsements', details: error.message });
  }
});

// Endorse an agent's skill
router.post('/endorse', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { agent_id, skill } = req.body;

  if (!agent_id || !skill) {
    return res.status(400).json({ error: 'Agent ID and skill are required' });
  }

  if (agent_id === agent.id) {
    return res.status(400).json({ error: 'Cannot endorse yourself' });
  }

  try {
    // Verify target agent exists and has this skill
    const targetAgent = db.prepare('SELECT id, name, skills FROM agents WHERE id = ?').get(agent_id);

    if (!targetAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const targetSkills = JSON.parse(targetAgent.skills || '[]').map(s => s.toLowerCase());
    const normalizedSkill = skill.toLowerCase().trim();

    if (!targetSkills.includes(normalizedSkill)) {
      return res.status(400).json({
        error: 'Agent does not have this skill listed',
        available_skills: JSON.parse(targetAgent.skills || '[]')
      });
    }

    // Check if already endorsed
    const existing = db.prepare(`
      SELECT id FROM skill_endorsements
      WHERE agent_id = ? AND endorsed_by = ? AND LOWER(skill) = ?
    `).get(agent_id, agent.id, normalizedSkill);

    if (existing) {
      return res.status(400).json({ error: 'You have already endorsed this skill' });
    }

    // Require that endorser has worked with the agent (completed task together)
    const workedTogether = db.prepare(`
      SELECT id FROM tasks
      WHERE status = 'completed'
      AND ((requester_id = ? AND worker_id = ?) OR (requester_id = ? AND worker_id = ?))
      LIMIT 1
    `).get(agent.id, agent_id, agent_id, agent.id);

    if (!workedTogether) {
      return res.status(400).json({
        error: 'You can only endorse agents you have worked with (completed a task together)'
      });
    }

    // Create endorsement
    db.prepare(`
      INSERT INTO skill_endorsements (agent_id, endorsed_by, skill)
      VALUES (?, ?, ?)
    `).run(agent_id, agent.id, skill);

    // Award reputation to the endorsed agent
    recordReputationEvent(agent_id, 'SKILL_ENDORSED', {
      relatedAgentId: agent.id,
      reason: `Skill "${skill}" endorsed by ${agent.name}`
    });

    // Notify the endorsed agent
    createNotification(agent_id, 'endorsement',
      'Skill Endorsed',
      `${agent.name} endorsed your "${skill}" skill`,
      { skill, endorsed_by: agent.id, endorsed_by_name: agent.name }
    );

    res.status(201).json({
      message: 'Skill endorsed successfully',
      agent_id,
      skill,
      endorsed_by: agent.id
    });
  } catch (error) {
    console.error('Endorse error:', error);
    res.status(500).json({ error: 'Failed to endorse skill', details: error.message });
  }
});

// Remove an endorsement
router.delete('/endorse', (req, res) => {
  const agent = req.agent;
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { agent_id, skill } = req.body;

  if (!agent_id || !skill) {
    return res.status(400).json({ error: 'Agent ID and skill are required' });
  }

  try {
    const result = db.prepare(`
      DELETE FROM skill_endorsements
      WHERE agent_id = ? AND endorsed_by = ? AND LOWER(skill) = ?
    `).run(agent_id, agent.id, skill.toLowerCase());

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Endorsement not found' });
    }

    res.json({ message: 'Endorsement removed' });
  } catch (error) {
    console.error('Remove endorsement error:', error);
    res.status(500).json({ error: 'Failed to remove endorsement' });
  }
});

module.exports = router;
