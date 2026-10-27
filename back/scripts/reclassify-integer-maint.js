'use strict';

const { planCatalog } = require('../src/pci/integer/maintenanceCatalog');
const quote = name => '`' + name.replace(/`/g, '``') + '`';

// Keep the source work logs and checklist answers intact. Only PCI references
// move. Duplicate daily buckets add their counters rather than losing credits.
async function moveReferences(conn, table, from, to) {
  const [columns] = await conn.query(`SHOW COLUMNS FROM ${quote(table)}`);
  const writable = columns.filter(c => !/auto_increment|GENERATED/i.test(c.Extra || ''));
  const names = writable.map(c => c.Field);
  if (!names.includes('pci_item_id')) throw new Error(`${table}: pci_item_id missing`);
  if (table === 'pci_manual_credit') {
    await conn.query(`UPDATE ${quote(table)} SET pci_item_id = ? WHERE pci_item_id = ?`, [to, from]);
    return;
  }
  const additive = names.filter(n => /^(main_count|support_count|converted_count|event_count|weight|main_weight|support_weight)$/.test(n));
  const mapping = ['pci_item_source_map', 'pci_item_selfcheck_map'].includes(table);
  if (!mapping && !additive.length) throw new Error(`${table}: unsupported aggregation columns; rolled back`);
  const assignments = additive.map(n => `${quote(n)} = COALESCE(${quote(n)}, 0) + COALESCE(VALUES(${quote(n)}), 0)`);
  if (mapping && names.includes('is_active')) assignments.push('is_active = GREATEST(is_active, VALUES(is_active))');
  if (!assignments.length) assignments.push('pci_item_id = pci_item_id');
  await conn.query(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')})
    SELECT ${names.map(n => n === 'pci_item_id' ? '?' : quote(n)).join(', ')}
    FROM ${quote(table)} WHERE pci_item_id = ?
    ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`, [to, from]);
  await conn.query(`DELETE FROM ${quote(table)} WHERE pci_item_id = ?`, [from]);
}

async function migrate(conn, apply = false) {
  await conn.beginTransaction();
  try {
    const [rows] = await conn.query(`SELECT * FROM pci_item
      WHERE equipment_group_code = ? AND pci_domain = ? FOR UPDATE`, ['INTEGER', 'MAINT']);
    const plan = planCatalog(rows);
    if (!apply) { await conn.rollback(); return plan; }
    if (!plan.ready) throw new Error('누락 또는 중복 항목이 있습니다. 변경하지 않았습니다.');
    const allowedTables = ['pci_item_source_map', 'pci_item_selfcheck_map', 'pci_manual_credit', 'pci_daily_summary', 'pci_event_fact'];
    const [refs] = await conn.query(`SELECT DISTINCT TABLE_NAME AS table_name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'pci_item_id'`);
    const unknown = refs.map(r => r.table_name).filter(t => !allowedTables.includes(t));
    if (unknown.length) throw new Error(`추가 PCI 참조 테이블 검토 필요: ${unknown.join(', ')}`);
    // Cloning retains the server's scoring defaults and any schema-specific fields.
    const [columns] = await conn.query('SHOW COLUMNS FROM pci_item');
    const writable = columns.filter(c => !/auto_increment|GENERATED/i.test(c.Extra || '')).map(c => c.Field);
    for (const item of plan.creates) {
      const templateName = item.name.startsWith('AM ') ? item.name.replace(/^AM /, 'PM ') : '통다발(H/W) (Bush, Main Sharft, Bellows)';
      const templateUpdate = plan.updates.find(u => u.item.name === templateName);
      if (!templateUpdate) throw new Error(`신규 항목 기준 없음: ${item.name}`);
      const template = rows.find(r => r.id === templateUpdate.id);
      const values = { ...template, item_name: item.name, item_name_kr: item.name,
        item_code: `INTEGER_MAINT_${item.sortOrder}`, category: item.category, sort_order: item.sortOrder, is_active: 1 };
      await conn.query(`INSERT INTO pci_item (${writable.map(quote).join(', ')}) VALUES (${writable.map(() => '?').join(', ')})`, writable.map(n => values[n]));
    }
    for (const { from, to } of plan.merges) {
      const source = rows.find(r => r.id === from);
      const target = rows.find(r => r.id === to);
      for (const key of ['required_count', 'self_weight', 'history_max_score', 'main_weight', 'support_weight']) {
        if (Number(source[key]) !== Number(target[key])) throw new Error(`통다발 H/W 기준 불일치: ${key}`);
      }
      for (const { table_name: table } of refs) await moveReferences(conn, table, from, to);
      await conn.query('UPDATE pci_item SET is_active = 0 WHERE id = ?', [from]);
    }
    for (const { id, item } of plan.updates) {
      await conn.query(`UPDATE pci_item SET category = ?, item_name = ?, item_name_kr = ?, sort_order = ?
        WHERE id = ? AND equipment_group_code = ? AND pci_domain = ?`,
      [item.category, item.name, item.name, item.sortOrder, id, 'INTEGER', 'MAINT']);
    }
    const [verified] = await conn.query(`SELECT * FROM pci_item WHERE equipment_group_code = 'INTEGER' AND pci_domain = 'MAINT'`);
    const check = planCatalog(verified);
    if (!check.ready || check.creates.length || check.merges.length) throw new Error('변경 후 검증 실패');
    await conn.commit();
    return plan;
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

async function main() {
  const { pool } = require('../config/database');
  let conn;
  try {
    conn = await pool.getConnection();
    console.log(JSON.stringify(await migrate(conn, process.argv.includes('--apply')), null, 2));
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

module.exports = { migrate, moveReferences };
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
