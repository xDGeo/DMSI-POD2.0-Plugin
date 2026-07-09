sap.ui.define([], () => {
    "use strict";

    class ValidationErrorHandler {

        /**
         * @param {*} value
         * @param {string} fieldName
         * @throws {Error} If value is empty.
         */
        static validateNotEmpty(value, fieldName) {
            if (!value) {
                throw new Error(`${fieldName} cannot be empty`);
            }
        }

        /**
         * @param {*} obj
         * @param {string} objectName
         * @throws {Error} If object is not a non-null object.
         */
        static validateObject(obj, objectName) {
            if (!obj || typeof obj !== "object") {
                throw new Error(`Invalid ${objectName}`);
            }
        }

        /**
         * Validates a value used inside an OData $filter expression, preventing injection.
         * Allows only alphanumeric characters, dash, and underscore.
         * @param {string} value
         * @param {string} fieldName
         * @returns {string} Trimmed, validated value.
         * @throws {Error} If value is empty, too long, or contains illegal characters.
         */
        static validateFilterValue(value, fieldName) {
            this.validateNotEmpty(value, fieldName);

            const sSanitized = String(value).trim();

            if (!/^[a-zA-Z0-9_-]+$/.test(sSanitized)) {
                throw new Error(`Invalid ${fieldName}: contains illegal characters`);
            }
            if (sSanitized.length > 100) {
                throw new Error(`${fieldName} exceeds maximum length of 100 characters`);
            }

            return sSanitized;
        }
    }

    return ValidationErrorHandler;
});
