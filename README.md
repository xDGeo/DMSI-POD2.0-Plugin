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
  sample `ExternalDataFetchAction` uses for first-party REST calls.

  **The correct request — confirmed by actually running the widget against the tenant — is
  `plant` + `sfcs` + `parameterName`, sent to the *fully-qualified* gateway URL.** Two things
  make this work, and both were previously wrong:
  1. **The URL must include the POD 2.0 API gateway prefix.** The endpoint is called at
     `<gatewayBase>/datacollection/v1/measurements`, where `<gatewayBase>` is
     `.../sapdmdmepod2/~{hash}~/fnd/api-gateway-ms/` — the same `~{hash}~` segment the POD page
     itself is served under. `FinishedSfcList._resolveApiBaseUrl()` derives this from
     `window.location` (with a POD-Designer **API Base URL** override and runtime/same-origin
     fallbacks), then passes it into the client. Passing a bare **origin-relative**
     `/datacollection/v1/measurements` (as an earlier version did) resolves against the page
     origin, misses the gateway prefix, and **404s for every SFC** — this was the actual root
     cause of the empty batch columns.
  2. **`dcGroup.name`/`dcGroup.version` are deliberately NOT sent.** Once the URL is correct,
     adding them makes the request **404 on this tenant even for SFCs that do have a value** —
     silently blanking the whole column (a 404 is treated as "no value logged"). An earlier
     Postman "confirmation" that they were *required* was misleading: Postman's base URL already
     contained the gateway prefix, so those calls succeeded for a different reason — the real
     variable was the URL base, not the dcGroup filter. `operation.name`/`.version`/`resource`
     are likewise not sent.
  - `parameterName` is set per call to the batch or predecessor batch parameter — two calls
    are made per SFC (one per parameter, since `parameterName` only accepts a single value).
  - `sfcs` is sent as a plain string (one SFC per call), not an array — `RestClient.get()`
    serializes a JS array as `sfcs.0=<value>`, which the backend doesn't recognize as the
    `sfcs` parameter at all (confirmed via a 404 with that literal query string).
- Falls back to the SFC's `defaultBatchId` if no matching Data Collection value is found.

**POD Designer configuration:**

| Property | Description | Default |
|---|---|---|
| **Batch Parameter Name** | Data Collection parameter name holding the batch number | `BATCH` |
| **Predecessor Batch Parameter Name** | Data Collection parameter name holding the predecessor batch number | `IP_PREDECESSOR_BATCH` |
| **API Base URL (optional)** | Manual override for the API gateway base URL used for Data Collection calls. Leave blank to auto-detect from the POD URL. | *(blank — auto-detect)* |

The two parameter names are configurable (rather than hardcoded) because the actual names
depend on how each plant's Data Collection groups are set up — this is also what makes the
widget reusable across different PODs without code changes, per the spec. The defaults above
were confirmed against a live tenant's SFC → **Data Collections** tab; if a plant uses
different parameter names, override them per widget instance in the POD Designer. **API Base
URL** should normally be left blank — the widget auto-detects the gateway base from the POD
page URL; only set it if auto-detection fails (see the fallback warning in the console).

> **Note:** the widget no longer takes **Data Collection Group** / **Group Version**
> properties. Sending `dcGroup.name`/`dcGroup.version` was found to 404 the `/measurements`
> call on this tenant; the query is now just `plant` + `sfcs` + `parameterName`. If you have an
> old instance that still shows those two properties, it predates this change (see below).

**⚠️ Important — POD Designer property values are per-instance, not code defaults:** an
already-placed widget instance keeps whatever property set and values were saved when it was
first configured, and POD Designer does **not** re-scan `getProperties()` for an existing
instance just because a newer extension build is uploaded. So after any property change
(rename/add/remove — e.g. this build dropping the two Group properties and adding **API Base
URL**), **delete the existing "Finished SFC List" widget and drag a fresh one from the
palette** rather than reusing the old instance. This was confirmed to be the reason a newly
added property didn't appear on an existing instance.

**⚠️ Logging note:** this tenant's effective `sap/dm/dme/pod2/Logger` level filters out
`INFO`-level messages — `oLogger.info(...)` calls never reach the console at all here (calling
`Logger.setDefaultLevel(Logger.Level.DEBUG)` from the browser console doesn't help either,
since a full page reload wipes that in-memory override before the widget's `onInit()`, and its
first fetch, even runs). All diagnostic logging in this project (`FinishedSfcList.js`,
`OrderSfcClient.js`, `DataCollectionBatchClient.js`) therefore deliberately uses `.warn()`
instead of `.info()`, which is confirmed visible. Keep new diagnostic logs on `.warn()` (or
`.error()`) for the same reason — don't add `.info()` calls expecting them to show up here.

**✅ Resolved (was "still unverified") — the empty batch columns:** the root cause was the
request URL, exactly where this note used to say to look first. `DataCollectionBatchClient`
previously passed an **origin-relative** `/datacollection/v1/measurements` to `RestClient`,
which resolved it against the bare page origin and missed the POD 2.0 API gateway prefix —
so every call 404'd and every batch cell came back blank. The client now takes an
`apiBaseUrl` (the resolved gateway base, `.../sapdmdmepod2/~{hash}~/fnd/api-gateway-ms/`) from
the widget's `_resolveApiBaseUrl()` and builds the full URL from it (service path
`datacollection/v1/measurements`, **no** leading slash, appended to the base). The
`[DataCollectionBatchClient] Fetching batch info` log now includes the resolved `url` so it
can be verified in the console. A failure here is still isolated (see below) and only blanks
the batch columns, not the whole list.

**Note — a 404 for one SFC/parameter combination is not necessarily a bug:** once the URL is
correct, this API returns **404** (not 200 with an empty array) when a specific SFC has no
value logged for the requested parameter — e.g. predecessor batch may only be recorded on
certain SFCs, not universally. `#fetchParameterInto()` logs that case at `warn` level
(`[DataCollectionBatchClient] No value logged for this SFC/parameter`) instead of `error`, so
the console isn't full of red errors for a normal "nothing collected here" outcome. Genuine
failures (wrong path, 500, network errors, etc.) still log as errors. **Do not** try to
"fix" these 404s by re-adding `dcGroup.*`/`operation.*` filters — on this tenant those make
even SFCs that *do* have a value 404, silently blanking the whole column.

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

**Also fixed — batch/predecessor batch lookup history (the long one):**
`client/DataCollectionBatchClient.js` went through several incorrect iterations (guessed MDO
field names → `/measurements` with only `plant` → briefly the deprecated `/parameters`
endpoint with `operation`/`resource` believed required → `/measurements` with
`dcGroup.name`+`dcGroup.version` believed required). **All of these shared one hidden cause:
the request URL was origin-relative and missed the API gateway prefix, so it 404'd no matter
what query params were sent** — which repeatedly sent the debugging down the wrong path
(blaming the dcGroup pairing, the parameter names, POD Designer property caching, etc.). The
actual fix, confirmed by running the widget against the tenant: build the full URL from the
resolved gateway base (`_resolveApiBaseUrl()` → `apiBaseUrl`) and send only `plant` + `sfcs`
+ `parameterName`. Adding `dcGroup.*` back on top of the *correct* URL 404s valid SFCs, so
those params were removed entirely (and the corresponding widget properties dropped). Response
parsing stays tolerant of multiple possible shapes (bare array vs `.data`-wrapped, singular
`parameter` vs plural `parameters`) as a safety net, though the confirmed `/measurements`
response matches the `.data`-wrapped/singular-`parameter` shape exactly.

_Lesson for future debugging: when **every** call to an endpoint 404s regardless of query
params, suspect the URL/base resolution before the params. The README flagged this exact
risk ("not yet confirmed that `RestClient` resolves relative paths against that base") but it
was deprioritized in favour of the params._

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
