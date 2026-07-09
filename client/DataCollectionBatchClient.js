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
    // NOT the deprecated GET /parameters endpoint (getLoggedSfcDataUsingGET). There's no typed
    // POD 2.0 SDK wrapper for this endpoint (DataCollectionPublicApiClient only exposes
    // group/parameter *definitions*, not collected *values*), so it's called directly via
    // RestClient — the same sanctioned mechanism used by the sample ExternalDataFetchAction
    // for first-party REST calls.
    //
    // CONFIRMED via side-by-side Postman tests against the tenant: plant + sfcs + dcGroup.name
    // + dcGroup.version (+ optionally parameterName) is sufficient and correct.
    // operation.name/operation.version/resource are NOT needed — both successful test calls
    // omitted them entirely. dcGroup.name and dcGroup.version must always be sent together:
    // an earlier bug sent dcGroup.name alone (the paired version was blank because the widget
    // instance's "Data Collection Group Version" property hadn't been set in POD Designer),
    // and that combination 404s. To make that failure mode structurally impossible, dcGroup
    // filtering is applied here only when BOTH name and version are present.
    //
    // Two calls per SFC (one per parameter — parameterName only accepts a single value).
    // Calling per-SFC (rather than passing all SFCs in one bulk "sfcs" array) avoids relying
    // on how RestClient serializes a multi-value query parameter, which isn't confirmed.
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
         * @param {string} [oRequest.group] - Data collection group to scope the query to (e.g. BATCH_CHARS). Ignored unless groupVersion is also given.
         * @param {string} [oRequest.groupVersion] - Data collection group version (e.g. A). Ignored unless group is also given.
         * @returns {Promise<Object<string, {batchNumber: string, predecessorBatchNumber: string}>>} Keyed by SFC.
         * @throws {Error} If validation fails.
         */
        async getBatchInfo(oRequest) {
            ValidationErrorHandler.validateObject(oRequest, "request object");

            const sPlant = ValidationErrorHandler.validateFilterValue(oRequest.plant, "Plant");
            const aSfcs = (oRequest.sfcs ?? []).filter(Boolean).slice(0, MAX_SFCS);
            const sBatchParam = oRequest.batchParameter?.trim();
            const sPredecessorParam = oRequest.predecessorParameter?.trim();
            const sGroup = oRequest.group?.trim();
            const sGroupVersion = oRequest.groupVersion?.trim();

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            // dcGroup.name and dcGroup.version must travel together — sending name without
            // version 404s (confirmed). If either is missing, omit both rather than send an
            // invalid half-pair.
            const bHasGroup = Boolean(sGroup && sGroupVersion);
            if (sGroup && !bHasGroup) {
                oLogger.warn("[DataCollectionBatchClient] Data Collection Group is set but " +
                    "Group Version is blank — omitting both filters rather than sending an " +
                    "invalid combination. Set the Group Version property to fix this.");
            }

            oLogger.info("[DataCollectionBatchClient] Fetching batch info", {
                plant: sPlant,
                sfcCount: aSfcs.length,
                group: bHasGroup ? sGroup : "(none)",
                groupVersion: bHasGroup ? sGroupVersion : "(none)",
                batchParameter: sBatchParam,
                predecessorParameter: sPredecessorParam
            });

            const oContext = { sPlant, sGroup: bHasGroup ? sGroup : null, sGroupVersion: bHasGroup ? sGroupVersion : null };
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
                    "— verify the parameterName/group/version values are correct (case-sensitive).");
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

                if (oContext.sGroup && oContext.sGroupVersion) {
                    oQuery["dcGroup.name"] = oContext.sGroup;
                    oQuery["dcGroup.version"] = oContext.sGroupVersion;
                }

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
