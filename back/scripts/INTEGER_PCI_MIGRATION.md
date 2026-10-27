# INTEGER maintenance PCI classification

This change targets `pci.html` (the unified PCI matrix) for INTEGER / MAINT.
The older `pci_integer.html` page is not changed.

The catalog has 61 items in EFEM, TM, Load Lock, PM, AM, ETC order.
The approved history policy is:

- FLANGE ADAPTOR, PIN BELLOWS, UNDER COVER keep their IDs and become PM items.
- BUSH retains its ID as 통다발(H/W). MAIN SHAFT and BELLOWS PCI references move to it; their old catalog entries are deactivated.
- Existing work counts and manual additions are summed for H/W. The existing PCI formula, cap, and scoring thresholds remain in use. This is a merge of supporting credits, not an addition of already capped percentages.
- H/W self-check mappings are combined; the existing MAINT rule grants self credit when any mapped answer is checked.
- AM FLANGE ADAPTOR, AM PIN BELLOWS, AM UNDER COVER and 통다발(S/W) are new entries with no inherited history/self-check mappings. AM scoring parameters copy the corresponding PM item; S/W parameters copy H/W. The old three hardware items must have matching scoring parameters or application rolls back.
- Original work logs and checklist answers are preserved. Source/self-check PCI mappings, fact rows, daily summaries and manual credit references are transferred together in a transaction.

## Deployment

Back up the database before running this data migration. Pause PCI rebuilds and writes while applying it. Deploy the DAO ordering change with the script.

From `back/`, with the existing server database configuration available:

```
node scripts/reclassify-integer-maint.js
node scripts/reclassify-integer-maint.js --apply
node scripts/reclassify-integer-maint.js
```

The first and last commands only inspect the migration plan. The last plan should have no creates, merges, missing, conflicts or unmapped items. Writes are limited to INTEGER MAINT items and references to their merged IDs. Unrecognized reference tables, missing items, incompatible scoring parameters, SQL errors or unsupported fact aggregation columns roll back the transaction. Fix the cause rather than bypassing these checks.

Inspect the deployed schema's unique keys and fact counter columns before applying. The script sums main_count, support_count, converted_count, event_count and supported weight fields on duplicate keys; this has been checked with mocked queries, not an actual production database. Test on a restored database first, including a subsequent normal PCI rebuild and a repeated migration.

Check the 61-item count, category order, transferred scores, detail histories, manual additions, self-check results and Excel export. New AM/SW items need source and checklist mappings configured before future work can earn credit under those new names; no mapping rules for those new items were supplied. Existing legacy source mappings follow their moved IDs.

No operational server/database connection was available during preparation. The data migration has not been executed and the site has not been deployed.
