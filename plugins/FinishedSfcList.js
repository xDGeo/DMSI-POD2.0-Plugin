sap.ui.define([
    "sap/m/library",
    "sap/ui/core/library",
    "sap/dm/dme/pod2/widget/core/TableWidget",
    "sap/dm/dme/pod2/context/ModelPath",
    "sap/dm/dme/pod2/context/PodContext",
    "sap/dm/dme/pod2/model/I18nResourceModel",
    "sap/dm/dme/pod2/widget/metadata/WidgetProperty",
    "sap/dm/dme/pod2/propertyeditor/StringPropertyEditor",
    "sap/dm/dme/pod2/propertyeditor/PropertyCategory",
    "sap/dm/dme/pod2/enumeration/SFCStatusCode",
    "dmsi/pod2/client/OrderSfcClient",
    "dmsi/pod2/client/DataCollectionBatchClient",
    "sap/dm/dme/pod2/Logger"
], (
    MobileLibrary,
    CoreLibrary,
    TableWidget,
    ModelPath,
    PodContext,
    I18nResourceModel,
    WidgetProperty,
    StringPropertyEditor,
    PropertyCategory,
    SFCStatusCode,
    OrderSfcClient,
    DataCollectionBatchClient,
    Logger
) => {
    "use strict";

    const { Priority } = CoreLibrary;
    const { ObjectStatus, Text, MessageToast } = MobileLibrary;

    const oLogger = Logger.getLogger("dmsi.pod2.plugins.FinishedSfcList");

    // Confirmed against a live tenant's SFC > Data Collections tab.
    const DEFAULT_BATCH_PARAMETER = "BATCH";
    const DEFAULT_PREDECESSOR_PARAMETER = "IP_PREDECESSOR_BATCH";

    // When a split adds a new SFC row, its batch / predecessor batch data collection values
    // are written asynchronously by the backend and lag by a few seconds. After detecting a
    // new row we reload the page once after this delay so the values fill in without the user
    // having to refresh manually.
    const AUTO_REFRESH_DELAY_MS = 5000;

    /**
     * Lists all finished (COMPLETED) SFCs of the order behind the currently selected
     * work list item, together with the SFC's split quantity, batch number, and predecessor
     * batch number (both read from Data Collection). A totals row with the summed quantity
     * is appended at the end of the list.
     *
     * The order number is the key input parameter driving the whole query: it's resolved
     * from PodContext once per fetch and passed explicitly into every downstream call
     * (OrderSfcClient, DataCollectionBatchClient) rather than re-read from context deeper in
     * the call chain. Finished SFCs are read via OrderSfcClient (Order API's getOrder().sfcs
     * combined with per-SFC getSfcDetail()), not the SFC Work List REST API
     * (SfcPublicApiClient.getSfcs()), because that REST API only supports
     * NEW/IN_QUEUE/ACTIVE/HOLD as status filters — completed SFCs are excluded from "work
     * list" results by design and would never be returned no matter how they're filtered
     * client-side.
     */
    class FinishedSfcList extends TableWidget {

        static #oI18nModel = new I18nResourceModel({ bundleName: "dmsi.pod2.plugins.i18n.i18n" });

        static getI18nModel() { return this.#oI18nModel; }

        static PropertyId = Object.freeze({
            BatchParameterName: "batchParameterName",
            PredecessorBatchParameterName: "predecessorBatchParameterName",
            ApiBaseUrl: "apiBaseUrl"
        });

        static Field = Object.freeze({
            Sfc: "sfc",
            Quantity: "quantity",
            BatchNumber: "batchNumber",
            PredecessorBatchNumber: "predecessorBatchNumber"
        });

        /** @extensible @override */
        static getDisplayName() { return "Finished SFC List"; }

        /** @extensible @override */
        static getIcon() { return "sap-icon://list"; }

        /** @extensible @override */
        static getCategory() { return "DMSI Custom Extensions"; }

        /** @extensible @override */
        static getDescription() {
            return "Lists all finished SFCs of the selected order with split quantity, batch number, " +
                "predecessor batch number, and a total quantity row.";
        }

        /** @extensible @override */
        static getDefaultConfig(sId) {
            const oConfig = super.getDefaultConfig(sId);
            return {
                ...oConfig,
                properties: {
                    ...oConfig.properties,
                    [FinishedSfcList.PropertyId.BatchParameterName]: DEFAULT_BATCH_PARAMETER,
                    [FinishedSfcList.PropertyId.PredecessorBatchParameterName]: DEFAULT_PREDECESSOR_PARAMETER,
                    [FinishedSfcList.PropertyId.ApiBaseUrl]: ""
                }
            };
        }

        /** @extensible @override */
        static getFields() {
            const thisI18n = this.getI18nText.bind(this);
            return [
                { field: this.Field.Sfc, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.sfc") },
                { field: this.Field.BatchNumber, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.batchNumber") },
                { field: this.Field.PredecessorBatchNumber, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.predecessorBatchNumber") },
                { field: this.Field.Quantity, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.quantity") }
            ];
        }

        #oSfcClient = new OrderSfcClient();
        #oBatchClient = new DataCollectionBatchClient();
        #bIsLoading = false;

        // Auto-refresh-on-new-split state. #oKnownSfcs is the set of SFCs seen in the last
        // fetch (null before the first fetch); #sLastOrder is the order that set belongs to;
        // #iRefreshTimer holds the pending delayed re-fetch so it can be debounced/cancelled.
        #oKnownSfcs = null;
        #sLastOrder = null;
        #iRefreshTimer = null;

        /** @extensible @override */
        onInit() {
            super.onInit();
            if (PodContext.isRunMode()) {
                PodContext.subscribe(ModelPath.SelectedWorkListItems, this._onSelectionChanged, this);
                this._fetchData();
            }
        }

        /** @extensible @override */
        onExit() {
            super.onExit();
            if (this.#iRefreshTimer) {
                clearTimeout(this.#iRefreshTimer);
                this.#iRefreshTimer = null;
            }
            if (PodContext.isRunMode()) {
                PodContext.unsubscribe(ModelPath.SelectedWorkListItems, this._onSelectionChanged, this);
            }
        }

        /** @extensible @override */
        _getModelPath() {
            return "/dmsi/finishedSfcList/rows";
        }

        _onSelectionChanged() {
            this._fetchData();
        }

        /**
         * Fetches finished SFCs for the order behind the currently selected work list item,
         * enriches them with batch data collected against each SFC, and appends a totals row.
         * @private
         * @async
         */
        async _fetchData() {
            if (this.#bIsLoading) {
                return;
            }
            this.#bIsLoading = true;

            try {
                const sPlant = PodContext.getPlant();
                const sOrder = PodContext.getLastSelectedWorkListItem()?.order;

                oLogger.info("[FinishedSfcList] Resolved context", { plant: sPlant, order: sOrder });

                if (!sPlant || !sOrder) {
                    oLogger.info("[FinishedSfcList] Plant or order not available yet, showing empty list");
                    PodContext.set(this._getModelPath(), []);
                    return;
                }

                const aFinished = await this._fetchFinishedSfcs(sPlant, sOrder);

                // Detect SFC rows that are new since the last fetch of THIS order — i.e. a
                // fresh split. A new order selection (different #sLastOrder) is NOT treated as
                // "new rows": those SFCs already have their data collection written, so there's
                // nothing to wait for.
                const bHasNewRows = this._detectNewRows(sOrder, aFinished);

                if (!aFinished.length) {
                    PodContext.set(this._getModelPath(), []);
                    return;
                }

                // Batch info is a best-effort enrichment: if it fails (e.g. wrong Data
                // Collection parameter name/MDO field), the SFC/quantity rows must still
                // render rather than the whole list disappearing.
                const mBatchInfo = await this._fetchBatchInfo(sPlant, aFinished);

                PodContext.set(this._getModelPath(), this._buildRows(aFinished, mBatchInfo));

                // A split just added a row whose data collection values lag behind by a few
                // seconds. Reload the page once after a short delay so batch / predecessor
                // batch fill in automatically. (After the reload #oKnownSfcs is empty again, so
                // the first fetch detects no new rows and this terminates on its own.)
                if (bHasNewRows) {
                    this._scheduleDelayedRefresh();
                }
            } catch (oError) {
                oLogger.error("[FinishedSfcList] Failed to load finished SFCs", { message: oError.message });
                MessageToast.show(this.getI18nText("FinishedSfcList.loadFailed") || "Failed to load finished SFCs");
                PodContext.set(this._getModelPath(), []);
            } finally {
                this.#bIsLoading = false;
            }
        }

        /**
         * Compares the just-fetched SFCs against the previous fetch and reports whether any
         * new SFC appeared for the SAME order (a split). Updates the tracked set/order as a
         * side effect. Returns false on the first fetch and on an order switch — in both cases
         * there's no "just split" row to wait for.
         * @private
         * @param {string} sOrder
         * @param {Array<{sfc: string}>} aFinished
         * @returns {boolean}
         */
        _detectNewRows(sOrder, aFinished) {
            const oCurrentSfcs = new Set(aFinished.map((oSfc) => oSfc.sfc));
            const bSameOrder = this.#sLastOrder === sOrder;
            const bHasNewRows = bSameOrder && this.#oKnownSfcs !== null &&
                [...oCurrentSfcs].some((sSfc) => !this.#oKnownSfcs.has(sSfc));

            this.#oKnownSfcs = oCurrentSfcs;
            this.#sLastOrder = sOrder;

            return bHasNewRows;
        }

        /**
         * Schedules a single delayed full page reload (debounced — a pending timer is
         * replaced) so newly split rows pick up their asynchronously written data collection
         * values. A full reload is used instead of an in-place re-fetch because the re-fetch
         * alone did not surface the freshly written values.
         *
         * This does NOT loop: after the reload the widget re-initialises with an empty
         * #oKnownSfcs, so the first post-reload fetch is treated as an initial load and never
         * detects a "new" row.
         * @private
         */
        _scheduleDelayedRefresh() {
            if (this.#iRefreshTimer) {
                clearTimeout(this.#iRefreshTimer);
            }
            oLogger.info("[FinishedSfcList] New split detected — reloading the page after delay to pick up data collection values",
                { delayMs: AUTO_REFRESH_DELAY_MS });
            this.#iRefreshTimer = setTimeout(() => {
                this.#iRefreshTimer = null;
                window.location.reload();
            }, AUTO_REFRESH_DELAY_MS);
        }

        /**
         * Fetches SFCs of the given order that are already finished (COMPLETED), via
         * OrderSfcClient (see class doc for why the Work List REST API can't be used for
         * this).
         * @private
         * @async
         */
        async _fetchFinishedSfcs(sPlant, sOrder) {
            const aFinished = await this.#oSfcClient.getSfcsByOrderAndStatus({
                plant: sPlant,
                order: sOrder,
                statusCode: SFCStatusCode.COMPLETED
            });

            oLogger.info("[FinishedSfcList] Finished SFCs fetched", { order: sOrder, count: aFinished.length });

            return aFinished;
        }

        /**
         * Fetches batch/predecessor batch info for the given finished SFCs. Failures are
         * logged and surfaced via toast but do not propagate, so the SFC list still renders.
         * @private
         * @async
         */
        async _fetchBatchInfo(sPlant, aFinished) {
            try {
                // Confirmed via Postman: plant + sfcs + parameterName is sufficient. dcGroup.*
                // and operation.* are deliberately not sent — see DataCollectionBatchClient.
                // The apiBaseUrl (resolved gateway base) is what makes the URL correct; without
                // it the call resolves against the bare origin and 404s.
                // TODO(TESTING ONLY): plant hardcoded to "1000" to rule out a missing/wrong
                // plant from PodContext. Revert to `plant: sPlant` before shipping.
                return await this.#oBatchClient.getBatchInfo({
                    apiBaseUrl: this._resolveApiBaseUrl(),
                    plant: "1000",
                    sfcs: aFinished.map((oSfc) => oSfc.sfc),
                    batchParameter: this.getPropertyValue(FinishedSfcList.PropertyId.BatchParameterName),
                    predecessorParameter: this.getPropertyValue(FinishedSfcList.PropertyId.PredecessorBatchParameterName)
                });
            } catch (oError) {
                oLogger.error("[FinishedSfcList] Failed to load batch info", { message: oError.message });
                MessageToast.show(this.getI18nText("FinishedSfcList.batchLoadFailed") || "Failed to load batch data");
                return {};
            }
        }

        /**
         * Resolves the SAP DM API gateway base URL that Data Collection calls must be prefixed
         * with (mirrors the sample AttendanceImport plugin), in priority order:
         *   1. POD Designer "apiBaseUrl" property — manual override.
         *   2. window.location path — POD 2.0 serves all API calls under the same ~{hash}~
         *      segment as the page itself: .../sapdmdmepod2/~{hash}~/fnd/api-gateway-ms/
         *   3. getPodRuntime().getPublicApiRestDataSourceUri() if available (POD 1.0 legacy).
         *   4. Same-origin /api/ fallback.
         * @private
         */
        _resolveApiBaseUrl() {
            // 1. Manual override configured in POD Designer.
            const sManual = this.getPropertyValue(FinishedSfcList.PropertyId.ApiBaseUrl)?.trim();
            if (sManual) {
                oLogger.info("[FinishedSfcList] Using configured API base URL", { url: sManual });
                return sManual;
            }

            // 2. Derive from window.location — the ~hash~ segment POD 2.0 uses for same-origin
            //    API gateway proxying, e.g. /sapdmdmepod2/~e0114c14-.../fnd/api-gateway-ms/
            try {
                const oMatch = window.location.pathname.match(/^(.*\/~[^~]+~\/)/);
                if (oMatch) {
                    const sResolved = `${window.location.origin}${oMatch[1]}fnd/api-gateway-ms/`;
                    oLogger.info("[FinishedSfcList] Resolved API base URL from window.location", { url: sResolved });
                    return sResolved;
                }
            } catch (oError) {
                oLogger.warn("[FinishedSfcList] Failed to derive API base URL from window.location", { message: oError.message });
            }

            // 3. POD runtime may expose the URL (POD 1.0, may carry over to 2.0).
            try {
                const oRuntime = this.getPodRuntime?.();
                if (typeof oRuntime?.getPublicApiRestDataSourceUri === "function") {
                    const sUrl = oRuntime.getPublicApiRestDataSourceUri();
                    if (sUrl) {
                        oLogger.info("[FinishedSfcList] Resolved API base URL from POD runtime", { url: sUrl });
                        return sUrl;
                    }
                }
            } catch (oError) {
                oLogger.warn("[FinishedSfcList] Failed to resolve API base URL from POD runtime", { message: oError.message });
            }

            // 4. Last resort — same-origin /api/ path.
            const sFallback = `${window.location.origin}/api/`;
            oLogger.warn("[FinishedSfcList] API base URL auto-detection failed — using fallback", { url: sFallback });
            return sFallback;
        }

        /**
         * Combines finished SFCs with their batch info and appends a totals row.
         * @private
         */
        _buildRows(aFinished, mBatchInfo) {
            const aRows = aFinished.map((oSfc) => {
                const oBatch = mBatchInfo[oSfc.sfc] ?? {};
                return {
                    sfc: oSfc.sfc,
                    quantity: oSfc.quantity ?? 0,
                    batchNumber: oBatch.batchNumber || oSfc.defaultBatchId || "",
                    predecessorBatchNumber: oBatch.predecessorBatchNumber || "",
                    isTotal: false
                };
            });

            const fTotalQuantity = aRows.reduce((fSum, oRow) => fSum + (Number(oRow.quantity) || 0), 0);

            aRows.push({
                sfc: this.getI18nText("FinishedSfcList.total") || "Total",
                quantity: fTotalQuantity,
                batchNumber: "",
                predecessorBatchNumber: "",
                isTotal: true
            });

            return aRows;
        }

        /** @extensible @override */
        _createCell(oColumnConfig) {
            const oTotalRowState = { path: "isTotal", formatter: (b) => (b ? "Information" : "None") };

            const cellMap = {
                [FinishedSfcList.Field.Sfc]: () => new ObjectStatus({ text: "{sfc}", state: oTotalRowState }),
                [FinishedSfcList.Field.Quantity]: () => new ObjectStatus({ text: "{quantity}", state: oTotalRowState }),
                [FinishedSfcList.Field.BatchNumber]: () => new Text({ text: "{batchNumber}" }),
                [FinishedSfcList.Field.PredecessorBatchNumber]: () => new Text({ text: "{predecessorBatchNumber}" })
            };

            return cellMap[oColumnConfig.field]?.() || super._createCell(oColumnConfig);
        }

        /** @extensible @override */
        getProperties() {
            return [
                new WidgetProperty({
                    displayName: this.getI18nText("FinishedSfcList.prop.batchParameterName"),
                    description: this.getI18nText("FinishedSfcList.prop.batchParameterNameDesc"),
                    category: PropertyCategory.Data,
                    propertyEditor: new StringPropertyEditor(this, FinishedSfcList.PropertyId.BatchParameterName)
                }),
                new WidgetProperty({
                    displayName: this.getI18nText("FinishedSfcList.prop.predecessorBatchParameterName"),
                    description: this.getI18nText("FinishedSfcList.prop.predecessorBatchParameterNameDesc"),
                    category: PropertyCategory.Data,
                    propertyEditor: new StringPropertyEditor(this, FinishedSfcList.PropertyId.PredecessorBatchParameterName)
                }),
                new WidgetProperty({
                    displayName: this.getI18nText("FinishedSfcList.prop.apiBaseUrl"),
                    description: this.getI18nText("FinishedSfcList.prop.apiBaseUrlDesc"),
                    category: PropertyCategory.Data,
                    propertyEditor: new StringPropertyEditor(this, FinishedSfcList.PropertyId.ApiBaseUrl)
                })
            ];
        }
    }

    return FinishedSfcList;
});
