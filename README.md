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
  /measurements` endpoint (`getLoggedMeasuresUsingGET`) directly through `RestClient` — **not**
  the deprecated `GET /parameters` endpoint. There's no typed POD 2.0 SDK client for this
  specific endpoint (`DataCollectionPublicApiClient` only exposes group/parameter
  *definitions*, not collected *values*), so it's called directly — the same pattern the
  sample `ExternalDataFetchAction` uses for first-party REST calls. Per the API's own
  documentation, only `plant` is strictly required; `dcGroup.name`/`.version`,
  `operation.name`/`.version`, `resource`, and `parameterName` are all optional refinements —
  but every one of them is passed through when available, matching the full documented
  parameter set rather than guessing which subset actually matters:
  - `operation.name`/`operation.version` from `PodContext.getFilterOperationActivities()?.[0]`
    (the operation activity this POD is currently working within, not user-configured).
  - `resource` from `PodContext.getFilterResources()?.[0]?.resource`.
  - `dcGroup.name`/`dcGroup.version` from the **Data Collection Group**/**Data Collection
    Group Version** properties below.
  - `parameterName` set per call to the batch or predecessor batch parameter — two calls are
    made per SFC (one per parameter, since `parameterName` only accepts a single value),
    calling per-SFC rather than passing all SFCs in one bulk `sfcs` array (which would rely on
    how `RestClient` serializes a multi-value query parameter — unconfirmed).
- Falls back to the SFC's `defaultBatchId` if no matching Data Collection value is found.

**POD Designer configuration:**

| Property | Description | Default |
|---|---|---|
| **Batch Parameter Name** | Data Collection parameter name holding the batch number | `BATCH` |
| **Predecessor Batch Parameter Name** | Data Collection parameter name holding the predecessor batch number | `IP_PREDECESSOR_BATCH` |
| **Data Collection Group** | Data Collection group the two parameters above belong to | `BATCH_CHARS` |
| **Data Collection Group Version** | Version of the Data Collection Group above | `A` |

These are configurable (rather than hardcoded) because the actual parameter names depend on
how each plant's Data Collection groups are set up — this is also what makes the widget
reusable across different PODs without code changes, per the spec. The defaults above were
confirmed against a live tenant's SFC → **Data Collections** tab (group `BATCH_CHARS`,
version `A`); if a plant uses different parameter names, override them per widget instance in
the POD Designer.

**⚠️ Important — POD Designer property values are per-instance, not code defaults:** an
already-placed widget instance keeps whatever property values were saved when it was first
configured. If it was added to the POD *before* these defaults were corrected, it will still
be querying under old/blank values until someone manually retypes the four values above into
the instance's Properties panel in POD Designer. This is one of the most likely reasons the
batch columns come back empty even when everything else works.

**⚠️ Still unverified — check if the batch columns come back empty:** in
`client/DataCollectionBatchClient.js`, `MEASUREMENTS_PATH` (`/datacollection/v1/measurements`)
mirrors the OpenAPI spec's declared base URL segment, but it hasn't been confirmed that
`RestClient` resolves relative paths against that exact base on this tenant — check this
first if the call itself 404s. Also unconfirmed: that `PodContext.getFilterOperationActivities()`
and `getFilterResources()` reliably reflect the operation/resource this specific POD is
working within at the moment the widget fetches. Every call now logs its raw response
(`[DataCollectionBatchClient] Raw response`) so the actual response shape and content can be
inspected directly in the console rather than assumed — check this log first if values still
don't appear. A failure here is isolated (see below) and only blanks the batch columns, not
the whole list.

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

**Also fixed — batch/predecessor batch lookup history:** `client/DataCollectionBatchClient.js`
went through several iterations before landing on the design described above:
1. Originally queried the `DATA_COLLECTION` MDO via OData with guessed field names.
2. Switched to the Data Collection API's `GET /measurements` REST endpoint once its OpenAPI
   spec was available — but the response-parsing code assumed the response matched that
   spec's documented schema (`{ data: [{ parameter: {...} }] }`) without ever confirming it
   against a real call, and only `plant` was passed (per the spec's stated requirements).
3. A test directly against the tenant returned `operation.name`/`operation.version`/
   `resource` as apparently required — but that test turned out to be against the
   **deprecated** `GET /parameters` endpoint, not `/measurements`; briefly switched to
   `/parameters` to match, then reverted since it's deprecated.
4. The tenant's actual API documentation for `/measurements` (not a test, the real parameter
   list) showed only `plant` is required — `operation.name`/`.version`, `resource`,
   `dcGroup.name`/`.version`, and `parameterName` are all optional but accepted. All of them
   are now passed when available, matching that documentation exactly.
5. Response parsing was made tolerant of multiple possible shapes (bare array vs
   `.data`-wrapped, singular `parameter` vs plural `parameters`) since the actual
   `/measurements` response shape still hasn't been directly confirmed — and every call now
   logs its raw response so this can be verified from the browser console instead of assumed.

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
