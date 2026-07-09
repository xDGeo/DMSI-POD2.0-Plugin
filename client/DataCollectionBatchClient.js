sap.ui.define([
    "sap/dm/dme/pod2/api/RestClient",
    "sap/dm/dme/pod2/Logger",
    "dmsi/pod2/util/ValidationErrorHandler"
], (
    RestClient,
    Logger,
    ValidationErrorHandler
) => {
    "use strict";

    const oLogger = Logger.getLogger("dmsi.pod2.client.DataCollectionBatchClient");

    // Confirmed against the public Data Collection API's OpenAPI spec: GET /measurements
    // (base URL https://api.{regionHost}/datacollection/v1/measurements). Accepts a bulk
    // "sfcs" array plus optional "dcGroup.name"/"parameterName" filters and returns one row
    // per SFC+parameter (ParametricData: { plant, sfc, parameter: { measureName, actual, ... } }).
    // There's no typed POD 2.0 SDK wrapper for this endpoint (DataCollectionPublicApiClient
    // only exposes group/parameter *definitions*, not collected *values*), so it's called
    // directly via RestClient — the same sanctioned mechanism used by the sample
    // ExternalDataFetchAction for first-party REST calls.
    //
    // parameterName only accepts a single value per call, so batch and predecessor batch are
    // fetched as two separate, narrowly-filtered calls rather than one broad query — this
    // also keeps each page small, since pageSize is capped server-side at 50.
    //
    // ASSUMPTION: the relative path below mirrors the OpenAPI spec's base URL segment
    // (.../datacollection/v1/measurements). Not yet confirmed that RestClient resolves it
    // this way on this tenant — check this first if a call 404s.
    const MEASUREMENTS_PATH = "/datacollection/v1/measurements";
    const PAGE_SIZE = 50;
    const MAX_PAGES = 20; // safety cap: 20 * 50 = 1000 records per parameter

    class DataCollectionBatchClient {

        /**
         * Retrieves the most recently collected batch number and predecessor batch number
         * for a list of SFCs.
         * @param {Object} oRequest
         * @param {string} oRequest.plant
         * @param {Array<string>} oRequest.sfcs
         * @param {string} oRequest.batchParameter - Data collection parameter name holding the batch number.
         * @param {string} oRequest.predecessorParameter - Data collection parameter name holding the predecessor batch number.
         * @param {string} [oRequest.group] - Data collection group to scope the query to (e.g. BATCH_CHARS). Optional.
         * @returns {Promise<Object<string, {batchNumber: string, predecessorBatchNumber: string}>>} Keyed by SFC.
         * @throws {Error} If validation fails.
         */
        async getBatchInfo(oRequest) {
            ValidationErrorHandler.validateObject(oRequest, "request object");

            const sPlant = ValidationErrorHandler.validateFilterValue(oRequest.plant, "Plant");
            const aSfcs = (oRequest.sfcs ?? []).filter(Boolean);
            const sBatchParam = oRequest.batchParameter?.trim();
            const sPredecessorParam = oRequest.predecessorParameter?.trim();
            const sGroup = oRequest.group?.trim();

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            const mResult = {};

            if (sBatchParam) {
                await this.#fetchParameterInto(mResult, sPlant, aSfcs, sGroup, sBatchParam, "batchNumber");
            }
            if (sPredecessorParam) {
                await this.#fetchParameterInto(mResult, sPlant, aSfcs, sGroup, sPredecessorParam, "predecessorBatchNumber");
            }

            return mResult;
        }

        /**
         * Fetches all pages of a single parameter's collected values across the given SFCs,
         * and writes the latest value per SFC into mResult under sField.
         * @private
         * @async
         */
        async #fetchParameterInto(mResult, sPlant, aSfcs, sGroup, sParameterName, sField) {
            const aRecords = await this.#fetchAllPages(sPlant, aSfcs, sGroup, sParameterName);

            for (const oRecord of aRecords) {
                const sSfc = oRecord.sfc;
                if (!sSfc) {
                    continue;
                }
                if (!mResult[sSfc]) {
                    mResult[sSfc] = { batchNumber: "", predecessorBatchNumber: "" };
                }
                if (!mResult[sSfc][sField]) {
                    mResult[sSfc][sField] = oRecord.parameter?.actual ?? "";
                }
            }
        }

        /**
         * @private
         * @async
         */
        async #fetchAllPages(sPlant, aSfcs, sGroup, sParameterName) {
            const aAllRecords = [];

            for (let iPage = 0; iPage < MAX_PAGES; iPage++) {
                const oQuery = {
                    plant: sPlant,
                    sfcs: aSfcs,
                    parameterName: sParameterName,
                    pageNumber: iPage,
                    pageSize: PAGE_SIZE
                };
                if (sGroup) {
                    oQuery["dcGroup.name"] = sGroup;
                }

                const oResponse = await RestClient.get(MEASUREMENTS_PATH, oQuery);
                const aPageRecords = oResponse?.data ?? [];
                aAllRecords.push(...aPageRecords);

                const iNumberOfPages = oResponse?.numberOfPages ?? 1;
                if (aPageRecords.length < PAGE_SIZE || iPage + 1 >= iNumberOfPages) {
                    break;
                }
            }

            oLogger.info("[DataCollectionBatchClient] Fetched measurements", {
                parameterName: sParameterName,
                recordCount: aAllRecords.length
            });

            return aAllRecords;
        }
    }

    return DataCollectionBatchClient;
});
