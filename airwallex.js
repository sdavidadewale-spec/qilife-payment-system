
require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");

let accessToken = null;
let tokenExpiry = null;

async function getAirwallexToken() {
  if (
    accessToken &&
    tokenExpiry &&
    Date.now() < tokenExpiry - 60000
  ) {
    return accessToken;
  }

  try {
    const response = await axios.post(
      `${process.env.AIRWALLEX_BASE_URL}/api/v1/authentication/login`,
      null,
      {
        timeout: 30000,
        headers: {
          "x-client-id": process.env.AIRWALLEX_CLIENT_ID,
          "x-api-key": process.env.AIRWALLEX_API_KEY,
        },
      }
    );

    accessToken = response.data.token;
    tokenExpiry = new Date(response.data.expires_at).getTime();

    return accessToken;
  } catch (error) {
    console.error("Airwallex authentication failed:", {
      status: error.response?.status || null,
      code: error.code || null,
    });

    throw new Error("Could not authenticate with Airwallex");
  }
}

async function airwallexRequest(
  method,
  endpoint,
  data = null,
  extraHeaders = {}
) {
  // Authenticate before starting the API request.
  const token = await getAirwallexToken();

  const config = {
    method,
    url: `${process.env.AIRWALLEX_BASE_URL}${endpoint}`,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  };

  if (data !== null && method.toUpperCase() !== "GET") {
    config.data = data;
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const status = error.response?.status || null;

    const outcomeUnknown =
      !error.response ||
      status >= 500;

    const apiError = new Error(
      "Airwallex API request failed"
    );

    apiError.status = status;
    apiError.code = error.code || null;
    apiError.airwallexError = error.response?.data || null;
    apiError.requestMayHaveReachedAirwallex = true;
    apiError.outcomeUnknown = outcomeUnknown;

    console.error("Airwallex API request failed:", {
      method,
      endpoint,
      status,
      code: apiError.code,
      outcomeUnknown,
    });

    throw apiError;
  }
}

function createRequestId() {
  return crypto.randomUUID();
}

async function findAirwallexCustomerByMerchantId(merchantCustomerId) {
  const params = new URLSearchParams({
    merchant_customer_id: merchantCustomerId,
    page_num: "0",
    page_size: "10",
  });

  const result = await airwallexRequest(
    "GET",
    `/api/v1/pa/customers?${params.toString()}`
  );

  const customers = Array.isArray(result.items)
    ? result.items.filter(
        customer =>
          customer.merchant_customer_id === merchantCustomerId
      )
    : [];

  if (customers.length > 1) {
    throw new Error("Multiple Airwallex customers found for this student");
  }

  return customers[0] || null;
}

async function createAirwallexCustomer(student) {
  if (!student?.id || !student?.email || !student?.full_name) {
    throw new Error("Student details are incomplete");
  }

  // Recover an existing customer before creating another one.
  const existingCustomer = await findAirwallexCustomerByMerchantId(
    student.id
  );

  if (existingCustomer) {
    return existingCustomer;
  }

  try {
    return await airwallexRequest(
      "POST",
      "/api/v1/pa/customers/create",
      {
        request_id: `customer-${student.id}`,
        merchant_customer_id: student.id,
        email: student.email,
        phone_number: student.phone || undefined,
        first_name: student.full_name,
      }
    );
  } catch (createError) {
    // Check again in case another request created the customer.
    try {
      const recoveredCustomer = await findAirwallexCustomerByMerchantId(
        student.id
      );

      if (recoveredCustomer) {
        return recoveredCustomer;
      }
    } catch (recoveryError) {
      console.error(
        "Airwallex customer recovery failed:",
        recoveryError.message
      );
    }

    throw createError;
  }
}

async function createAirwallexPaymentIntent({
  amount,
  currency,
  customerId,
  merchantOrderId,
  requestId,
  paymentConsent,
  returnUrl,
}) {
  if (!requestId || !merchantOrderId || !customerId) {
    throw new Error("Required payment details are missing");
  }

  if (!paymentConsent) {
    throw new Error("Payment consent details are required");
  }

  let parsedReturnUrl;

  try {
    parsedReturnUrl = new URL(returnUrl);
  } catch {
    throw new Error("A valid payment return URL is required");
  }

  if (parsedReturnUrl.protocol !== "https:") {
    throw new Error("The payment return URL must use HTTPS");
  }

  return airwallexRequest(
    "POST",
    "/api/v1/pa/payment_intents/create",
    {
      request_id: requestId,
      amount: Number(amount),
      currency,
      customer_id: customerId,
      merchant_order_id: merchantOrderId,
      payment_consent: paymentConsent,
      return_url: parsedReturnUrl.toString(),
    }
  );
}

async function createRecurringAirwallexPaymentIntent({
  amount,
  currency,
  customerId,
  merchantOrderId,
  requestId,
}) {
  if (
    !Number.isFinite(Number(amount)) ||
    Number(amount) <= 0 ||
    !currency ||
    !customerId ||
    !merchantOrderId ||
    !requestId
  ) {
    throw new Error("Required recurring payment details are missing");
  }

  if (merchantOrderId.length > 64 || requestId.length > 64) {
    throw new Error("Airwallex request IDs must not exceed 64 characters");
  }

  return airwallexRequest(
    "POST",
    "/api/v1/pa/payment_intents/create",
    {
      request_id: requestId,
      amount: Number(amount),
      currency,
      customer_id: customerId,
      merchant_order_id: merchantOrderId,
    }
  );
}

async function confirmAirwallexPaymentIntent({
  paymentIntentId,
  requestId,
  customerId,
  paymentConsentId,
  paymentMethodId,
}) {
  if (
    !paymentIntentId ||
    !requestId ||
    !customerId ||
    !paymentConsentId ||
    !paymentMethodId
  ) {
    throw new Error("Required confirmation details are missing");
  }

  if (requestId.length > 64) {
    throw new Error("Airwallex request IDs must not exceed 64 characters");
  }

  return airwallexRequest(
    "POST",
    `/api/v1/pa/payment_intents/${encodeURIComponent(paymentIntentId)}/confirm`,
    {
      request_id: requestId,
      customer_id: customerId,
      payment_method: {
        id: paymentMethodId,
        type: "card",
      },
      payment_consent_id: paymentConsentId,
      triggered_by: "merchant",
    }
  );
}

async function retrieveAirwallexPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) {
    throw new Error("PaymentIntent ID is required");
  }

  return airwallexRequest(
    "GET",
    `/api/v1/pa/payment_intents/${encodeURIComponent(paymentIntentId)}`
  );
}

async function retrieveAirwallexPaymentConsent(paymentConsentId) {
  if (!paymentConsentId) {
    throw new Error("Payment Consent ID is required");
  }

  return airwallexRequest(
    "GET",
    `/api/v1/pa/payment_consents/${encodeURIComponent(paymentConsentId)}`
  );
}

module.exports = {
  getAirwallexToken,
  airwallexRequest,
  createRequestId,
  findAirwallexCustomerByMerchantId,
  createAirwallexCustomer,
  createAirwallexPaymentIntent,
  createRecurringAirwallexPaymentIntent,
  confirmAirwallexPaymentIntent,
  retrieveAirwallexPaymentIntent,
  retrieveAirwallexPaymentConsent,
};
