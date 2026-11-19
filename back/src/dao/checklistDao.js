'use strict';

const { pool } = require('../../config/database');
const catalog = require('../config/checklistCatalog');

function sanitizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

function sanitizeKind(v) {
  return String(v || '').trim().toUpperCase();
}

function calcSectionSummary(section, answersMap) {
  const total = section.questions.length;
  const checked = section.questions.filter((q) => !!answersMap.get(q.id)).length;
  const completionRate = total > 0 ? Math.round((checked / total) * 1000) / 10 : 0;
  return { total_questions: total, checked_questions: checked, completion_rate: completionRate };
}

async function getUserById(conn, userIdx) {
  const [rows] = await conn.query(
    `SELECT userIdx, nickname, userID, role, status, \`group\`, site
       FROM Users
      WHERE userIdx = ? AND status = 'A'
      LIMIT 1`,
    [userIdx]
  );
  return rows[0] || null;
}

async function resolveEngineer(conn, userIdx) {
  const user = await getUserById(conn, userIdx);
  if (!user) return null;

  const [mappedRows] = await conn.query(
    `SELECT e.*
       FROM user_engineer_map m
       JOIN engineer e ON e.id = m.engineer_id
      WHERE m.user_idx = ?
        AND m.is_active = 1
      ORDER BY m.is_primary DESC, m.id ASC
      LIMIT 1`,
    [userIdx]
  );
  if (mappedRows[0]) {
    return { ...mappedRows[0], resolved_by: 'user_engineer_map', user };
  }

  const [engineerRows] = await conn.query(
    `SELECT e.*
       FROM engineer e
      WHERE e.name = ?
      ORDER BY (e.\`group\` = ?) DESC, (e.site = ?) DESC, e.id ASC
      LIMIT 1`,
    [user.nickname, user.group || '', user.site || '']
  );
  if (engineerRows[0]) {
    return { ...engineerRows[0], resolved_by: 'nickname_fallback', user };
  }

  return { user, resolved_by: 'user_only' };
}

// Checklist access follows the engineer's registered equipment, never the group.
function equipmentKey(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function checklistEquipmentCode(eq) {
  const aliases = {
    SUPRAN: 'SUPRA_N', SUPRANM: 'SUPRA_N', TERA: 'SUPRA_N',
    SUPRAXP: 'SUPRA_XP',
    INTEGER: 'INTEGER', INTEGERPLUS: 'INTEGER', INTEGERIVR: 'INTEGER',
    PRECIA: 'PRECIA', ECOLITE: 'ECOLITE', ECOLITE300: 'ECOLITE',
    GENEVA: 'GENEVA', HDW: 'HDW',
  };
  return aliases[equipmentKey(eq.eq_code)] || aliases[equipmentKey(eq.eq_name)] || null;
}

async function getAccessMap(conn, engineerId) {
  const [equipmentRows] = await conn.query(
    `SELECT code, display_name, sort_order, is_active
       FROM checklist_equipment_group
      WHERE is_active = 1
      ORDER BY sort_order, code`
  );

  const registeredCodes = new Set();
  if (engineerId) {
    const [registeredRows] = await conn.query(
      `SELECT em.eq_code, em.eq_name,
              CASE WHEN em.id = e.main_eq_id THEN 0 ELSE 1 END AS equipment_order
         FROM engineer e
         JOIN eq_master em ON em.id = e.main_eq_id OR em.id = e.multi_eq_id
        WHERE e.id = ?
        ORDER BY equipment_order, em.id`,
      [engineerId]
    );
    for (const row of registeredRows) {
      const code = checklistEquipmentCode(row);
      if (code) registeredCodes.add(code);
    }
  }

  const equipmentOrder = new Map([...registeredCodes].map((code, index) => [code, index]));
  return equipmentRows.map((row) => ({
    code: row.code,
    display_name: row.display_name,
    sort_order: row.sort_order,
    allowed: registeredCodes.has(row.code),
    access_source: 'REGISTERED_EQUIPMENT',
  })).sort((a, b) =>
    (equipmentOrder.get(a.code) ?? 99) - (equipmentOrder.get(b.code) ?? 99)
    || a.sort_order - b.sort_order
  );
}

async function findActiveTemplate(conn, equipmentGroupCode, checklistKind) {
  const [rows] = await conn.query(
    `SELECT id, equipment_group_code, checklist_kind, template_name, version_no, is_active, created_at, updated_at
       FROM checklist_template
      WHERE equipment_group_code = ?
        AND checklist_kind = ?
        AND is_active = 1
      ORDER BY version_no DESC, id DESC
      LIMIT 1`,
    [sanitizeCode(equipmentGroupCode), sanitizeKind(checklistKind)]
  );
  return rows[0] || null;
}

async function loadTemplateStructure(conn, templateId) {
  const [sectionRows] = await conn.query(
    `SELECT id, section_code, section_name, sort_order
       FROM checklist_section
      WHERE template_id = ? AND is_active = 1
      ORDER BY sort_order, id`,
    [templateId]
  );

  const [questionRows] = await conn.query(
    `SELECT id, section_id, question_code, question_text, sort_order
       FROM checklist_question
      WHERE template_id = ? AND is_active = 1
      ORDER BY section_id IS NULL, section_id, sort_order, id`,
    [templateId]
  );

  const questionsBySection = new Map();
  for (const row of questionRows) {
    const key = row.section_id || '__NO_SECTION__';
    if (!questionsBySection.has(key)) questionsBySection.set(key, []);
    questionsBySection.get(key).push({
      id: row.id,
      question_code: row.question_code,
      question_text: row.question_text,
      sort_order: row.sort_order,
    });
  }

  const sections = sectionRows.map((section) => ({
    id: section.id,
    section_code: section.section_code,
    section_name: section.section_name,
    sort_order: section.sort_order,
    questions: questionsBySection.get(section.id) || [],
  }));

  const noSectionQuestions = questionsBySection.get('__NO_SECTION__') || [];
  if (noSectionQuestions.length) {
    sections.push({
      id: null,
      section_code: 'GENERAL',
      section_name: 'GENERAL',
      sort_order: 999,
      questions: noSectionQuestions,
    });
  }

  return sections;
}

async function ensureTemplateAccess(conn, userIdx, equipmentGroupCode) {
  const engineer = await resolveEngineer(conn, userIdx);
  if (!engineer?.id && !engineer?.user) {
    const err = new Error('사용자 정보를 찾을 수 없습니다.');
    err.statusCode = 401;
    throw err;
  }

  const accessRows = await getAccessMap(conn, engineer.id || null);
  const access = accessRows.find((row) => row.code === sanitizeCode(equipmentGroupCode));
  if (!access?.allowed) {
    const err = new Error('해당 설비 체크리스트 접근 권한이 없습니다.');
    err.statusCode = 403;
    throw err;
  }

  return { engineer, accessRows };
}

async function ensureAdmin(conn, userIdx) {
  const user = await getUserById(conn, userIdx);
  if (!user) {
    const err = new Error('사용자 정보를 찾을 수 없습니다.');
    err.statusCode = 401;
    throw err;
  }
  if (user.role !== 'admin') {
    const err = new Error('관리자만 사용할 수 있습니다.');
    err.statusCode = 403;
    throw err;
  }
  return user;
}

async function getOrCreateResponse(conn, engineerId, templateId, userIdx) {
  const [rows] = await conn.query(
    `SELECT *
       FROM checklist_response
      WHERE engineer_id = ? AND template_id = ?
      LIMIT 1`,
    [engineerId, templateId]
  );
  if (rows[0]) return rows[0];

  const [result] = await conn.query(
    `INSERT INTO checklist_response (
       engineer_id, template_id, response_status, created_by, updated_by
     ) VALUES (?, ?, 'ACTIVE', ?, ?)`,
    [engineerId, templateId, userIdx || null, userIdx || null]
  );

  const [createdRows] = await conn.query(
    `SELECT * FROM checklist_response WHERE id = ?`,
    [result.insertId]
  );
  return createdRows[0];
}

function buildPermission({ role, responseStatus }) {
  const status = String(responseStatus || 'ACTIVE').toUpperCase();
  const isAdmin = role === 'admin';
  const canEdit = isAdmin || ['ACTIVE', 'REJECTED', ''].includes(status);
  const canSubmit = isAdmin || ['ACTIVE', 'REJECTED', ''].includes(status);
  const canApprove = isAdmin && status === 'SUBMITTED';
  return { can_edit: canEdit, can_submit: canSubmit, can_approve: canApprove };
}

function decorateChecklistPayload({ engineer, template, response, sections }) {
  const answersMap = new Map((response?.answers || []).map((row) => [row.question_id, !!row.is_checked]));
  const answersDetailMap = new Map((response?.answers || []).map((row) => [row.question_id, row]));

  const sectionsWithAnswers = sections.map((section) => {
    const summary = calcSectionSummary(section, answersMap);
    return {
      ...section,
      summary,
      questions: section.questions.map((q) => ({
        ...q,
        is_checked: !!answersMap.get(q.id),
        checked_at: answersDetailMap.get(q.id)?.checked_at || null,
        note: answersDetailMap.get(q.id)?.note || null,
      })),
    };
  });

  const totalQuestions = sectionsWithAnswers.reduce((acc, section) => acc + section.questions.length, 0);
  const totalChecked = sectionsWithAnswers.reduce((acc, section) => acc + section.summary.checked_questions, 0);
  const overallCompletionRate = totalQuestions > 0
    ? Math.round((totalChecked / totalQuestions) * 1000) / 10
    : 0;

  return {
    engineer,
    template,
    response: response ? { ...response, answers: undefined } : null,
    sections: sectionsWithAnswers,
    summary: {
      total_questions: totalQuestions,
      checked_questions: totalChecked,
      completion_rate: overallCompletionRate,
    },
  };
}

async function loadResponseAnswers(conn, responseId) {
  const [rows] = await conn.query(
    `SELECT question_id, is_checked, checked_at, note
       FROM checklist_response_answer
      WHERE response_id = ?`,
    [responseId]
  );
  return rows;
}

async function loadResponseBundleByResponseId(conn, responseId) {
  const [rows] = await conn.query(
    `SELECT
        r.*,
        e.id AS engineer_id,
        e.legacy_id,
        e.name AS engineer_name,
        e.company,
        e.\`group\` AS engineer_group,
        e.site AS engineer_site,
        e.role AS engineer_role,
        t.id AS template_id,
        t.equipment_group_code,
        t.checklist_kind,
        t.template_name,
        t.version_no,
        eg.display_name AS equipment_group_name,
        uc.nickname AS created_by_name,
        uu.nickname AS updated_by_name,
        ua.nickname AS approved_by_name,
        ur.nickname AS rejected_by_name
      FROM checklist_response r
      JOIN engineer e ON e.id = r.engineer_id
      JOIN checklist_template t ON t.id = r.template_id
      JOIN checklist_equipment_group eg ON eg.code = t.equipment_group_code
      LEFT JOIN Users uc ON uc.userIdx = r.created_by
      LEFT JOIN Users uu ON uu.userIdx = r.updated_by
      LEFT JOIN Users ua ON ua.userIdx = r.approved_by
      LEFT JOIN Users ur ON ur.userIdx = r.rejected_by
      WHERE r.id = ?
      LIMIT 1`,
    [responseId]
  );
  return rows[0] || null;
}

function getQuestionCompareKey(question) {
  const code = String(question?.question_code || '').trim();
  if (code) return code;
  const id = question?.id || question?.question_id || '';
  return `ID:${id}`;
}

function flattenQuestionsForCompare(sections) {
  const rows = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const question of Array.isArray(section?.questions) ? section.questions : []) {
      rows.push({
        question_key: getQuestionCompareKey(question),
        question_code: question.question_code || null,
        question_text: question.question_text || '',
        section_name: section.section_name || section.section_code || 'GENERAL',
        is_checked: !!question.is_checked,
      });
    }
  }
  return rows;
}

function buildLatestApprovedComparison(currentPayload, previousPayload) {
  if (!previousPayload) return null;

  const currentRows = flattenQuestionsForCompare(currentPayload?.sections || []);
  const previousRows = flattenQuestionsForCompare(previousPayload?.sections || []);
  const currentMap = new Map(currentRows.map((row) => [row.question_key, row]));
  const previousMap = new Map(previousRows.map((row) => [row.question_key, row]));
  const allKeys = new Set([...currentMap.keys(), ...previousMap.keys()]);

  const changes = [];
  for (const key of allKeys) {
    const current = currentMap.get(key) || null;
    const previous = previousMap.get(key) || null;

    if (current && previous) {
      if (!!current.is_checked !== !!previous.is_checked) {
        const type = current.is_checked ? 'checked' : 'unchecked';
        changes.push({
          type,
          label: current.is_checked ? '새 체크' : '해제',
          question_key: key,
          question_code: current.question_code || previous.question_code || null,
          question_text: current.question_text || previous.question_text || '',
          message: `${current.question_text || previous.question_text || ''} · ${previous.is_checked ? '완료' : '미완료'} → ${current.is_checked ? '완료' : '미완료'}`,
          current_checked: !!current.is_checked,
          previous_checked: !!previous.is_checked,
        });
      }
      continue;
    }

    if (current && !previous && current.is_checked) {
      changes.push({
        type: 'added',
        label: '신규 문항',
        question_key: key,
        question_code: current.question_code || null,
        question_text: current.question_text || '',
        message: `${current.question_text || ''} · 이전 승인본에는 없던 문항입니다.`,
        current_checked: true,
        previous_checked: false,
      });
    }

    if (!current && previous && previous.is_checked) {
      changes.push({
        type: 'removed',
        label: '제외 문항',
        question_key: key,
        question_code: previous.question_code || null,
        question_text: previous.question_text || '',
        message: `${previous.question_text || ''} · 이전 승인본에는 있었지만 현재 체크리스트에는 없습니다.`,
        current_checked: false,
        previous_checked: true,
      });
    }
  }

  const sortOrder = { checked: 1, unchecked: 2, added: 3, removed: 4 };
  changes.sort((a, b) => {
    const typeDiff = (sortOrder[a.type] || 99) - (sortOrder[b.type] || 99);
    if (typeDiff !== 0) return typeDiff;
    return String(a.question_code || a.question_key || '').localeCompare(String(b.question_code || b.question_key || ''), 'ko');
  });

  return {
    basis: 'LATEST_APPROVED',
    previous_response: {
      id: previousPayload?.response?.id || null,
      response_status: previousPayload?.response?.response_status || null,
      approved_at: previousPayload?.response?.approved_at || null,
      updated_at: previousPayload?.response?.updated_at || null,
      template_name: previousPayload?.template?.template_name || null,
      version_no: previousPayload?.template?.version_no || null,
    },
    summary: {
      changed_count: changes.length,
      current_checked_count: currentPayload?.summary?.checked_questions || 0,
      previous_checked_count: previousPayload?.summary?.checked_questions || 0,
    },
    changes,
  };
}

async function loadLatestApprovedPayload(conn, currentRow, adminUser) {
  const [prevRows] = await conn.query(
    `SELECT r.id
       FROM checklist_response r
       JOIN checklist_template t ON t.id = r.template_id
      WHERE r.engineer_id = ?
        AND r.response_status = 'APPROVED'
        AND t.equipment_group_code = ?
        AND t.checklist_kind = ?
        AND r.id <> ?
      ORDER BY COALESCE(r.approved_at, r.updated_at, r.submitted_at) DESC, r.id DESC
      LIMIT 1`,
    [currentRow.engineer_id, currentRow.equipment_group_code, currentRow.checklist_kind, currentRow.id]
  );

  const prevId = prevRows[0]?.id;
  if (!prevId) return null;

  const prevRow = await loadResponseBundleByResponseId(conn, prevId);
  if (!prevRow) return null;

  const prevSections = await loadTemplateStructure(conn, prevRow.template_id);
  const prevAnswers = await loadResponseAnswers(conn, prevRow.id);

  return decorateChecklistPayload({
    engineer: {
      id: prevRow.engineer_id,
      legacy_id: prevRow.legacy_id,
      name: prevRow.engineer_name,
      company: prevRow.company,
      group: prevRow.engineer_group,
      site: prevRow.engineer_site,
      role: prevRow.engineer_role,
      user: adminUser,
    },
    template: {
      id: prevRow.template_id,
      equipment_group_code: prevRow.equipment_group_code,
      equipment_group_name: prevRow.equipment_group_name,
      checklist_kind: prevRow.checklist_kind,
      template_name: prevRow.template_name,
      version_no: prevRow.version_no,
    },
    response: {
      id: prevRow.id,
      response_status: prevRow.response_status,
      submitted_at: prevRow.submitted_at,
      approved_at: prevRow.approved_at,
      rejected_at: prevRow.rejected_at,
      updated_at: prevRow.updated_at,
      decision_comment: prevRow.decision_comment,
      answers: prevAnswers,
    },
    sections: prevSections,
  });
}

exports.getCurrentUserProfile = async (userIdx) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const engineer = await resolveEngineer(conn, userIdx);
    if (!engineer?.user) return null;

    const access = await getAccessMap(conn, engineer.id || null);
    return {
      user: engineer.user,
      engineer: engineer.id ? {
        id: engineer.id,
        legacy_id: engineer.legacy_id,
        name: engineer.name,
        company: engineer.company,
        group: engineer.group,
        site: engineer.site,
        role: engineer.role,
        main_eq_id: engineer.main_eq_id,
        multi_eq_id: engineer.multi_eq_id,
        resolved_by: engineer.resolved_by,
      } : null,
      access,
    };
  } finally {
    conn.release();
  }
};

exports.getAvailableTemplatesForUser = async (userIdx) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const engineer = await resolveEngineer(conn, userIdx);
    if (!engineer?.user) {
      const err = new Error('인증 사용자 정보를 찾을 수 없습니다.');
      err.statusCode = 401;
      throw err;
    }

    const access = await getAccessMap(conn, engineer.id || null);
    const allowedCodes = access.filter((row) => row.allowed).map((row) => row.code);
    if (!allowedCodes.length) return { engineer, rows: [], access };

    const [templateRows] = await conn.query(
      `SELECT
         t.id,
         t.equipment_group_code,
         eg.display_name AS equipment_group_name,
         t.checklist_kind,
         t.template_name,
         t.version_no,
         t.updated_at,
         r.response_status,
         r.updated_at AS response_updated_at,
         COUNT(q.id) AS question_count,
         COALESCE(SUM(CASE WHEN a.is_checked = 1 THEN 1 ELSE 0 END), 0) AS checked_count
       FROM checklist_template t
       JOIN checklist_equipment_group eg
         ON eg.code = t.equipment_group_code
       LEFT JOIN checklist_question q
         ON q.template_id = t.id
        AND q.is_active = 1
       LEFT JOIN checklist_response r
         ON r.template_id = t.id
        AND r.engineer_id = ?
       LEFT JOIN checklist_response_answer a
         ON a.response_id = r.id
        AND a.question_id = q.id
      WHERE t.is_active = 1
        AND t.equipment_group_code IN (?)
      GROUP BY
        t.id, t.equipment_group_code, eg.display_name, t.checklist_kind, t.template_name, t.version_no, t.updated_at,
        r.response_status, r.updated_at
      ORDER BY eg.sort_order, t.checklist_kind, t.version_no DESC`,
      [engineer.id || 0, allowedCodes]
    );

    const equipmentOrder = new Map(allowedCodes.map((code, index) => [code, index]));
    templateRows.sort((a, b) => equipmentOrder.get(a.equipment_group_code) - equipmentOrder.get(b.equipment_group_code));
    return { engineer, rows: templateRows, access };
  } finally {
    conn.release();
  }
};

exports.getTemplate = async ({ userIdx, equipmentGroupCode, checklistKind }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const { engineer } = await ensureTemplateAccess(conn, userIdx, equipmentGroupCode);
    const template = await findActiveTemplate(conn, equipmentGroupCode, checklistKind);
    if (!template) {
      const err = new Error('체크리스트 템플릿이 없습니다. 먼저 sync-catalog를 실행하세요.');
      err.statusCode = 404;
      throw err;
    }
    const sections = await loadTemplateStructure(conn, template.id);
    return { engineer, template, sections };
  } finally {
    conn.release();
  }
};

exports.getMyChecklist = async ({ userIdx, equipmentGroupCode, checklistKind }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const { engineer } = await ensureTemplateAccess(conn, userIdx, equipmentGroupCode);
    if (!engineer?.id) {
      const err = new Error('engineer 테이블과 현재 로그인 사용자가 연결되지 않았습니다.');
      err.statusCode = 400;
      throw err;
    }

    const template = await findActiveTemplate(conn, equipmentGroupCode, checklistKind);
    if (!template) {
      const err = new Error('체크리스트 템플릿이 없습니다. 먼저 sync-catalog를 실행하세요.');
      err.statusCode = 404;
      throw err;
    }

    const sections = await loadTemplateStructure(conn, template.id);

    const [responseRows] = await conn.query(
      `SELECT *
         FROM checklist_response
        WHERE engineer_id = ? AND template_id = ?
        LIMIT 1`,
      [engineer.id, template.id]
    );
    const response = responseRows[0] || null;

    let answers = [];
    if (response) {
      answers = await loadResponseAnswers(conn, response.id);
    }

    const payload = decorateChecklistPayload({
      engineer,
      template,
      response: response ? { ...response, answers } : null,
      sections,
    });

    return {
      ...payload,
      permission: buildPermission({
        role: engineer.user?.role,
        responseStatus: payload.response?.response_status || 'ACTIVE',
      }),
    };
  } finally {
    conn.release();
  }
};

exports.saveMyChecklist = async ({ userIdx, equipmentGroupCode, checklistKind, answers, responseStatus = 'ACTIVE' }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();

    const { engineer } = await ensureTemplateAccess(conn, userIdx, equipmentGroupCode);
    if (!engineer?.id) {
      const err = new Error('engineer 테이블과 현재 로그인 사용자가 연결되지 않았습니다.');
      err.statusCode = 400;
      throw err;
    }

    const template = await findActiveTemplate(conn, equipmentGroupCode, checklistKind);
    if (!template) {
      const err = new Error('체크리스트 템플릿이 없습니다. 먼저 sync-catalog를 실행하세요.');
      err.statusCode = 404;
      throw err;
    }

    const response = await getOrCreateResponse(conn, engineer.id, template.id, userIdx);
    const currentStatus = String(response.response_status || 'ACTIVE').toUpperCase();
    const userRole = engineer.user?.role || 'worker';

    if (userRole !== 'admin' && ['SUBMITTED', 'APPROVED'].includes(currentStatus)) {
      const err = new Error(currentStatus === 'APPROVED'
        ? '승인 완료된 체크리스트는 수정할 수 없습니다.'
        : '결재 대기 중인 체크리스트는 수정할 수 없습니다.');
      err.statusCode = 409;
      throw err;
    }

    const [questionRows] = await conn.query(
      `SELECT id, question_code
         FROM checklist_question
        WHERE template_id = ? AND is_active = 1`,
      [template.id]
    );
    const questionById = new Map(questionRows.map((row) => [row.id, row]));
    const questionByCode = new Map(questionRows.map((row) => [row.question_code, row]));

    const normalized = [];
    for (const item of Array.isArray(answers) ? answers : []) {
      let question = null;
      if (item.question_id) {
        question = questionById.get(Number(item.question_id));
      } else if (item.question_code) {
        question = questionByCode.get(String(item.question_code).trim());
      }
      if (!question) continue;

      normalized.push({
        question_id: question.id,
        is_checked: item.is_checked ? 1 : 0,
        note: item.note == null ? null : String(item.note).trim(),
      });
    }

    const normalizedMap = new Map();
    for (const row of normalized) {
      if (!normalizedMap.has(row.question_id)) normalizedMap.set(row.question_id, row);
    }
    for (const row of questionRows) {
      if (!normalizedMap.has(row.id)) {
        normalizedMap.set(row.id, { question_id: row.id, is_checked: 0, note: null });
      }
    }

    const nextStatus = responseStatus === 'SUBMITTED' ? 'SUBMITTED' : 'ACTIVE';

    await conn.query(
      `UPDATE checklist_response
          SET response_status = ?,
              updated_by = ?,
              submitted_at = CASE WHEN ? = 'SUBMITTED' THEN NOW() ELSE NULL END,
              approved_by = NULL,
              approved_at = NULL,
              rejected_by = NULL,
              rejected_at = NULL,
              decision_comment = NULL
        WHERE id = ?`,
      [nextStatus, userIdx || null, nextStatus, response.id]
    );

    await conn.query(`DELETE FROM checklist_response_answer WHERE response_id = ?`, [response.id]);

    const values = Array.from(normalizedMap.values()).map((row) => ([
      response.id,
      row.question_id,
      row.is_checked,
      row.is_checked ? new Date() : null,
      row.note,
    ]));

    if (values.length) {
      await conn.query(
        `INSERT INTO checklist_response_answer (
           response_id, question_id, is_checked, checked_at, note
         ) VALUES ?`,
        [values]
      );
    }

    await conn.commit();
    return await exports.getMyChecklist({ userIdx, equipmentGroupCode, checklistKind });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

exports.getEngineerAccess = async (engineerId) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const [engineerRows] = await conn.query(
      `SELECT id, legacy_id, name, company, \`group\`, site, role, main_eq_id, multi_eq_id
         FROM engineer
        WHERE id = ?
        LIMIT 1`,
      [engineerId]
    );
    const engineer = engineerRows[0];
    if (!engineer) {
      const err = new Error('engineer not found');
      err.statusCode = 404;
      throw err;
    }

    const defaultAccess = await getAccessMap(conn, engineerId);

    const [overrideRows] = await conn.query(
      `SELECT id, engineer_id, equipment_group_code, access_type, reason, created_by, created_at, updated_at
         FROM checklist_engineer_access_override
        WHERE engineer_id = ?
        ORDER BY equipment_group_code`,
      [engineerId]
    );

    const finalAccess = defaultAccess;
    return {
      engineer,
      policy: 'REGISTERED_EQUIPMENT',
      default_access: defaultAccess,
      overrides: [],
      legacy_overrides: overrideRows,
      final_access: finalAccess,
    };
  } finally {
    conn.release();
  }
};

exports.upsertEngineerAccessOverride = async () => {
  const err = new Error('체크리스트 설비는 본인의 메인/멀티설비로 고정됩니다. 설비 등록 정보를 수정해 주세요.');
  err.statusCode = 409;
  throw err;
};

exports.deleteEngineerAccessOverride = async ({ engineerId, equipmentGroupCode }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.query(
      `DELETE FROM checklist_engineer_access_override
        WHERE engineer_id = ? AND equipment_group_code = ?`,
      [engineerId, equipmentGroupCode]
    );
    return await exports.getEngineerAccess(engineerId);
  } finally {
    conn.release();
  }
};

exports.getApprovalQueue = async ({ userIdx, status = 'SUBMITTED', equipmentGroupCode = '', checklistKind = '', keyword = '' }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await ensureAdmin(conn, userIdx);

    const filters = [];
    const params = [];

    if (status && ['SUBMITTED', 'APPROVED', 'REJECTED', 'ACTIVE'].includes(status)) {
      filters.push('r.response_status = ?');
      params.push(status);
    }
    if (equipmentGroupCode) {
      filters.push('t.equipment_group_code = ?');
      params.push(equipmentGroupCode);
    }
    if (checklistKind && ['SETUP', 'MAINT'].includes(checklistKind)) {
      filters.push('t.checklist_kind = ?');
      params.push(checklistKind);
    }
    if (keyword) {
      filters.push('(e.name LIKE ? OR t.template_name LIKE ? OR eg.display_name LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [rows] = await conn.query(
      `SELECT
         r.id AS response_id,
         r.response_status,
         r.submitted_at,
         r.approved_at,
         r.rejected_at,
         r.updated_at,
         r.decision_comment,
         e.id AS engineer_id,
         e.name AS engineer_name,
         e.\`group\` AS engineer_group,
         e.site AS engineer_site,
         t.id AS template_id,
         t.template_name,
         t.checklist_kind,
         t.equipment_group_code,
         eg.display_name AS equipment_group_name,
         COUNT(q.id) AS total_questions,
         COALESCE(SUM(CASE WHEN a.is_checked = 1 THEN 1 ELSE 0 END), 0) AS checked_questions
       FROM checklist_response r
       JOIN engineer e ON e.id = r.engineer_id
       JOIN checklist_template t ON t.id = r.template_id
       JOIN checklist_equipment_group eg ON eg.code = t.equipment_group_code
       LEFT JOIN checklist_question q
         ON q.template_id = t.id
        AND q.is_active = 1
       LEFT JOIN checklist_response_answer a
         ON a.response_id = r.id
        AND a.question_id = q.id
       ${whereSql}
       GROUP BY
         r.id, r.response_status, r.submitted_at, r.approved_at, r.rejected_at, r.updated_at, r.decision_comment,
         e.id, e.name, e.\`group\`, e.site,
         t.id, t.template_name, t.checklist_kind, t.equipment_group_code, eg.display_name
       ORDER BY
         CASE r.response_status
           WHEN 'SUBMITTED' THEN 1
           WHEN 'REJECTED' THEN 2
           WHEN 'APPROVED' THEN 3
           ELSE 4
         END,
         COALESCE(r.submitted_at, r.updated_at) DESC,
         r.id DESC`,
      params
    );

    return { rows };
  } finally {
    conn.release();
  }
};

exports.getApprovalRequestDetail = async ({ userIdx, responseId }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const adminUser = await ensureAdmin(conn, userIdx);
    const row = await loadResponseBundleByResponseId(conn, responseId);
    if (!row) {
      const err = new Error('체크리스트 응답을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }

    const sections = await loadTemplateStructure(conn, row.template_id);
    const answers = await loadResponseAnswers(conn, row.id);

    const payload = decorateChecklistPayload({
      engineer: {
        id: row.engineer_id,
        legacy_id: row.legacy_id,
        name: row.engineer_name,
        company: row.company,
        group: row.engineer_group,
        site: row.engineer_site,
        role: row.engineer_role,
        user: adminUser,
      },
      template: {
        id: row.template_id,
        equipment_group_code: row.equipment_group_code,
        equipment_group_name: row.equipment_group_name,
        checklist_kind: row.checklist_kind,
        template_name: row.template_name,
        version_no: row.version_no,
      },
      response: {
        id: row.id,
        response_status: row.response_status,
        submitted_at: row.submitted_at,
        approved_at: row.approved_at,
        rejected_at: row.rejected_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        updated_by: row.updated_by,
        approved_by: row.approved_by,
        rejected_by: row.rejected_by,
        decision_comment: row.decision_comment,
        created_by_name: row.created_by_name,
        updated_by_name: row.updated_by_name,
        approved_by_name: row.approved_by_name,
        rejected_by_name: row.rejected_by_name,
        answers,
      },
      sections,
    });

    const previousPayload = await loadLatestApprovedPayload(conn, row, adminUser);
    const comparison = buildLatestApprovedComparison(payload, previousPayload);

    return {
      ...payload,
      comparison,
      permission: {
        can_edit: false,
        can_submit: false,
        can_approve: row.response_status === 'SUBMITTED',
      },
    };
  } finally {
    conn.release();
  }
};

exports.decideApprovalRequest = async ({ userIdx, responseId, decision, comment }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await conn.beginTransaction();
    await ensureAdmin(conn, userIdx);

    const row = await loadResponseBundleByResponseId(conn, responseId);
    if (!row) {
      const err = new Error('체크리스트 응답을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }
    if (row.response_status !== 'SUBMITTED') {
      const err = new Error('제출 상태(SUBMITTED)인 체크리스트만 결재할 수 있습니다.');
      err.statusCode = 409;
      throw err;
    }

    if (decision === 'APPROVED') {
      await conn.query(
        `UPDATE checklist_response
            SET response_status = 'APPROVED',
                approved_by = ?,
                approved_at = NOW(),
                rejected_by = NULL,
                rejected_at = NULL,
                decision_comment = ?
          WHERE id = ?`,
        [userIdx, comment || null, responseId]
      );
    } else {
      await conn.query(
        `UPDATE checklist_response
            SET response_status = 'REJECTED',
                rejected_by = ?,
                rejected_at = NOW(),
                approved_by = NULL,
                approved_at = NULL,
                decision_comment = ?
          WHERE id = ?`,
        [userIdx, comment || null, responseId]
      );
    }

    await conn.commit();
    return await exports.getApprovalRequestDetail({ userIdx, responseId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

exports.syncCatalog = async () => {
  const conn = await pool.getConnection(async c => c);
  const counters = {
    equipment_groups_upserted: 0,
    templates_upserted: 0,
    sections_upserted: 0,
    questions_upserted: 0,
  };

  try {
    await conn.beginTransaction();

    for (const eq of catalog.equipmentGroups || []) {
      await conn.query(
        `INSERT INTO checklist_equipment_group (code, display_name, sort_order, is_active)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name),
           sort_order = VALUES(sort_order),
           is_active = 1`,
        [eq.code, eq.display_name, eq.sort_order || 999]
      );
      counters.equipment_groups_upserted += 1;
    }

    for (const [groupName, eqCodes] of Object.entries(catalog.defaultGroupAccess || {})) {
      for (const code of eqCodes) {
        await conn.query(
          `INSERT INTO checklist_group_equipment_access (engineer_group, equipment_group_code, is_allowed)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE
             is_allowed = 1`,
          [groupName, code]
        );
      }
    }

    for (const templateDef of catalog.templates || []) {
      await conn.query(
        `INSERT INTO checklist_template (
           equipment_group_code, checklist_kind, template_name, version_no, is_active
         ) VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           template_name = VALUES(template_name),
           is_active = 1`,
        [
          templateDef.equipment_group_code,
          templateDef.checklist_kind,
          templateDef.template_name,
          templateDef.version_no || 1,
        ]
      );

      const [templateRows] = await conn.query(
        `SELECT id
           FROM checklist_template
          WHERE equipment_group_code = ?
            AND checklist_kind = ?
            AND version_no = ?
          LIMIT 1`,
        [
          templateDef.equipment_group_code,
          templateDef.checklist_kind,
          templateDef.version_no || 1,
        ]
      );
      const templateId = templateRows[0].id;
      counters.templates_upserted += 1;

      const sectionCodes = [];
      for (const sectionDef of templateDef.sections || []) {
        sectionCodes.push(sectionDef.section_code);

        await conn.query(
          `INSERT INTO checklist_section (
             template_id, section_code, section_name, sort_order, is_active
           ) VALUES (?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE
             section_name = VALUES(section_name),
             sort_order = VALUES(sort_order),
             is_active = 1`,
          [
            templateId,
            sectionDef.section_code,
            sectionDef.section_name,
            sectionDef.sort_order || 999,
          ]
        );
        counters.sections_upserted += 1;

        const [sectionRows] = await conn.query(
          `SELECT id
             FROM checklist_section
            WHERE template_id = ? AND section_code = ?
            LIMIT 1`,
          [templateId, sectionDef.section_code]
        );
        const sectionId = sectionRows[0].id;

        const questionCodes = [];
        for (const questionDef of sectionDef.questions || []) {
          questionCodes.push(questionDef.question_code);
          await conn.query(
            `INSERT INTO checklist_question (
               template_id, section_id, question_code, question_text, sort_order, is_active
             ) VALUES (?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
               section_id = VALUES(section_id),
               question_text = VALUES(question_text),
               sort_order = VALUES(sort_order),
               is_active = 1`,
            [
              templateId,
              sectionId,
              questionDef.question_code,
              questionDef.question_text,
              questionDef.sort_order || 999,
            ]
          );
          counters.questions_upserted += 1;
        }

        if (questionCodes.length) {
          await conn.query(
            `UPDATE checklist_question
                SET is_active = 0
              WHERE template_id = ?
                AND section_id = ?
                AND question_code NOT IN (?)`,
            [templateId, sectionId, questionCodes]
          );
        }
      }

      if (sectionCodes.length) {
        await conn.query(
          `UPDATE checklist_section
              SET is_active = 0
            WHERE template_id = ?
              AND section_code NOT IN (?)`,
          [templateId, sectionCodes]
        );
      }
    }

    await conn.commit();
    return counters;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};


exports.getMyRequestList = async ({ userIdx, status = '', equipmentGroupCode = '', checklistKind = '' }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const engineer = await resolveEngineer(conn, userIdx);
    if (!engineer?.id) {
      const err = new Error('engineer 테이블과 현재 로그인 사용자가 연결되지 않았습니다.');
      err.statusCode = 400;
      throw err;
    }

    const filters = ['r.engineer_id = ?'];
    const params = [engineer.id];

    if (status && ['SUBMITTED', 'APPROVED', 'REJECTED', 'ACTIVE'].includes(status)) {
      filters.push('r.response_status = ?');
      params.push(status);
    }
    if (equipmentGroupCode) {
      filters.push('t.equipment_group_code = ?');
      params.push(sanitizeCode(equipmentGroupCode));
    }
    if (checklistKind && ['SETUP', 'MAINT'].includes(checklistKind)) {
      filters.push('t.checklist_kind = ?');
      params.push(sanitizeKind(checklistKind));
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const [rows] = await conn.query(
      `SELECT
         r.id AS response_id,
         r.response_status,
         r.submitted_at,
         r.approved_at,
         r.rejected_at,
         r.updated_at,
         r.decision_comment,
         t.id AS template_id,
         t.template_name,
         t.checklist_kind,
         t.equipment_group_code,
         eg.display_name AS equipment_group_name,
         COUNT(q.id) AS total_questions,
         COALESCE(SUM(CASE WHEN a.is_checked = 1 THEN 1 ELSE 0 END), 0) AS checked_questions
       FROM checklist_response r
       JOIN checklist_template t ON t.id = r.template_id
       JOIN checklist_equipment_group eg ON eg.code = t.equipment_group_code
       LEFT JOIN checklist_question q
         ON q.template_id = t.id
        AND q.is_active = 1
       LEFT JOIN checklist_response_answer a
         ON a.response_id = r.id
        AND a.question_id = q.id
       ${whereSql}
       GROUP BY
         r.id, r.response_status, r.submitted_at, r.approved_at, r.rejected_at, r.updated_at, r.decision_comment,
         t.id, t.template_name, t.checklist_kind, t.equipment_group_code, eg.display_name
       ORDER BY
         CASE r.response_status
           WHEN 'REJECTED' THEN 1
           WHEN 'SUBMITTED' THEN 2
           WHEN 'APPROVED' THEN 3
           ELSE 4
         END,
         COALESCE(r.updated_at, r.submitted_at) DESC,
         r.id DESC`,
      params
    );

    return { engineer, rows };
  } finally {
    conn.release();
  }
};

exports.getMyRequestDetail = async ({ userIdx, responseId }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    const engineer = await resolveEngineer(conn, userIdx);
    if (!engineer?.user) {
      const err = new Error('사용자 정보를 찾을 수 없습니다.');
      err.statusCode = 401;
      throw err;
    }

    const row = await loadResponseBundleByResponseId(conn, responseId);
    if (!row) {
      const err = new Error('체크리스트 응답을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }

    if (engineer.user.role !== 'admin' && row.engineer_id !== engineer.id) {
      const err = new Error('해당 체크리스트를 볼 권한이 없습니다.');
      err.statusCode = 403;
      throw err;
    }

    const sections = await loadTemplateStructure(conn, row.template_id);
    const answers = await loadResponseAnswers(conn, row.id);

    const payload = decorateChecklistPayload({
      engineer: {
        id: row.engineer_id,
        legacy_id: row.legacy_id,
        name: row.engineer_name,
        company: row.company,
        group: row.engineer_group,
        site: row.engineer_site,
        role: row.engineer_role,
        user: engineer.user,
      },
      template: {
        id: row.template_id,
        equipment_group_code: row.equipment_group_code,
        equipment_group_name: row.equipment_group_name,
        checklist_kind: row.checklist_kind,
        template_name: row.template_name,
        version_no: row.version_no,
      },
      response: {
        id: row.id,
        response_status: row.response_status,
        submitted_at: row.submitted_at,
        approved_at: row.approved_at,
        rejected_at: row.rejected_at,
        created_by: row.created_by,
        updated_by: row.updated_by,
        approved_by: row.approved_by,
        rejected_by: row.rejected_by,
        decision_comment: row.decision_comment,
        created_by_name: row.created_by_name,
        updated_by_name: row.updated_by_name,
        approved_by_name: row.approved_by_name,
        rejected_by_name: row.rejected_by_name,
        answers,
      },
      sections,
    });

    return {
      ...payload,
      permission: buildPermission({
        role: engineer.user?.role,
        responseStatus: row.response_status,
      }),
    };
  } finally {
    conn.release();
  }
};

exports.getMyDecisionHistory = async ({ userIdx, decision = '' }) => {
  const conn = await pool.getConnection(async c => c);
  try {
    await ensureAdmin(conn, userIdx);

    const filters = [];
    const params = [];

    if (decision === 'APPROVED') {
      filters.push('r.approved_by = ?');
      params.push(userIdx);
    } else if (decision === 'REJECTED') {
      filters.push('r.rejected_by = ?');
      params.push(userIdx);
    } else {
      filters.push('(r.approved_by = ? OR r.rejected_by = ?)');
      params.push(userIdx, userIdx);
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const [rows] = await conn.query(
      `SELECT
         r.id AS response_id,
         r.response_status,
         r.submitted_at,
         r.approved_at,
         r.rejected_at,
         r.updated_at,
         r.decision_comment,
         e.id AS engineer_id,
         e.name AS engineer_name,
         e.\`group\` AS engineer_group,
         e.site AS engineer_site,
         t.id AS template_id,
         t.template_name,
         t.checklist_kind,
         t.equipment_group_code,
         eg.display_name AS equipment_group_name,
         COUNT(q.id) AS total_questions,
         COALESCE(SUM(CASE WHEN a.is_checked = 1 THEN 1 ELSE 0 END), 0) AS checked_questions
       FROM checklist_response r
       JOIN engineer e ON e.id = r.engineer_id
       JOIN checklist_template t ON t.id = r.template_id
       JOIN checklist_equipment_group eg ON eg.code = t.equipment_group_code
       LEFT JOIN checklist_question q
         ON q.template_id = t.id
        AND q.is_active = 1
       LEFT JOIN checklist_response_answer a
         ON a.response_id = r.id
        AND a.question_id = q.id
       ${whereSql}
       GROUP BY
         r.id, r.response_status, r.submitted_at, r.approved_at, r.rejected_at, r.updated_at, r.decision_comment,
         e.id, e.name, e.\`group\`, e.site,
         t.id, t.template_name, t.checklist_kind, t.equipment_group_code, eg.display_name
       ORDER BY COALESCE(r.approved_at, r.rejected_at, r.updated_at) DESC, r.id DESC`,
      params
    );

    return { rows };
  } finally {
    conn.release();
  }
};
