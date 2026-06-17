/**
 * wl_dao.js
 * 새 스키마(wl_event, wl_worker, wl_work_item, wl_part, wl_approval)용 DAO
 * [수정] 작업자별 none_time, move_time 지원
 * [추가] listEvents (조회 페이지용), updateEvent (승인된 건 수정), fullPatchEvent (반려 재제출 시 workers 포함 수정)
 */
'use strict';

const { pool } = require('../../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function minToTime(min) {
  const m = Math.max(0, Number(min) || 0);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function calcDuration(startTime, endTime, noneTime, moveTime) {
  if (!startTime || !endTime) return 0;
  const toSec = s => {
    const [hh, mm, ss = 0] = s.split(':').map(Number);
    return hh * 3600 + mm * 60 + ss;
  };
  const raw = toSec(endTime) - toSec(startTime);
  // 실작업시간 = END - START - NONE (MOVE는 빼지 않음)
  const net = raw - (Number(noneTime) || 0) * 60;
  return Math.max(0, Math.floor(net / 60));
}


// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

exports.getUsersByNicknames = async (nicknames) => {
  if (!Array.isArray(nicknames) || !nicknames.length) return [];
  const conn = await pool.getConnection(async c => c);
  try {
    const [rows] = await conn.query(
      `SELECT userIdx, nickname, userID, role, \`group\`, site
       FROM Users WHERE nickname IN (?) AND status='A'`,
      [nicknames]
    );
    return rows;
  } finally { conn.release(); }
};

exports.getEngineerLevel = async (name) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const [rows] = await conn.query(
      `SELECT ID, \`LEVEL\` FROM userDB WHERE NAME = ? LIMIT 1`,
      [name.trim()]
    );
    return rows[0] || null;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// Work Code 자동 생성
// ─────────────────────────────────────────────────────────────────────────────

async function lookupCode(conn, ruleType, sourceValue) {
  const [rows] = await conn.query(
    `SELECT code_value FROM wl_code_rule
     WHERE rule_type = ? AND BINARY source_value = BINARY ?
     LIMIT 1`,
    [ruleType, sourceValue]
  );
  return rows[0]?.code_value ?? null;
}

async function buildWorkCode(conn, eqType, site, wtype, wtype2, taskDate, taskName) {
  const vEq   = (await lookupCode(conn, 'EQ_TYPE',   eqType))  ?? 'Z';
  const vSite = (await lookupCode(conn, 'SITE',       site))    ?? '6';
  const vWt   = (await lookupCode(conn, 'WORK_TYPE',  wtype))   ?? 'X';
  const vWt2  = (await lookupCode(conn, 'WORK_TYPE2', wtype2))  ?? 'X';
  const prefix = `${vEq}${vSite}${vWt}${vWt2}`;

  const [seqRows] = await conn.query(
    `SELECT COUNT(*) + 1 AS seq FROM wl_event
     WHERE task_date = ? AND LEFT(work_code, 4) = ?`,
    [taskDate, prefix]
  );
  const seq = seqRows[0]?.seq ?? 1;
  const suffix = (taskName || '').substring(0, 20);
  return `${prefix}${seq} ${vWt2} - ${suffix}`;
}

exports.generateWorkCode = async (eqType, site, wtype, wtype2, taskDate, taskName) => {
  const conn = await pool.getConnection(async c => c);
  try {
    return await buildWorkCode(conn, eqType, site, wtype, wtype2, taskDate, taskName);
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 마스터 데이터
// ─────────────────────────────────────────────────────────────────────────────

exports.getWorkItemsByEqType = async (equipmentType) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const [rows] = await conn.query(
      `SELECT id, item_name, item_name_kr, category
       FROM wl_work_item_master
       WHERE equipment_type = ? AND is_active = 1
       ORDER BY category, item_name`,
      [equipmentType]
    );
    return rows;
  } finally { conn.release(); }
};

exports.getPartsByEqType = async (equipmentType) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const [rows] = await conn.query(
      `SELECT id, part_name, part_name_kr, category
       FROM wl_part_master
       WHERE equipment_type = ? AND is_active = 1
       ORDER BY category, part_name`,
      [equipmentType]
    );
    return rows;
  } finally { conn.release(); }
};

const normalizeCompareText = (v) => String(v || '')
  .replace(/[\s\u00A0]+/g, '')
  .trim()
  .toLowerCase();

exports.findReworkCandidates = async ({ task_name, task_cause, task_date, days = 14, limit = 8 }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const titleNorm = normalizeCompareText(task_name);
    const causeNorm = normalizeCompareText(task_cause);

    const sql = `
      SELECT
        e.id,
        e.work_code,
        e.task_name,
        DATE_FORMAT(e.task_date, '%Y-%m-%d') AS task_date,
        e.site,
        e.\`line\`,
        e.equipment_type,
        e.equipment_name,
        e.task_description,
        e.task_cause,
        e.task_result,
        e.is_rework,
        e.rework_reason,
        DATEDIFF(?, e.task_date) AS days_diff,
        GROUP_CONCAT(CONCAT(w.engineer_name, '(', w.role, ')') ORDER BY w.id SEPARATOR ', ') AS workers_str
      FROM wl_event e
      LEFT JOIN wl_worker w ON w.event_id = e.id
      WHERE e.approval_status = 'APPROVED'
        AND e.work_type = 'MAINT'
        AND e.task_date >= DATE_SUB(?, INTERVAL ? DAY)
        AND e.task_date <= ?
        AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(e.task_name, ''), ' ', ''), CHAR(10), ''), CHAR(13), ''), CHAR(9), '')) = ?
        AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(e.task_cause, ''), ' ', ''), CHAR(10), ''), CHAR(13), ''), CHAR(9), '')) = ?
      GROUP BY e.id
      ORDER BY e.task_date DESC, e.id DESC
      LIMIT ?
    `;

    const [rows] = await conn.query(sql, [task_date, task_date, Number(days) || 14, task_date, titleNorm, causeNorm, Number(limit) || 8]);
    return { rows, total: rows.length };
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 결재 대기 제출  →  wl_event + wl_worker + wl_work_item + wl_part
// [수정] 작업자별 none_time, move_time 지원
// ─────────────────────────────────────────────────────────────────────────────

exports.submitEvent = async (payload) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    const workCode = await buildWorkCode(
      conn,
      payload.equipment_type, payload.site,
      payload.work_type, payload.work_type2,
      payload.task_date, payload.task_name
    );

    // wl_event INSERT — 공통 시간 필드는 첫 번째 작업자 시간으로 대표값 저장 (하위호환)
    const firstWorker = (payload.workers || [])[0] || {};
    const evStartTime = firstWorker.start_time || payload.start_time || null;
    const evEndTime   = firstWorker.end_time   || payload.end_time   || null;
    const evNoneTime  = Number(firstWorker.none_time ?? payload.none_time) || 0;
    const evMoveTime  = Number(firstWorker.move_time ?? payload.move_time) || 0;

    const [evRes] = await conn.query(
      `INSERT INTO wl_event (
        work_code, task_name, task_date, country,
        \`group\`, site, \`line\`,
        equipment_type, equipment_name, warranty, ems,
        work_type, work_type2, setup_item,
        status, task_description, task_cause, task_result,
        SOP, tsguide,
        start_time, end_time, none_time, move_time,
        is_rework, rework_reason, rework_detail, rework_seq, rework_ref_id,
        approval_status, created_by
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        'PENDING', ?
      )`,
      [
        workCode,
        payload.task_name,
        payload.task_date,
        payload.country || 'KR',
        payload.group,
        payload.site,
        payload.line,
        payload.equipment_type,
        payload.equipment_name,
        payload.warranty,
        payload.ems === 1 ? 1 : 0,
        payload.work_type,
        payload.work_type2,
        payload.setup_item || null,
        payload.status,
        payload.task_description,
        payload.task_cause,
        payload.task_result,
        payload.SOP,
        payload.tsguide,
        evStartTime, evEndTime, evNoneTime, evMoveTime,
        payload.is_rework ? 1 : 0,
        payload.rework_reason || null,
        payload.rework_detail || null,
        Number(payload.rework_seq) || 0,
        payload.rework_ref_id || null,
        payload.created_by || null,
      ]
    );
    const eventId = evRes.insertId;

    // wl_worker INSERT (작업자별 시간 — none_time, move_time 포함)
    const workers = Array.isArray(payload.workers) ? payload.workers : [];
    for (const w of workers) {
      const [uRows] = await conn.query(
        `SELECT ID, \`LEVEL\` FROM userDB WHERE NAME = ? LIMIT 1`,
        [w.name.trim()]
      );
      const userdbId = uRows[0]?.ID   || null;
      const engLevel = uRows[0]?.LEVEL ?? null;

      const wNone = Number(w.none_time) || 0;
      const wMove = Number(w.move_time) || 0;
      const duration = calcDuration(
        w.start_time || null,
        w.end_time   || null,
        wNone,
        wMove
      );

      await conn.query(
        `INSERT INTO wl_worker
           (event_id, engineer_name, userdb_id, role, eng_level,
            task_duration, start_time, end_time, none_time, move_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId, w.name.trim(), userdbId,
          w.role || 'main', engLevel,
          duration,
          w.start_time || null,
          w.end_time   || null,
          wNone,
          wMove,
        ]
      );
    }

    // wl_work_item INSERT
    const workItems = Array.isArray(payload.workItems) ? payload.workItems : [];
    for (const wi of workItems) {
      if (!wi.master_id && !wi.item_name_free) continue;
      await conn.query(
        `INSERT INTO wl_work_item (event_id, master_id, item_name_free)
         VALUES (?, ?, ?)`,
        [eventId, wi.master_id || null, wi.item_name_free || null]
      );
    }

    // wl_part INSERT
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    for (const p of parts) {
      if (!p.master_id && !p.part_name_free) continue;
      await conn.query(
        `INSERT INTO wl_part (event_id, master_id, part_name_free, qty)
         VALUES (?, ?, ?, ?)`,
        [eventId, p.master_id || null, p.part_name_free || null, Number(p.qty) || 1]
      );
    }

    // wl_approval 로그
    await conn.query(
      `INSERT INTO wl_approval (event_id, seq, action, actor_id, actor_name)
       VALUES (?, 1, 'SUBMIT', ?, ?)`,
      [eventId, payload.created_by || null, payload.submitter_name || null]
    );

    await conn.commit();
    return { eventId, workCode };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 결재 대기 목록 조회
// ─────────────────────────────────────────────────────────────────────────────

exports.listPendingEvents = async (group, site, mineNickname) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const cond = [`e.approval_status = 'PENDING'`];
    const vals = [];

    if (group) { cond.push('e.`group` = ?'); vals.push(group); }
    if (site && group !== 'PSKH') { cond.push('e.site = ?'); vals.push(site); }

    if (mineNickname) {
      cond.push(`EXISTS (
        SELECT 1 FROM wl_worker ww
        WHERE ww.event_id = e.id AND ww.engineer_name = ?
      )`);
      vals.push(mineNickname.trim());
    }

    const sql = `
      SELECT e.*,
        DATE_FORMAT(e.task_date, '%Y-%m-%d') AS task_date,
        GROUP_CONCAT(ww.engineer_name ORDER BY ww.id SEPARATOR ', ') AS workers
      FROM wl_event e
      LEFT JOIN wl_worker ww ON ww.event_id = e.id
      WHERE ${cond.join(' AND ')}
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `;
    const [rows] = await conn.query(sql, vals);
    return rows;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 단건 조회 (wl_event + workers + work_items + parts + approvals)
// ─────────────────────────────────────────────────────────────────────────────

exports.getEventById = async (id) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const [[event]] = await conn.query(
      `SELECT *,
              DATE_FORMAT(task_date, '%Y-%m-%d') AS task_date
       FROM wl_event
       WHERE id = ?`,
      [id]
    );
    if (!event) return null;

    const [workers] = await conn.query(
      `SELECT * FROM wl_worker WHERE event_id = ? ORDER BY id`, [id]
    );
    const [workItems] = await conn.query(
      `SELECT wi.*, m.item_name AS master_item_name
       FROM wl_work_item wi
       LEFT JOIN wl_work_item_master m ON m.id = wi.master_id
       WHERE wi.event_id = ?`, [id]
    );
    const [parts] = await conn.query(
      `SELECT p.*, pm.part_name AS master_part_name
       FROM wl_part p
       LEFT JOIN wl_part_master pm ON pm.id = p.master_id
       WHERE p.event_id = ?`, [id]
    );
    const [approvals] = await conn.query(
      `SELECT * FROM wl_approval WHERE event_id = ? ORDER BY seq, acted_at`, [id]
    );

    return { ...event, workers, workItems, parts, approvals };
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// PATCH (결재자 또는 제출자 수정 — wl_event 필드만)
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_PATCH_FIELDS = [
  'task_name', 'task_date', 'country',
  'group', 'site', 'line',
  'equipment_type', 'equipment_name', 'warranty', 'ems',
  'work_type', 'work_type2', 'setup_item',
  'status', 'task_description', 'task_cause', 'task_result',
  'SOP', 'tsguide',
  'start_time', 'end_time', 'none_time', 'move_time',
  'is_rework', 'rework_reason', 'rework_detail', 'rework_seq', 'rework_ref_id',
];

exports.patchEvent = async (id, patch) => {
  const sets = [], vals = [];
  for (const k of Object.keys(patch || {})) {
    if (!ALLOWED_PATCH_FIELDS.includes(k)) continue;
    sets.push(`\`${k}\` = ?`);
    vals.push(patch[k]);
  }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE wl_event SET ${sets.join(', ')} WHERE id = ?`, vals);
};


// ─────────────────────────────────────────────────────────────────────────────
// fullPatchEvent — wl_event + workers 재생성 (반려 재제출, 승인 후 수정 시)
// ─────────────────────────────────────────────────────────────────────────────

exports.fullPatchEvent = async (id, patch, workers) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    // 1) wl_event 패치
    const sets = [], vals = [];
    for (const k of Object.keys(patch || {})) {
      if (!ALLOWED_PATCH_FIELDS.includes(k)) continue;
      sets.push(`\`${k}\` = ?`);
      vals.push(patch[k]);
    }
    if (sets.length) {
      vals.push(id);
      await conn.query(`UPDATE wl_event SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    // 2) workers 재생성 (제공된 경우)
    if (Array.isArray(workers) && workers.length) {
      await conn.query(`DELETE FROM wl_worker WHERE event_id = ?`, [id]);

      for (const w of workers) {
        const [uRows] = await conn.query(
          `SELECT ID, \`LEVEL\` FROM userDB WHERE NAME = ? LIMIT 1`,
          [w.name.trim()]
        );
        const userdbId = uRows[0]?.ID   || null;
        const engLevel = uRows[0]?.LEVEL ?? null;

        const wNone = Number(w.none_time) || 0;
        const wMove = Number(w.move_time) || 0;
        const duration = calcDuration(
          w.start_time || null,
          w.end_time   || null,
          wNone,
          wMove
        );

        await conn.query(
          `INSERT INTO wl_worker
             (event_id, engineer_name, userdb_id, role, eng_level,
              task_duration, start_time, end_time, none_time, move_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, w.name.trim(), userdbId,
            w.role || 'main', engLevel,
            duration,
            w.start_time || null,
            w.end_time   || null,
            wNone,
            wMove,
          ]
        );
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 반려
// ─────────────────────────────────────────────────────────────────────────────

exports.rejectEvent = async (id, actorId, actorName, comment) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE wl_event SET approval_status = 'REJECTED' WHERE id = ?`, [id]
    );

    const [[prev]] = await conn.query(
      `SELECT IFNULL(MAX(seq), 0) AS maxSeq FROM wl_approval WHERE event_id = ?`, [id]
    );
    await conn.query(
      `INSERT INTO wl_approval (event_id, seq, action, actor_id, actor_name, comment)
       VALUES (?, ?, 'REJECT', ?, ?, ?)`,
      [id, (prev.maxSeq || 0) + 1, actorId, actorName, comment || null]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 재제출 (REJECTED → PENDING) — fullPatch 포함
// ─────────────────────────────────────────────────────────────────────────────

exports.resubmitEvent = async (id, actorId, actorName, patch, workers) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    // 이벤트 필드 패치
    if (patch && Object.keys(patch).length) {
      const sets = [], vals = [];
      for (const k of Object.keys(patch)) {
        if (!ALLOWED_PATCH_FIELDS.includes(k)) continue;
        sets.push(`\`${k}\` = ?`); vals.push(patch[k]);
      }
      if (sets.length) {
        vals.push(id);
        await conn.query(`UPDATE wl_event SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
    }

    // workers 재생성 (제공된 경우)
    if (Array.isArray(workers) && workers.length) {
      await conn.query(`DELETE FROM wl_worker WHERE event_id = ?`, [id]);

      for (const w of workers) {
        const [uRows] = await conn.query(
          `SELECT ID, \`LEVEL\` FROM userDB WHERE NAME = ? LIMIT 1`,
          [w.name.trim()]
        );
        const userdbId = uRows[0]?.ID   || null;
        const engLevel = uRows[0]?.LEVEL ?? null;

        const wNone = Number(w.none_time) || 0;
        const wMove = Number(w.move_time) || 0;
        const duration = calcDuration(
          w.start_time || null,
          w.end_time   || null,
          wNone,
          wMove
        );

        await conn.query(
          `INSERT INTO wl_worker
             (event_id, engineer_name, userdb_id, role, eng_level,
              task_duration, start_time, end_time, none_time, move_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, w.name.trim(), userdbId,
            w.role || 'main', engLevel,
            duration,
            w.start_time || null,
            w.end_time   || null,
            wNone,
            wMove,
          ]
        );
      }
    }

    await conn.query(
      `UPDATE wl_event SET approval_status = 'PENDING' WHERE id = ?`, [id]
    );

    const [[prev]] = await conn.query(
      `SELECT IFNULL(MAX(seq), 0) AS maxSeq FROM wl_approval WHERE event_id = ?`, [id]
    );
    await conn.query(
      `INSERT INTO wl_approval (event_id, seq, action, actor_id, actor_name)
       VALUES (?, ?, 'SUBMIT', ?, ?)`,
      [id, (prev.maxSeq || 0) + 1, actorId, actorName]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 승인 (PENDING → APPROVED)
// ─────────────────────────────────────────────────────────────────────────────

exports.approveEvent = async (id, actorId, actorName, comment, patch) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    if (patch && Object.keys(patch).length) {
      const sets = [], vals = [];
      for (const k of Object.keys(patch)) {
        if (!ALLOWED_PATCH_FIELDS.includes(k)) continue;
        sets.push(`\`${k}\` = ?`); vals.push(patch[k]);
      }
      if (sets.length) { vals.push(id); await conn.query(`UPDATE wl_event SET ${sets.join(', ')} WHERE id = ?`, vals); }
    }

    const [[snapshot]] = await conn.query(
      `SELECT *, DATE_FORMAT(task_date, '%Y-%m-%d') AS task_date
       FROM wl_event
       WHERE id = ?`,
      [id]
    );

    await conn.query(
      `UPDATE wl_event SET approval_status = 'APPROVED' WHERE id = ?`, [id]
    );

    const [[prev]] = await conn.query(
      `SELECT IFNULL(MAX(seq), 0) AS maxSeq FROM wl_approval WHERE event_id = ?`, [id]
    );
    await conn.query(
      `INSERT INTO wl_approval (event_id, seq, action, actor_id, actor_name, comment, snapshot)
       VALUES (?, ?, 'APPROVE', ?, ?, ?, ?)`,
      [id, (prev.maxSeq || 0) + 1, actorId, actorName, comment || null, JSON.stringify(snapshot)]
    );

    await conn.commit();
    return id;
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 내 반려 목록
// ─────────────────────────────────────────────────────────────────────────────

exports.listMyRejected = async (userIdx) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const [rows] = await conn.query(
      `SELECT e.*,
         DATE_FORMAT(e.task_date, '%Y-%m-%d') AS task_date,
         GROUP_CONCAT(ww.engineer_name ORDER BY ww.id SEPARATOR ', ') AS workers,
         (SELECT comment FROM wl_approval
          WHERE event_id = e.id AND action = 'REJECT'
          ORDER BY acted_at DESC LIMIT 1) AS reject_comment
       FROM wl_event e
       LEFT JOIN wl_worker ww ON ww.event_id = e.id
       WHERE e.approval_status = 'REJECTED' AND e.created_by = ?
       GROUP BY e.id
       ORDER BY e.updated_at DESC`,
      [userIdx]
    );
    return rows;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// [추가] 전체 이벤트 조회 (wl_read 페이지용 — 승인 완료 건 + 필터)
// ─────────────────────────────────────────────────────────────────────────────

exports.listEvents = async (filters = {}) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const cond = [];
    const vals = [];

    // 기본: APPROVED 만 (옵션으로 전체 가능)
    if (filters.status) {
      cond.push('e.approval_status = ?'); vals.push(filters.status);
    } else {
      cond.push(`e.approval_status = 'APPROVED'`);
    }

    if (filters.group) { cond.push('e.`group` = ?'); vals.push(filters.group); }
    if (filters.site)  { cond.push('e.site = ?');     vals.push(filters.site); }
    if (filters.equipment_name) {
      cond.push('e.equipment_name LIKE ?'); vals.push(`%${filters.equipment_name}%`);
    }
    if (filters.work_type)  { cond.push('e.work_type = ?');  vals.push(filters.work_type); }
    if (filters.date_from)  { cond.push('e.task_date >= ?'); vals.push(filters.date_from); }
    if (filters.date_to)    { cond.push('e.task_date <= ?'); vals.push(filters.date_to); }
    if (filters.task_name)  {
      cond.push('e.task_name LIKE ?'); vals.push(`%${filters.task_name}%`);
    }
    if (filters.worker_name) {
      cond.push(`EXISTS (
        SELECT 1 FROM wl_worker ww
        WHERE ww.event_id = e.id AND ww.engineer_name LIKE ?
      )`);
      vals.push(`%${filters.worker_name}%`);
    }

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const limit  = Math.min(Number(filters.limit) || 200, 1000);
    const offset = Number(filters.offset) || 0;

    const sql = `
      SELECT e.*,
        DATE_FORMAT(e.task_date, '%Y-%m-%d') AS task_date,
        GROUP_CONCAT(DISTINCT ww.engineer_name ORDER BY ww.id SEPARATOR ', ') AS workers_str
      FROM wl_event e
      LEFT JOIN wl_worker ww ON ww.event_id = e.id
      ${where}
      GROUP BY e.id
      ORDER BY e.task_date DESC, e.id DESC
      LIMIT ? OFFSET ?
    `;
    vals.push(limit, offset);

    const [rows] = await conn.query(sql, vals);

    // 건수 조회
    const countSql = `
      SELECT COUNT(DISTINCT e.id) AS total
      FROM wl_event e
      LEFT JOIN wl_worker ww ON ww.event_id = e.id
      ${where}
    `;
    const countVals = vals.slice(0, vals.length - 2); // limit, offset 제외
    const [[countRow]] = await conn.query(countSql, countVals);

    return { rows, total: countRow?.total || 0 };
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// [추가] 승인된 이벤트 수정 (APPROVED 상태에서 수정 + 이력 기록)
// ─────────────────────────────────────────────────────────────────────────────

exports.updateApprovedEvent = async (id, patch, workers, actorId, actorName) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    // 이벤트 필드 패치
    if (patch && Object.keys(patch).length) {
      const sets = [], vals = [];
      for (const k of Object.keys(patch)) {
        if (!ALLOWED_PATCH_FIELDS.includes(k)) continue;
        sets.push(`\`${k}\` = ?`); vals.push(patch[k]);
      }
      if (sets.length) {
        vals.push(id);
        await conn.query(`UPDATE wl_event SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
    }

    // workers 재생성
    if (Array.isArray(workers) && workers.length) {
      await conn.query(`DELETE FROM wl_worker WHERE event_id = ?`, [id]);

      for (const w of workers) {
        const [uRows] = await conn.query(
          `SELECT ID, \`LEVEL\` FROM userDB WHERE NAME = ? LIMIT 1`,
          [w.name.trim()]
        );
        const userdbId = uRows[0]?.ID   || null;
        const engLevel = uRows[0]?.LEVEL ?? null;

        const wNone = Number(w.none_time) || 0;
        const wMove = Number(w.move_time) || 0;
        const duration = calcDuration(
          w.start_time || null,
          w.end_time   || null,
          wNone,
          wMove
        );

        await conn.query(
          `INSERT INTO wl_worker
             (event_id, engineer_name, userdb_id, role, eng_level,
              task_duration, start_time, end_time, none_time, move_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, w.name.trim(), userdbId,
            w.role || 'main', engLevel,
            duration,
            w.start_time || null,
            w.end_time   || null,
            wNone,
            wMove,
          ]
        );
      }
    }

    // 수정 이력 기록
    const [[prev]] = await conn.query(
      `SELECT IFNULL(MAX(seq), 0) AS maxSeq FROM wl_approval WHERE event_id = ?`, [id]
    );
    await conn.query(
      `INSERT INTO wl_approval (event_id, seq, action, actor_id, actor_name, comment)
       VALUES (?, ?, 'REVISE', ?, ?, ?)`,
      [id, (prev.maxSeq || 0) + 1, actorId, actorName, '승인 후 수정']
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// [추가] 엑셀용 데이터 조회 (작업자 단위 flat)
// ─────────────────────────────────────────────────────────────────────────────

exports.listEventsForExcel = async (filters = {}) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const cond = [];
    const vals = [];

    if (filters.status) {
      cond.push('e.approval_status = ?'); vals.push(filters.status);
    } else {
      cond.push(`e.approval_status = 'APPROVED'`);
    }
    if (filters.group) { cond.push('e.`group` = ?'); vals.push(filters.group); }
    if (filters.site)  { cond.push('e.site = ?');     vals.push(filters.site); }
    if (filters.date_from) { cond.push('e.task_date >= ?'); vals.push(filters.date_from); }
    if (filters.date_to)   { cond.push('e.task_date <= ?'); vals.push(filters.date_to); }
    if (filters.equipment_name) {
      cond.push('e.equipment_name LIKE ?'); vals.push(`%${filters.equipment_name}%`);
    }
    if (filters.work_type) { cond.push('e.work_type = ?'); vals.push(filters.work_type); }
    if (filters.worker_name) {
      cond.push('w.engineer_name LIKE ?'); vals.push(`%${filters.worker_name}%`);
    }

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const sql = `
      SELECT
        e.work_code,
        e.task_name,
        DATE_FORMAT(e.task_date, '%Y-%m-%d') AS task_date,
        e.country,
        e.\`group\`,
        e.site,
        e.\`line\`,
        e.equipment_type,
        e.equipment_name,
        e.warranty,
        CASE WHEN e.ems = 1 THEN '유상' ELSE '무상' END AS ems_text,
        e.work_type,
        e.work_type2,
        e.setup_item,
        e.status,
        e.task_description,
        e.task_cause,
        e.task_result,
        e.SOP,
        e.tsguide,
        CASE WHEN e.is_rework = 1 THEN 'Y' ELSE 'N' END AS is_rework,
        e.rework_seq,
        (SELECT GROUP_CONCAT(IFNULL(m.item_name, wi.item_name_free) ORDER BY wi.id SEPARATOR ', ')
         FROM wl_work_item wi LEFT JOIN wl_work_item_master m ON m.id = wi.master_id
         WHERE wi.event_id = e.id) AS work_items_str,
        (SELECT GROUP_CONCAT(CONCAT(IFNULL(pm.part_name, p.part_name_free), ' x', p.qty) ORDER BY p.id SEPARATOR ', ')
         FROM wl_part p LEFT JOIN wl_part_master pm ON pm.id = p.master_id
         WHERE p.event_id = e.id) AS parts_str,
        w.engineer_name,
        w.role,
        w.eng_level,
        w.start_time AS w_start_time,
        w.end_time   AS w_end_time,
        w.none_time  AS w_none_time,
        w.move_time  AS w_move_time,
        w.task_duration,
        e.approval_status
      FROM wl_event e
      JOIN wl_worker w ON w.event_id = e.id
      ${where}
      ORDER BY e.task_date DESC, e.id DESC, w.id ASC
    `;

    const [rows] = await conn.query(sql, vals);
    return rows;
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 삭제 (CASCADE로 worker, work_item, part, approval 같이 삭제됨)
// ─────────────────────────────────────────────────────────────────────────────

exports.deleteEvent = async (id) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.query(`DELETE FROM wl_event WHERE id = ?`, [id]);
  } finally { conn.release(); }
};


// ─────────────────────────────────────────────────────────────────────────────
// 결재자 조회
// ─────────────────────────────────────────────────────────────────────────────

exports.getApproversByGroupSite = async (group, site) => {
  return exports.getUsersByNicknames;
};
