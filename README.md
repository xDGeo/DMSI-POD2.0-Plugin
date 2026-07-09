# DMSI POD 2.0 Custom Plugins

Custom SAP Digital Manufacturing **POD 2.0** widgets for DMSI, built with the lightweight
ES6+ widget architecture (see the
[digital-manufacturing-extension-samples](https://github.com/SAP-samples/digital-manufacturing-extension-samples)
`dm-podplugin-extensions/custom-pod2-examples` package for the reference patterns this
project follows).

## Plugins

### Finished SFC List (`plugins/FinishedSfcList.js`)

**Purpose:** Re-creates the POD 1.0 "finished SFCs of an order" list (screenshot in
[Context.md](Context.md)) as a reusable POD 2.0 widget. Shown at the order/worklist level;
when an operator navigates into an order from the worklist, it lists every SFC in that
order that is already **finished (COMPLETED)**.

**Columns:** SFC · Quantity (the SFC's split quantity) · Batch Number · Predecessor Batch
Number, plus a **Total** row at the end summing the quantity column.

**Key behaviour:**
- Reacts to `PodContext` worklist selection (`ModelPath.SelectedWorkListItems`) — reloads
  whenever the operator selects/navigates to a different order.
- Fetches the order's SFCs via `SfcPublicApiClient.getSfcs({ filter: { order } })` and keeps
  only SFCs with `status.code === SFCStatusCode.COMPLETED`.
- Batch number and predecessor batch number are **not** standard SFC fields — per the spec
  they are logged as Data Collection parameters against each SFC. They are fetched in bulk
  via `client/DataCollectionBatchClient.js`, which queries the `DATA_COLLECTION` MDO
  (Manufacturing Data Object) filtered by SFC and parameter name.
- Falls back to the SFC's `defaultBatchId` if no matching Data Collection value is found.

**POD Designer configuration:**

| Property | Description | Default |
|---|---|---|
| **Batch Parameter Name** | Data Collection parameter name holding the batch number | `BATCH` |
| **Predecessor Batch Parameter Name** | Data Collection parameter name holding the predecessor batch number | `IP_PREDECESSOR_BATCH` |

These are configurable (rather than hardcoded) because the actual parameter names depend on
how each plant's Data Collection groups are set up — this is also what makes the widget
reusable across different PODs without code changes, per the spec. The defaults above were
confirmed against a live tenant's SFC → **Data Collections** tab (group `BATCH_CHARS`); if a
plant uses different parameter names, override them per widget instance in the POD Designer.

**⚠️ Still unverified — check if the batch columns come back empty:** in
`client/DataCollectionBatchClient.js`, `FIELD_PARAMETER_NAME` (`PARAMETER_NAME`),
`FIELD_PARAMETER_VALUE` (`PARAMETER_VALUE`), and `FIELD_COLLECTED_AT` (`COLLECTED_AT`) are
confirmed — they match the "Parameter Name" / "Parameter Value" / "Collected At" column
headers on that same Data Collections tab. `FIELD_PLANT` (`PLANT`) and `FIELD_SFC` (`SFC`)
are still an informed guess (naming convention inferred from other MDOs like
`SFC_STEP_STATUS`) since those aren't visible as UI columns — check the tenant's `$metadata`
for `/DATA_COLLECTION` if the batch lookup itself throws. A failure there is isolated (see
below) and only blanks the batch columns, not the whole list.

Also note: the widget currently queries the SFC list without restricting to a work center
(`workCenter: ""`) so that all of an order's finished SFCs are returned regardless of which
operation/work center they're currently at — confirm this is the desired behavior against the
live API.

**Fixed:** an earlier version shared one `try/catch` across both the SFC-list fetch and the
batch-info fetch, so a failure in the batch lookup (e.g. wrong parameter/field name) silently
wiped the *entire* row list ("No data" for every column, not just batch). `_fetchData()` now
calls `_fetchFinishedSfcs()` and `_fetchBatchInfo()` separately — a batch-info failure logs
via `Logger`, shows a toast (`FinishedSfcList.batchLoadFailed`), and falls back to an empty
batch map, but the SFC/Quantity rows still render.

### Planned follow-up (not yet built)

> "Similar plugin idea to above but it shows custom data from order in the worklist level."

A second widget showing custom order-level fields directly in the worklist row (rather than
in a drill-down list) is the next candidate — see [Context.md](Context.md). It would follow
the same pattern as `FinishedSfcList.js` but likely extend `OrderListTableWidget` instead of
`TableWidget` directly, since it augments the existing order worklist rather than showing a
separate drill-down table.

## Project Structure

```
.
├── extension.json                      # POD 2.0 extension registry
├── plugins/
│   ├── FinishedSfcList.js              # Widget: finished SFC list for an order
│   └── i18n/
│       └── i18n.properties
├── client/
│   └── DataCollectionBatchClient.js    # MDO query wrapper for batch/predecessor batch
├── util/
│   └── ValidationErrorHandler.js       # OData $filter input sanitization
└── .claude/commands/
    └── pod2-extension-package.md       # /pod2-extension-package: build the deployable zip
```

## Deployment

Run the `/pod2-extension-package` skill from Claude Code to build a deployment-ready zip and
get the exact values to paste into the **Manage POD 2.0 → Extensions** upload dialog:

```
/pod2-extension-package
```

Or manually:

1. Zip the contents of this repo's root (root of the zip should be `/`, i.e. `extension.json`
   at the top level) — exclude `.git`, `.claude`, and `Context.md`.
2. Upload to **Manage PODs 2.0 → Extensions** in SAP DM.
3. Use Namespace `dmsi.pod2`.
4. Add the **Finished SFC List** widget to an Order-type POD via the POD Designer.

## Reference

- [POD Plugins Developer Guide](https://help.sap.com/docs/sap-digital-manufacturing/pod-plugin-developer-s-guide/introduction)
- [Building Custom POD Plugins Blog](https://community.sap.com/t5/supply-chain-management-blog-posts-by-sap/building-a-custom-digital-manufacturing-pod-plugin-the-new-easy-way/ba-p/14161535)
