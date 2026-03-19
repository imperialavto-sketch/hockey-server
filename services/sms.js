/**
 * SMS abstraction layer for auth code delivery.
 * Provider-agnostic foundation for production SMS integration.
 *
 * REQUIRED ENV (production, smsru):
 * - SMS_PROVIDER: "smsru" | "mock"
 * - SMS_API_KEY: sms.ru api_id (from https://sms.ru)
 * - SMS_SENDER: optional, alphanumeric sender (must be approved in sms.ru panel)
 *
 * In development: sendSmsCode is a no-op (codes delivered via debugCode).
 */

const isProduction = process.env.NODE_ENV === "production";
const SMSRU_URL = "https://sms.ru/sms/send";

function isSmsConfigured() {
  const provider = process.env.SMS_PROVIDER;
  const apiKey = process.env.SMS_API_KEY;
  return typeof provider === "string" && provider.trim() !== "" &&
    typeof apiKey === "string" && apiKey.trim() !== "";
}

async function sendViaSmsRu(phone, code) {
  const apiId = (process.env.SMS_API_KEY || "").trim();
  const from = (process.env.SMS_SENDER || "").trim();
  const msg = `Код: ${code}`;

  const body = new URLSearchParams({
    api_id: apiId,
    to: phone,
    msg,
    json: "1",
  });
  if (from) body.set("from", from);

  let res;
  try {
    res = await fetch(SMSRU_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    const errMsg = err?.message || String(err);
    console.error("[sms][smsru] fetch error:", errMsg);
    return { ok: false, error: `SMS delivery failed: ${errMsg}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "SMS provider returned invalid response" };
  }

  if (data?.status !== "OK") {
    const text = data?.status_text || `status_code ${data?.status_code ?? "unknown"}`;
    console.error("[sms][smsru] API error:", data?.status_code, text);
    return { ok: false, error: `SMS provider error: ${text}` };
  }

  const smsData = data?.sms?.[phone] ?? data?.sms?.[Object.keys(data.sms || {})[0]];
  if (smsData?.status !== "OK") {
    const text = smsData?.status_text || `code ${smsData?.status_code ?? "unknown"}`;
    console.error("[sms][smsru] send error for", phone, ":", text);
    return { ok: false, error: `SMS delivery failed: ${text}` };
  }

  return { ok: true };
}

/**
 * Send auth code via SMS.
 * @param {string} phone - Normalized phone (digits only)
 * @param {string} code - 4-digit code
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
async function sendSmsCode(phone, code) {
  if (!isProduction) {
    // Dev: no real SMS; codes delivered via debugCode in response.
    return { ok: true };
  }

  if (!isSmsConfigured()) {
    return { ok: false, error: "SMS provider not configured" };
  }

  const provider = (process.env.SMS_PROVIDER || "").trim().toLowerCase();

  switch (provider) {
    case "mock":
      console.log("[sms] mock send:", phone, "code:", code);
      return { ok: true };
    case "smsru":
      return sendViaSmsRu(phone, code);
    default:
      return { ok: false, error: `Unknown SMS_PROVIDER: ${provider}` };
  }
}

module.exports = {
  sendSmsCode,
  isSmsConfigured,
};
