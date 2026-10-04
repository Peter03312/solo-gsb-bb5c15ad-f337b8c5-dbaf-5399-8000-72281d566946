'use strict';

const path = require('path');
const express = require('express');

const { open, newId, newSessionCode, newRoomCode, newSecretToken } = require('./db');
const { seed } = require('./seed');
const {
  normalizeDraft,
  analyze,
  witnessPath,
  findBadContinuation,
  formatPathReport,
  formatStateValues,
  initialMask,
  decodeKey,
} = require('./scenario');
const { buildSnapshot, performMove, forkSession, loadLineage, computeTotalScore } = require('./session');
const { buildCoverageReport } = require('./coverage');
const roomCore = require('./room');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

const db = open(DB_PATH);
seed(db);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 培训师：情境管理 ----------
// 对循环包含的边做“旋转无关”的规范化，用于同一环去重
function canonicalCycle(cycleSegs) {
  const edges = cycleSegs.map((s) => `${s.optionId}:${s.toKey}`);
  let best = edges.join('|');
  for (let i = 1; i < edges.length; i++) {
    const rot = edges.slice(i).concat(edges.slice(0, i)).join('|');
    if (rot < best) best = rot;
  }
  return best;
}

function buildPublishReport(scenario) {
  const graph = analyze(scenario);
  const problems = [];
  const warnings = [];

  for (const key of graph.deadEnds) {
    const { nodeId, mask } = decodeKey(key);
    const node = scenario.nodes.find((n) => n.id === nodeId);
    const segs = witnessPath(graph, key);
    problems.push({
      kind: 'DEAD_END',
      message: `非结局节点「${node ? node.title : nodeId}」在某条可达路径下没有任何可选项（无路可走）`,
      vertex: {
        nodeId,
        nodeTitle: node ? node.title : nodeId,
        states: formatStateValues(scenario, mask),
      },
      reproduciblePath: formatPathReport(scenario, segs),
    });
  }

  // doomed 中排除已经作为死路报告的顶点（死路必然 doomed），只额外报告“可无限循环”的。
  // 同一个环上的多个顶点会产生重复报告：按循环包含的边去重，每个唯一循环只保留
  // 到达路径最短的一份可复现报告。
  const loopEntries = [];
  for (const key of graph.doomed) {
    if (graph.deadEnds.includes(key)) continue;
    const { nodeId, mask } = decodeKey(key);
    const node = scenario.nodes.find((n) => n.id === nodeId);
    const segs = witnessPath(graph, key);
    const cont = findBadContinuation(graph, key);
    loopEntries.push({ key, nodeId, mask, node, segs, cont });
  }
  const byCycle = new Map();
  for (const entry of loopEntries) {
    const cycleId = entry.cont ? canonicalCycle(entry.cont.cycle) : `noncycle:${entry.key}`;
    const prev = byCycle.get(cycleId);
    if (!prev || entry.segs.length < prev.segs.length) byCycle.set(cycleId, entry);
  }

  for (const entry of byCycle.values()) {
    const { nodeId, mask, node, segs, cont } = entry;
    const lines = formatPathReport(scenario, segs);
    const loopLines = cont ? formatPathReport(scenario, cont.cycle) : [];
    problems.push({
      kind: 'INFINITE_LOOP',
      message: `从节点「${node ? node.title : nodeId}」出发存在可无限循环而不抵达结局的路径`,
      vertex: {
        nodeId,
        nodeTitle: node ? node.title : nodeId,
        states: formatStateValues(scenario, mask),
      },
      reproduciblePath: lines,
      cycle: loopLines,
      hint: cont ? '沿上述路径到达该节点后，重复执行“循环”段中列出的选择即可永不抵达结局。'
                  : '该顶点无法保证抵达结局。',
    });
  }

  for (const nodeId of graph.unreachableNodeIds) {
    const node = scenario.nodes.find((n) => n.id === nodeId);
    warnings.push({
      kind: 'UNREACHABLE_NODE',
      message: `节点「${node ? node.title : nodeId}」从初态不可到达（不影响发布，但通常是编排问题）`,
      nodeId,
    });
  }

  return { ok: problems.length === 0, problems, warnings };
}

// ---------- 健康检查 ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- 培训师：情境管理 ----------

// 情境列表
app.get('/api/scenarios', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.current_version, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM sessions WHERE sessions.scenario_id = s.id) AS session_count
      FROM scenarios s
     ORDER BY s.updated_at DESC
  `).all();
  res.json(rows);
});

// 情境详情（含草稿与版本清单）
app.get('/api/scenarios/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  const versions = db.prepare('SELECT version, created_at FROM versions WHERE scenario_id = ? ORDER BY version DESC').all(row.id);
  res.json({
    id: row.id,
    title: row.title,
    draft: row.draft ? JSON.parse(row.draft) : null,
    currentVersion: row.current_version,
    versions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

// 新建情境（保存第一版草稿；结构不合法直接拒绝）
app.post('/api/scenarios', (req, res) => {
  const { ok, scenario, errors } = normalizeDraft(req.body);
  if (!ok) return res.status(400).json({ error: '草稿校验失败，未保存', errors });
  const id = newId('sc');
  db.prepare(`INSERT INTO scenarios (id, title, draft, current_version) VALUES (?, ?, ?, 0)`)
    .run(id, scenario.title, JSON.stringify(scenario));
  res.status(201).json({ id, draft: scenario, currentVersion: 0 });
});

// 保存草稿（结构校验，拒绝无效引用/矛盾条件）
app.put('/api/scenarios/:id/draft', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  const { ok, scenario, errors } = normalizeDraft(req.body);
  if (!ok) return res.status(400).json({ error: '草稿校验失败，未保存', errors });
  db.prepare(`UPDATE scenarios SET title = ?, draft = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(scenario.title, JSON.stringify(scenario), row.id);
  // 附带发布前分析结果（仅提示，不阻断保存）
  const report = buildPublishReport(scenario);
  res.json({ ok: true, title: scenario.title, publishReport: report });
});

// 草稿试分析（不保存、不发布）
app.post('/api/scenarios/:id/analyze', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  let draft;
  if (req.body && req.body.draft !== undefined) {
    const r = normalizeDraft(req.body.draft);
    if (!r.ok) return res.status(400).json({ error: '草稿校验失败', errors: r.errors });
    draft = r.scenario;
  } else {
    draft = row.draft ? JSON.parse(row.draft) : null;
    if (!draft) return res.status(400).json({ error: '尚无草稿可分析' });
  }
  res.json(buildPublishReport(draft));
});

// 发布：运行完整分析，有问题则拒绝；通过则冻结新版本
app.post('/api/scenarios/:id/publish', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  if (!row.draft) return res.status(400).json({ error: '尚无草稿，无法发布' });
  const draft = JSON.parse(row.draft);

  // 发布前再跑一次结构校验（双保险）
  const normalized = normalizeDraft(draft);
  if (!normalized.ok) {
    return res.status(400).json({ error: '草稿存在结构性错误，拒绝发布', errors: normalized.errors });
  }
  const scenario = normalized.scenario;
  const report = buildPublishReport(scenario);
  if (!report.ok) {
    return res.status(422).json({ error: '发布检查未通过：存在无路可走的节点或可无限循环的路径，已拒绝发布', ...report });
  }

  const nextVersion = row.current_version + 1;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO versions (scenario_id, version, content) VALUES (?, ?, ?)`)
      .run(row.id, nextVersion, JSON.stringify(scenario));
    db.prepare(`UPDATE scenarios SET title = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(scenario.title, nextVersion, row.id);
  });
  tx();
  res.status(201).json({
    ok: true,
    publishedVersion: nextVersion,
    warnings: report.warnings,
    note: '内容已冻结；进行中的会话继续沿旧版本进行，新会话使用本版本。',
  });
});

// ---------- 学员：版本与会话 ----------

// 学员可见的已发布情境
app.get('/api/published', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.current_version, v.created_at AS published_at
      FROM scenarios s
      JOIN versions v ON v.scenario_id = s.id AND v.version = s.current_version
     WHERE s.current_version > 0
     ORDER BY v.created_at DESC
  `).all();
  res.json(rows);
});

// 查看某已发布版本的冻结内容（供会话卡片展示，不暴露全部结构也无妨，这里给学员用）
app.get('/api/scenarios/:id/versions/:version', (req, res) => {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(req.params.id, parseInt(req.params.version, 10));
  if (!row) return res.status(404).json({ error: '版本不存在' });
  res.json(JSON.parse(row.content));
});

// 开始新会话：绑定最新发布版
app.post('/api/sessions', (req, res) => {
  const { scenarioId, traineeName } = req.body || {};
  if (!scenarioId) return res.status(400).json({ error: '缺少 scenarioId' });
  const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!sc) return res.status(404).json({ error: '情境不存在' });
  if (sc.current_version < 1) return res.status(400).json({ error: '该情境尚未发布，无法开始演练' });
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(sc.id, sc.current_version);
  const content = JSON.parse(versionRow.content);

  const code = newSessionCode();
  db.prepare(`
    INSERT INTO sessions (code, scenario_id, version, current_node_id, state_mask, step_no, status, trainee_name, root_code)
    VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)
  `).run(code, sc.id, sc.current_version, content.startNodeId, initialMask(content),
    typeof traineeName === 'string' && traineeName.trim() ? traineeName.trim().slice(0, 100) : null,
    code);

  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  res.status(201).json(buildSnapshot(content, session, sc.id, sc.current_version));
});

// 会话列表（便于恢复；总分按各自绑定版本的冻结规则与已完成路径实时计算）
app.get('/api/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT se.code, se.scenario_id, s.title AS scenario_title, se.version, se.status,
           se.step_no, se.trainee_name, se.current_node_id, se.created_at, se.updated_at,
           se.parent_code, se.fork_step_no, se.root_code, se.path
      FROM sessions se JOIN scenarios s ON s.id = se.scenario_id
     ORDER BY se.updated_at DESC LIMIT 200
  `).all();
  const contentCache = new Map();
  const contentFor = (scenarioId, version) => {
    const key = `${scenarioId}|${version}`;
    if (!contentCache.has(key)) {
      const r = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
        .get(scenarioId, version);
      contentCache.set(key, r ? JSON.parse(r.content) : null);
    }
    return contentCache.get(key);
  };
  res.json(rows.map((se) => {
    const { path, ...rest } = se;
    let content;
    try {
      content = contentFor(se.scenario_id, se.version);
    } catch (_) { content = null; }
    let totalScore = 0;
    try { totalScore = content ? computeTotalScore(content, JSON.parse(path || '[]')) : 0; } catch (_) { totalScore = 0; }
    return { ...rest, total_score: totalScore };
  }));
});

// 查询会话现状
app.get('/api/sessions/:code', (req, res) => {
  // 房间码不属于单人会话命名空间：引导到房间状态接口
  if (isRoomCode(req.params.code)) {
    return res.status(404).json({
      error: '该码是共识演练房间码（非单人会话码），请使用 /api/rooms/:code/state 查询房间状态',
      errorCode: 'CONSENSUS_ROOM_NOT_SOLO',
      current: roomCore.buildRoomState(db, roomCore.getRoom(db, req.params.code), null).state,
    });
  }
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(req.params.code);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  if (!versionRow) return res.status(500).json({ error: '版本内容缺失' });
  const content = JSON.parse(versionRow.content);
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(session.scenario_id);
  res.json({
    ...buildSnapshot(content, session, session.scenario_id, session.version),
    scenarioTitle: sc ? sc.title : null,
  });
});

// 执行一步选择（携带当前步号）
app.post('/api/sessions/:code/move', (req, res) => {
  const { optionId, stepNo, traineeName } = req.body || {};
  if (typeof optionId !== 'string') return res.status(400).json({ error: '缺少 optionId' });
  if (!Number.isInteger(stepNo)) return res.status(400).json({ error: '缺少或非法的 stepNo（必须为整数）' });

  // 共识演练房间只能走“投票—主持结算”流程，不得经单人选择入口绕过
  if (isRoomCode(req.params.code)) {
    return res.status(409).json({
      error: '该码属于共识演练房间（非单人会话）：房间的每一步必须由学员投票、主持人结算，不能在此直接选择',
      errorCode: 'CONSENSUS_ROOM_NOT_SOLO',
      current: roomCore.buildRoomState(db, roomCore.getRoom(db, req.params.code), null).state,
    });
  }

  const result = performMove(db, { code: req.params.code, optionId, stepNo, traineeName });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.session.scenario_id);
  const snapshot = buildSnapshot(result.content, result.session, result.session.scenario_id, result.session.version);
  // 本次有效选择的得分与说明（过期/重复/条件不符不会走到这里，故不改变成绩）
  const last = snapshot.path.find((p) => p.step === result.session.step_no) || null;
  res.json({
    ok: true,
    ...snapshot,
    scenarioTitle: sc ? sc.title : null,
    lastMove: last ? {
      step: last.step,
      optionId: last.optionId,
      optionLabel: last.optionLabel,
      score: last.score,
      scoreNote: last.scoreNote,
      totalScore: snapshot.totalScore,
    } : null,
  });
});

// ---------- 培训师复盘：从历史局面分叉 ----------

// 创建分支：{forkStepNo, observedStepNo, traineeName?}
// 成功返回分支会话快照（沿用源绑定版本，步号重置为分歧步号）；
// 源步号已变化/分歧点越界/结局步/会话或版本不存在时返回原因，
// 能定位源会话时一并返回其当前步号（sourceCurrent.stepNo），且不创建分支。
app.post('/api/sessions/:code/fork', (req, res) => {
  const { forkStepNo, observedStepNo, traineeName } = req.body || {};
  if (!Number.isInteger(forkStepNo)) {
    return res.status(400).json({ error: '缺少或非法的 forkStepNo（分歧步号必须为非负整数）' });
  }
  if (!Number.isInteger(observedStepNo)) {
    return res.status(400).json({ error: '缺少或非法的 observedStepNo（所见源当前步号必须为整数）' });
  }

  // 房间会话不得经复盘分叉入口被拆成单人会话（房间不属于 sessions 家族体系）
  if (isRoomCode(req.params.code)) {
    return res.status(409).json({
      error: '该码属于共识演练房间（非单人会话）：房间沿同一条经投票结算的路径推进，不能在此分叉',
      errorCode: 'CONSENSUS_ROOM_NOT_SOLO',
      current: roomCore.buildRoomState(db, roomCore.getRoom(db, req.params.code), null).state,
    });
  }

  // 会话码随机碰撞时极小概率重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const newCode = newSessionCode();
    const result = forkSession(db, {
      sourceCode: req.params.code,
      forkStepNo,
      observedStepNo,
      traineeName,
      newCode,
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        errorCode: result.errorCode,
        sourceCurrent: result.sourceCurrent || null,
        current: result.current || null,
      });
    }
    const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.session.scenario_id);
    const snapshot = buildSnapshot(result.content, result.session, result.session.scenario_id, result.session.version);
    // 分支尚未做出自己的选择，当前累计分即“截至分歧步已完成路径”的继承得分
    return res.status(201).json({
      ok: true,
      forkedFrom: req.params.code,
      forkStepNo,
      ...snapshot,
      scenarioTitle: sc ? sc.title : null,
      inheritedScore: snapshot.totalScore,
    });
  }
  return res.status(500).json({ error: '分支会话码生成失败，请重试' });
});

// 来源与分支对照：返回同一家族（root_code）下原始会话与全部分支的树，
// 每个节点携带来源、分歧步与各自完整后续路径。
app.get('/api/sessions/:code/lineage', (req, res) => {
  const result = loadLineage(db, req.params.code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, rootCode: result.rootCode, requestedCode: result.requestedCode, tree: result.tree });
});

// ---------- 共识演练房间 ----------

// 凭证可经请求头或请求体 / 查询参数传递（curl 与浏览器均方便）
function hostTokenOf(req, body) {
  return req.get('X-Room-Host-Token') || (body && body.hostToken) || req.query.hostToken || '';
}
function memberTokenOf(req, body) {
  return req.get('X-Room-Member-Token') || (body && body.memberToken) || req.query.memberToken || '';
}

// 房间码 / 单人会话码共用命名空间：任一入口拿到码，先判断它是不是房间码
function isRoomCode(code) {
  return !!roomCore.getRoom(db, code);
}

// 培训师开启共识演练：锁定一个已发布冻结版本，取得主持凭证与学员加入码
app.post('/api/rooms', (req, res) => {
  const { scenarioId, version, hostName } = req.body || {};
  const result = roomCore.createRoom(db, { scenarioId, version, hostName },
    { newRoomCode, newSecretToken });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  }
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.room.scenario_id);
  res.status(201).json({
    ok: true,
    room: {
      code: result.code,
      scenarioId: result.room.scenario_id,
      scenarioTitle: sc ? sc.title : null,
      version: result.version,
      hostName: result.room.host_name || null,
      status: result.room.status,
      stepNo: 0,
      createdAt: result.room.created_at,
    },
    // 主持凭证只在创建时完整返回一次，请培训师妥善保存
    hostToken: result.hostToken,
    joinCode: result.code,
  });
});

// 房间列表：持主持凭证返回该主持的房间（也可用 ?hostToken= 查询）；
// 无凭证不返回房间清单。
app.get('/api/rooms', (req, res) => {
  const token = hostTokenOf(req, null);
  if (!roomCore.tokenPresent(token)) {
    return res.status(400).json({ error: '缺少主持凭证，无法列出房间', errorCode: 'HOST_TOKEN_REQUIRED' });
  }
  const rows = db.prepare(`
    SELECT r.code, r.scenario_id, s.title AS scenario_title, r.version, r.status,
           r.step_no, r.host_name, r.created_at, r.updated_at,
           (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.code) AS member_count
      FROM rooms r JOIN scenarios s ON s.id = r.scenario_id
     ORDER BY r.updated_at DESC LIMIT 200
  `).all();
  const out = [];
  for (const r of rows) {
    const room = roomCore.getRoom(db, r.code);
    if (roomCore.tokenEqual(room.host_token, token)) {
      out.push({
        code: r.code,
        scenarioId: r.scenario_id,
        scenarioTitle: r.scenario_title,
        version: r.version,
        status: r.status,
        stepNo: r.step_no,
        hostName: r.host_name,
        memberCount: r.member_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }
  }
  res.json({ rooms: out });
});

// 房间公开摘要（未鉴权）：学员凭加入码查看“是否已开始/已结束、第几步、几人加入”
app.get('/api/rooms/:code', (req, res, next) => {
  const room = roomCore.getRoom(db, req.params.code);
  if (!room) return next(); // 可能是单人会话码：交给后续 /api 兜底返回 404
  res.json(roomCore.buildRoomState(db, room, null).state);
});

// 学员加入：POST /api/rooms/:code/join {name} -> 201 {joinCode, memberToken, room}
app.post('/api/rooms/:code/join', (req, res) => {
  const result = roomCore.joinRoom(db, req.params.code, (req.body || {}).name, newSecretToken);
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      room: result.publicState || null,
    });
  }
  res.status(201).json({
    ok: true,
    joinCode: req.params.code,
    memberToken: result.member.token,
    memberName: result.member.name,
    memberId: result.member.id,
    room: result.state,
  });
});

// 主持台 / 学员台：持相应凭证返回带视角的完整房间状态
app.get('/api/rooms/:code/state', (req, res) => {
  const room = roomCore.getRoom(db, req.params.code);
  if (!room) return res.status(404).json({ error: '房间不存在', errorCode: 'ROOM_NOT_FOUND' });
  const hostToken = hostTokenOf(req, null);
  const mToken = memberTokenOf(req, null);
  let viewer;
  if (roomCore.tokenPresent(hostToken)) {
    const auth = roomCore.authorizeHost(db, room, hostToken);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error, errorCode: auth.errorCode });
    viewer = auth.viewer;
  } else if (roomCore.tokenPresent(mToken)) {
    const auth = roomCore.authorizeMember(db, room, mToken);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error, errorCode: auth.errorCode });
    viewer = auth.viewer;
  } else {
    // 未带凭证等价于公开摘要
    return res.json(roomCore.buildRoomState(db, room, null).state);
  }
  const r = roomCore.buildRoomState(db, room, viewer);
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(room.scenario_id);
  res.json({ ...r.state, scenarioTitle: sc ? sc.title : null });
});

// 主持人查看成员名单（未结算时含各人当前选票，仅主持凭证可用）
app.get('/api/rooms/:code/members', (req, res) => {
  const room = roomCore.getRoom(db, req.params.code);
  if (!room) return res.status(404).json({ error: '房间不存在', errorCode: 'ROOM_NOT_FOUND' });
  const auth = roomCore.authorizeHost(db, room, hostTokenOf(req, null));
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, errorCode: auth.errorCode });
  const r = roomCore.buildRoomState(db, room, auth.viewer);
  res.json({ ok: true, code: room.code, stepNo: room.step_no, status: room.status, members: r.state.members });
});

// 学员投票 / 改票：{memberToken, optionId, stepNo}；每人每步只计最后一票
app.post('/api/rooms/:code/vote', (req, res) => {
  const { optionId, stepNo } = req.body || {};
  const result = roomCore.castVote(db, {
    code: req.params.code,
    memberToken: memberTokenOf(req, req.body),
    optionId,
    stepNo,
  });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
      room: result.room && !result.current
        ? roomCore.buildRoomState(db, result.room, null).state : null,
    });
  }
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.room.scenario_id);
  res.json({ ok: true, ...result.state, scenarioTitle: sc ? sc.title : null });
});

// 主持人结算：{hostToken, stepNo}；票数最多选项推进，同票按冻结版本编排顺序；无人投票拒绝
app.post('/api/rooms/:code/settle', (req, res) => {
  const { stepNo } = req.body || {};
  const result = roomCore.settleRoom(db, {
    code: req.params.code,
    hostToken: hostTokenOf(req, req.body),
    stepNo,
  });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.room.scenario_id);
  res.json({
    ok: true,
    ...result.state,
    scenarioTitle: sc ? sc.title : null,
    settled: result.settled,
  });
});

// ---------- 培训师：处置覆盖报告 ----------

// 针对某个已发布冻结版本：覆盖项 = 从初态可达的（节点 × 进入时现场状态 × 可选选项）。
// 只按绑定该版本的会话已完成选择统计；同一家族（原始会话与多级分支）对同一覆盖项
// 至多贡献一次，继承前缀不重复累计；进行中会话只计已完成步骤；其它版本不混入。
// ?uncovered=1 时 items 只列未覆盖项（totals 仍基于全量统计）。
// 版本不存在 / 冻结内容损坏 / 会话路径损坏时返回明确错误码，不返回部分统计。
app.get('/api/scenarios/:id/versions/:version/coverage', (req, res) => {
  const uncoveredOnly = ['1', 'true', 'yes'].includes(String(req.query.uncovered || '').toLowerCase());
  const result = buildCoverageReport(db, req.params.id, req.params.version, { uncoveredOnly });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      detail: result.detail,
    });
  }
  res.json(result.report);
});

// 兜底：未匹配的 /api 返回 JSON 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// JSON 解析失败 / 其它异常统一返回 JSON
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 前端单页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[事故处置情境编排] 服务已启动: http://localhost:${PORT}`);
  console.log(`[数据库] ${DB_PATH}`);
});
