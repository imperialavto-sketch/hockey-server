/**
 * SMS abstraction layer for auth code delivery.
 *
 * smsc.ru (production): SMSC_LOGIN, SMSC_PASSWORD, SMSC_SENDER
 * sms.ru (legacy): SMS_PROVIDER=smsru, SMS_API_KEY, SMS_SENDER
 * mock: SMS_PROVIDER=mock
 *
 * DEV_AUTH=true: codes via debugCode, no SMS.
 */

const isProduction = process.env.NODE_ENV === "production";
const SMSRU_URL = "https://sms.ru/sms/send";
const SMSC_URL = "https://smsc.ru/sys/send.php";
const SMSC_STATUS_URL = "https://smsc.ru/sys/status.php";

function isSmscConfigured() {
  const login = process.env.SMSC_LOGIN;
  const psw = process.env.SMSC_PASSWORD;
  return typeof login === "string" && login.trim() !== "" &&
    typeof psw === "string" && psw.trim() !== "";
}

function isSmsConfigured() {
  if (isSmscConfigured()) return true;
  const provider = process.env.SMS_PROVIDER;
  const apiKey = process.env.SMS_API_KEY;
  return typeof provider === "string" && provider.trim() !== "" &&
    typeof apiKey === "string" && apiKey.trim() !== "";
}

function normalizePhoneForSmsc(phone) {
  const digits = String(phone || "").replace(/\D/g, "").trim();
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith("9")) {
    return `7${digits}`;
  }
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return digits.startsWith("8") ? `7${digits.slice(1)}` : digits;
  }
  return digits.length >= 10 && digits.length <= 11 ? digits : null;
}

async function doSmscSend(login, psw, phonesFormatted, msg, sender) {
  const params = new URLSearchParams({
    login,
    psw,
    phones: phonesFormatted,
    mes: msg,
    fmt: "3",
    cost: "3",
  });
  if (sender) params.set("sender", sender);

  const res = await fetch(`${SMSC_URL}?${params.toString()}`, {
    method: "GET",
    signal: AbortSignal.timeout(15000),
  });
  return res.text();
}

async function sendViaSmscRu(phone, code) {
  const login = (process.env.SMSC_LOGIN || "").trim();
  const psw = (process.env.SMSC_PASSWORD || "").trim();
  const senderRaw = (process.env.SMSC_SENDER || "").trim();
  const sender = senderRaw || undefined;
  const msg = `Код входа Hockey ID: ${code}`;

  const phonesFormatted = normalizePhoneForSmsc(phone);
  if (!phonesFormatted) {
    const err = `Invalid phone format for SMSC: ${phone} (expected 79XXXXXXXXX or 9XXXXXXXXX)`;
    console.error("[sms][smsc]", err);
    return { ok: false, error: err };
  }

  const paramsSafe = new URLSearchParams({
    login,
    psw: "***",
    phones: phonesFormatted,
    mes: msg.slice(0, 30) + "...",
    fmt: "3",
    cost: "3",
  });
  if (sender) paramsSafe.set("sender", sender);
  console.log("[sms][smsc] send start", { phone: phonesFormatted, sender: sender || "(default)", url: `${SMSC_URL}?${paramsSafe.toString()}` });

  const trySend = async (useSender) => {
    let raw;
    try {
      raw = await doSmscSend(login, psw, phonesFormatted, msg, useSender);
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error("[sms][smsc] fetch error:", errMsg);
      return { ok: false, error: errMsg, data: null };
    }
    const rawTrimmed = raw.trim();
    console.log("[sms][smsc] raw response:", rawTrimmed);

    if (rawTrimmed.toUpperCase().startsWith("ERROR") || (/^-?\d+$/.test(rawTrimmed) && parseInt(rawTrimmed, 10) < 0)) {
      return { ok: false, error: rawTrimmed, data: null };
    }

    let data;
    try {
      data = JSON.parse(rawTrimmed);
    } catch {
      return { ok: false, error: `invalid JSON: ${rawTrimmed.slice(0, 100)}`, data: null };
    }

    const logFields = {
      id: data?.id,
      cnt: data?.cnt,
      cost: data?.cost,
      balance: data?.balance,
      status: data?.status,
      error: data?.error,
      error_code: data?.error_code,
    };
    console.log("[sms][smsc] response fields:", JSON.stringify(logFields));

    if (data?.error) {
      const errText = data.error_code != null ? `${data.error} (code ${data.error_code})` : String(data.error);
      return { ok: false, error: errText, data };
    }

    const id = data?.id;
    if (id != null && (typeof id === "number" ? id > 0 : String(id).trim() !== "")) {
      return { ok: true, data, smscId: id };
    }

    return { ok: false, error: `no id in response: ${JSON.stringify(data)}`, data };
  };

  let result = await trySend(sender);
  if (!result.ok && sender) {
    console.log("[sms][smsc] retry without sender");
    result = await trySend(undefined);
  }

  if (result.ok) {
    console.log("[sms][smsc] success", { id: result.smscId, cnt: result.data?.cnt, cost: result.data?.cost, balance: result.data?.balance });
    return { ok: true, smscId: result.smscId };
  }

  console.error("[sms][smsc] fail:", result.error);
  return { ok: false, error: `SMS delivery failed: ${result.error}` };
}

/**
 * Check delivery status by SMSC message id.
 * @param {string} phone - Normalized phone (e.g. 79119888885)
 * @param {string|number} smscId - SMSC message id from send response
 * @returns {Promise<{ ok: boolean; status?: string; statusText?: string; error?: string }>}
 */
async function checkSmscStatus(phone, smscId) {
  const login = (process.env.SMSC_LOGIN || "").trim();
  const psw = (process.env.SMSC_PASSWORD || "").trim();
  if (!login || !psw) {
    return { ok: false, error: "SMSC not configured" };
  }

  const params = new URLSearchParams({ login, psw, phone, id: String(smscId), fmt: "3" });
  console.log("[sms][smsc] status check request", { phone, smscId });
  try {
    const res = await fetch(`${SMSC_STATUS_URL}?${params.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    const raw = await res.text().trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: `invalid response: ${raw.slice(0, 100)}`, status: raw };
    }
    const status = data?.status ?? data?.status_code;
    const statusText = data?.status_text ?? data?.last_date;
    console.log("[sms][smsc] status check", { phone, smscId, status, statusText, raw: raw.slice(0, 200) });
    if (data?.error) {
      return { ok: false, error: data.error, status, statusText };
    }
    return { ok: true, status, statusText, data };
  } catch (err) {
    console.error("[sms][smsc] status check error:", err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
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
  if (isSmscConfigured()) {
    return sendViaSmscRu(phone, code);
  }

  if (!isProduction) {
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
  checkSmscStatus,
};
