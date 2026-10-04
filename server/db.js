'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let db;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS scenarios (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    draft           TEXT,                 -- JSON：当前草稿；NULL 表示尚未保存草稿
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS versions (
    scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,       -- 冻结的完整 JSON
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scenario_id, version)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    code            TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL,
    version         INTEGER NOT NULL,     -- 创建会话时冻结的版本
    current_node_id TEXT NOT NULL,
    state_mask      INTEGER NOT NULL,
    step_no         INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',  -- active / ended
    path            TEXT NOT NULL DEFAULT '[]',       -- [{step, fromNodeId, optionId, toNodeId, stateMask}]
    trainee_name    TEXT,
    parent_code     TEXT REFERENCES sessions(code) ON DELETE RESTRICT, -- 复盘分叉的源会话；NULL 为原始会话
    fork_step_no    INTEGER,              -- 分叉时的分歧步号（NULL 表示非分支）
    root_code       TEXT,                 -- 家族根会话码（原始会话即自身 code，分支沿用源的 root）
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scenario_id, version) REFERENCES versions(scenario_id, version) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_versions_scenario ON versions(scenario_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON sessions(scenario_id);
  -- 注：idx_sessions_root 在下方迁移补列之后再创建（老库此时尚无 root_code 列）

  -- ---------- 共识演练房间 ----------
  -- 房间码（学员加入码）与单人会话码共用 10 位 hex 命名空间，由应用层保证互不碰撞：
  -- 这样单人选择/分叉入口可以直接据码识别“这是房间会话”而拒绝绕过投票。
  CREATE TABLE IF NOT EXISTS rooms (
    code            TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL,
    version         INTEGER NOT NULL,      -- 创建时锁定的冻结版本；后续发布不改变本场规则
    host_token      TEXT NOT NULL,         -- 主持凭证（不随列表/公开状态返回）
    host_name       TEXT,
    current_node_id TEXT NOT NULL,
    state_mask      INTEGER NOT NULL,
    step_no         INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',   -- active / ended
    -- [{step, fromNodeId, optionId, toNodeId, stateMask, votes, tally:[{optionId,label,count}]}]
    path            TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scenario_id, version) REFERENCES versions(scenario_id, version) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS room_members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    name        TEXT NOT NULL,             -- 房间内唯一，便于主持台辨识谁投了什么
    token       TEXT NOT NULL UNIQUE,      -- 学员各自的成员凭证
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (room_id, name)
  );

  -- 每人每步只有一行（结算前改票即覆盖 UPDATE），天然实现“每人每步只计最后一票”
  CREATE TABLE IF NOT EXISTS room_votes (
    room_id     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    member_id   INTEGER NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
    step_no     INTEGER NOT NULL,
    option_id   TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, member_id, step_no)
  );

  CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
  CREATE INDEX IF NOT EXISTS idx_room_votes_room_step ON room_votes(room_id, step_no);
  `);

  // 老库迁移：补入复盘分叉所需的溯源列
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  const addColumn = (name, ddl) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  };
  addColumn('parent_code', 'parent_code TEXT');
  addColumn('fork_step_no', 'fork_step_no INTEGER');
  addColumn('root_code', 'root_code TEXT');
  // 存量会话（含建表后尚未回填 root_code 的库）：无溯源信息即为原始会话，根是自身
  db.exec(`UPDATE sessions SET root_code = code WHERE root_code IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_code)`);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function newSessionCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 位
}

// 房间码与单人会话码共用同一命名空间（均为 10 位 hex），生成时同时查两张表防碰撞
function newRoomCode() {
  for (let i = 0; i < 20; i++) {
    const code = crypto.randomBytes(5).toString('hex');
    const inSessions = db.prepare('SELECT 1 FROM sessions WHERE code = ?').get(code);
    const inRooms = db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code);
    if (!inSessions && !inRooms) return code;
  }
  throw new Error('房间码生成失败：随机碰撞次数超限');
}

// 主持凭证 / 成员凭证：更长的随机密钥，只在创建/加入时完整返回一次
function newSecretToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 位
}

module.exports = { open, get db() { return db; }, newId, newSessionCode, newRoomCode, newSecretToken };
