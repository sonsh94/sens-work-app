'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/dao/checklistDao.js'), 'utf8');
const groups = ['SUPRA_N', 'SUPRA_XP', 'INTEGER', 'PRECIA', 'ECOLITE', 'GENEVA', 'HDW']
  .map((code, index) => ({ code, display_name: code, sort_order: index, is_active: 1 }));

function fixture(registered = [], group = 'PEE1', engineerId = 176) {
  const calls = [];
  let rolledBack = false;
  const conn = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM Users')) return [[{ userIdx: 23393, nickname: '오세훈', group, role: 'worker' }]];
      if (sql.includes('FROM user_engineer_map')) return [[{ id: engineerId, group, main_eq_id: 4, multi_eq_id: 1 }]];
      if (sql.includes('FROM checklist_equipment_group')) return [groups];
      if (sql.includes('JOIN eq_master')) return [registered];
      if (sql.includes('FROM engineer') && !sql.includes('JOIN')) return [[{ id: engineerId, group, main_eq_id: 4, multi_eq_id: 1 }]];
      if (sql.includes('FROM checklist_engineer_access_override')) return [[{ equipment_group_code: 'SUPRA_XP', access_type: 'ALLOW' }]];
      if (sql.includes('FROM checklist_template t')) {
        return [[{ equipment_group_code: 'SUPRA_N', checklist_kind: 'SETUP' }, { equipment_group_code: 'PRECIA', checklist_kind: 'SETUP' }]];
      }
      throw new Error('Unexpected SQL: ' + sql);
    },
    async beginTransaction() {},
    async rollback() { rolledBack = true; },
    release() {},
  };
  const sandbox = {
    exports: {},
    require(id) {
      if (id === '../../config/database') return { pool: { async getConnection() { return conn; } } };
      if (id === '../config/checklistCatalog') return {};
      throw new Error('Unexpected require: ' + id);
    },
  };
  vm.runInNewContext(source + '\nexports.__test = { getAccessMap, ensureTemplateAccess, checklistEquipmentCode };', sandbox);
  return { dao: sandbox.exports, conn, calls, didRollback: () => rolledBack };
}
const preciaAndN = [{ eq_code: 'PRECIA', eq_name: 'PRECIA' }, { eq_code: 'SUPRA_N', eq_name: 'SUPRA N' }];
const allowed = rows => Array.from(rows.filter(row => row.allowed), row => row.code);

test('PEE1 engineer sees registered PRECIA and SUPRA N, in main/multi order', async () => {
  const f = fixture(preciaAndN);
  assert.deepEqual(allowed(await f.dao.__test.getAccessMap(f.conn, 176)), ['PRECIA', 'SUPRA_N']);
  assert.equal(f.calls.some(call => /checklist_group_equipment_access|checklist_engineer_access_override/.test(call.sql)), false);
});
test('group changes cannot alter equipment', async () => {
  for (const group of ['PEE1', 'PEE2', 'PSKH']) {
    const f = fixture(preciaAndN, group);
    assert.deepEqual(allowed(await f.dao.__test.getAccessMap(f.conn, 176)), ['PRECIA', 'SUPRA_N']);
  }
});
test('both reported engineer ids use their own registration query', async () => {
  for (const id of [176, 177]) {
    const f = fixture(preciaAndN, 'PEE1', id);
    const result = await f.dao.getCurrentUserProfile(23393);
    assert.deepEqual(allowed(result.access), ['PRECIA', 'SUPRA_N']);
    assert.equal(f.calls.find(call => call.sql.includes('JOIN eq_master')).params[0], id);
  }
});
test('missing registration grants no default equipment', async () => {
  const f = fixture();
  assert.deepEqual(allowed(await f.dao.__test.getAccessMap(f.conn, 176)), []);
  assert.deepEqual(allowed(await f.dao.__test.getAccessMap(f.conn, null)), []);
});
test('duplicate main/multi and unknown models do not grant extra access', async () => {
  const f = fixture([{ eq_code: 'SUPRA_N' }, { eq_code: 'SUPRA_N' }, { eq_code: 'UNKNOWN' }]);
  assert.deepEqual(allowed(await f.dao.__test.getAccessMap(f.conn, 176)), ['SUPRA_N']);
});
test('supported eq_master spellings resolve to checklist codes', () => {
  const f = fixture();
  for (const [value, expected] of [['SUPRA N', 'SUPRA_N'], ['SUPRA XP', 'SUPRA_XP'], ['INTEGER Plus', 'INTEGER'], ['ECOLITE(300)', 'ECOLITE'], ['GENEVA', 'GENEVA'], ['HDW', 'HDW']]) {
    assert.equal(f.dao.__test.checklistEquipmentCode({ eq_code: value }), expected);
    assert.equal(f.dao.__test.checklistEquipmentCode({ eq_code: 'OTHER', eq_name: value }), expected);
  }
});
test('available templates query contains only registered equipment and is main first', async () => {
  const f = fixture(preciaAndN);
  const result = await f.dao.getAvailableTemplatesForUser(23393);
  assert.deepEqual(Array.from(result.rows, row => row.equipment_group_code), ['PRECIA', 'SUPRA_N']);
  const call = f.calls.find(call => call.sql.includes('FROM checklist_template t'));
  assert.deepEqual(Array.from(call.params[1]), ['PRECIA', 'SUPRA_N']);
});
test('unregistered template reads and checklist saves are rejected before mutation', async () => {
  for (const method of ['getTemplate', 'getMyChecklist', 'saveMyChecklist']) {
    const f = fixture(preciaAndN);
    await assert.rejects(f.dao[method]({ userIdx: 23393, equipmentGroupCode: 'SUPRA_XP', checklistKind: 'SETUP', answers: [] }), error => error.statusCode === 403);
    assert.equal(f.calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)), false);
    if (method === 'saveMyChecklist') assert.equal(f.didRollback(), true);
  }
});
test('admin access summary reflects registration and ignores legacy overrides', async () => {
  const f = fixture(preciaAndN);
  const result = await f.dao.getEngineerAccess(176);
  assert.equal(result.policy, 'REGISTERED_EQUIPMENT');
  assert.deepEqual(allowed(result.default_access), ['PRECIA', 'SUPRA_N']);
  assert.deepEqual(allowed(result.final_access), ['PRECIA', 'SUPRA_N']);
  assert.equal(result.overrides.length, 0);
  assert.equal(result.legacy_overrides.length, 1);
});
test('new overrides cannot bypass fixed equipment policy', async () => {
  const f = fixture(preciaAndN);
  await assert.rejects(f.dao.upsertEngineerAccessOverride({ engineerId: 176, equipmentGroupCode: 'SUPRA_XP', accessType: 'ALLOW' }), error => error.statusCode === 409);
  assert.equal(f.calls.length, 0);
});
