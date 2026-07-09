sap.ui.define([
    "sap/dm/dme/pod2/api/mdo/MDO",
    "sap/dm/dme/pod2/api/mdo/MdoApiClient",
    "sap/dm/dme/pod2/api/odata/ODataV4Client",
    "dmsi/pod2/util/ValidationErrorHandler"
], (
    MDO,
    MdoApiClient,
    ODataV4Client,
    ValidationErrorHandler
) => {
    "use strict";

    // ASSUMPTION: field names below follow the standard SAP DM MDO naming convention
    // (all-caps, underscore-separated) inferred from other MDOs such as SFC_STEP_STATUS.
    // Verify these against the tenant's actual $metadata for the /DATA_COLLECTION entity
    // set before go-live and adjust the constants here if they differ.
    const FIELD_PLANT = "PLANT";
    const FIELD_SFC = "SFC";
    const FIELD_PARAMETER_NAME = "PARAMETER_NAME";
    const FIELD_PARAMETER_VALUE = "PARAMETER_VALUE";
    const FIELD_CREATED_AT = "CREATED_AT";

    const MAX_SFCS_PER_QUERY = 50;

    class DataCollectionBatchClient extends MdoApiClient {

        #oMdoClient = ODataV4Client.getMdoClient();

        /**
         * Retrieves the most recently collected batch number and predecessor batch number
         * for a list of SFCs, read from the Data Collection MDO.
         * @param {Object} oRequest
         * @param {string} oRequest.plant
         * @param {Array<string>} oRequest.sfcs
         * @param {string} oRequest.batchParameter - Data collection parameter name holding the batch number.
         * @param {string} oRequest.predecessorParameter - Data collection parameter name holding the predecessor batch number.
         * @returns {Promise<Object<string, {batchNumber: string, predecessorBatchNumber: string}>>} Keyed by SFC.
         * @throws {Error} If validation fails.
         */
        async getBatchInfo(oRequest) {
            ValidationErrorHandler.validateObject(oRequest, "request object");

            const sPlant = ValidationErrorHandler.validateFilterValue(oRequest.plant, "Plant");
            const aSfcs = (oRequest.sfcs ?? []).filter(Boolean).slice(0, MAX_SFCS_PER_QUERY);
            const sBatchParam = oRequest.batchParameter?.trim();
            const sPredecessorParam = oRequest.predecessorParameter?.trim();

            if (!aSfcs.length || (!sBatchParam && !sPredecessorParam)) {
                return {};
            }

            const aSanitizedSfcs = aSfcs.map((sSfc) => ValidationErrorHandler.validateFilterValue(sSfc, "SFC"));
            const aParameterNames = [sBatchParam, sPredecessorParam].filter(Boolean);

            const sPlantFilter = `${FIELD_PLANT} eq '${sPlant}'`;
            const sSfcFilter = `${FIELD_SFC} in (${aSanitizedSfcs.map((s) => `'${s}'`).join(",")})`;
            const sParameterFilter = `${FIELD_PARAMETER_NAME} in (${aParameterNames
                .map((s) => `'${ValidationErrorHandler.validateFilterValue(s, "Parameter name")}'`)
                .join(",")})`;

            const [aRecords] = await this.#oMdoClient.getPage(MDO.DataCollection, {
                $top: aSanitizedSfcs.length * aParameterNames.length * 5,
                $skip: 0,
                $select: "*",
                $orderby: `${FIELD_CREATED_AT} desc`,
                $filter: `${sPlantFilter} and ${sSfcFilter} and ${sParameterFilter}`
            });

            return this.#groupLatestBySfc(aRecords ?? [], sBatchParam, sPredecessorParam);
        }

        /**
         * Reduces raw Data Collection records (newest first) into a per-SFC map, keeping only
         * the first (i.e. latest) value found per SFC/parameter combination.
         * @private
         */
        #groupLatestBySfc(aRecords, sBatchParam, sPredecessorParam) {
            const mResult = {};

            for (const oRecord of aRecords) {
                const sSfc = oRecord[FIELD_SFC];
                const sParamName = oRecord[FIELD_PARAMETER_NAME];

                if (!sSfc || !sParamName) {
                    continue;
                }
                if (!mResult[sSfc]) {
                    mResult[sSfc] = { batchNumber: "", predecessorBatchNumber: "" };
                }

                const sValue = oRecord[FIELD_PARAMETER_VALUE] ?? "";

                if (sParamName === sBatchParam && !mResult[sSfc].batchNumber) {
                    mResult[sSfc].batchNumber = sValue;
                } else if (sParamName === sPredecessorParam && !mResult[sSfc].predecessorBatchNumber) {
                    mResult[sSfc].predecessorBatchNumber = sValue;
                }
            }

            return mResult;
        }
    }

    return DataCollectionBatchClient;
});
