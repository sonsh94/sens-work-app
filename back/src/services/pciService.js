'use strict';

const pciDao = require('../dao/pciDao');
const { pool } = require('../../config/database');

function normalizeDomain(v) {
  const value = String(v || 'SETUP').trim().toUpperCase();
  return value === 'MAINT' ? 'MAINT' : 'SETUP';
}

function normalizeDate(value, fallback) {
  const v = String(value || '').trim();

  if (!v) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;

  return v;
}

function getLocalToday() {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function normalizeSourceWorkType(domain, value) {
  const v = String(value || '').trim().toUpperCase();

  if (domain === 'MAINT') return 'MAINT';
  if (['SETUP', 'RELOCATION', 'MERGED'].includes(v)) return v;

  return 'MERGED';
}

function shapeMatrixResult(raw) {
  const engineerMap = new Map();
  const itemMap = new Map();
  const cellMap = new Map();
  const engineerScoreBuckets = new Map();

  for (const row of raw.rows || []) {
    if (!engineerMap.has(row.engineer_id)) {
      engineerMap.set(row.engineer_id, {
        engineer_id: row.engineer_id,
        engineer_name: row.engineer_name,
        company: row.company,
        group: row.engineer_group,
        site: row.engineer_site,
      });
    }

    if (!itemMap.has(row.pci_item_id)) {
      itemMap.set(row.pci_item_id, {
        pci_item_id: row.pci_item_id,
        item_code: row.item_code,
        item_name: row.item_name,
        item_name_kr: row.item_name_kr,
        category: row.category,
        required_count: Number(row.required_count),
      });
    }

    const cell = {
      engineer_id: row.engineer_id,
      pci_item_id: row.pci_item_id,
      self_completed: !!row.self_completed,
      self_total_questions: Number(row.self_total_questions || 0),
      self_checked_questions: Number(row.self_checked_questions || 0),
      self_score: Number(row.self_score || 0),
      main_count: Number(row.main_count || 0),
      support_count: Number(row.support_count || 0),
      converted_count: Number(row.converted_count || 0),
      event_count: Number(row.event_count || 0),
      manual_main_count: Number(row.manual_main_count || 0),
      manual_support_count: Number(row.manual_support_count || 0),
      manual_converted_count: Number(row.manual_converted_count || 0),
      manual_event_count: Number(row.manual_event_count || 0),
      history_score: Number(row.history_score || 0),
      pci_score: Number(row.pci_score || 0),
    };

    cellMap.set(`${row.pci_item_id}:${row.engineer_id}`, cell);

    if (!engineerScoreBuckets.has(row.engineer_id)) {
      engineerScoreBuckets.set(row.engineer_id, []);
    }

    engineerScoreBuckets.get(row.engineer_id).push(cell.pci_score);
  }

  const engineerAverages = [...engineerScoreBuckets.entries()].map(
    ([engineerId, scores]) => ({
      engineer_id: engineerId,
      avg_pci: Number(
        (
          scores.reduce((a, b) => a + b, 0) /
          (scores.length || 1)
        ).toFixed(2)
      ),
    })
  );

  const allScores = [...cellMap.values()].map((row) => row.pci_score);

  const overallAverage = allScores.length
    ? Number(
        (
          allScores.reduce((a, b) => a + b, 0) /
          allScores.length
        ).toFixed(2)
      )
    : 0;

  return {
    engineers: [...engineerMap.values()],
    items: [...itemMap.values()],
    cells: [...cellMap.values()],
    engineer_averages: engineerAverages,
    summary: {
      engineer_count: engineerMap.size,
      item_count: itemMap.size,
      avg_pci: overallAverage,
    },
    meta: {
      source_work_type: raw.sourceWorkType,
    },
  };
}

async function getMatrix(params) {
  const pciDomain = normalizeDomain(
    params.pciDomain || params.domain
  );

  const dateFrom = normalizeDate(
    params.dateFrom || params.date_from,
    '2025-01-01'
  );

  const dateTo = normalizeDate(
    params.dateTo || params.date_to,
    getLocalToday()
  );

  const sourceWorkType = normalizeSourceWorkType(
    pciDomain,
    params.sourceWorkType || params.source_work_type
  );

  if (!params.equipmentGroupCode && !params.equipment_group) {
    const err = new Error('equipment_group 값이 필요합니다.');
    err.statusCode = 400;
    throw err;
  }

  const raw = await pciDao.getMatrix({
    equipmentGroupCode:
      params.equipmentGroupCode || params.equipment_group,
    pciDomain,
    engineerGroup:
      params.engineerGroup || params.group || '',
    site: params.site || '',
    keyword: params.keyword || '',
    dateFrom,
    dateTo,
    sourceWorkType,
  });

  return {
    ...shapeMatrixResult(raw),
    filters: {
      equipment_group:
        params.equipmentGroupCode || params.equipment_group,
      pci_domain: pciDomain,
      engineer_group:
        params.engineerGroup || params.group || '',
      site: params.site || '',
      keyword: params.keyword || '',
      date_from: dateFrom,
      date_to: dateTo,
      source_work_type: raw.sourceWorkType,
    },
  };
}

async function getCellDetail(params) {
  const dateFrom = normalizeDate(
    params.dateFrom || params.date_from,
    '2025-01-01'
  );

  const dateTo = normalizeDate(
    params.dateTo || params.date_to,
    getLocalToday()
  );

  const engineerId = Number(
    params.engineerId || params.engineer_id
  );

  const pciItemId = Number(
    params.pciItemId || params.pci_item_id
  );

  if (!engineerId || !pciItemId) {
    const err = new Error(
      'engineer_id 와 pci_item_id 가 필요합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  const raw = await pciDao.getCellDetail({
    engineerId,
    pciItemId,
    dateFrom,
    dateTo,
    sourceWorkType: String(
      params.sourceWorkType ||
      params.source_work_type ||
      ''
    ).toUpperCase(),
  });

  const summary = raw.summary || {};
  const requiredCount = Number(summary.required_count || 0);
  const convertedCount = Number(summary.converted_count || 0);

  const historyRatio =
    requiredCount > 0
      ? Math.min(convertedCount / requiredCount, 1)
      : 0;

  const historyScore = Number(
    (
      historyRatio *
      Number(summary.history_max_score || 80)
    ).toFixed(2)
  );

  const selfScore = Number(summary.self_score || 0);

  const pciScore = Number(
    Math.min(selfScore + historyScore, 100).toFixed(2)
  );

  return {
    engineer: raw.engineer,
    item: raw.item,
    summary: {
      ...summary,
      main_count: Number(summary.main_count || 0),
      support_count: Number(summary.support_count || 0),
      converted_count: convertedCount,
      event_count: Number(summary.event_count || 0),
      manual_main_count: Number(
        summary.manual_main_count || 0
      ),
      manual_support_count: Number(
        summary.manual_support_count || 0
      ),
      manual_converted_count: Number(
        summary.manual_converted_count || 0
      ),
      manual_event_count: Number(
        summary.manual_event_count || 0
      ),
      self_score: selfScore,
      self_completed: !!summary.self_completed,
      self_total_questions: Number(
        summary.self_total_questions || 0
      ),
      self_checked_questions: Number(
        summary.self_checked_questions || 0
      ),
      history_ratio: Number(historyRatio.toFixed(4)),
      history_score: historyScore,
      pci_score: pciScore,
    },
    self_questions: raw.self_questions || [],
    events: raw.events || [],
    filters: {
      date_from: dateFrom,
      date_to: dateTo,
      source_work_type: raw.source_work_type,
    },
  };
}

async function getEngineerDetail(params) {
  const pciDomain = normalizeDomain(
    params.pciDomain || params.domain
  );

  const dateFrom = normalizeDate(
    params.dateFrom || params.date_from,
    '2025-01-01'
  );

  const dateTo = normalizeDate(
    params.dateTo || params.date_to,
    getLocalToday()
  );

  const engineerId = Number(
    params.engineerId || params.engineer_id
  );

  if (!engineerId) {
    const err = new Error('engineer_id 가 필요합니다.');
    err.statusCode = 400;
    throw err;
  }

  const raw = await pciDao.getEngineerDetail({
    engineerId,
    equipmentGroupCode:
      params.equipmentGroupCode ||
      params.equipment_group,
    pciDomain,
    dateFrom,
    dateTo,
    sourceWorkType: normalizeSourceWorkType(
      pciDomain,
      params.sourceWorkType ||
      params.source_work_type
    ),
  });

  return {
    engineer: raw.engineer,
    rows: raw.rows || [],
    filters: {
      equipment_group:
        params.equipmentGroupCode ||
        params.equipment_group,
      pci_domain: pciDomain,
      date_from: dateFrom,
      date_to: dateTo,
      source_work_type: raw.sourceWorkType,
    },
  };
}

async function getFilterOptions() {
  return await pciDao.getFilterOptions();
}

async function getAdminItems({ userIdx, params }) {
  return await pciDao.getAdminItems({
    userIdx,
    equipmentGroupCode:
      params.equipmentGroupCode ||
      params.equipment_group ||
      '',
    pciDomain: String(
      params.pciDomain ||
      params.domain ||
      ''
    ).toUpperCase(),
    keyword: params.keyword || '',
  });
}

async function updatePciItem({
  userIdx,
  pciItemId,
  body,
}) {
  const requiredCount = Number(body.required_count);
  const selfWeight = Number(body.self_weight ?? 20);
  const mainWeight = Number(body.main_weight ?? 1);
  const supportWeight = Number(body.support_weight ?? 0.1);
  const historyMaxScore = Number(
    body.history_max_score ?? 80
  );
  const sortOrder = Number(body.sort_order ?? 999);

  if (
    !Number.isFinite(requiredCount) ||
    requiredCount <= 0
  ) {
    const err = new Error(
      'required_count 는 0보다 커야 합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  return await pciDao.updatePciItem({
    userIdx,
    pciItemId: Number(pciItemId),
    requiredCount,
    selfWeight,
    mainWeight,
    supportWeight,
    historyMaxScore,
    sortOrder,
    isActive:
      body.is_active !== false &&
      body.is_active !== 0,
    descriptionText: body.description_text || '',
  });
}

async function rebuildRange({ userIdx, body }) {
  const dateFrom = normalizeDate(
    body.date_from || body.dateFrom,
    '2025-01-01'
  );

  const dateTo = normalizeDate(
    body.date_to || body.dateTo,
    getLocalToday()
  );

  return await pciDao.rebuildRange({
    userIdx,
    dateFrom,
    dateTo,
  });
}

async function getManualCredits({ userIdx, params }) {
  return await pciDao.getManualCredits({
    userIdx,
    engineerId:
      params.engineerId ||
      params.engineer_id ||
      '',
    equipmentGroupCode:
      params.equipmentGroupCode ||
      params.equipment_group ||
      '',
    pciDomain: String(
      params.pciDomain ||
      params.domain ||
      ''
    ).toUpperCase(),
    keyword: params.keyword || '',
  });
}

async function saveManualCredit({
  userIdx,
  manualCreditId,
  body,
}) {
  const engineerId = Number(body.engineer_id);
  const pciItemId = Number(body.pci_item_id);
  const mainCountAdd = Number(
    body.main_count_add ?? 0
  );
  const supportCountAdd = Number(
    body.support_count_add ?? 0
  );
  const convertedCountAdd = Number(
    body.converted_count_add ?? 0
  );

  if (!engineerId || !pciItemId) {
    const err = new Error(
      'engineer_id 와 pci_item_id 가 필요합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  if (
    ![
      mainCountAdd,
      supportCountAdd,
      convertedCountAdd,
    ].some(
      (v) => Number.isFinite(v) && v !== 0
    )
  ) {
    const err = new Error(
      '가산할 main/support/converted 값 중 하나는 0보다 커야 합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  return await pciDao.saveManualCredit({
    userIdx,
    manualCreditId: manualCreditId
      ? Number(manualCreditId)
      : null,
    engineerId,
    pciItemId,
    mainCountAdd,
    supportCountAdd,
    convertedCountAdd,
    effectiveDate: normalizeDate(
      body.effective_date ||
      body.effectiveDate,
      ''
    ),
    note: body.note || '',
    isActive:
      body.is_active !== false &&
      body.is_active !== 0,
  });
}

function average(values) {
  if (!values || !values.length) return 0;

  return (
    values.reduce((a, b) => a + b, 0) /
    values.length
  );
}

function normalizeEquipmentKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getEquipmentKeys(...values) {
  const keys = new Set();

  for (const value of values) {
    const key = normalizeEquipmentKey(value);

    if (key) keys.add(key);
  }

  return keys;
}

function hasMatchingEquipmentKey(allowedKeys, targetKeys) {
  if (!allowedKeys || !targetKeys) return false;

  for (const key of targetKeys) {
    if (allowedKeys.has(key)) return true;
  }

  return false;
}

/**
 * capability_score에 등록된 사원별 설비 목록을 가져온다.
 *
 * pciDao.js를 수정하지 않기 위해
 * 이 서비스에서 DB를 직접 조회한다.
 */
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

function normalizeMonth(value) {
  const v = String(value || '').trim();

  if (!/^\d{4}-\d{2}$/.test(v)) {
    const err = new Error(
      'ym 은 YYYY-MM 형식이어야 합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  return v;
}

/**
 * 각 월의 시작일부터 계산하는 것이 아니라
 * 2024-01-01부터 해당 월 말일까지 누적 계산한다.
 */
function getMonthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0));

  const fmt = (d) =>
    `${d.getUTCFullYear()}-${String(
      d.getUTCMonth() + 1
    ).padStart(2, '0')}-${String(
      d.getUTCDate()
    ).padStart(2, '0')}`;

  return {
    dateFrom: '2024-01-01',
    dateTo: fmt(end),
  };
}

async function syncCapabilityScore({
  userIdx,
  body,
}) {
  const equipmentGroupCode = String(
    body.equipment_group ||
    body.equipmentGroupCode ||
    ''
  ).trim();

  if (!equipmentGroupCode) {
    const err = new Error(
      'equipment_group 값이 필요합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  const dateFrom = normalizeDate(
    body.date_from || body.dateFrom,
    '2025-01-01'
  );

  const dateTo = normalizeDate(
    body.date_to || body.dateTo,
    getLocalToday()
  );

  const common = {
    equipment_group: equipmentGroupCode,
    group: body.group || '',
    site: body.site || '',
    keyword: body.keyword || '',
    date_from: dateFrom,
    date_to: dateTo,
  };

  const [setup, maint] = await Promise.all([
    getMatrix({
      ...common,
      domain: 'SETUP',
      source_work_type:
        body.source_work_type ||
        body.sourceWorkType ||
        'MERGED',
    }),
    getMatrix({
      ...common,
      domain: 'MAINT',
      source_work_type: 'MAINT',
    }),
  ]);

  const map = new Map();

  for (const row of setup.engineers || []) {
    if (!map.has(row.engineer_id)) {
      map.set(row.engineer_id, {
        engineer_id: row.engineer_id,
        engineer_name: row.engineer_name,
        setup_score: 0,
        maint_score: 0,
      });
    }
  }

  for (const row of maint.engineers || []) {
    if (!map.has(row.engineer_id)) {
      map.set(row.engineer_id, {
        engineer_id: row.engineer_id,
        engineer_name: row.engineer_name,
        setup_score: 0,
        maint_score: 0,
      });
    }
  }

  for (
    const row of setup.engineer_averages || []
  ) {
    if (!map.has(row.engineer_id)) {
      map.set(row.engineer_id, {
        engineer_id: row.engineer_id,
        engineer_name: '',
        setup_score: 0,
        maint_score: 0,
      });
    }

    map.get(row.engineer_id).setup_score =
      Number(
        (
          Number(row.avg_pci || 0) / 100
        ).toFixed(6)
      );
  }

  for (
    const row of maint.engineer_averages || []
  ) {
    if (!map.has(row.engineer_id)) {
      map.set(row.engineer_id, {
        engineer_id: row.engineer_id,
        engineer_name: '',
        setup_score: 0,
        maint_score: 0,
      });
    }

    map.get(row.engineer_id).maint_score =
      Number(
        (
          Number(row.avg_pci || 0) / 100
        ).toFixed(6)
      );
  }

  const rows = [...map.values()];

  const result =
    await pciDao.upsertCapabilityScores({
      userIdx,
      equipmentGroupCode,
      rows,
    });

  return {
    ...result,
    filters: {
      ...common,
      source_work_type:
        body.source_work_type ||
        body.sourceWorkType ||
        'MERGED',
    },
    rows,
  };
}

/**
 * 월별 CAPA 생성
 *
 * 계산 기준:
 * 1. 2024-01-01부터 해당 월 말일까지 누적 계산
 * 2. 0점 항목 제외
 * 3. 각 사원의 capability_score에 등록된 설비만 포함
 * 4. 다른 설비군 점수는 월별 평균에서 제외
 */
async function syncMonthlyCapability({
  userIdx,
  body,
}) {
  const ym = normalizeMonth(body.ym);

  const { dateFrom, dateTo } =
    getMonthRange(ym);

  const common = {
    group: body.group || '',
    site: body.site || '',
    keyword: body.keyword || '',
    date_from: dateFrom,
    date_to: dateTo,
  };

  const setupSourceWorkType = String(
    body.source_work_type ||
    body.sourceWorkType ||
    'MERGED'
  )
    .trim()
    .toUpperCase();

  const [
    groups,
    capabilityEquipmentRows,
  ] = await Promise.all([
    pciDao.getActiveEquipmentGroups(),
    getCapabilityEquipmentRows(),
  ]);

  /**
   * 사원별 등록 설비 목록
   *
   * 예:
   * engineer_id 10
   * → SUPRA N
   * → SUPRA XP
   */
  const allowedEquipmentMap = new Map();

  for (
    const row of capabilityEquipmentRows
  ) {
    const engineerId = Number(
      row.engineer_id
    );

    if (!engineerId) continue;

    if (
      !allowedEquipmentMap.has(engineerId)
    ) {
      allowedEquipmentMap.set(
        engineerId,
        new Set()
      );
    }

    const allowed =
      allowedEquipmentMap.get(engineerId);

    const equipmentKeys = getEquipmentKeys(
      row.eq_id,
      row.eq_code,
      row.eq_name
    );

    for (const key of equipmentKeys) {
      allowed.add(key);
    }
  }

  const bucket = new Map();

  function ensureBucket(engineerId) {
    if (!bucket.has(engineerId)) {
      bucket.set(engineerId, {
        engineer_id: engineerId,
        setup: [],
        maint: [],
      });
    }

    return bucket.get(engineerId);
  }

  /**
   * 0점이 아닌 PCI 항목만 사용하여
   * 사원별 설비 평균을 계산한다.
   */
  function averagePositiveScoresByEngineer(
    cells
  ) {
    const scoreMap = new Map();

    for (const cell of cells || []) {
      const engineerId = Number(
        cell.engineer_id
      );

      const score = Number(
        cell.pci_score || 0
      );

      if (
        !engineerId ||
        !Number.isFinite(score) ||
        score <= 0
      ) {
        continue;
      }

      if (!scoreMap.has(engineerId)) {
        scoreMap.set(engineerId, []);
      }

      scoreMap
        .get(engineerId)
        .push(score / 100);
    }

    const result = new Map();

    for (
      const [
        engineerId,
        scores,
      ] of scoreMap.entries()
    ) {
      result.set(
        engineerId,
        average(scores)
      );
    }

    return result;
  }

  for (const groupRow of groups) {
    const equipmentGroupCode =
      groupRow.code ||
      groupRow.equipment_group_code ||
      groupRow.eq_code ||
      groupRow.eq_name;

    if (!equipmentGroupCode) continue;

    /*
     * 화면/PCI/eq_master에서 설비명이 서로
     * SUPRA_N, SUPRA N, SUPRAN처럼 달라도
     * 같은 설비로 인식하도록 가능한 키를 모두 만든다.
     */
    const equipmentGroupKeys =
      getEquipmentKeys(
        groupRow.id,
        groupRow.eq_id,
        groupRow.code,
        groupRow.equipment_group_code,
        groupRow.eq_code,
        groupRow.eq_name,
        equipmentGroupCode
      );

    const [setup, maint] =
      await Promise.all([
        getMatrix({
          ...common,
          equipment_group:
            equipmentGroupCode,
          domain: 'SETUP',
          source_work_type:
            setupSourceWorkType ||
            'MERGED',
        }),
        getMatrix({
          ...common,
          equipment_group:
            equipmentGroupCode,
          domain: 'MAINT',
          source_work_type: 'MAINT',
        }),
      ]);

    const setupMap =
      averagePositiveScoresByEngineer(
        setup.cells || []
      );

    const maintMap =
      averagePositiveScoresByEngineer(
        maint.cells || []
      );

    const engineerIds = new Set([
      ...setupMap.keys(),
      ...maintMap.keys(),
    ]);

    for (const engineerId of engineerIds) {
      const allowedEquipment =
        allowedEquipmentMap.get(
          Number(engineerId)
        );

      /*
       * capability_score에 등록되지 않은
       * 설비군이면 계산에서 제외
       */
      if (
        !hasMatchingEquipmentKey(
          allowedEquipment,
          equipmentGroupKeys
        )
      ) {
        continue;
      }

      const target =
        ensureBucket(engineerId);

      const setupScore =
        setupMap.get(engineerId);

      const maintScore =
        maintMap.get(engineerId);

      if (
        Number.isFinite(setupScore) &&
        setupScore > 0
      ) {
        target.setup.push(setupScore);
      }

      if (
        Number.isFinite(maintScore) &&
        maintScore > 0
      ) {
        target.maint.push(maintScore);
      }
    }
  }

  const rows = [...bucket.values()].map(
    (row) => {
      const setupScore =
        average(row.setup);

      const maintScore =
        average(row.maint);

      const validScores = [
        setupScore,
        maintScore,
      ].filter((score) => score > 0);

      return {
        engineer_id: row.engineer_id,
        setup_score: Number(
          setupScore.toFixed(6)
        ),
        maint_score: Number(
          maintScore.toFixed(6)
        ),
        total_score: Number(
          average(validScores).toFixed(6)
        ),
      };
    }
  );

  const result =
    await pciDao.upsertMonthlyCapability({
      userIdx,
      ym,
      rows,
    });

  return {
    ...result,
    ym,
    date_from: dateFrom,
    date_to: dateTo,
    source_work_type:
      setupSourceWorkType || 'MERGED',
    rows,
  };
}

async function deleteManualCredit({
  userIdx,
  manualCreditId,
}) {
  const id = Number(manualCreditId);

  if (!id) {
    const err = new Error(
      'manual credit id 가 필요합니다.'
    );
    err.statusCode = 400;
    throw err;
  }

  return await pciDao.deleteManualCredit({
    userIdx,
    manualCreditId: id,
  });
}

module.exports = {
  getFilterOptions,
  getMatrix,
  getCellDetail,
  getEngineerDetail,
  getAdminItems,
  updatePciItem,
  rebuildRange,
  getManualCredits,
  saveManualCredit,
  deleteManualCredit,
  syncCapabilityScore,
  syncMonthlyCapability,
};
