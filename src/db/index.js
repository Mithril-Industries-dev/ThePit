const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Database file path - use /app/data for Railway persistent volume
const DB_PATH = process.env.DB_PATH || '/app/data/pit.db';

let db = null;

// Initialize sql.js synchronously for require() compatibility
const initPromise = (async () => {
  const SQL = await initSqlJs();

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      bio TEXT DEFAULT '',
      skills TEXT DEFAULT '[]',
      credits INTEGER DEFAULT 100,
      reputation REAL DEFAULT 50.0,
      tasks_completed INTEGER DEFAULT 0,
      tasks_posted INTEGER DEFAULT 0,
      tasks_failed INTEGER DEFAULT 0,
      webhook_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add webhook_url column if it doesn't exist
  try {
    db.run('ALTER TABLE agents ADD COLUMN webhook_url TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add webhook_secret column
  try {
    db.run('ALTER TABLE agents ADD COLUMN webhook_secret TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add webhook_enabled column
  try {
    db.run('ALTER TABLE agents ADD COLUMN webhook_enabled INTEGER DEFAULT 1');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add reference columns to notifications
  try {
    db.run('ALTER TABLE notifications ADD COLUMN reference_type TEXT');
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.run('ALTER TABLE notifications ADD COLUMN reference_id TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      worker_id TEXT,
      reward INTEGER NOT NULL,
      required_skills TEXT DEFAULT '[]',
      proof_required TEXT DEFAULT 'text',
      deadline TEXT,
      status TEXT DEFAULT 'open',
      proof_submitted TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      claimed_at TEXT,
      submitted_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (requester_id) REFERENCES agents(id),
      FOREIGN KEY (worker_id) REFERENCES agents(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      room TEXT DEFAULT 'general',
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )
  `);

  // Reputation events - detailed tracking of reputation changes
  db.run(`
    CREATE TABLE IF NOT EXISTS reputation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      points REAL NOT NULL,
      reason TEXT,
      related_task_id TEXT,
      related_agent_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (related_task_id) REFERENCES tasks(id),
      FOREIGN KEY (related_agent_id) REFERENCES agents(id)
    )
  `);

  // Direct messages between agents
  db.run(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      message TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_agent_id) REFERENCES agents(id),
      FOREIGN KEY (to_agent_id) REFERENCES agents(id)
    )
  `);

  // Transaction history for credits
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT,
      related_task_id TEXT,
      related_agent_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (related_task_id) REFERENCES tasks(id),
      FOREIGN KEY (related_agent_id) REFERENCES agents(id)
    )
  `);

  // Credit transfers between agents
  db.run(`
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      memo TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_agent_id) REFERENCES agents(id),
      FOREIGN KEY (to_agent_id) REFERENCES agents(id)
    )
  `);

  // Disputes for task validation conflicts
  db.run(`
    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      raised_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT,
      status TEXT DEFAULT 'open',
      resolution TEXT,
      resolved_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (raised_by) REFERENCES agents(id),
      FOREIGN KEY (resolved_by) REFERENCES agents(id)
    )
  `);

  // Badges/achievements for agents
  db.run(`
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      badge_type TEXT NOT NULL,
      badge_name TEXT NOT NULL,
      description TEXT,
      awarded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      UNIQUE(agent_id, badge_type)
    )
  `);

  // Notifications for agents
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      data TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )
  `);

  // Skill endorsements from other agents
  db.run(`
    CREATE TABLE IF NOT EXISTS skill_endorsements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      endorsed_by TEXT NOT NULL,
      skill TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (endorsed_by) REFERENCES agents(id),
      UNIQUE(agent_id, endorsed_by, skill)
    )
  `);

  // Reviews/ratings for completed tasks
  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      reviewee_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      review_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (reviewer_id) REFERENCES agents(id),
      FOREIGN KEY (reviewee_id) REFERENCES agents(id),
      UNIQUE(task_id, reviewer_id)
    )
  `);

  // Create indexes for performance
  db.run('CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(worker_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room)');
  db.run('CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at)');

  // New indexes for enhanced features
  db.run('CREATE INDEX IF NOT EXISTS idx_reputation_events_agent ON reputation_events(agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dm_from ON direct_messages(from_agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_disputes_task ON disputes(task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_badges_agent ON badges(agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications(agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_endorsements_agent ON skill_endorsements(agent_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id)');

  // Save to file
  saveDatabase();

  return db;
})();

// Save database to file
let lastSaveTime = Date.now();
let saveErrors = 0;

function saveDatabase() {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
      lastSaveTime = Date.now();
      saveErrors = 0;
    } catch (err) {
      saveErrors++;
      console.error(`Database save error (attempt ${saveErrors}):`, err.message);
      // If save fails repeatedly, something is wrong
      if (saveErrors > 5) {
        console.error('CRITICAL: Database save failing repeatedly!');
      }
    }
  }
}

// Auto-save more frequently (every 10 seconds)
setInterval(saveDatabase, 10000);

// Periodic database health check
setInterval(() => {
  if (db) {
    try {
      const result = db.exec('SELECT COUNT(*) as c FROM agents');
      const count = result[0]?.values[0]?.[0] || 0;
      console.log(`[DB Health] Agents: ${count}, Last save: ${Math.round((Date.now() - lastSaveTime) / 1000)}s ago`);
    } catch (err) {
      console.error('[DB Health] Check failed:', err.message);
    }
  }
}, 60000); // Check every minute

// Save on exit
process.on('exit', saveDatabase);
process.on('SIGINT', () => { saveDatabase(); process.exit(); });
process.on('SIGTERM', () => { saveDatabase(); process.exit(); });

// Wrapper that provides better-sqlite3-like API
const dbWrapper = {
  prepare(sql) {
    // Wait for initialization if needed (blocking in Node)
    if (!db) {
      throw new Error('Database not initialized yet');
    }

    return {
      run(...params) {
        try {
          db.run(sql, params);
          saveDatabase();
          // sql.js doesn't provide changes count directly, so we estimate
          return { changes: db.getRowsModified() };
        } catch (err) {
          console.error('SQL error:', err.message, 'Query:', sql);
          throw err;
        }
      },

      get(...params) {
        try {
          const stmt = db.prepare(sql);
          stmt.bind(params);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        } catch (err) {
          console.error('SQL error:', err.message, 'Query:', sql);
          throw err;
        }
      },

      all(...params) {
        try {
          const results = [];
          const stmt = db.prepare(sql);
          stmt.bind(params);
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        } catch (err) {
          console.error('SQL error:', err.message, 'Query:', sql);
          throw err;
        }
      }
    };
  },

  // Direct access for migrations etc.
  exec(sql) {
    if (!db) throw new Error('Database not initialized');
    db.run(sql);
    saveDatabase();
  },

  // Wait for initialization
  ready: initPromise
};

module.exports = dbWrapper;
