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
    "sap/dm/dme/pod2/api/sfc/SfcPublicApiClient",
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
    SfcPublicApiClient,
    DataCollectionBatchClient,
    Logger
) => {
    "use strict";

    const { Priority } = CoreLibrary;
    const { ObjectStatus, Text, MessageToast } = MobileLibrary;

    const oLogger = Logger.getLogger("dmsi.pod2.plugins.FinishedSfcList");

    // Confirmed against a live tenant's SFC > Data Collections tab (group BATCH_CHARS).
    const DEFAULT_BATCH_PARAMETER = "BATCH";
    const DEFAULT_PREDECESSOR_PARAMETER = "IP_PREDECESSOR_BATCH";

    /**
     * Lists all finished (COMPLETED) SFCs of the order behind the currently selected
     * work list item, together with the SFC's split quantity, batch number, and predecessor
     * batch number (both read from Data Collection). A totals row with the summed quantity
     * is appended at the end of the list.
     */
    class FinishedSfcList extends TableWidget {

        static #oI18nModel = new I18nResourceModel({ bundleName: "dmsi.pod2.plugins.i18n.i18n" });

        static getI18nModel() { return this.#oI18nModel; }

        static PropertyId = Object.freeze({
            BatchParameterName: "batchParameterName",
            PredecessorBatchParameterName: "predecessorBatchParameterName"
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
                    [FinishedSfcList.PropertyId.PredecessorBatchParameterName]: DEFAULT_PREDECESSOR_PARAMETER
                }
            };
        }

        /** @extensible @override */
        static getFields() {
            const thisI18n = this.getI18nText.bind(this);
            return [
                { field: this.Field.Sfc, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.sfc") },
                { field: this.Field.Quantity, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.quantity") },
                { field: this.Field.BatchNumber, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.batchNumber") },
                { field: this.Field.PredecessorBatchNumber, importance: Priority.High, sortable: false, text: thisI18n("FinishedSfcList.predecessorBatchNumber") }
            ];
        }

        #oClient = new SfcPublicApiClient();
        #oBatchClient = new DataCollectionBatchClient();
        #bIsLoading = false;

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

                if (!sPlant || !sOrder) {
                    PodContext.set(this._getModelPath(), []);
                    return;
                }

                const aFinished = await this._fetchFinishedSfcs(sPlant, sOrder);

                if (!aFinished.length) {
                    PodContext.set(this._getModelPath(), []);
                    return;
                }

                // Batch info is a best-effort enrichment: if it fails (e.g. wrong Data
                // Collection parameter name/MDO field), the SFC/quantity rows must still
                // render rather than the whole list disappearing.
                const mBatchInfo = await this._fetchBatchInfo(sPlant, aFinished);

                PodContext.set(this._getModelPath(), this._buildRows(aFinished, mBatchInfo));
            } catch (oError) {
                oLogger.error("[FinishedSfcList] Failed to load finished SFCs", { message: oError.message });
                MessageToast.show(this.getI18nText("FinishedSfcList.loadFailed") || "Failed to load finished SFCs");
                PodContext.set(this._getModelPath(), []);
            } finally {
                this.#bIsLoading = false;
            }
        }

        /**
         * Fetches all SFCs of the given order and keeps only the finished (COMPLETED) ones.
         * @private
         * @async
         */
        async _fetchFinishedSfcs(sPlant, sOrder) {
            const aSfcs = await this.#oClient.getSfcs({
                plant: sPlant,
                // Deliberately left unrestricted: the order's finished SFCs may sit at
                // different work centers/operations, so we scope only by order below.
                workCenter: "",
                filter: { order: sOrder }
            });

            return (aSfcs ?? []).filter((oSfc) => oSfc.status?.code === SFCStatusCode.COMPLETED);
        }

        /**
         * Fetches batch/predecessor batch info for the given finished SFCs. Failures are
         * logged and surfaced via toast but do not propagate, so the SFC list still renders.
         * @private
         * @async
         */
        async _fetchBatchInfo(sPlant, aFinished) {
            try {
                return await this.#oBatchClient.getBatchInfo({
                    plant: sPlant,
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
                })
            ];
        }
    }

    return FinishedSfcList;
});
