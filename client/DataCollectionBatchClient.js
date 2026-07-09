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
    // NOT the deprecated GET /parameters endpoint (getLoggedSfcDataUsingGET). Per the API's
    // own documentation, only "plant" is required; dcGroup.name/.version, operation.name/
    // .version, resource, and parameterName are all optional refinements — but every one of
    // them is passed through here when available, matching the full documented parameter set
    // exactly rather than guessing which subset is needed. There's no typed POD 2.0 SDK
    // wrapper for this endpoint (DataCollectionPublicApiClient only exposes group/parameter
    // *definitions*, not collected *values*), so it's called directly via RestClient — the
    // same sanctioned mechanism used by the sample ExternalDataFetchAction for first-party
    // REST calls.
    //
    // Two calls per SFC (one per parameter — parameterName only accepts a single value), with
    // plant/operation/resource resolved from PodContext and group/version configured in the
    // POD Designer. Calling per-SFC (rather than passing all SFCs in one bulk "sfcs" array)
    // avoids relying on how RestClient serializes a multi-value query parameter, which isn't
    // confirmed.
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
         * @param {string} oRequest.plant - Required by the API.
         * @param {Array<string>} oRequest.sfcs
         * @param {string} oRequest.batchParameter - Data collection parameter name holding the batch number.
         * @param {string} oRequest.predecessorParameter - Data collection parameter name holding the predecessor batch number.
         * @param {string} [oRequest.operationName] - Current operation name, if known.
         * @param {string} [oRequest.operationVersion] - Current operation version, if known.
         * @param {string} [oRequest.resource] - Current resource, if known.
         * @param {string} [oRequest.group] - Data collection group to scope the query to (e.g. BATCH_CHARS).
         * @param {string} [oRequest.groupVersion] - Data collection group version (e.g. A).
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
            const sGroup = oRequest.group?.trim();
            const sGroupVersion = oRequest.groupVersion?.trim();

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            oLogger.info("[DataCollectionBatchClient] Fetching batch info", {
                plant: sPlant,
                sfcCount: aSfcs.length,
                operationName: sOperationName || "(none)",
                operationVersion: sOperationVersion || "(none)",
                resource: sResource || "(none)",
                group: sGroup || "(none)",
                groupVersion: sGroupVersion || "(none)",
                batchParameter: sBatchParam,
                predecessorParameter: sPredecessorParam
            });

            const oContext = { sPlant, sOperationName, sOperationVersion, sResource, sGroup, sGroupVersion };
            const mResult = {};
            aSfcs.forEach((sSfc) => { mResult[sSfc] = { batchNumber: "", predecessorBatchNumber: "" }; });

            const aFetches = [];
            if (sBatchParam) {
                aFetches.push(...aSfcs.map((sSfc) =>
                    this.#fetchParameterInto(mResult, sSfc, "batchNumber", oContext, sBatchParam)
                ));
            }
            if (sPredecessorParam) {
                aFetches.push(...aSfcs.map((sSfc) =>
                    this.#fetchParameterInto(mResult, sSfc, "predecessorBatchNumber", oContext, sPredecessorParam)
                ));
            }
            await Promise.all(aFetches);

            const iFoundCount = Object.values(mResult).filter((o) => o.batchNumber || o.predecessorBatchNumber).length;
            if (!iFoundCount) {
                oLogger.warn("[DataCollectionBatchClient] No batch/predecessor batch values found for any SFC " +
                    "— verify the parameterName/group/version/operation/resource values are correct " +
                    "(case-sensitive).");
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
        async #fetchParameterInto(mResult, sSfc, sField, oContext, sParameterName) {
            try {
                // sfcs is documented as an array (collectionFormat "multi" = repeated
                // sfcs=X&sfcs=Y), but RestClient.get() serializes a JS array as indexed keys
                // (sfcs.0=X) instead — which the backend doesn't recognize as the sfcs
                // parameter at all (confirmed via a 404 with sfcs.0= in the resulting URL).
                // Passing a plain string here instead produces the correct sfcs=X, which is
                // sufficient since we only ever query one SFC per call.
                const oQuery = { plant: oContext.sPlant, sfcs: sSfc, parameterName: sParameterName };

                if (oContext.sOperationName) { oQuery["operation.name"] = oContext.sOperationName; }
                if (oContext.sOperationVersion) { oQuery["operation.version"] = oContext.sOperationVersion; }
                if (oContext.sResource) { oQuery.resource = oContext.sResource; }
                if (oContext.sGroup) { oQuery["dcGroup.name"] = oContext.sGroup; }
                if (oContext.sGroupVersion) { oQuery["dcGroup.version"] = oContext.sGroupVersion; }

                const oResponse = await RestClient.get(MEASUREMENTS_PATH, oQuery);

                oLogger.info("[DataCollectionBatchClient] Raw response", {
                    sfc: sSfc,
                    parameterName: sParameterName,
                    response: oResponse
                });

                const sValue = this.#extractValue(oResponse, sParameterName);
                if (sValue !== null) {
                    mResult[sSfc][sField] = sValue;
                }
            } catch (oError) {
                oLogger.error("[DataCollectionBatchClient] Failed to fetch measurement", {
                    sfc: sSfc,
                    parameterName: sParameterName,
                    message: oError.message
                });
            }
        }

        /**
         * Extracts a parameter's collected value from the response, tolerating shape
         * differences between the documented /measurements schema and what the tenant
         * actually returns:
         *  - Response may be the array directly, or wrapped in a "data" property.
         *  - Each record may carry the matched parameter as a singular "parameter" object
         *    (documented /measurements shape) or a plural "parameters" array (the shape
         *    confirmed on this tenant via the deprecated /parameters endpoint).
         * Returns null if no match was found (as opposed to "" for a genuinely empty value).
         * @private
         */
        #extractValue(oResponse, sParameterName) {
            const aRecords = Array.isArray(oResponse) ? oResponse : (oResponse?.data ?? []);

            for (const oRecord of aRecords) {
                if (oRecord.parameter?.measureName === sParameterName) {
                    return oRecord.parameter.actual ?? "";
                }

                const oMatch = (oRecord.parameters ?? []).find((oParam) => oParam.measureName === sParameterName);
                if (oMatch) {
                    return oMatch.actual ?? "";
                }
            }

            return null;
        }
    }

    return DataCollectionBatchClient;
});
