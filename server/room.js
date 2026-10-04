'use strict';

// 共识演练房间：培训师基于“已发布冻结版本”开启，学员凭加入码取得成员凭证后
// 在当前步的可选处置中投票（结算前可反复改票，每人每步只计最后一票），
// 主持人携所见步号结算：票数最多的选项推进同一条会话路径，同票按冻结版本中
// 选项编排顺序（节点 options 数组顺序）决定；无人投票不得结算。
//
// 并发与一致性：所有写操作都在单个 better-sqlite3 事务内完成（同步执行，
// 天然串行化）；推进前严格比对 step_no（乐观锁），过期步号 / 无效凭证 /
// 条件不符 / 房间已结束一律拒绝，不改变票数、路径与得分。
//
// 房间会话不写入 sessions 表、不能经单人 /move、/fork 入口操作（路由层拦截），
// 即“房间会话不得经现有单人选择入口绕过投票”。

const crypto = require('crypto');

const {
  initialMask,
  optionAvailable,
  applyChanges,
  findOption,
} = require('./scenario');
const { buildSnapshot, nodesById } = require('./session');

const NAME_MAX = 100;

// ---------- 凭证校验（定长 + 恒定时间比较） ----------

function tokenPresent(token) {
  return typeof token === 'string' && token.length > 0;
}

function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_) {
    return false;
  }
}

function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '';
}

// ---------- 数据读取 ----------

function getRoom(db, code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
}

function getVersionContent(db, scenarioId, version) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(scenarioId, version);
  return row ? JSON.parse(row.content) : null;
}

function listMembers(db, roomId, stepNo) {
  return db.prepare(`
    SELECT m.id, m.name, m.created_at,
           (SELECT v.option_id FROM room_votes v
             WHERE v.room_id = m.room_id AND v.member_id = m.id AND v.step_no = ?) AS current_option_id
      FROM room_members m
     WHERE m.room_id = ?
     ORDER BY m.id
  `).all(stepNo, roomId);
}

// 当前步各选项票数（按冻结版本的选项编排顺序返回；不可选项也列出，正常票数恒为 0）
function buildLiveTally(content, room, voteRows) {
  const node = nodesById(content).get(room.current_node_id);
  if (!node || node.isEnd) return [];
  const counts = new Map();
  for (const v of voteRows) {
    const o = node.options.find((x) => x.id === v.option_id);
    // 只统计“当前仍可选”的选项的票；防御性地忽略脏票（正常流程不可能产生）
    if (!o || !optionAvailable(o, room.state_mask, content)) continue;
    counts.set(v.option_id, (counts.get(v.option_id) || 0) + 1);
  }
  return node.options.map((o) => ({
    optionId: o.id,
    label: o.label,
    available: optionAvailable(o, room.state_mask, content),
    count: counts.get(o.id) || 0,
  }));
}

/**
 * 构造房间状态。
 * viewer:
 *   null                          —— 未鉴权（仅公开摘要，不泄露路径/票数/选项）
 *   { role:'host' }               —— 主持人：成员名单、未结算实时票数（含谁投了什么）
 *   { role:'member', member }     —— 学员：自己的票；未结算时看不到他人选票与票数
 */
function buildRoomState(db, room, viewer) {
  const content = getVersionContent(db, room.scenario_id, room.version);
  if (!content) {
    return {
      ok: false, status: 500, errorCode: 'VERSION_MISSING',
      error: `房间绑定的冻结版本（${room.scenario_id} v${room.version}）内容缺失`,
    };
  }

  const storedPath = JSON.parse(room.path || '[]');
  const settledByStep = new Map(storedPath.map((p) => [p.step, p]));

  // 未鉴权：只给加入房间所需的公开摘要（不含选项、状态、路径、票数、得分）
  const base = {
    kind: 'consensus-room',
    code: room.code,
    scenarioId: room.scenario_id,
    version: room.version,
    status: room.status,
    ended: room.status === 'ended',
    stepNo: room.step_no,
    memberCount: db.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?').get(room.code).c,
  };
  if (!viewer) return { ok: true, content, state: base };

  // 成员 / 主持视角：复用单人会话快照（选项不含分值；得分只在已结算路径中出现）
  const snap = buildSnapshot(content, {
    code: room.code,
    scenario_id: room.scenario_id,
    version: room.version,
    current_node_id: room.current_node_id,
    state_mask: room.state_mask,
    step_no: room.step_no,
    status: room.status,
    path: room.path,
    trainee_name: null,
    created_at: room.created_at,
  }, room.scenario_id, room.version);
  delete snap.lineage; // 房间不属于单人会话的分叉家族体系

  // 已结算路径附带当步票数快照与得分（snap.path 已含 score/scoreNote）
  snap.path = snap.path.map((p) => {
    const sp = settledByStep.get(p.step);
    return sp ? { ...p, votes: sp.votes || 0, tally: sp.tally || [] } : p;
  });

  const state = {
    ...base,
    ...snap,
    kind: 'consensus-room',
  };

  const members = listMembers(db, room.code, room.step_no);

  // 最近一次结算（进入当前局面的那一步）的票数结果：所有在场成员可见
  if (room.step_no > 0) {
    const last = storedPath[storedPath.length - 1];
    if (last) {
      state.lastSettlement = {
        step: last.step,
        votes: last.votes || 0,
        winningOptionId: last.optionId,
        tally: last.tally || [],
      };
    }
  }

  if (viewer.role === 'host') {
    state.viewer = { role: 'host', hostName: room.host_name || null };
    state.members = members.map((m) => ({
      id: m.id, name: m.name,
      voted: m.current_option_id != null,
      currentOptionId: m.current_option_id || null,
    }));
    // 主持人可见未结算的实时票数与投票人；已结束房间没有“当前步投票”
    if (room.status === 'active') {
      const voteRows = db.prepare(`
        SELECT v.option_id, m.name AS member_name
          FROM room_votes v JOIN room_members m ON m.id = v.member_id
         WHERE v.room_id = ? AND v.step_no = ?
      `).all(room.code, room.step_no);
      const tally = buildLiveTally(content, room, voteRows);
      const votersByOption = new Map();
      for (const o of tally) votersByOption.set(o.optionId, []);
      for (const v of voteRows) {
        if (votersByOption.has(v.option_id)) votersByOption.get(v.option_id).push(v.member_name);
      }
      state.currentTally = {
        stepNo: room.step_no,
        totalVotes: new Set(voteRows.map((v) => v.member_name)).size,
        options: tally.map((o) => ({ ...o, voters: votersByOption.get(o.optionId) || [] })),
      };
    } else {
      state.currentTally = null;
    }
  } else if (viewer.role === 'member') {
    const me = members.find((m) => m.id === viewer.member.id);
    state.viewer = { role: 'member', memberId: viewer.member.id, name: viewer.member.name };
    // 未结算时学员只能看到自己的票；结算结果（lastSettlement）人人可见
    state.myCurrentVote = me ? (me.current_option_id || null) : null;
    state.currentTally = null;
  }

  return { ok: true, content, state };
}

// 主持人鉴权：返回 viewer 或错误结果
function authorizeHost(db, room, token) {
  if (!tokenPresent(token)) {
    return { ok: false, status: 401, errorCode: 'HOST_TOKEN_REQUIRED', error: '缺少主持凭证（X-Room-Host-Token 或 hostToken）' };
  }
  if (!tokenEqual(token, room.host_token)) {
    return { ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID', error: '主持凭证无效' };
  }
  return { ok: true, viewer: { role: 'host' } };
}

// 成员鉴权：返回 {viewer, member} 或错误结果
function authorizeMember(db, room, token) {
  if (!tokenPresent(token)) {
    return { ok: false, status: 401, errorCode: 'MEMBER_TOKEN_REQUIRED', error: '缺少成员凭证（X-Room-Member-Token 或 memberToken）' };
  }
  const member = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND token = ?')
    .get(room.code, token);
  if (!member) {
    return { ok: false, status: 401, errorCode: 'MEMBER_TOKEN_INVALID', error: '成员凭证无效或不属于本房间' };
  }
  return { ok: true, viewer: { role: 'member', member }, member };
}

// ---------- 写操作 ----------

/**
 * 开启共识演练：锁定某已发布冻结版本（默认该情境最新发布版），
 * 返回房间码（学员加入码）与主持凭证。后续发布新版本不改变本场规则。
 */
function createRoom(db, params, generators) {
  const { scenarioId, version, hostName } = params;
  if (typeof scenarioId !== 'string' || !scenarioId) {
    return { ok: false, status: 400, errorCode: 'SCENARIO_ID_REQUIRED', error: '缺少 scenarioId' };
  }
  const scenario = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!scenario) return { ok: false, status: 404, errorCode: 'SCENARIO_NOT_FOUND', error: '情境不存在' };

  let versionNo;
  if (version === undefined || version === null) {
    versionNo = scenario.current_version;
  } else {
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, status: 400, errorCode: 'VERSION_INVALID', error: '版本号必须是 ≥1 的整数' };
    }
    versionNo = version;
  }
  if (versionNo < 1) {
    return { ok: false, status: 400, errorCode: 'NOT_PUBLISHED', error: '该情境尚未发布，无法开启共识演练' };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(scenarioId, versionNo);
  if (!versionRow) {
    return { ok: false, status: 404, errorCode: 'VERSION_NOT_FOUND', error: `情境不存在已冻结版本 v${versionNo}` };
  }
  let content;
  try {
    content = JSON.parse(versionRow.content);
  } catch (_) {
    return { ok: false, status: 500, errorCode: 'VERSION_CONTENT_CORRUPT', error: '冻结版本内容无法解析' };
  }

  const name = cleanName(hostName);
  const code = generators.newRoomCode();
  const hostToken = generators.newSecretToken();
  const mask = initialMask(content);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO rooms (code, scenario_id, version, host_token, host_name,
                         current_node_id, state_mask, step_no, status, path)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', '[]')
    `).run(code, scenarioId, versionNo, hostToken, name || null,
      content.startNodeId, mask);
  });
  tx();

  const room = getRoom(db, code);
  return { ok: true, room, content, code, hostToken, version: versionNo };
}

/**
 * 学员凭加入码加入，取得各自成员凭证（姓名在房间内唯一）。
 */
function joinRoom(db, code, rawName, newToken) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在或加入码有误' };

  const fail = (status, errorCode, error) => {
    const r = buildRoomState(db, room, null);
    return { ok: false, status, errorCode, error, room, publicState: r.state };
  };

  if (room.status === 'ended') {
    return fail(409, 'ROOM_ENDED', '本场共识演练已结束，不能再加入');
  }
  const name = cleanName(rawName);
  if (!name) return fail(400, 'MEMBER_NAME_REQUIRED', '请填写学员姓名（加入房间时记录）');

  const exists = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND name = ?')
    .get(room.code, name);
  if (exists) {
    return fail(409, 'MEMBER_NAME_EXISTS', `本房间已有学员使用姓名「${name}」，请换一个姓名或由主持人核对`);
  }

  let member;
  const tx = db.transaction(() => {
    const token = newToken();
    const info = db.prepare('INSERT INTO room_members (room_id, name, token) VALUES (?, ?, ?)')
      .run(room.code, name, token);
    member = { id: info.lastInsertRowid, room_id: room.code, name, token };
  });
  try {
    tx();
  } catch (err) {
    // 并发同名加入 / token 极小概率碰撞
    if (String(err && err.message).includes('UNIQUE')) {
      return fail(409, 'MEMBER_NAME_EXISTS', `本房间已有学员使用姓名「${name}」，请换一个姓名或由主持人核对`);
    }
    throw err;
  }

  const r = buildRoomState(db, room, { role: 'member', member });
  return { ok: true, room, member: member, content: r.content, state: r.state };
}

/**
 * 学员在当前步投票 / 改票（每人每步只保留最后一票）。
 * 入参：{ code, memberToken, optionId, stepNo }
 */
function castVote(db, params) {
  const { code, memberToken, optionId, stepNo } = params;
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };

  const auth = authorizeMember(db, room, memberToken);
  if (!auth.ok) return { ...auth, room };

  const reject = (status, errorCode, error) => {
    const r = buildRoomState(db, room, auth.viewer);
    return { ok: false, status, errorCode, error, room, current: r.state, content: r.content };
  };

  if (!Number.isInteger(stepNo)) {
    return reject(400, 'STEP_NO_INVALID', '缺少或非法的 stepNo（必须为整数）');
  }
  if (typeof optionId !== 'string' || !optionId) {
    return reject(400, 'OPTION_ID_REQUIRED', '缺少 optionId');
  }
  const content = getVersionContent(db, room.scenario_id, room.version);
  if (!content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的冻结版本内容缺失', room };
  }

  let result;
  const tx = db.transaction(() => {
    const cur = getRoom(db, code); // 事务内重读，避免与结算并发
    const node = nodesById(content).get(cur.current_node_id);
    const failNow = (status, errorCode, error) => {
      const r = buildRoomState(db, cur, auth.viewer);
      result = { ok: false, status, errorCode, error, room: cur, current: r.state, content };
    };

    if (cur.status !== 'active') {
      failNow(409, 'ROOM_ENDED', '本场共识演练已结束，不能再投票');
      return;
    }
    if (stepNo !== cur.step_no) {
      failNow(409, 'STEP_STALE',
        `步号不匹配：你看到的是第 ${stepNo} 步，房间当前为第 ${cur.step_no} 步（该步可能已结算），投票未计入`);
      return;
    }
    if (!node || node.isEnd) {
      failNow(409, 'NODE_NOT_CHOOSABLE', '当前局面不是可投票的非结局节点');
      return;
    }
    const option = node.options.find((o) => o.id === optionId);
    if (!option) {
      failNow(400, 'OPTION_NOT_FOUND', '当前节点下不存在该选项，投票未计入');
      return;
    }
    if (!optionAvailable(option, cur.state_mask, content)) {
      failNow(409, 'CONDITION_NOT_MET',
        `当前现场状态不满足选项「${option.label}」的显示条件，投票未计入`);
      return;
    }

    db.prepare(`
      INSERT INTO room_votes (room_id, member_id, step_no, option_id, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(room_id, member_id, step_no) DO UPDATE
        SET option_id = excluded.option_id, updated_at = datetime('now')
    `).run(cur.code, auth.member.id, cur.step_no, option.id);

    const updated = getRoom(db, code);
    const r = buildRoomState(db, updated, auth.viewer);
    result = { ok: true, room: updated, content, state: r.state };
  });
  tx();
  return result;
}

/**
 * 主持人携“所见步号”结算当前步。
 *  - 步号不一致（过期/并发重复结算）→ STEP_STALE，不改变任何数据；
 *  - 无人投票 → NO_VOTES，不得结算；
 *  - 票数最多的选项推进；同票按冻结版本选项编排顺序（仅在严格更高时替换赢家）。
 * 返回 settled 摘要（含各选项票数）与推进后的房间状态。
 */
function settleRoom(db, params) {
  const { code, hostToken, stepNo } = params;
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };

  const auth = authorizeHost(db, room, hostToken);
  if (!auth.ok) return { ...auth, room };

  const reject = (status, errorCode, error) => {
    const r = buildRoomState(db, room, auth.viewer);
    return { ok: false, status, errorCode, error, room, current: r.state, content: r.content };
  };

  if (!Number.isInteger(stepNo)) {
    return reject(400, 'STEP_NO_INVALID', '缺少或非法的 stepNo（必须为整数）');
  }

  let result;
  const tx = db.transaction(() => {
    const cur = getRoom(db, code);
    const content = getVersionContent(db, cur.scenario_id, cur.version);
    if (!content) {
      result = { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的冻结版本内容缺失', room: cur };
      return;
    }
    const failNow = (status, errorCode, error) => {
      const r = buildRoomState(db, cur, auth.viewer);
      result = { ok: false, status, errorCode, error, room: cur, current: r.state, content };
    };

    if (cur.status !== 'active') {
      failNow(409, 'ROOM_ENDED', '本场共识演练已结束，不能重复结算');
      return;
    }
    if (stepNo !== cur.step_no) {
      failNow(409, 'STEP_STALE',
        `步号不匹配：你看到的是第 ${stepNo} 步，房间当前为第 ${cur.step_no} 步（可能已被并发结算），未重复推进`);
      return;
    }

    const node = nodesById(content).get(cur.current_node_id);
    if (!node || node.isEnd) {
      failNow(409, 'NODE_NOT_CHOOSABLE', '当前局面不是可结算的非结局节点');
      return;
    }

    const voteRows = db.prepare(`
      SELECT v.member_id, v.option_id
        FROM room_votes v
       WHERE v.room_id = ? AND v.step_no = ?
    `).all(cur.code, cur.step_no);

    // 只统计当前确实可选的票（防御性过滤；正常流程不可能投出不可选票）
    const counts = new Map();
    let validVotes = 0;
    for (const v of voteRows) {
      const o = node.options.find((x) => x.id === v.option_id);
      if (!o || !optionAvailable(o, cur.state_mask, content)) continue;
      counts.set(v.option_id, (counts.get(v.option_id) || 0) + 1);
      validVotes += 1;
    }
    if (validVotes === 0) {
      failNow(409, 'NO_VOTES', `第 ${cur.step_no} 步还没有任何选票，不能结算；请先组织学员投票`);
      return;
    }

    // 同票按冻结版本的选项编排顺序：严格更高才替换，先出现的选项赢得平局
    let winner = null;
    let winnerCount = -1;
    for (const o of node.options) {
      const c = counts.get(o.id) || 0;
      if (c > winnerCount) {
        winner = o;
        winnerCount = c;
      }
    }

    const nextMask = applyChanges(winner, cur.state_mask, content);
    const nextStep = cur.step_no + 1;
    const path = JSON.parse(cur.path || '[]');
    const tally = node.options.map((o) => ({
      optionId: o.id,
      label: o.label,
      count: counts.get(o.id) || 0,
    }));
    path.push({
      step: nextStep,
      fromNodeId: node.id,
      optionId: winner.id,
      toNodeId: winner.toNodeId,
      stateMask: nextMask,
      votes: validVotes,
      tally,
    });
    const target = nodesById(content).get(winner.toNodeId);
    const newStatus = target && target.isEnd ? 'ended' : 'active';

    db.prepare(`
      UPDATE rooms
         SET current_node_id = ?, state_mask = ?, step_no = ?, status = ?,
             path = ?, updated_at = datetime('now')
       WHERE code = ? AND step_no = ? AND status = 'active'
    `).run(winner.toNodeId, nextMask, nextStep, newStatus, JSON.stringify(path),
      cur.code, cur.step_no);

    const updated = getRoom(db, code);
    const r = buildRoomState(db, updated, auth.viewer);
    const chosen = findOption(content, node.id, winner.id);
    result = {
      ok: true,
      room: updated,
      content,
      state: r.state,
      settled: {
        step: nextStep,
        winningOptionId: winner.id,
        winningOptionLabel: winner.label,
        votes: validVotes,
        tally,
        score: chosen && Number.isInteger(chosen.score) ? chosen.score : 0,
        totalScore: r.state.totalScore,
        advancedToNodeId: winner.toNodeId,
        advancedToNodeTitle: target ? target.title : winner.toNodeId,
        ended: newStatus === 'ended',
      },
    };
  });
  tx();
  return result;
}

module.exports = {
  buildRoomState,
  getRoom,
  createRoom,
  joinRoom,
  castVote,
  settleRoom,
  authorizeHost,
  authorizeMember,
  tokenPresent,
  tokenEqual,
  NAME_MAX,
};
