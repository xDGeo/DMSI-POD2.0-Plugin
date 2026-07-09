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
  whenever the operator selects/navigates to a different order. The resolved order number is
  the key input parameter for the whole widget: it's read once per fetch and passed
  explicitly into every downstream call (never re-derived deeper in the call chain).
- Fetches finished SFCs via `client/OrderSfcClient.js`, which combines two **confirmed, fully
  documented** REST APIs (verified against their OpenAPI specs, not guessed):
  1. `OrderPublicApiClient.getOrder({ plant, order })` (Order API, `GET /v1/orders`) → returns
     `sfcs: string[]`, *every* SFC released from the order, with no status-based scoping.
  2. `SfcPublicApiClient.getSfcDetail({ plant, sfc })` (SFC API, `GET /sfcdetail`) per SFC →
     returns `quantity`, `status.code`, `defaultBatchId` for that one SFC. Also not scoped to
     pending work.
  This is deliberately **not** `SfcPublicApiClient.getSfcs()` / the SFC Work List REST API
  (`sfc/v2` `/worklist/sfcs`, `/worklist/orders`) — that API's `sfcStatuses` filter only
  accepts `NEW`, `IN_QUEUE`, `ACTIVE`, `HOLD`. Completed SFCs are excluded from "work list"
  results by design (a work list shows pending work), so no amount of client-side filtering
  on that API would ever surface a finished SFC.
  Trade-off: this costs one `getSfcDetail()` call per SFC in the order (capped at 200,
  fetched in parallel) rather than a single bulk query — acceptable given typical order SFC
  counts, and it avoids guessing at undocumented MDO OData field names entirely.
- Batch number and predecessor batch number are **not** standard SFC fields — per the spec
  they are logged as Data Collection parameters against each SFC. They are fetched via
  `client/DataCollectionBatchClient.js`, which calls the Data Collection API's `GET
  /measurements` endpoint directly through `RestClient` (confirmed against that API's own
  OpenAPI spec) — this endpoint takes a bulk `sfcs` array plus `dcGroup.name`/`parameterName`
  filters and returns one row per SFC+parameter. There's no typed POD 2.0 SDK client for this
  specific endpoint (`DataCollectionPublicApiClient` only exposes group/parameter
  *definitions*, not collected *values*), so it's called directly — the same pattern the
  sample `ExternalDataFetchAction` uses for first-party REST calls. Since `parameterName`
  only accepts one value per call and `pageSize` is capped server-side at 50, batch and
  predecessor batch are fetched as two separate, paginated calls.
- Falls back to the SFC's `defaultBatchId` if no matching Data Collection value is found.

**POD Designer configuration:**

| Property | Description | Default |
|---|---|---|
| **Batch Parameter Name** | Data Collection parameter name holding the batch number | `BATCH` |
| **Predecessor Batch Parameter Name** | Data Collection parameter name holding the predecessor batch number | `IP_PREDECESSOR_BATCH` |
| **Data Collection Group** | Data Collection group the two parameters above belong to | `BATCH_CHARS` |

These are configurable (rather than hardcoded) because the actual parameter names depend on
how each plant's Data Collection groups are set up — this is also what makes the widget
reusable across different PODs without code changes, per the spec. The defaults above were
confirmed against a live tenant's SFC → **Data Collections** tab (group `BATCH_CHARS`); if a
plant uses different parameter names, override them per widget instance in the POD Designer.

**⚠️ Still unverified — check if the batch columns come back empty:** in
`client/DataCollectionBatchClient.js`, `MEASUREMENTS_PATH` (`/datacollection/v1/measurements`)
mirrors the OpenAPI spec's declared base URL segment, but it hasn't been confirmed that
`RestClient` resolves relative paths against that exact base on this tenant — check this
first if the call itself 404s. Everything else about this call (query params, response
shape) is directly copied from the confirmed OpenAPI spec, not guessed. A failure here is
isolated (see below) and only blanks the batch columns, not the whole list.

**Fixed (root cause):** the widget originally fetched SFCs via `SfcPublicApiClient.getSfcs()`,
which wraps the SFC Work List REST API. That API's `sfcStatuses` filter only supports
`NEW`/`IN_QUEUE`/`ACTIVE`/`HOLD` — there is no `COMPLETE`/`DONE` option, because "work list"
results are scoped to pending work by design. Client-side filtering for
`status.code === SFCStatusCode.COMPLETED` therefore always produced zero rows: the API never
returned completed SFCs to filter in the first place. This is the most likely explanation for
the widget showing "No data" across *all* columns (not just batch), even after the batch
parameter names were corrected. An intermediate version queried the `/SFC` MDO directly to
work around this, but that required guessing at undocumented OData field names. Once the
Order API's OpenAPI spec confirmed `getOrder().sfcs` returns all SFCs regardless of status,
switched to `client/OrderSfcClient.js` instead — no field names guessed, every field used
(`sfcs`, `quantity`, `status.code`, `defaultBatchId`) is documented in the public API specs.

**Also fixed:** `client/DataCollectionBatchClient.js` originally queried the `DATA_COLLECTION`
MDO via OData with guessed field names (`PLANT`, `SFC`, `GROUP`). Once the Data Collection
API's OpenAPI spec confirmed the `GET /measurements` endpoint and its exact request/response
shape, rewrote the client to call that REST endpoint directly via `RestClient` instead —
removing the last piece of guessed field-name risk in the widget.

**Also fixed:** an earlier version shared one `try/catch` across both the SFC-list fetch and
the batch-info fetch, so a failure in the batch lookup (e.g. wrong parameter/field name)
silently wiped the *entire* row list. `_fetchData()` now calls `_fetchFinishedSfcs()` and
`_fetchBatchInfo()` separately — a batch-info failure logs via `Logger`, shows a toast
(`FinishedSfcList.batchLoadFailed`), and falls back to an empty batch map, but the
SFC/Quantity rows still render. Both `_fetchData()` and `_fetchFinishedSfcs()` also now log
the resolved plant/order and result count via `Logger`, so a genuinely empty result can be
told apart from a context-resolution failure by checking the browser console.

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
│   ├── OrderSfcClient.js               # Order + SFC API wrapper for finished SFCs of an order
│   └── DataCollectionBatchClient.js    # Data Collection /measurements API wrapper for batch/predecessor batch
├── util/
│   └── ValidationErrorHandler.js       # Input sanitization
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
