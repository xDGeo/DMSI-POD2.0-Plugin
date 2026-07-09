sap.ui.define([
    "sap/dm/dme/pod2/api/order/OrderPublicApiClient",
    "sap/dm/dme/pod2/api/sfc/SfcPublicApiClient",
    "sap/dm/dme/pod2/Logger",
    "dmsi/pod2/util/ValidationErrorHandler"
], (
    OrderPublicApiClient,
    SfcPublicApiClient,
    Logger,
    ValidationErrorHandler
) => {
    "use strict";

    const oLogger = Logger.getLogger("dmsi.pod2.client.OrderSfcClient");

    // Order.getOrder() returns EVERY SFC released from the order (field: sfcs: string[]),
    // with no status-based scoping — confirmed against the public Order API's OpenAPI spec
    // (GET /v1/orders -> FindOrderResponse.sfcs). SfcPublicApiClient.getSfcDetail() (backed
    // by GET /sfcdetail) is likewise not scoped to pending work, unlike the SFC Work List API
    // (getSfcs()/GET /worklist/sfcs), whose sfcStatuses filter only supports
    // NEW/IN_QUEUE/ACTIVE/HOLD and can never return a completed SFC. Combining the two here
    // gives a reliable way to list an order's SFCs regardless of status, at the cost of one
    // getSfcDetail() call per SFC.
    const MAX_SFCS = 200;

    class OrderSfcClient {

        #oOrderClient = new OrderPublicApiClient();
        #oSfcClient = new SfcPublicApiClient();

        /**
         * Retrieves SFCs of an order that are at a given status.
         * @param {Object} oRequest
         * @param {string} oRequest.plant
         * @param {string} oRequest.order
         * @param {string} oRequest.statusCode - SFCStatusCode value to keep (e.g. "405" for COMPLETED).
         * @returns {Promise<Array<{sfc: string, quantity: number, defaultBatchId: string, statusCode: string}>>}
         * @throws {Error} If validation fails or the order request itself fails.
         */
        async getSfcsByOrderAndStatus(oRequest) {
            ValidationErrorHandler.validateObject(oRequest, "request object");

            const sPlant = ValidationErrorHandler.validateFilterValue(oRequest.plant, "Plant");
            const sOrder = ValidationErrorHandler.validateFilterValue(oRequest.order, "Order");
            const sStatus = oRequest.statusCode;

            const oOrder = await this.#oOrderClient.getOrder({ plant: sPlant, order: sOrder });
            const aSfcs = (oOrder?.sfcs ?? []).slice(0, MAX_SFCS);

            oLogger.info("[OrderSfcClient] Order fetched", { order: sOrder, sfcCount: aSfcs.length });

            const aDetails = await Promise.all(aSfcs.map((sSfc) => this.#fetchSfcDetail(sPlant, sSfc)));

            return aDetails.filter((oDetail) => oDetail && oDetail.statusCode === sStatus);
        }

        /**
         * Fetches a single SFC's detail. Failures are logged and swallowed (returning null)
         * so that one bad SFC lookup doesn't block the rest of the order's SFCs.
         * @private
         * @async
         */
        async #fetchSfcDetail(sPlant, sSfc) {
            try {
                const oDetail = await this.#oSfcClient.getSfcDetail({ plant: sPlant, sfc: sSfc });
                return {
                    sfc: oDetail.sfc,
                    quantity: Number(oDetail.quantity) || 0,
                    defaultBatchId: oDetail.defaultBatchId ?? "",
                    statusCode: oDetail.status?.code
                };
            } catch (oError) {
                oLogger.error("[OrderSfcClient] Failed to fetch SFC detail", { sfc: sSfc, message: oError.message });
                return null;
            }
        }
    }

    return OrderSfcClient;
});
