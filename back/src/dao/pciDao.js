'use strict';

const { pool } = require('../../config/database');

function resolveUserIdx(userLike) {
  return userLike?.userIdx || userLike?.user_idx || userLike?.id || null;
}

async function getUserById(conn, userIdx) {
  if (!userIdx) return null;
  const [rows] = await conn.query(
    `SELECT userIdx, nickname, role, status, \`group\`, site
       FROM Users
      WHERE userIdx = ?
      LIMIT 1`,
    [userIdx]
  );
  return rows[0] || null;
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

async function getFilterOptions() {
  const conn = await pool.getConnection();
  try {
    const [equipmentGroups] = await conn.query(
      `SELECT code, display_name, sort_order
         FROM checklist_equipment_group
        WHERE is_active = 1
        ORDER BY sort_order, code`
    );

    const [groups] = await conn.query(
      `SELECT DISTINCT \`group\`
         FROM engineer
        WHERE \`group\` IS NOT NULL AND \`group\` <> ''
        ORDER BY \`group\``
    );

    const [sites] = await conn.query(
      `SELECT DISTINCT site
         FROM engineer
        WHERE site IS NOT NULL AND site <> ''
        ORDER BY site`
    );

    return {
      equipment_groups: equipmentGroups,
      groups: groups.map((row) => row.group),
      sites: sites.map((row) => row.site),
      domains: ['MAINT', 'SETUP'],
      source_work_types: ['MAINT', 'SETUP', 'RELOCATION', 'MERGED'],
    };
  } finally {
    conn.release();
  }
}

function getManualWorkTypePredicate(pciDomain, sourceWorkType) {
  if (pciDomain === 'MAINT') {
    return {
      sql: `mc.source_work_type = 'MAINT'`,
      params: [],
    };
  }

  if (sourceWorkType === 'MERGED') {
    return {
      sql: `mc.source_work_type IN ('SETUP', 'RELOCATION', 'MERGED')`,
      params: [],
    };
  }

  return {
    sql: `mc.source_work_type = ?`,
    params: [sourceWorkType],
  };
}

async function getMatrix({
  equipmentGroupCode,
  pciDomain,
  engineerGroup = '',
  site = '',
  keyword = '',
  dateFrom,
  dateTo,
  sourceWorkType = '',
}) {
  const conn = await pool.getConnection();
  try {
    const useSourceWorkType =
      pciDomain === 'MAINT'
        ? 'MAINT'
        : (sourceWorkType && ['SETUP', 'RELOCATION', 'MERGED'].includes(sourceWorkType) ? sourceWorkType : 'MERGED');

    const manualPredicate = getManualWorkTypePredicate(pciDomain, useSourceWorkType);

    const [rows] = await conn.query(
      `
      WITH filtered_engineers AS (
        SELECT e.id, e.name, e.company, e.\`group\`, e.site
        FROM engineer e
        WHERE 1=1
          AND (? = '' OR e.\`group\` = ?)
          AND (? = '' OR e.site = ?)
          AND (? = '' OR e.name LIKE ?)
      ),
      filtered_items AS (
        SELECT pi.id, pi.equipment_group_code, pi.pci_domain, pi.item_code, pi.item_name, pi.item_name_kr,
               pi.category, pi.required_count, pi.self_weight, pi.history_max_score, pi.main_weight, pi.support_weight, pi.sort_order
        FROM pci_item pi
        WHERE pi.is_active = 1
          AND pi.equipment_group_code = ?
          AND pi.pci_domain = ?
      ),
      history_agg AS (
        SELECT
          ds.engineer_id,
          ds.pci_item_id,
          SUM(ds.main_count) AS main_count,
          SUM(ds.support_count) AS support_count,
          SUM(ds.converted_count) AS converted_count,
          SUM(ds.event_count) AS event_count
        FROM pci_daily_summary ds
        WHERE ds.equipment_group_code = ?
          AND ds.pci_domain = ?
          AND ds.source_work_type = ?
          AND ds.task_date BETWEEN ? AND ?
        GROUP BY ds.engineer_id, ds.pci_item_id
      ),
      manual_agg AS (
        SELECT
          mc.engineer_id,
          mc.pci_item_id,
          SUM(mc.main_count_add) AS main_count,
          SUM(mc.support_count_add) AS support_count,
          SUM(mc.converted_count_add + (mc.main_count_add * pi.main_weight) + (mc.support_count_add * pi.support_weight)) AS converted_count,
          COUNT(*) AS event_count
        FROM pci_manual_credit mc
        JOIN pci_item pi
          ON pi.id = mc.pci_item_id
         AND pi.is_active = 1
        WHERE pi.equipment_group_code = ?
          AND pi.pci_domain = ?
          AND mc.is_active = 1
          AND (${manualPredicate.sql})
          AND (mc.effective_date IS NULL OR mc.effective_date BETWEEN ? AND ?)
        GROUP BY mc.engineer_id, mc.pci_item_id
      ),
      self_question_rows AS (
        SELECT
          r.engineer_id,
          sm.pci_item_id,
          UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id)))) AS question_key,
          MAX(CASE WHEN COALESCE(a.is_checked, 0) = 1 THEN 1 ELSE 0 END) AS is_checked
        FROM pci_item_selfcheck_map sm
        JOIN pci_item pi
          ON pi.id = sm.pci_item_id
         AND pi.equipment_group_code = ?
         AND pi.pci_domain = ?
         AND pi.is_active = 1
        JOIN checklist_question q
          ON q.id = sm.checklist_question_id
         AND q.is_active = 1
        JOIN checklist_template t
          ON t.id = q.template_id
         AND t.is_active = 1
        LEFT JOIN checklist_response r
          ON r.template_id = t.id
        LEFT JOIN checklist_response_answer a
          ON a.response_id = r.id
         AND a.question_id = q.id
        WHERE sm.is_active = 1
        GROUP BY
          r.engineer_id,
          sm.pci_item_id,
          UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id))))
      ),
      self_agg AS (
        SELECT
          sq.engineer_id,
          sq.pci_item_id,
          COUNT(*) AS total_questions,
          SUM(CASE WHEN sq.is_checked = 1 THEN 1 ELSE 0 END) AS checked_questions,
          MAX(CASE WHEN sq.is_checked = 1 THEN 1 ELSE 0 END) AS any_checked
        FROM self_question_rows sq
        WHERE sq.engineer_id IS NOT NULL
        GROUP BY sq.engineer_id, sq.pci_item_id
      )
      SELECT
        fe.id AS engineer_id,
        fe.name AS engineer_name,
        fe.company,
        fe.\`group\` AS engineer_group,
        fe.site AS engineer_site,
        fi.id AS pci_item_id,
        fi.item_code,
        fi.item_name,
        fi.item_name_kr,
        fi.category,
        fi.required_count,
        fi.self_weight,
        fi.history_max_score,
        COALESCE(sa.any_checked, 0) AS self_completed,
        COALESCE(sa.total_questions, 0) AS self_total_questions,
        COALESCE(sa.checked_questions, 0) AS self_checked_questions,
        CASE
          WHEN fi.pci_domain = 'SETUP' AND COALESCE(sa.total_questions, 0) > 0 THEN ROUND(COALESCE(sa.checked_questions, 0) / sa.total_questions * fi.self_weight, 2)
          WHEN fi.pci_domain = 'MAINT' AND COALESCE(sa.any_checked, 0) = 1 THEN fi.self_weight
          ELSE 0
        END AS self_score,
        COALESCE(ha.main_count, 0) + COALESCE(ma.main_count, 0) AS main_count,
        COALESCE(ha.support_count, 0) + COALESCE(ma.support_count, 0) AS support_count,
        COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0) AS converted_count,
        COALESCE(ha.event_count, 0) + COALESCE(ma.event_count, 0) AS event_count,
        COALESCE(ma.main_count, 0) AS manual_main_count,
        COALESCE(ma.support_count, 0) AS manual_support_count,
        COALESCE(ma.converted_count, 0) AS manual_converted_count,
        COALESCE(ma.event_count, 0) AS manual_event_count,
        ROUND(
          LEAST((COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0)) / NULLIF(fi.required_count, 0), 1.0) * fi.history_max_score,
          2
        ) AS history_score,
        ROUND(
          LEAST(
            CASE
              WHEN fi.pci_domain = 'SETUP' AND COALESCE(sa.total_questions, 0) > 0 THEN COALESCE(sa.checked_questions, 0) / sa.total_questions * fi.self_weight
              WHEN fi.pci_domain = 'MAINT' AND COALESCE(sa.any_checked, 0) = 1 THEN fi.self_weight
              ELSE 0
            END + (LEAST((COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0)) / NULLIF(fi.required_count, 0), 1.0) * fi.history_max_score),
            100
          ),
          2
        ) AS pci_score
      FROM filtered_engineers fe
      CROSS JOIN filtered_items fi
      LEFT JOIN history_agg ha
        ON ha.engineer_id = fe.id
       AND ha.pci_item_id = fi.id
      LEFT JOIN manual_agg ma
        ON ma.engineer_id = fe.id
       AND ma.pci_item_id = fi.id
      LEFT JOIN self_agg sa
        ON sa.engineer_id = fe.id
       AND sa.pci_item_id = fi.id
      ORDER BY fi.category, fi.sort_order, fi.item_name, fe.name
      `,
      [
        engineerGroup, engineerGroup,
        site, site,
        keyword, `%${keyword}%`,
        equipmentGroupCode, pciDomain,
        equipmentGroupCode, pciDomain, useSourceWorkType, dateFrom, dateTo,
        equipmentGroupCode, pciDomain, ...manualPredicate.params, dateFrom, dateTo,
        equipmentGroupCode, pciDomain,
      ]
    );

    return { rows, sourceWorkType: useSourceWorkType };
  } finally {
    conn.release();
  }
}

async function getCellDetail({ engineerId, pciItemId, dateFrom, dateTo, sourceWorkType = '' }) {
  const conn = await pool.getConnection();
  try {
    const [[itemRow]] = await conn.query(
      `SELECT id, equipment_group_code, pci_domain, item_code, item_name, item_name_kr,
              category, required_count, self_weight, history_max_score, main_weight, support_weight
         FROM pci_item
        WHERE id = ?
        LIMIT 1`,
      [pciItemId]
    );

    if (!itemRow) {
      const err = new Error('PCI 항목을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }

    const effectiveSourceWorkType =
      itemRow.pci_domain === 'MAINT'
        ? 'MAINT'
        : (sourceWorkType && ['SETUP', 'RELOCATION', 'MERGED'].includes(sourceWorkType) ? sourceWorkType : 'MERGED');

    const manualPredicate = getManualWorkTypePredicate(itemRow.pci_domain, effectiveSourceWorkType);

    const [[engineerRow]] = await conn.query(
      `SELECT id, name, company, \`group\`, site
         FROM engineer
        WHERE id = ?
        LIMIT 1`,
      [engineerId]
    );

    const [[summary]] = await conn.query(
      `
      WITH self_question_rows AS (
        SELECT
          r.engineer_id,
          sm.pci_item_id,
          UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id)))) AS question_key,
          MAX(CASE WHEN COALESCE(a.is_checked, 0) = 1 THEN 1 ELSE 0 END) AS is_checked
        FROM pci_item_selfcheck_map sm
        JOIN checklist_question q
          ON q.id = sm.checklist_question_id
         AND q.is_active = 1
        JOIN checklist_template t
          ON t.id = q.template_id
         AND t.is_active = 1
        LEFT JOIN checklist_response r
          ON r.template_id = t.id
         AND r.engineer_id = ?
        LEFT JOIN checklist_response_answer a
          ON a.response_id = r.id
         AND a.question_id = q.id
        WHERE sm.pci_item_id = ?
          AND sm.is_active = 1
        GROUP BY r.engineer_id, sm.pci_item_id,
          UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id))))
      ),
      self_agg AS (
        SELECT
          sq.engineer_id,
          sq.pci_item_id,
          COUNT(*) AS total_questions,
          SUM(CASE WHEN sq.is_checked = 1 THEN 1 ELSE 0 END) AS checked_questions,
          MAX(CASE WHEN sq.is_checked = 1 THEN 1 ELSE 0 END) AS any_checked
        FROM self_question_rows sq
        WHERE sq.engineer_id IS NOT NULL
        GROUP BY sq.engineer_id, sq.pci_item_id
      ),
      history_agg AS (
        SELECT
          SUM(ds.main_count) AS main_count,
          SUM(ds.support_count) AS support_count,
          SUM(ds.converted_count) AS converted_count,
          SUM(ds.event_count) AS event_count
        FROM pci_daily_summary ds
        WHERE ds.pci_item_id = ?
          AND ds.engineer_id = ?
          AND ds.source_work_type = ?
          AND ds.task_date BETWEEN ? AND ?
      ),
      manual_agg AS (
        SELECT
          SUM(mc.main_count_add) AS main_count,
          SUM(mc.support_count_add) AS support_count,
          SUM(mc.converted_count_add + (mc.main_count_add * ?) + (mc.support_count_add * ?)) AS converted_count,
          COUNT(*) AS event_count
        FROM pci_manual_credit mc
        WHERE mc.pci_item_id = ?
          AND mc.engineer_id = ?
          AND mc.is_active = 1
          AND (${manualPredicate.sql})
          AND (mc.effective_date IS NULL OR mc.effective_date BETWEEN ? AND ?)
      )
      SELECT
        pi.id AS pci_item_id,
        pi.equipment_group_code,
        pi.pci_domain,
        pi.item_code,
        pi.item_name,
        pi.item_name_kr,
        pi.category,
        pi.required_count,
        pi.self_weight,
        pi.history_max_score,
        COALESCE(sa.any_checked, 0) AS self_completed,
        COALESCE(sa.total_questions, 0) AS self_total_questions,
        COALESCE(sa.checked_questions, 0) AS self_checked_questions,
        CASE
          WHEN pi.pci_domain = 'SETUP' AND COALESCE(sa.total_questions, 0) > 0 THEN ROUND(COALESCE(sa.checked_questions, 0) / sa.total_questions * pi.self_weight, 2)
          WHEN pi.pci_domain = 'MAINT' AND COALESCE(sa.any_checked, 0) = 1 THEN pi.self_weight
          ELSE 0
        END AS self_score,
        COALESCE(ha.main_count, 0) + COALESCE(ma.main_count, 0) AS main_count,
        COALESCE(ha.support_count, 0) + COALESCE(ma.support_count, 0) AS support_count,
        COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0) AS converted_count,
        COALESCE(ha.event_count, 0) + COALESCE(ma.event_count, 0) AS event_count,
        COALESCE(ma.main_count, 0) AS manual_main_count,
        COALESCE(ma.support_count, 0) AS manual_support_count,
        COALESCE(ma.converted_count, 0) AS manual_converted_count,
        COALESCE(ma.event_count, 0) AS manual_event_count
      FROM pci_item pi
      LEFT JOIN self_agg sa ON sa.pci_item_id = pi.id AND sa.engineer_id = ?
      LEFT JOIN history_agg ha ON 1=1
      LEFT JOIN manual_agg ma ON 1=1
      WHERE pi.id = ?
      `,
      [
        engineerId, pciItemId,
        pciItemId, engineerId, effectiveSourceWorkType, dateFrom, dateTo,
        Number(itemRow.main_weight || 1), Number(itemRow.support_weight || 0.1), pciItemId, engineerId, ...manualPredicate.params, dateFrom, dateTo,
        engineerId, pciItemId,
      ]
    );

    const [events] = await conn.query(
      `
      SELECT
        f.event_id,
        'EVENT' AS entry_type,
        f.role,
        f.main_count,
        f.support_count,
        f.converted_count,
        f.task_date,
        f.source_work_type,
        e.task_name,
        e.equipment_type,
        e.equipment_name,
        e.work_type,
        e.setup_item,
        e.task_description,
        e.task_cause,
        e.task_result,
        e.\`group\` AS event_group,
        e.site AS event_site,
        e.line,
        NULL AS note
      FROM pci_event_fact f
      JOIN wl_event e
        ON e.id = f.event_id
      WHERE f.engineer_id = ?
        AND f.pci_item_id = ?
        AND f.task_date BETWEEN ? AND ?
        AND (
          ? = '' OR
          (? = 'MERGED' AND f.source_work_type IN ('SETUP', 'RELOCATION')) OR
          f.source_work_type = ?
        )
      UNION ALL
      SELECT
        NULL AS event_id,
        'MANUAL' AS entry_type,
        'manual' AS role,
        mc.main_count_add AS main_count,
        mc.support_count_add AS support_count,
        (mc.converted_count_add + (mc.main_count_add * ?) + (mc.support_count_add * ?)) AS converted_count,
        mc.effective_date AS task_date,
        mc.source_work_type,
        '수동 가산' AS task_name,
        NULL AS equipment_type,
        NULL AS equipment_name,
        NULL AS work_type,
        NULL AS setup_item,
        NULL AS task_description,
        NULL AS task_cause,
        NULL AS task_result,
        NULL AS event_group,
        NULL AS event_site,
        NULL AS line,
        mc.note AS note
      FROM pci_manual_credit mc
      WHERE mc.engineer_id = ?
        AND mc.pci_item_id = ?
        AND mc.is_active = 1
        AND (${manualPredicate.sql})
        AND (mc.effective_date IS NULL OR mc.effective_date BETWEEN ? AND ?)
      ORDER BY task_date DESC, event_id DESC
      `,
      [
        engineerId, pciItemId, dateFrom, dateTo, effectiveSourceWorkType, effectiveSourceWorkType, effectiveSourceWorkType,
        Number(itemRow.main_weight || 1), Number(itemRow.support_weight || 0.1),
        engineerId, pciItemId, ...manualPredicate.params, dateFrom, dateTo,
      ]
    );

    const [selfQuestions] = await conn.query(
      `
      SELECT
        MIN(q.id) AS checklist_question_id,
        MAX(q.question_code) AS question_code,
        MAX(q.question_text) AS question_text,
        UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id)))) AS question_key,
        MAX(CASE WHEN COALESCE(a.is_checked, 0) = 1 THEN 1 ELSE 0 END) AS is_checked,
        MAX(a.checked_at) AS checked_at,
        CASE
          WHEN SUM(CASE WHEN r.response_status = 'APPROVED' THEN 1 ELSE 0 END) > 0 THEN 'APPROVED'
          WHEN SUM(CASE WHEN r.response_status = 'SUBMITTED' THEN 1 ELSE 0 END) > 0 THEN 'SUBMITTED'
          WHEN SUM(CASE WHEN r.response_status = 'REJECTED' THEN 1 ELSE 0 END) > 0 THEN 'REJECTED'
          WHEN SUM(CASE WHEN r.response_status = 'ACTIVE' THEN 1 ELSE 0 END) > 0 THEN 'ACTIVE'
          ELSE '-'
        END AS response_status,
        COUNT(DISTINCT q.id) AS mapped_question_count
      FROM pci_item_selfcheck_map sm
      JOIN checklist_question q
        ON q.id = sm.checklist_question_id
      JOIN checklist_template t
        ON t.id = q.template_id
      LEFT JOIN checklist_response r
        ON r.template_id = t.id
       AND r.engineer_id = ?
      LEFT JOIN checklist_response_answer a
        ON a.response_id = r.id
       AND a.question_id = q.id
      WHERE sm.pci_item_id = ?
        AND sm.is_active = 1
      GROUP BY UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id))))
      ORDER BY MAX(q.question_code), MAX(q.question_text)
      `,
      [engineerId, pciItemId]
    );

    return {
      item: itemRow,
      engineer: engineerRow || null,
      summary: summary || null,
      events,
      self_questions: selfQuestions,
      source_work_type: effectiveSourceWorkType,
    };
  } finally {
    conn.release();
  }
}

async function getEngineerDetail({ engineerId, equipmentGroupCode, pciDomain, dateFrom, dateTo, sourceWorkType = '' }) {
  const conn = await pool.getConnection();
  try {
    const effectiveSourceWorkType =
      pciDomain === 'MAINT'
        ? 'MAINT'
        : (sourceWorkType && ['SETUP', 'RELOCATION', 'MERGED'].includes(sourceWorkType) ? sourceWorkType : 'MERGED');

    const manualPredicate = getManualWorkTypePredicate(pciDomain, effectiveSourceWorkType);

    const [[engineer]] = await conn.query(
      `SELECT id, name, company, \`group\`, site
         FROM engineer
        WHERE id = ?
        LIMIT 1`,
      [engineerId]
    );

    if (!engineer) {
      const err = new Error('엔지니어를 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }

    const [rows] = await conn.query(
      `
      WITH filtered_items AS (
        SELECT id, item_code, item_name, item_name_kr, category, required_count, self_weight, history_max_score, main_weight, support_weight, sort_order, pci_domain
        FROM pci_item
        WHERE is_active = 1
          AND equipment_group_code = ?
          AND pci_domain = ?
      ),
      history_agg AS (
        SELECT
          ds.engineer_id,
          ds.pci_item_id,
          SUM(ds.main_count) AS main_count,
          SUM(ds.support_count) AS support_count,
          SUM(ds.converted_count) AS converted_count,
          SUM(ds.event_count) AS event_count
        FROM pci_daily_summary ds
        WHERE ds.engineer_id = ?
          AND ds.equipment_group_code = ?
          AND ds.pci_domain = ?
          AND ds.source_work_type = ?
          AND ds.task_date BETWEEN ? AND ?
        GROUP BY ds.engineer_id, ds.pci_item_id
      ),
      manual_agg AS (
        SELECT
          mc.engineer_id,
          mc.pci_item_id,
          SUM(mc.main_count_add) AS main_count,
          SUM(mc.support_count_add) AS support_count,
          SUM(mc.converted_count_add + (mc.main_count_add * pi.main_weight) + (mc.support_count_add * pi.support_weight)) AS converted_count,
          COUNT(*) AS event_count
        FROM pci_manual_credit mc
        JOIN pci_item pi
          ON pi.id = mc.pci_item_id
         AND pi.is_active = 1
        WHERE mc.engineer_id = ?
          AND pi.equipment_group_code = ?
          AND pi.pci_domain = ?
          AND mc.is_active = 1
          AND (${manualPredicate.sql})
          AND (mc.effective_date IS NULL OR mc.effective_date BETWEEN ? AND ?)
        GROUP BY mc.engineer_id, mc.pci_item_id
      ),
      self_question_rows AS (
        SELECT
          r.engineer_id,
          sm.pci_item_id,
          UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id)))) AS question_key,
          MAX(CASE WHEN COALESCE(a.is_checked, 0) = 1 THEN 1 ELSE 0 END) AS is_checked
        FROM pci_item_selfcheck_map sm
        JOIN checklist_question q
          ON q.id = sm.checklist_question_id
         AND q.is_active = 1
        JOIN checklist_template t
          ON t.id = q.template_id
         AND t.is_active = 1
        LEFT JOIN checklist_response r
          ON r.template_id = t.id
         AND r.engineer_id = ?
        LEFT JOIN checklist_response_answer a
          ON a.response_id = r.id
         AND a.question_id = q.id
        WHERE sm.is_active = 1
        GROUP BY r.engineer_id, sm.pci_item_id,
          UPPER(TRIM(COALESCE(NULLIF(q.question_code, ''), q.question_text, CONCAT('Q#', q.id))))
      ),
      self_agg AS (
        SELECT
          sq.engineer_id,
          sq.pci_item_id,
          COUNT(*) AS total_questions,
          SUM(CASE WHEN sq.is_checked = 1 THEN 1 ELSE 0 END) AS checked_questions,
          MAX(CASE WHEN sq.is_checked = 1 THEN 1 ELSE 0 END) AS any_checked
        FROM self_question_rows sq
        WHERE sq.engineer_id IS NOT NULL
        GROUP BY sq.engineer_id, sq.pci_item_id
      )
      SELECT
        fi.id AS pci_item_id,
        fi.item_code,
        fi.item_name,
        fi.item_name_kr,
        fi.category,
        fi.required_count,
        COALESCE(sa.any_checked, 0) AS self_completed,
        COALESCE(sa.total_questions, 0) AS self_total_questions,
        COALESCE(sa.checked_questions, 0) AS self_checked_questions,
        CASE
          WHEN fi.pci_domain = 'SETUP' AND COALESCE(sa.total_questions, 0) > 0 THEN ROUND(COALESCE(sa.checked_questions, 0) / sa.total_questions * fi.self_weight, 2)
          WHEN fi.pci_domain = 'MAINT' AND COALESCE(sa.any_checked, 0) = 1 THEN fi.self_weight
          ELSE 0
        END AS self_score,
        COALESCE(ha.main_count, 0) + COALESCE(ma.main_count, 0) AS main_count,
        COALESCE(ha.support_count, 0) + COALESCE(ma.support_count, 0) AS support_count,
        COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0) AS converted_count,
        COALESCE(ha.event_count, 0) + COALESCE(ma.event_count, 0) AS event_count,
        COALESCE(ma.main_count, 0) AS manual_main_count,
        COALESCE(ma.support_count, 0) AS manual_support_count,
        COALESCE(ma.converted_count, 0) AS manual_converted_count,
        COALESCE(ma.event_count, 0) AS manual_event_count,
        ROUND(LEAST((COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0)) / NULLIF(fi.required_count, 0), 1.0) * fi.history_max_score, 2) AS history_score,
        ROUND(
          LEAST(
            CASE
              WHEN fi.pci_domain = 'SETUP' AND COALESCE(sa.total_questions, 0) > 0 THEN COALESCE(sa.checked_questions, 0) / sa.total_questions * fi.self_weight
              WHEN fi.pci_domain = 'MAINT' AND COALESCE(sa.any_checked, 0) = 1 THEN fi.self_weight
              ELSE 0
            END + LEAST((COALESCE(ha.converted_count, 0) + COALESCE(ma.converted_count, 0)) / NULLIF(fi.required_count, 0), 1.0) * fi.history_max_score,
            100
          ),
          2
        ) AS pci_score
      FROM filtered_items fi
      LEFT JOIN history_agg ha ON ha.pci_item_id = fi.id
      LEFT JOIN manual_agg ma ON ma.pci_item_id = fi.id
      LEFT JOIN self_agg sa ON sa.pci_item_id = fi.id AND sa.engineer_id = ?
      ORDER BY fi.category, fi.sort_order, fi.item_name
      `,
      [
        equipmentGroupCode, pciDomain,
        engineerId, equipmentGroupCode, pciDomain, effectiveSourceWorkType, dateFrom, dateTo,
        engineerId, equipmentGroupCode, pciDomain, ...manualPredicate.params, dateFrom, dateTo,
        engineerId,
        engineerId,
      ]
    );

    return { engineer, rows, sourceWorkType: effectiveSourceWorkType };
  } finally {
    conn.release();
  }
}

async function updatePciItem({ userIdx, pciItemId, requiredCount, selfWeight, mainWeight, supportWeight, historyMaxScore, sortOrder, isActive, descriptionText }) {
  const conn = await pool.getConnection();
  try {
    await ensureAdmin(conn, userIdx);
    await conn.query(
      `
      UPDATE pci_item
         SET required_count = ?,
             self_weight = ?,
             main_weight = ?,
             support_weight = ?,
             history_max_score = ?,
             sort_order = ?,
             is_active = ?,
             description_text = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
      `,
      [requiredCount, selfWeight, mainWeight, supportWeight, historyMaxScore, sortOrder, isActive ? 1 : 0, descriptionText || null, pciItemId]
    );

    const [[row]] = await conn.query(`SELECT * FROM pci_item WHERE id = ? LIMIT 1`, [pciItemId]);
    return row || null;
  } finally {
    conn.release();
  }
}

async function rebuildRange({ userIdx, dateFrom, dateTo }) {
  const conn = await pool.getConnection();
  try {
    const admin = await ensureAdmin(conn, userIdx);
    await conn.query(`CALL sp_pci_rebuild_all(?, ?)`, [dateFrom, dateTo]);
    return { ok: true, requested_by: admin.nickname, date_from: dateFrom, date_to: dateTo };
  } finally {
    conn.release();
  }
}

async function getAdminItems({ userIdx, equipmentGroupCode = '', pciDomain = '', keyword = '' }) {
  const conn = await pool.getConnection();
  try {
    await ensureAdmin(conn, userIdx);

    const [rows] = await conn.query(
      `
      SELECT
        pi.*,
        COUNT(DISTINCT sm.id) AS source_map_count,
        COUNT(DISTINCT scm.id) AS selfcheck_map_count
      FROM pci_item pi
      LEFT JOIN pci_item_source_map sm ON sm.pci_item_id = pi.id AND sm.is_active = 1
      LEFT JOIN pci_item_selfcheck_map scm ON scm.pci_item_id = pi.id AND scm.is_active = 1
      WHERE 1=1
        AND (? = '' OR pi.equipment_group_code = ?)
        AND (? = '' OR pi.pci_domain = ?)
        AND (? = '' OR pi.item_name LIKE ? OR pi.item_name_kr LIKE ? OR pi.item_code LIKE ?)
      GROUP BY pi.id
      ORDER BY pi.equipment_group_code, pi.pci_domain, pi.category, pi.sort_order, pi.item_name
      `,
      [equipmentGroupCode, equipmentGroupCode, pciDomain, pciDomain, keyword, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
    );
    return { rows };
  } finally {
    conn.release();
  }
}

async function getManualCredits({ userIdx, engineerId = '', equipmentGroupCode = '', pciDomain = '', keyword = '' }) {
  const conn = await pool.getConnection();
  try {
    await ensureAdmin(conn, userIdx);

    const [rows] = await conn.query(
      `
      SELECT
        mc.id,
        mc.engineer_id,
        e.name AS engineer_name,
        e.company,
        e.\`group\` AS engineer_group,
        e.site AS engineer_site,
        mc.pci_item_id,
        pi.equipment_group_code,
        pi.pci_domain,
        pi.item_code,
        pi.item_name,
        pi.item_name_kr,
        mc.source_work_type,
        mc.main_count_add,
        mc.support_count_add,
        mc.converted_count_add,
        mc.effective_date,
        mc.note,
        mc.is_active,
        mc.created_by,
        u.nickname AS created_by_name,
        mc.created_at,
        mc.updated_at
      FROM pci_manual_credit mc
      JOIN engineer e ON e.id = mc.engineer_id
      JOIN pci_item pi ON pi.id = mc.pci_item_id
      LEFT JOIN Users u ON u.userIdx = mc.created_by
      WHERE 1=1
        AND (? = '' OR mc.engineer_id = ?)
        AND (? = '' OR pi.equipment_group_code = ?)
        AND (? = '' OR pi.pci_domain = ?)
        AND (? = '' OR e.name LIKE ? OR pi.item_name LIKE ? OR pi.item_name_kr LIKE ? OR pi.item_code LIKE ? OR mc.note LIKE ?)
      ORDER BY mc.created_at DESC, mc.id DESC
      `,
      [engineerId, engineerId, equipmentGroupCode, equipmentGroupCode, pciDomain, pciDomain, keyword, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
    );
    return { rows };
  } finally {
    conn.release();
  }
}

async function saveManualCredit({ userIdx, manualCreditId = null, engineerId, pciItemId, sourceWorkType, mainCountAdd, supportCountAdd, convertedCountAdd, effectiveDate, note, isActive = true }) {
  const conn = await pool.getConnection();
  try {
    await ensureAdmin(conn, userIdx);

    const [[item]] = await conn.query(`SELECT id, pci_domain FROM pci_item WHERE id = ? LIMIT 1`, [pciItemId]);
    if (!item) {
      const err = new Error('PCI 항목을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }

    const normalizedWorkType = item.pci_domain === 'MAINT'
      ? 'MAINT'
      : (['SETUP', 'RELOCATION', 'MERGED'].includes(String(sourceWorkType || 'MERGED').toUpperCase()) ? String(sourceWorkType || 'MERGED').toUpperCase() : 'MERGED');

    if (manualCreditId) {
      await conn.query(
        `
        UPDATE pci_manual_credit
           SET engineer_id = ?,
               pci_item_id = ?,
               source_work_type = ?,
               main_count_add = ?,
               support_count_add = ?,
               converted_count_add = ?,
               effective_date = ?,
               note = ?,
               is_active = ?,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
        `,
        [engineerId, pciItemId, normalizedWorkType, mainCountAdd, supportCountAdd, convertedCountAdd, effectiveDate || null, note || null, isActive ? 1 : 0, manualCreditId]
      );
      const [[row]] = await conn.query(`SELECT * FROM pci_manual_credit WHERE id = ? LIMIT 1`, [manualCreditId]);
      return row || null;
    }

    const [result] = await conn.query(
      `
      INSERT INTO pci_manual_credit (
        engineer_id, pci_item_id, source_work_type,
        main_count_add, support_count_add, converted_count_add,
        effective_date, note, is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [engineerId, pciItemId, normalizedWorkType, mainCountAdd, supportCountAdd, convertedCountAdd, effectiveDate || null, note || null, isActive ? 1 : 0, userIdx || null]
    );

    const [[row]] = await conn.query(`SELECT * FROM pci_manual_credit WHERE id = ? LIMIT 1`, [result.insertId]);
    return row || null;
  } finally {
    conn.release();
  }
}

async function deleteManualCredit({ userIdx, manualCreditId }) {
  const conn = await pool.getConnection();
  try {
    await ensureAdmin(conn, userIdx);
    await conn.query(`DELETE FROM pci_manual_credit WHERE id = ?`, [manualCreditId]);
    return { ok: true, id: manualCreditId };
  } finally {
    conn.release();
  }
}


async function getEqIdByEquipmentGroupCode(conn, equipmentGroupCode) {
  const normalized = String(equipmentGroupCode || '').trim().toUpperCase().replace(/\s+/g, '_');
  const [rows] = await conn.query(
    `SELECT id, eq_code, eq_name
       FROM eq_master
      WHERE REPLACE(UPPER(COALESCE(eq_code, '')), ' ', '_') = ?
         OR REPLACE(UPPER(COALESCE(eq_name, '')), ' ', '_') = ?
      ORDER BY id
      LIMIT 1`,
    [normalized, normalized]
  );
  return rows[0] || null;
}

async function upsertCapabilityScores({ userIdx, equipmentGroupCode, rows }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureAdmin(conn, userIdx);

    const eq = await getEqIdByEquipmentGroupCode(conn, equipmentGroupCode);
    if (!eq) {
      const err = new Error(`eq_master 에서 설비군(${equipmentGroupCode})을 찾을 수 없습니다.`);
      err.statusCode = 404;
      throw err;
    }

    let affected = 0;
    for (const row of rows) {
      const engineerId = Number(row.engineer_id);
      const setupScore = Number(row.setup_score || 0);
      const maintScore = Number(row.maint_score || 0);
      const [[exists]] = await conn.query(
        `SELECT id FROM capability_score WHERE engineer_id = ? AND eq_id = ? LIMIT 1`,
        [engineerId, eq.id]
      );

      if (exists) {
        await conn.query(
          `UPDATE capability_score
              SET setup_score = ?,
                  maint_score = ?
            WHERE id = ?`,
          [setupScore, maintScore, exists.id]
        );
      } else {
        await conn.query(
          `INSERT INTO capability_score (engineer_id, eq_id, setup_score, maint_score)
           VALUES (?, ?, ?, ?)`,
          [engineerId, eq.id, setupScore, maintScore]
        );
      }
      affected += 1;
    }

    await conn.commit();
    return { ok: true, eq_id: eq.id, eq_code: eq.eq_code, eq_name: eq.eq_name, affected_rows: affected };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function upsertMonthlyCapability({ userIdx, ym, rows }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureAdmin(conn, userIdx);

    let affected = 0;
    for (const row of rows) {
      const engineerId = Number(row.engineer_id);
      const totalScore = Number(row.total_score || 0);
      const setupScore = Number(row.setup_score || 0);
      const maintScore = Number(row.maint_score || 0);
      const [[exists]] = await conn.query(
        `SELECT id FROM monthly_capability WHERE engineer_id = ? AND ym = ? LIMIT 1`,
        [engineerId, ym]
      );

      if (exists) {
        await conn.query(
          `UPDATE monthly_capability
              SET total_score = ?,
                  setup_score = ?,
                  maint_score = ?
            WHERE id = ?`,
          [totalScore, setupScore, maintScore, exists.id]
        );
      } else {
        await conn.query(
          `INSERT INTO monthly_capability (engineer_id, ym, total_score, setup_score, maint_score)
           VALUES (?, ?, ?, ?, ?)`,
          [engineerId, ym, totalScore, setupScore, maintScore]
        );
      }
      affected += 1;
    }

    await conn.commit();
    return { ok: true, ym, affected_rows: affected };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getActiveEquipmentGroups() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT code, display_name, sort_order
         FROM checklist_equipment_group
        WHERE is_active = 1
        ORDER BY sort_order, code`
    );
    return rows;
  } finally {
    conn.release();
  }
}

module.exports = {
  resolveUserIdx,
  getFilterOptions,
  getMatrix,
  getCellDetail,
  getEngineerDetail,
  updatePciItem,
  rebuildRange,
  getAdminItems,
  getManualCredits,
  saveManualCredit,
  deleteManualCredit,
  upsertCapabilityScores,
  upsertMonthlyCapability,
  getActiveEquipmentGroups,

  async function getCapabilityEquipmentRows() {
  const conn = await pool.getConnection();

  try {
    const [rows] = await conn.query(`
      SELECT
        cs.engineer_id,
        cs.eq_id,
        em.eq_code,
        em.eq_name
      FROM capability_score cs
      JOIN eq_master em
        ON em.id = cs.eq_id
    `);

    return rows || [];
  } finally {
    conn.release();
  }
}
};
