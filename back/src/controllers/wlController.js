/**
 * wlController.js
 * 새 스키마(wl_event 등)용 컨트롤러
 * [추가] listEvents, updateEvent, exportExcel
 * [수정] resubmit — workers 포함 재제출 지원
 */
'use strict';

const wlDao = require('../dao/wl_dao');

const wlDao = require('../dao/wl_dao');

function normalizeDateOnly(v) {
  if (!v) return null;

  const s = String(v).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    return s.slice(0, 10);
  }

  return s.slice(0, 10);
}

// ─── 결재자 매핑 ────────────────────────────────────────────────────────────
const APPROVER_MAP = {
  'PEE1:PT': ['조지훈', '전대영', '손석현'],
  'PEE1:HS': ['진덕장', '한정훈', '정대환'],
  'PEE1:IC': ['강문호', '배한훈', '최원준'],
  'PEE1:CJ': ['강문호', '배한훈', '최원준'],
  'PEE2:PT': ['이지웅', '송왕근', '정현우'],
  'PEE2:HS': ['안재영', '김건희'],
  'PSKH:*':  ['유정현', '문순현'],
};
const approverKey = (g, s) => g === 'PSKH' ? 'PSKH:*' : `${g}:${s}`;
const getApproverNicknames = (g, s) => APPROVER_MAP[approverKey(g, s)] || [];
const isApprover = (user, g, s) => {
  if (user?.role === 'admin' || user?.role === 'editor') return true;
  return getApproverNicknames(g, s).includes(user?.nickname);
};


// ─── 결재자 목록 ─────────────────────────────────────────────────────────────
exports.getApprovers = async (req, res) => {
  const { group: g = '', site: s = '' } = req.query;
  if (!g) return res.status(400).json({ error: 'group is required' });

  const names = getApproverNicknames(g, s);
  if (!names.length) return res.json({ approvers: [] });

  try {
    const users = await wlDao.getUsersByNicknames(names);
    const order = new Map(names.map((n, i) => [n, i]));
    users.sort((a, b) => (order.get(a.nickname) ?? 999) - (order.get(b.nickname) ?? 999));
    res.json({ approvers: users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'approver fetch failed' });
  }
};


// ─── 마스터 데이터 ───────────────────────────────────────────────────────────
exports.getWorkItemMaster = async (req, res) => {
  const { equipment_type } = req.query;
  if (!equipment_type) return res.status(400).json({ error: 'equipment_type required' });
  try {
    const items = await wlDao.getWorkItemsByEqType(equipment_type);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'work item fetch failed' });
  }
};

exports.getPartMaster = async (req, res) => {
  const { equipment_type } = req.query;
  if (!equipment_type) return res.status(400).json({ error: 'equipment_type required' });
  try {
    const parts = await wlDao.getPartsByEqType(equipment_type);
    res.json({ parts });
  } catch (e) {
    res.status(500).json({ error: 'part fetch failed' });
  }
};


// ─── 제출 (PENDING 등록) ─────────────────────────────────────────────────────
exports.submit = async (req, res) => {
  try {
    const body = req.body || {};
    const createdBy     = req.user?.userIdx   || null;
    const submitterName = req.user?.nickname  || body.submitter_name || 'unknown';

    const required = ['task_name', 'task_date', 'equipment_type', 'equipment_name',
                      'work_type', 'site', 'group'];

    body.task_date = normalizeDateOnly(body.task_date);
    
    for (const f of required) {
      if (!body[f] || body[f] === 'SELECT') {
        return res.status(400).json({ error: `${f} is required` });
      }
    }

    const workers = Array.isArray(body.workers) ? body.workers : [];
    if (!workers.length) {
      return res.status(400).json({ error: '작업자(workers)를 최소 1명 이상 입력하세요.' });
    }

    const payload = {
      task_name:        body.task_name,
      task_date:        normalizeDateOnly(body.task_date),
      country:          body.country || 'KR',
      group:            body.group,
      site:             body.site,
      line:             body.line,
      equipment_type:   body.equipment_type,
      equipment_name:   body.equipment_name,
      warranty:         body.warranty,
      ems:              body.ems === 1 || body.ems === '1' ? 1 : 0,
      work_type:        body.work_type,
      work_type2:       body.work_type2 || null,
      setup_item:       body.setup_item || null,
      status:           body.status || '',
      task_description: body.task_description || '',
      task_cause:       body.task_cause || '',
      task_result:      body.task_result || '',
      SOP:              body.SOP || 'Not Utilized (No Need)',
      tsguide:          body.tsguide || 'Not Utilized (No Need)',
      start_time:       body.start_time || null,
      end_time:         body.end_time || null,
      none_time:        Number(body.none_time) || 0,
      move_time:        Number(body.move_time) || 0,
      is_rework:        body.is_rework ? 1 : 0,
      rework_reason:    body.rework_reason || null,
      rework_detail:    body.rework_detail || null,
      rework_seq:       Number(body.rework_seq) || 0,
      rework_ref_id:    body.rework_ref_id || null,
      created_by:       createdBy,
      submitter_name:   submitterName,
      workers,
      workItems: Array.isArray(body.workItems) ? body.workItems : [],
      parts:     Array.isArray(body.parts)     ? body.parts     : [],
    };

    const { eventId, workCode } = await wlDao.submitEvent(payload);
    res.status(201).json({ message: '결재 대기 등록 완료', event_id: eventId, work_code: workCode });
  } catch (err) {
    console.error('wl submit error:', err);
    res.status(500).json({ error: '결재 대기 등록 중 오류' });
  }
};


// ─── REWORK 의심 이력 조회 ───────────────────────────────────────────────────
// GET /wl/rework-candidates?task_name=&task_cause=&task_date=&days=14&limit=8
exports.getReworkCandidates = async (req, res) => {
  try {
    const taskName = String(req.query.task_name || '').trim();
    const taskCause = String(req.query.task_cause || '').trim();
    const taskDate = String(req.query.task_date || '').trim();
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);

    if (!taskName || !taskCause || !taskDate) return res.json({ rows: [], total: 0 });

    const result = await wlDao.findReworkCandidates({
      task_name: taskName,
      task_cause: taskCause,
      task_date: taskDate,
      days,
      limit,
    });
    res.json(result);
  } catch (e) {
    console.error('getReworkCandidates error:', e);
    res.status(500).json({ error: 'REWORK 의심 이력 조회 오류' });
  }
};


// ─── 대기 목록 ───────────────────────────────────────────────────────────────
exports.listPending = async (req, res) => {
  try {
    const g    = req.query.group || '';
    const s    = req.query.site  || '';
    const mine = ['1', 'true'].includes(String(req.query.mine || '').toLowerCase());
    const me   = mine ? (req.user?.nickname || null) : null;
    const rows = await wlDao.listPendingEvents(g, s, me);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '대기 목록 조회 오류' });
  }
};


// ─── 단건 조회 ────────────────────────────────────────────────────────────────
exports.getOne = async (req, res) => {
  try {
    const row = await wlDao.getEventById(req.params.id);
    if (!row) return res.status(404).json({ error: '없음' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: '조회 오류' });
  }
};


// ─── PATCH (결재자/제출자 수정 — 단순) ────────────────────────────────────────
exports.patchOne = async (req, res) => {
  try {
    const id  = req.params.id;
    const row = await wlDao.getEventById(id);
    if (!row) return res.status(404).json({ error: '없음' });

    const canApprove  = isApprover(req.user, row.group, row.site);
    const isSubmitter = req.user?.userIdx === row.created_by;

    if (row.approval_status === 'PENDING' && !canApprove) {
      return res.status(403).json({ error: '대기 상태 수정은 결재자만 가능합니다.' });
    }
    if (row.approval_status === 'REJECTED' && !isSubmitter && req.user?.role !== 'admin') {
      return res.status(403).json({ error: '반려건 수정은 제출자만 가능합니다.' });
    }

    await wlDao.patchEvent(id, req.body || {});
    res.json({ message: '수정 완료' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '수정 오류' });
  }
};


// ─── 내 반려 목록 ─────────────────────────────────────────────────────────────
exports.listMyRejected = async (req, res) => {
  try {
    const userIdx = req.user?.userIdx;
    if (!userIdx) return res.status(401).json({ error: '인증 필요' });
    const rows = await wlDao.listMyRejected(userIdx);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '조회 오류' });
  }
};


// ─── 재제출 (workers 포함) ────────────────────────────────────────────────────
exports.resubmit = async (req, res) => {
  try {
    const id  = req.params.id;
    const row = await wlDao.getEventById(id);
    if (!row) return res.status(404).json({ error: '없음' });

    if (row.approval_status !== 'REJECTED') {
      return res.status(400).json({ error: '반려 상태만 재제출 가능합니다.' });
    }
    if (row.created_by !== req.user?.userIdx && req.user?.role !== 'admin') {
      return res.status(403).json({ error: '본인 반려건만 재제출 가능합니다.' });
    }

    await wlDao.resubmitEvent(
      id,
      req.user?.userIdx,
      req.user?.nickname,
      req.body?.patch || {},
      req.body?.workers || null
    );
    res.json({ message: '재제출 완료' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '재제출 오류' });
  }
};


// ─── 승인 ─────────────────────────────────────────────────────────────────────
exports.approve = async (req, res) => {
  try {
    const id  = req.params.id;
    const row = await wlDao.getEventById(id);
    if (!row) return res.status(404).json({ error: '없음' });

    if (!isApprover(req.user, row.group, row.site)) {
      return res.status(403).json({ error: '해당 그룹/사이트의 결재 권한이 없습니다.' });
    }

    const { note = '', patch = {} } = req.body || {};
    const eventId = await wlDao.approveEvent(
      id,
      req.user?.userIdx,
      req.user?.nickname,
      note,
      patch
    );
    res.json({ message: '승인 완료', event_id: eventId });
  } catch (err) {
    console.error('approve error:', err);
    res.status(500).json({ error: '승인 처리 오류' });
  }
};


// ─── 반려 ─────────────────────────────────────────────────────────────────────
exports.reject = async (req, res) => {
  try {
    const id  = req.params.id;
    const row = await wlDao.getEventById(id);
    if (!row) return res.status(404).json({ error: '없음' });

    if (!isApprover(req.user, row.group, row.site)) {
      return res.status(403).json({ error: '해당 그룹/사이트의 결재 권한이 없습니다.' });
    }

    const { note = '' } = req.body || {};
    await wlDao.rejectEvent(id, req.user?.userIdx, req.user?.nickname, note);
    res.json({ message: '반려 처리 완료' });
  } catch (err) {
    res.status(500).json({ error: '반려 처리 오류' });
  }
};


// ─── [추가] 삭제 ──────────────────────────────────────────────────────────────
// DELETE /wl/event/:id
exports.deleteEvent = async (req, res) => {
  try {
    const id  = req.params.id;
    const row = await wlDao.getEventById(id);
    if (!row) return res.status(404).json({ error: '없음' });

    // 삭제 권한: 본인이 작성한 반려건, 또는 본인 이름이 포함된 승인건(+admin)
    const isAdmin = req.user?.role === 'admin';
    const isCreator = req.user?.userIdx === row.created_by;
    const isWorker = (row.workers || []).some(w => w.engineer_name === req.user?.nickname);

    if (!isAdmin && !isCreator && !isWorker) {
      return res.status(403).json({ error: '삭제 권한이 없습니다.' });
    }

    await wlDao.deleteEvent(id);
    res.json({ message: '삭제 완료' });
  } catch (e) {
    console.error('deleteEvent error:', e);
    res.status(500).json({ error: '삭제 오류' });
  }
};


// ─── [추가] 전체 이벤트 조회 (wl_read 페이지용) ──────────────────────────────
// GET /wl/events?group=&site=&date_from=&date_to=&status=APPROVED&limit=200&offset=0
exports.listEvents = async (req, res) => {
  try {
    const filters = {
      group:          req.query.group          || '',
      site:           req.query.site           || '',
      equipment_name: req.query.equipment_name || '',
      work_type:      req.query.work_type      || '',
      date_from:      req.query.date_from      || '',
      date_to:        req.query.date_to        || '',
      task_name:      req.query.task_name      || '',
      worker_name:    req.query.worker_name    || '',
      status:         req.query.status         || 'APPROVED',
      limit:          req.query.limit           || 200,
      offset:         req.query.offset          || 0,
    };
    const result = await wlDao.listEvents(filters);
    res.json(result);
  } catch (e) {
    console.error('listEvents error:', e);
    res.status(500).json({ error: '조회 오류' });
  }
};


// ─── [추가] 승인된 이벤트 수정 ────────────────────────────────────────────────
// PUT /wl/event/:id
exports.updateEvent = async (req, res) => {
  try {
    const id  = req.params.id;
    const row = await wlDao.getEventById(id);
    if (!row) return res.status(404).json({ error: '없음' });

    // 수정 권한: 결재자 또는 admin
    const canApprove = isApprover(req.user, row.group, row.site);
    if (!canApprove && req.user?.role !== 'admin') {
      return res.status(403).json({ error: '수정 권한이 없습니다. 결재자 또는 관리자만 수정할 수 있습니다.' });
    }

    const { patch = {}, workers = null } = req.body || {};

    await wlDao.updateApprovedEvent(
      id,
      patch,
      workers,
      req.user?.userIdx,
      req.user?.nickname
    );
    res.json({ message: '수정 완료' });
  } catch (e) {
    console.error('updateEvent error:', e);
    res.status(500).json({ error: '수정 오류' });
  }
};


// ─── [추가] 엑셀 데이터 조회 ──────────────────────────────────────────────────
// GET /wl/export/excel?group=&site=&date_from=&date_to=
exports.exportExcel = async (req, res) => {
  try {
    const filters = {
      group:          req.query.group          || '',
      site:           req.query.site           || '',
      equipment_name: req.query.equipment_name || '',
      work_type:      req.query.work_type      || '',
      date_from:      req.query.date_from      || '',
      date_to:        req.query.date_to        || '',
      worker_name:    req.query.worker_name    || '',
      status:         req.query.status         || 'APPROVED',
    };
    const rows = await wlDao.listEventsForExcel(filters);
    res.json(rows);
  } catch (e) {
    console.error('exportExcel error:', e);
    res.status(500).json({ error: '엑셀 데이터 조회 오류' });
  }
};
