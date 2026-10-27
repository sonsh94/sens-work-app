'use strict';

// INTEGER MAINT only. Names and order follow the requested PCI classification.
const groups = [
  ['EFEM', ['EFEM ROBOT REP', 'EFEM ROBOT TEACHING', 'PIO SENSOR BOARD']],
  ['TM', ['DOOR VALVE', 'SLOT VALVE', 'SLOT VALVE ASSY(HOUSING)', 'TM ROBOT REP', 'TM ROBOT SERVO PACK', 'TM ROBOT TEACHING', 'EPC']],
  ['Load Lock', ['CASSETTE & HOLDER PAD', '통다발(S/W)', '통다발(H/W) (Bush, Main Sharft, Bellows)', 'BALL SCREW ASSY', 'DIFFUSER', 'CHECK VALVE', 'SENSOR BOARD', 'LASER SENSOR AMP', 'STEP MOTOR & CONTROLLER']],
  ['PM', ['CERAMIC PARTS', 'COOLING CHUCK', 'PM FLANGE ADAPTOR', 'GAS FEED THROUGH', 'GAS BOX DOOR SENSOR', 'MATCHER', 'PIN ASSY MODIFY', 'PM PIN BELLOWS', 'PIN 구동부 ASSY', 'PM BAFFLE', 'SWAP KIT', 'TOP FEED THROUGH', 'PM UNDER COVER', 'SOURCE BOX BOARD', 'VACUUM BLOCK']],
  ['AM', ['AM BAFFLE', 'AM FLANGE ADAPTOR', 'HEATER CHUCK', 'AM PIN BELLOWS', 'AM UNDER COVER']],
  ['ETC', ['GAS SPRING', 'LP ESCORT', 'LOT 조사', 'GENERATOR', 'HE LEAK CHECK', 'BARATRON GAUGE', 'D-NET BOARD', 'AIO CALIBRATION(PSK BOARD)', 'AIO CALIBRATION(TOS BOARD)', 'CODED SENSOR', 'CONVACTION GAUGE', 'GAS LINE & GAS FILTER', 'INTERFACE BOARD', 'ISOLATION VALVE', 'MANUAL VALVE', 'MOTOR & CONTROLLER', 'PENDULUM VALVE', 'PIRANI GAUGE', 'PNEUMATIC VALVE', 'PURGE LINE REGULATOR', 'SENSOR', 'VAC LINE']],
];

// Approved history policy: shared PM/AM history goes to PM; BUSH through
// BELLOWS go to H/W. AM and S/W are new, empty items.
const aliases = {
  'PM FLANGE ADAPTOR': ['FLANGE ADAPTOR'],
  'PM PIN BELLOWS': ['PIN BELLOWS'],
  'PM UNDER COVER': ['UNDER COVER'],
  'AIO CALIBRATION(PSK BOARD)': ['AIO CALIBRATION[PSK BOARD]'],
  'AIO CALIBRATION(TOS BOARD)': ['AIO CALIBRATION[TOS BOARD]'],
  'CONVACTION GAUGE': ['CONVACTRON GAUGE'],
  'VAC LINE': ['VAC. LINE'],
};

const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const items = groups.flatMap(([category, names], groupIndex) => names.map((name, index) => ({
  name, category, sortOrder: (groupIndex + 1) * 100 + index + 1,
  matchNames: [name, ...(aliases[name] || [])],
})));
const hardwareName = groups[2][1][2];
const hardwareSources = ['BUSH', 'MAIN SHAFT', 'BELLOWS'];
const newNames = ['통다발(S/W)', 'AM FLANGE ADAPTOR', 'AM PIN BELLOWS', 'AM UNDER COVER'];

function planCatalog(rows) {
  const activeRows = rows.filter(row => Number(row.is_active) === 1);
  const matched = new Set();
  const updates = [];
  const missing = [];
  const conflicts = [];
  const creates = [];
  const merges = [];
  for (const item of items) {
    const names = new Set(item.matchNames.map(normalize));
    const matches = activeRows.filter(row => names.has(normalize(row.item_name)));
    if (item.name === hardwareName) {
      const sources = activeRows.filter(row => hardwareSources.includes(normalize(row.item_name)));
      if (matches.length > 1) conflicts.push(item.name);
      else if (matches.length || sources.length === 3) {
        const target = matches[0] || sources[0];
        matched.add(target.id);
        updates.push({ id: target.id, item });
        for (const source of sources) {
          matched.add(source.id);
          if (source.id !== target.id) merges.push({ from: source.id, to: target.id });
        }
      } else missing.push(item.name);
    }
    else if (!matches.length && newNames.includes(item.name)) creates.push(item);
    else if (!matches.length) missing.push(item.name);
    else if (matches.length > 1) conflicts.push(item.name);
    else {
      matched.add(matches[0].id);
      updates.push({ id: matches[0].id, item });
    }
  }
  const unmapped = activeRows.filter(row => !matched.has(row.id)).map(row => ({ id: row.id, name: row.item_name }));
  return { updates, creates, merges, missing, conflicts, unmapped, ready: !missing.length && !conflicts.length && !unmapped.length };
}

module.exports = { groups, items, planCatalog };
