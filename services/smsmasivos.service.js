// Cliente HTTP del API OTP de SMS Masivos (https://api.smsmasivos.com.mx)
// ---------------------------------------------------------------------
// Migración 2026-11-25: reemplaza al SDK de Twilio como proveedor de
// SMS/WhatsApp OTP (Twilio cobraba renta mensual por número + precio
// por mensaje; SMS Masivos es prepago por saldo, sin renta).
//
// Endpoint usado: POST /v2/otp con `code_custom` = el código que YA
// generó y guardó nuestro backend (User.otpCode). Así el ciclo de vida
// del OTP sigue siendo NUESTRO (storage, TTL 10 min, propósitos
// activation/password_reset, rate limits) y el proveedor solo entrega:
//   - channel "sms"     → SMS con nuestro mensaje (GSM-7, {{code}})
//   - channel "whatsapp"→ integración oficial "remitente Authenticate":
//     sin cuenta WhatsApp Business, sin verificación de Meta, sin
//     plantilla propia (el API ignora company/message y usa su plantilla
//     fija — el código custom SÍ va embebido).
//
// Autenticación: header `apikey: SMSMASIVOS_API_KEY`.
//
// Particularidades IMPORTANTES de este API (ojo al leer respuestas):
//   - Los errores `auth_*` / `server_*` llegan con HTTP 200 y
//     `success: false` en el body → revisar SIEMPRE el flag `success`,
//     no solo el status HTTP.
//   - Cooldown de 30s entre envíos al mismo número: un segundo POST
//     dentro de la ventana responde `429 otp_throttled`. Lo tratamos
//     como éxito con `throttled: true` (el código anterior sigue
//     vigente); ver otp-delivery.service.js y auth.controller.
//   - `402 otp_insufficient_credits` → saldo agotado.
//   - `502 otp_send_failed` → el canal no pudo entregar.
//
// Las clases de error viven acá y se re-exportan desde
// whatsapp.service.js con sus nombres históricos (`TwilioError` alias de
// OtpProviderError) para NO romper los `instanceof` de auth.controller.
// =====================================================================

const API_URL =
  process.env.SMSMASIVOS_API_URL || "https://api.smsmasivos.com.mx/v2/otp";

const COMPANY = process.env.SMSMASIVOS_COMPANY || "EdukControl";

// Mensaje SMS en GSM-7 puro (SIN acentos ni emojis — el API rechaza
// caracteres fuera de GSM-7 con otp_message_invalid) y con placeholders
// {{code}}/{{company}}. Expandido queda ~90 chars (< 160: un OTP nunca
// se envía partido en dos SMS porque eso rompe el autotelcompletado).
const SMS_MESSAGE =
  "{{code}} es tu codigo de verificacion de {{company}}. Caduca en 10 minutos. No lo compartas.";

// Timeout de la llamada: el flujo OTP corre ANTES de responder al
// cliente, así que hay que acotarlo (15s) para no colgar el request.
const REQUEST_TIMEOUT_MS = 15000;

// =====================================================================
// Errores semánticos (el controller los mapea a HTTP status sin
// acoplar a los códigos del proveedor).
//   - OtpProviderError    → 503 (config/saldo/fallo del proveedor)
//   - InvalidPhoneError   → 400 (teléfono inválido)
// =====================================================================
class OtpProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OtpProviderError";
    this.code = code;
  }
}

class InvalidPhoneError extends OtpProviderError {
  constructor(message = "Invalid phone number for SMS delivery.") {
    super("INVALID_PHONE", message);
    this.name = "InvalidPhoneError";
  }
}

// =====================================================================
// toMxDigits(phone)
// Normaliza a los 10 dígitos MX que espera el API:
//   "5512345678"          → "5512345678"
//   "+525512345678"       → "5512345678"
//   "+5215512345678"      → "5512345678"  (formato viejo con 1)
// Devuelve null si no se puede normalizar (el caller lanza
// InvalidPhoneError → 400, igual que antes con el 21211 de Twilio).
// =====================================================================
const toMxDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("52")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("521")) return digits.slice(3);
  return null;
};

// Mapea los `error` del API a nuestras clases semánticas.
const mapProviderError = (errCode, hint, httpStatus) => {
  const detail = hint || `HTTP ${httpStatus}`;
  if (errCode === "otp_insufficient_credits") {
    return new OtpProviderError(
      "INSUFFICIENT_CREDITS",
      `SMSMasivos saldo insuficiente: ${detail}`
    );
  }
  if (errCode === "otp_send_failed") {
    return new OtpProviderError("SMS_SEND_FAILED", `SMSMasivos send failed: ${detail}`);
  }
  if (String(errCode).startsWith("auth_")) {
    return new OtpProviderError(
      "SMSMASIVOS_AUTH",
      `SMSMasivos auth error: ${errCode} ${detail}`
    );
  }
  if (
    errCode === "otp_message_invalid" ||
    errCode === "otp_missing_param" ||
    errCode === "otp_invalid_channel"
  ) {
    // Error de NUESTRA configuración/caller → 503 (problema del server).
    return new OtpProviderError(
      "SMSMASIVOS_CONFIG",
      `SMSMasivos rejected our request: ${errCode} ${detail}`
    );
  }
  if (errCode === "otp_invalid_param" && /phone/i.test(detail)) {
    return new InvalidPhoneError(`Invalid phone number: ${detail}`);
  }
  if (errCode === "otp_internal" || String(errCode).startsWith("server_")) {
    return new OtpProviderError("SMSMASIVOS_INTERNAL", `SMSMasivos internal: ${detail}`);
  }
  return new OtpProviderError(errCode || `HTTP_${httpStatus}`, `SMSMasivos: ${detail}`);
};

// =====================================================================
// sendOtpCode({ phone, code, channel, purpose })
//   phone:   10 dígitos MX (o cualquier formato normalizable)
//   code:    código OTP que YA generamos (code_custom, 4-10 alnum)
//   channel: "sms" | "whatsapp"
//   purpose: "activation" | "password_reset" (solo para logs)
//
// Returns en éxito:
//   { success: true, reference, action, state, request_id, throttled? }
//   (throttled: true SOLO cuando el proveedor respondió otp_throttled —
//    cooldown de 30s; no se transmitió nada y el código anterior sigue
//    vigente; el caller decide cómo manejarlo).
// Throws OtpProviderError / InvalidPhoneError.
// =====================================================================
const sendOtpCode = async ({ phone, code, channel, purpose }) => {
  const apiKey = process.env.SMSMASIVOS_API_KEY;
  if (!apiKey) {
    // OtpProviderError → controller responde 503 (falta de config es
    // problema del server, no del usuario).
    throw new OtpProviderError(
      "SMSMASIVOS_CONFIG_MISSING",
      "SMSMASIVOS_API_KEY missing in .env / Render."
    );
  }

  const to = toMxDigits(phone);
  if (!to) {
    throw new InvalidPhoneError(`Cannot normalize phone to 10 MX digits: ${phone}`);
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({
        phone_number: to,
        country_code: "52",
        company: COMPANY,
        message: SMS_MESSAGE,
        channel,
        code_custom: String(code),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Red / timeout → 503.
    throw new OtpProviderError(
      "SMS_NETWORK",
      `SMSMasivos request failed: ${err?.message || err}`
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new OtpProviderError(
      "SMS_BAD_RESPONSE",
      `SMSMasivos non-JSON response (HTTP ${res.status}).`
    );
  }

  // OJO: los errores auth_*/server_* llegan con HTTP 200 + success:false.
  if (body?.success === true) {
    if (body.warning) {
      console.warn(`[smsmasivos] channel=${channel}: ${body.warning}`);
    }
    return {
      success: true,
      reference: body.reference ?? null,
      action: body.action ?? null,
      state: body.state ?? null,
      request_id: body.request_id ?? null,
    };
  }

  const errCode = body?.error || `HTTP_${res.status}`;
  const hint = body?.hint || body?.message || "";

  // Cooldown de 30s entre envíos: NO es un fallo — el código anterior
  // sigue vigente en el proveedor y el usuario ya lo recibió. Lo
  // devolvemos como éxito throttled para que el caller conserve el OTP
  // guardado en vez de rotar uno que nunca salió.
  if (errCode === "otp_throttled") {
    console.warn(
      `[smsmasivos] throttled (<30s cooldown) channel=${channel} purpose=${purpose} ` +
        `retry_in=${body?.resend_available_in ?? "?"}s`
    );
    return {
      success: true,
      throttled: true,
      resend_available_in: body?.resend_available_in ?? null,
    };
  }

  console.error(
    `[smsmasivos] send failed channel=${channel} purpose=${purpose} to=+52${to} ` +
      `error=${errCode} hint=${hint} http=${res.status}`
  );
  throw mapProviderError(errCode, hint, res.status);
};

module.exports = {
  sendOtpCode,
  toMxDigits,
  OtpProviderError,
  InvalidPhoneError,
  // Exportado para tests/logs.
  SMS_MESSAGE,
  API_URL,
};
