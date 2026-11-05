
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
    console.error(
      "Airwallex authentication error:",
      error.response?.data || error.message
    );

    throw new Error("Could not authenticate with Airwallex");
  }
}

async function airwallexRequest(
  method,
  endpoint,
  data = null,
  extraHeaders = {}
) {
  try {
    const token = await getAirwallexToken();

    const config = {
      method,
      url: `${process.env.AIRWALLEX_BASE_URL}${endpoint}`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    };

    if (data !== null && method.toUpperCase() !== "GET") {
      config.data = data;
    }

    const response = await axios(config);

    return response.data;
  } catch (error) {
    console.error(
      "Airwallex API error:",
      error.response?.status,
      error.response?.data || error.message
    );

    throw new Error("Airwallex API request failed");
  }
}

function createRequestId() {
  return crypto.randomUUID();
}

async function createAirwallexCustomer(student) {
  return airwallexRequest(
    "POST",
    "/api/v1/pa/customers/create",
    {
      request_id: createRequestId(),
      merchant_customer_id: student.id,
      email: student.email,
      phone_number: student.phone || undefined,
      first_name: student.full_name,
    }
  );
}

async function createAirwallexPaymentIntent({
  amount,
  currency,
  customerId,
  merchantOrderId,
  requestId,
  paymentConsent,
}) {
  if (!requestId || !merchantOrderId || !customerId) {
    throw new Error("Required payment details are missing");
  }

  if (!paymentConsent) {
    throw new Error("Payment consent details are required");
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

module.exports = {
  getAirwallexToken,
  airwallexRequest,
  createRequestId,
  createAirwallexCustomer,
  createAirwallexPaymentIntent,
  retrieveAirwallexPaymentIntent,
};
