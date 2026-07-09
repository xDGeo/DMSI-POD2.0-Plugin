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

    // Uses the Data Collection API's GET /parameters endpoint (getLoggedSfcDataUsingGET),
    // confirmed against that API's OpenAPI spec — operation.name, operation.version, plant,
    // resource, and sfcs are all required there (unlike GET /measurements, which only
    // requires plant; /parameters is what actually matches the required-field set observed
    // when testing directly against the tenant). There's no typed POD 2.0 SDK wrapper for
    // this endpoint (DataCollectionPublicApiClient only exposes group/parameter
    // *definitions*, not collected *values*), so it's called directly via RestClient — the
    // same sanctioned mechanism used by the sample ExternalDataFetchAction for first-party
    // REST calls.
    //
    // One call per SFC (plant/operation/resource from PodContext, sfc as the input), scoped
    // to the confirmed Data Collection Group (BATCH_CHARS, version A) rather than filtering
    // by parameterName — this fetches every parameter in that group for the SFC in a single
    // small response, from which both the batch and predecessor batch values are read
    // client-side. Calling per-SFC (rather than passing all SFCs in one bulk "sfcs" array)
    // avoids relying on how RestClient serializes a multi-value query parameter, which isn't
    // confirmed.
    //
    // ASSUMPTION: the relative path below mirrors the OpenAPI spec's base URL segment
    // (.../datacollection/v1/parameters). Not yet confirmed that RestClient resolves it this
    // way on this tenant — check this first if a call 404s.
    const PARAMETERS_PATH = "/datacollection/v1/parameters";
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
         * @param {string} oRequest.operationName - The current operation name (required by the API).
         * @param {string} oRequest.operationVersion - The current operation version (required by the API).
         * @param {string} oRequest.resource - The current resource (required by the API).
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
            const sGroup = oRequest.group?.trim();
            const sGroupVersion = oRequest.groupVersion?.trim();
            const sOperationName = oRequest.operationName?.trim();
            const sOperationVersion = oRequest.operationVersion?.trim();
            const sResource = oRequest.resource?.trim();

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            if (!sOperationName || !sOperationVersion || !sResource) {
                oLogger.warn("[DataCollectionBatchClient] Missing operation/resource context — " +
                    "cannot call the Data Collection /parameters API (all three are required)", {
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
                group: sGroup || "(none)",
                groupVersion: sGroupVersion || "(none)"
            });

            const mResult = {};

            await Promise.all(aSfcs.map((sSfc) =>
                this.#fetchSfcInto(
                    mResult, sPlant, sSfc, sOperationName, sOperationVersion, sResource,
                    sGroup, sGroupVersion, sBatchParam, sPredecessorParam
                )
            ));

            const iFoundCount = Object.values(mResult).filter((o) => o.batchNumber || o.predecessorBatchNumber).length;
            if (!iFoundCount) {
                oLogger.warn("[DataCollectionBatchClient] No batch/predecessor batch values found for any SFC " +
                    "— verify the parameterName/group/version/operation/resource values are correct " +
                    "(case-sensitive).");
            }

            return mResult;
        }

        /**
         * Fetches all Data Collection Group parameters for a single SFC and picks out the
         * batch/predecessor batch values. Failures are logged and swallowed so one bad SFC
         * doesn't block the rest.
         * @private
         * @async
         */
        async #fetchSfcInto(
            mResult, sPlant, sSfc, sOperationName, sOperationVersion, sResource,
            sGroup, sGroupVersion, sBatchParam, sPredecessorParam
        ) {
            mResult[sSfc] = { batchNumber: "", predecessorBatchNumber: "" };

            try {
                const oQuery = {
                    plant: sPlant,
                    sfcs: [sSfc],
                    "operation.name": sOperationName,
                    "operation.version": sOperationVersion,
                    resource: sResource
                };
                if (sGroup) {
                    oQuery["dcGroup.name"] = sGroup;
                }
                if (sGroupVersion) {
                    oQuery["dcGroup.version"] = sGroupVersion;
                }

                const aResponse = await RestClient.get(PARAMETERS_PATH, oQuery);
                const aParameters = aResponse?.[0]?.parameters ?? [];

                for (const oParam of aParameters) {
                    const sParamName = oParam.measureName;
                    const sValue = oParam.actual ?? "";

                    if (sParamName === sBatchParam && !mResult[sSfc].batchNumber) {
                        mResult[sSfc].batchNumber = sValue;
                    } else if (sParamName === sPredecessorParam && !mResult[sSfc].predecessorBatchNumber) {
                        mResult[sSfc].predecessorBatchNumber = sValue;
                    }
                }
            } catch (oError) {
                oLogger.error("[DataCollectionBatchClient] Failed to fetch parameters for SFC", {
                    sfc: sSfc,
                    message: oError.message
                });
            }
        }
    }

    return DataCollectionBatchClient;
});
