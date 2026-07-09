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
| **Batch Parameter Name** | Data Collection parameter name holding the batch number | `BATCH_NUMBER` |
| **Predecessor Batch Parameter Name** | Data Collection parameter name holding the predecessor batch number | `PREDECESSOR_BATCH_NUMBER` |

These are configurable (rather than hardcoded) because the actual parameter names depend on
how each plant's Data Collection groups are set up — this is also what makes the widget
reusable across different PODs without code changes, per the spec.

**⚠️ Verify before go-live:** the `DATA_COLLECTION` MDO's OData field names in
`client/DataCollectionBatchClient.js` (`PLANT`, `SFC`, `PARAMETER_NAME`, `PARAMETER_VALUE`,
`CREATED_AT`) are an informed assumption based on the naming convention of other MDOs (e.g.
`SFC_STEP_STATUS`), since this was built without access to a live tenant's `$metadata`. Check
the real field names for `/DATA_COLLECTION` on your tenant and adjust the `FIELD_*` constants
at the top of that file if they differ. Likewise, the widget currently queries the SFC list
without restricting to a work center (`workCenter: ""`) so that all of an order's finished
SFCs are returned regardless of which operation/work center they're currently at — confirm
this is the desired behavior against the live API.

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
