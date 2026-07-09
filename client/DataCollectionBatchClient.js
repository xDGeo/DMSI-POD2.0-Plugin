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
    // CONFIRMED against the tenant by actually running the widget: plant + sfcs + parameterName
    // is the sufficient and correct request, e.g.
    //   GET <gateway>/datacollection/v1/measurements?parameterName=IP_PREDECESSOR_BATCH&plant=1000&sfcs=140002057-893-76
    // returns the collected value in data[].parameter.actual.
    //
    // dcGroup.name / dcGroup.version are deliberately NOT sent. Although the OpenAPI spec lists
    // them as optional query params, sending dcGroup.name=BATCH_CHARS&dcGroup.version=A on this
    // tenant makes the request 404 for *every* SFC — even SFCs that DO have a logged value.
    // Because #fetchParameterInto treats 404 as "no value logged" and swallows it, that silently
    // blanked out every BATCH / IP_PREDECESSOR_BATCH column. (An earlier Postman "confirmation"
    // that dcGroup.name+version was required was misleading: Postman's base URL already included
    // the gateway prefix, so those calls succeeded for a different reason — the real variable was
    // the URL base, see below, not the dcGroup filter.) operation.name/operation.version/resource
    // are likewise not needed and not sent.
    //
    // Two calls per SFC (one per parameter — parameterName only accepts a single value).
    // Calling per-SFC (rather than passing all SFCs in one bulk "sfcs" array) avoids relying
    // on how RestClient serializes a multi-value query parameter, which isn't confirmed.
    //
    // The full request URL is built by concatenating the POD 2.0 API gateway base URL
    // (resolved by the widget, e.g. ".../sapdmdmepod2/~{hash}~/fnd/api-gateway-ms/") with the
    // service-relative path below — exactly the pattern the sample AttendanceApiClient uses.
    // Passing a bare "/datacollection/v1/measurements" to RestClient does NOT work: it resolves
    // against the page origin (https://<host>/datacollection/...), missing the gateway prefix,
    // and 404s for every SFC — this WAS the root cause of the empty batch columns. Note: NO
    // leading slash, so it appends onto the gateway base rather than replacing its path.
    const MEASUREMENTS_SERVICE_PATH = "datacollection/v1/measurements";
    const MAX_SFCS = 200;

    class DataCollectionBatchClient {

        /**
         * Retrieves the most recently collected batch number and predecessor batch number
         * for a list of SFCs.
         * @param {Object} oRequest
         * @param {string} oRequest.apiBaseUrl - POD 2.0 API gateway base URL (resolved by the widget).
         * @param {string} oRequest.plant - Required by the API.
         * @param {Array<string>} oRequest.sfcs
         * @param {string} oRequest.batchParameter - Data collection parameter name holding the batch number.
         * @param {string} oRequest.predecessorParameter - Data collection parameter name holding the predecessor batch number.
         * @returns {Promise<Object<string, {batchNumber: string, predecessorBatchNumber: string}>>} Keyed by SFC.
         * @throws {Error} If validation fails.
         */
        async getBatchInfo(oRequest) {
            ValidationErrorHandler.validateObject(oRequest, "request object");

            const sPlant = ValidationErrorHandler.validateFilterValue(oRequest.plant, "Plant");
            const aSfcs = (oRequest.sfcs ?? []).filter(Boolean).slice(0, MAX_SFCS);
            const sBatchParam = oRequest.batchParameter?.trim();
            const sPredecessorParam = oRequest.predecessorParameter?.trim();

            // Build the full measurements URL from the gateway base + service path. Guard
            // against a missing base so it fails loudly here rather than silently 404ing.
            const sBase = oRequest.apiBaseUrl?.trim();
            if (!sBase) {
                throw new Error("[DataCollectionBatchClient] apiBaseUrl is required — could not resolve the API gateway base URL.");
            }
            const sMeasurementsUrl = sBase.replace(/\/?$/, "/") + MEASUREMENTS_SERVICE_PATH;

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            // warn (not info) deliberately: this tenant's effective Logger level filters out
            // INFO entirely, so info() calls never reach the console at all (confirmed — even
            // Logger.setDefaultLevel(DEBUG) via the browser console had no effect, since a full
            // page reload wipes that override before the widget's first fetch). warn() is
            // confirmed visible. Keep diagnostic logs on warn()/error(), never info().
            oLogger.warn("[DataCollectionBatchClient] Fetching batch info", {
                url: sMeasurementsUrl,
                plant: sPlant,
                sfcCount: aSfcs.length,
                batchParameter: sBatchParam,
                predecessorParameter: sPredecessorParam
            });

            const oContext = { sPlant, sMeasurementsUrl };
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
                    "— verify the parameterName values are correct (case-sensitive) and that the resolved " +
                    "API base URL above points at the POD API gateway.");
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

                const oResponse = await RestClient.get(oContext.sMeasurementsUrl, oQuery);

                oLogger.warn("[DataCollectionBatchClient] Raw response", {
                    sfc: sSfc,
                    parameterName: sParameterName,
                    response: oResponse
                });

                const sValue = this.#extractValue(oResponse, sParameterName);
                if (sValue !== null) {
                    mResult[sSfc][sField] = sValue;
                }
            } catch (oError) {
                // This API can return 404 (rather than 200 with an empty array) when the
                // specific SFC has no value logged for the requested parameter — e.g.
                // predecessor batch may only be recorded on certain SFCs, not universally.
                // That's an expected, normal outcome, not a failure, so it's logged quietly
                // instead of as an error. Anything else (500, network failure, wrong path,
                // etc.) still logs as an error.
                //
                // NOTE: a 404 here means "no value for this SFC/parameter". It must NOT be
                // re-broadened by adding query filters (dcGroup.name/version, operation.*):
                // on this tenant those make even SFCs that DO have a value 404, which silently
                // blanks the whole column. Keep the query to plant + sfcs + parameterName.
                if (this.#getStatusCode(oError) === 404) {
                    oLogger.warn("[DataCollectionBatchClient] No value logged for this SFC/parameter", {
                        plant: oContext.sPlant,
                        sfc: sSfc,
                        parameterName: sParameterName
                    });
                } else {
                    oLogger.error("[DataCollectionBatchClient] Failed to fetch measurement", {
                        sfc: sSfc,
                        parameterName: sParameterName,
                        message: oError.message
                    });
                }
            }
        }

        /**
         * Extracts an HTTP status code from a RestClient error, tolerating whichever shape it
         * comes in (a numeric .status/.statusCode property, or embedded in the message text
         * as "Request returned 404").
         * @private
         */
        #getStatusCode(oError) {
            if (typeof oError?.status === "number") {
                return oError.status;
            }
            if (typeof oError?.statusCode === "number") {
                return oError.statusCode;
            }
            const oMatch = /returned (\d+)/.exec(oError?.message ?? "");
            return oMatch ? Number(oMatch[1]) : null;
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
