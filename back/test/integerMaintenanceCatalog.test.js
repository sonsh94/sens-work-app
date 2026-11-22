'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groups, items, planCatalog } = require('../src/pci/integer/maintenanceCatalog');
const { BASELINE } = require('../src/pci/integer/pciConfig');
const { migrate, moveReferences } = require('../scripts/reclassify-integer-maint');
const legacy = () => Object.keys(BASELINE).map((item_name, i) => ({ id: i + 1, item_name, is_active: 1 }));

test('catalog matches the requested 61 items in six ordered groups', () => {
  assert.deepEqual(groups.map(([name, rows]) => [name, rows.length]), [['EFEM', 3], ['TM', 7], ['Load Lock', 9], ['PM', 15], ['AM', 5], ['ETC', 22]]);
  assert.equal(items.length, 61);
  assert.equal(new Set(items.map(i => i.name)).size, 61);
});
test('legacy PM items keep their IDs and new AM/SW items start empty', () => {
  const rows = legacy();
  const plan = planCatalog(rows);
  assert(plan.ready);
  assert.deepEqual(plan.creates.map(i => i.name), ['통다발(S/W)', 'AM FLANGE ADAPTOR', 'AM PIN BELLOWS', 'AM UNDER COVER']);
  for (const name of ['FLANGE ADAPTOR', 'PIN BELLOWS', 'UNDER COVER']) {
    const old = rows.find(r => r.item_name === name);
    assert.equal(plan.updates.find(u => u.id === old.id).item.name, `PM ${name}`);
  }
});
test('BUSH, MAIN SHAFT, BELLOWS all map to one hardware target', () => {
  const rows = legacy();
  const plan = planCatalog(rows);
  const target = plan.updates.find(u => u.item.name.startsWith('통다발(H/W)')).id;
  const sourceIds = ['BUSH', 'MAIN SHAFT', 'BELLOWS'].map(name => rows.find(r => r.item_name === name).id);
  assert.deepEqual(new Set([target, ...plan.merges.map(m => m.from)]), new Set(sourceIds));
  assert(plan.merges.every(m => m.to === target));
  assert(!plan.updates.some(u => u.item.name === 'BALL SCREW ASSY' && u.id === target));
});
test('repeating the migration does not create or move items again', () => {
  const plan = planCatalog(items.map((item, i) => ({ id: i + 1, item_name: item.name, is_active: 1 })));
  assert(plan.ready);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.merges, []);
});
test('missing hardware source or duplicate item prevents application', () => {
  assert(!planCatalog(legacy().filter(r => r.item_name !== 'BELLOWS')).ready);
  assert(!planCatalog([...legacy(), { id: 999, item_name: 'EPC', is_active: 1 }]).ready);
});
test('dry run performs no writes and rolls back', async () => {
  const calls = [];
  const conn = { beginTransaction: async () => calls.push('begin'), query: async sql => { calls.push(sql); return [legacy()]; }, rollback: async () => calls.push('rollback') };
  const plan = await migrate(conn);
  assert(plan.ready);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1), 'rollback');
});
test('daily collisions sum credit counters instead of ignoring them', async () => {
  const calls = [];
  const columns = ['pci_item_id', 'engineer_id', 'main_count', 'support_count', 'converted_count', 'event_count'].map(Field => ({ Field, Extra: '' }));
  const conn = { query: async (sql, args) => { calls.push({ sql, args }); return [columns]; } };
  await moveReferences(conn, 'pci_daily_summary', 2, 1);
  assert.match(calls[1].sql, /ON DUPLICATE KEY UPDATE/);
  for (const name of ['main_count', 'support_count', 'converted_count', 'event_count']) assert(calls[1].sql.includes(`VALUES(\`${name}\`)`));
  assert.deepEqual(calls[1].args, [1, 2]);
  assert.match(calls[2].sql, /^DELETE/);
});
test('failed insertion never deletes the original credit', async () => {
  const calls = [];
  const conn = { query: async sql => {
    calls.push(sql);
    if (sql.startsWith('SHOW')) return [[{ Field: 'pci_item_id', Extra: '' }, { Field: 'main_count', Extra: '' }]];
    throw new Error('insert failed');
  } };
  await assert.rejects(moveReferences(conn, 'pci_daily_summary', 2, 1), /insert failed/);
  assert(!calls.some(sql => sql.startsWith('DELETE')));
});
