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

    // Uses the Data Collection API's GET /measurements endpoint (getLoggedMeasuresUsingGET) —
    // NOT the deprecated GET /parameters endpoint (getLoggedSfcDataUsingGET). A working test
    // directly against the tenant confirmed operation.name, operation.version, resource, and
    // sfcs are required in practice (the /measurements OpenAPI spec lists them as optional,
    // but the real backend behaves like /parameters here) and that dcGroup is NOT needed —
    // parameterName alone is sufficient to isolate the batch/predecessor batch values. There's
    // no typed POD 2.0 SDK wrapper for this endpoint (DataCollectionPublicApiClient only
    // exposes group/parameter *definitions*, not collected *values*), so it's called directly
    // via RestClient — the same sanctioned mechanism used by the sample ExternalDataFetchAction
    // for first-party REST calls.
    //
    // Two calls per SFC (one per parameter — parameterName only accepts a single value), with
    // plant/operation/resource all resolved from PodContext, not configured. Calling per-SFC
    // (rather than passing all SFCs in one bulk "sfcs" array) avoids relying on how RestClient
    // serializes a multi-value query parameter, which isn't confirmed.
    //
    // ASSUMPTION: the relative path below mirrors the OpenAPI spec's base URL segment
    // (.../datacollection/v1/measurements). Not yet confirmed that RestClient resolves it this
    // way on this tenant — check this first if a call 404s.
    const MEASUREMENTS_PATH = "/datacollection/v1/measurements";
    const MAX_SFCS = 200;

    class DataCollectionBatchClient {

        /**
         * Retrieves the most recently collected batch number and predecessor batch number
         * for a list of SFCs.
         * @param {Object} oRequest
         * @param {string} oRequest.plant
         * @param {Array<string>} oRequest.sfcs
         * @param {string} oRequest.batchParameter - Data collection parameter name holding the batch number.
         * @param {string} oRequest.predecessorParameter - Data collection parameter name holding the predecessor batch number.
         * @param {string} oRequest.operationName - The current operation name (required by the API in practice).
         * @param {string} oRequest.operationVersion - The current operation version (required by the API in practice).
         * @param {string} oRequest.resource - The current resource (required by the API in practice).
         * @returns {Promise<Object<string, {batchNumber: string, predecessorBatchNumber: string}>>} Keyed by SFC.
         * @throws {Error} If validation fails.
         */
        async getBatchInfo(oRequest) {
            ValidationErrorHandler.validateObject(oRequest, "request object");

            const sPlant = ValidationErrorHandler.validateFilterValue(oRequest.plant, "Plant");
            const aSfcs = (oRequest.sfcs ?? []).filter(Boolean).slice(0, MAX_SFCS);
            const sBatchParam = oRequest.batchParameter?.trim();
            const sPredecessorParam = oRequest.predecessorParameter?.trim();
            const sOperationName = oRequest.operationName?.trim();
            const sOperationVersion = oRequest.operationVersion?.trim();
            const sResource = oRequest.resource?.trim();

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            if (!sOperationName || !sOperationVersion || !sResource) {
                oLogger.warn("[DataCollectionBatchClient] Missing operation/resource context — " +
                    "cannot call the Data Collection /measurements API (all three are required)", {
                    operationName: sOperationName || "(missing)",
                    operationVersion: sOperationVersion || "(missing)",
                    resource: sResource || "(missing)"
                });
                return {};
            }

            oLogger.info("[DataCollectionBatchClient] Fetching batch info", {
                plant: sPlant,
                sfcCount: aSfcs.length,
                operationName: sOperationName,
                operationVersion: sOperationVersion,
                resource: sResource,
                batchParameter: sBatchParam,
                predecessorParameter: sPredecessorParam
            });

            const mResult = {};
            aSfcs.forEach((sSfc) => { mResult[sSfc] = { batchNumber: "", predecessorBatchNumber: "" }; });

            const aFetches = [];
            if (sBatchParam) {
                aFetches.push(...aSfcs.map((sSfc) =>
                    this.#fetchParameterInto(mResult, sSfc, "batchNumber", sPlant, sOperationName, sOperationVersion, sResource, sBatchParam)
                ));
            }
            if (sPredecessorParam) {
                aFetches.push(...aSfcs.map((sSfc) =>
                    this.#fetchParameterInto(mResult, sSfc, "predecessorBatchNumber", sPlant, sOperationName, sOperationVersion, sResource, sPredecessorParam)
                ));
            }
            await Promise.all(aFetches);

            const iFoundCount = Object.values(mResult).filter((o) => o.batchNumber || o.predecessorBatchNumber).length;
            if (!iFoundCount) {
                oLogger.warn("[DataCollectionBatchClient] No batch/predecessor batch values found for any SFC " +
                    "— verify the parameterName/operation/resource values are correct (case-sensitive).");
            }

            return mResult;
        }

        /**
         * Fetches a single parameter's collected value for a single SFC and writes it into
         * mResult under sField. Failures are logged and swallowed so one bad call doesn't
         * block the rest.
         * @private
         * @async
         */
        async #fetchParameterInto(mResult, sSfc, sField, sPlant, sOperationName, sOperationVersion, sResource, sParameterName) {
            try {
                const oQuery = {
                    plant: sPlant,
                    sfcs: [sSfc],
                    "operation.name": sOperationName,
                    "operation.version": sOperationVersion,
                    resource: sResource,
                    parameterName: sParameterName
                };

                const oResponse = await RestClient.get(MEASUREMENTS_PATH, oQuery);
                const aRecords = oResponse?.data ?? [];
                const oMatch = aRecords.find((oRecord) => oRecord.parameter?.measureName === sParameterName);

                if (oMatch) {
                    mResult[sSfc][sField] = oMatch.parameter?.actual ?? "";
                }
            } catch (oError) {
                oLogger.error("[DataCollectionBatchClient] Failed to fetch measurement", {
                    sfc: sSfc,
                    parameterName: sParameterName,
                    message: oError.message
                });
            }
        }
    }

    return DataCollectionBatchClient;
});
