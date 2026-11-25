// Servicio de SMS OTP vía SMS Masivos — CANAL PRINCIPAL de entrega de
// códigos.
//
// Contexto (corrección Guideline 4.2.3(i) — App Store Review, 2026-10-27):
// antes los OTPs solo salían por WhatsApp, y el revisor de Apple tuvo que
// INSTALAR WhatsApp para poder activar su cuenta → rechazo por exigir una
// app de terceros. Ahora el código se envía SIEMPRE por SMS (canal
// nativo del sistema, no requiere instalar nada) y, como canal
// ADICIONAL, por WhatsApp cuando el usuario dio consentimiento
// (ver services/otp-delivery.service.js).
//
// Migración 2026-11-25: proveedor SMS Masivos (prepagado, sin renta de
// número) en lugar de Twilio. El envío vive en smsmasivos.service.js
// (POST /v2/otp con code_custom = el código que ya generamos); acá solo
// quedan el bypass OTP_ECHO y el wrapper con logs.
//
// Reutiliza las clases de error de smsmasivos.service.js para que los
// controllers hagan un único set de `instanceof` checks al mapear a
// HTTP status (se re-exportan desde whatsapp.service.js con sus
// nombres históricos).

const {
  sendOtpCode,
  toMxDigits,
  OtpProviderError,
  InvalidPhoneError,
} = require("./smsmasivos.service");

// =====================================================================
// OTP_ECHO: mismo bypass que whatsapp.service.js — si OTP_ECHO está
// activo, NO se contacta al proveedor y el código se imprime en consola
// (`[otp-echo] ...`). Útil para probar flujos sin gastar saldo.
// ⚠️ NUNCA dejar activo en producción con usuarios reales.
// =====================================================================
const isOtpEchoEnabled = () => {
  const v = process.env.OTP_ECHO;
  if (!v) return false;
  return ["1", "true", "console", "yes", "on"].includes(String(v).toLowerCase());
};

// sendOtpViaSms(phone, code, purpose)
// phone:   10 dígitos MX (o ya E.164 / con +52)
// code:    6 dígitos (string) — se manda como code_custom
// purpose: 'activation' | 'password_reset' (metadata para logs)
//
// Returns { success: true, messageSid, status, throttled? } en éxito.
// Throws OtpProviderError (→503) o InvalidPhoneError (→400).
const sendOtpViaSms = async (phone, code, purpose = "activation") => {
  // Modo echo: loguear el código y devolver éxito sin tocar el proveedor.
  if (isOtpEchoEnabled()) {
    console.warn(
      `[otp-echo] OTP_ECHO activo — SMS DESHABILITADO, code en consola: ` +
        `purpose=${purpose} to=${phone} code=${code}`
    );
    return { success: true, messageSid: "echo", status: "echo", echoed: true };
  }

  // Normaliza ANTES de llamar (InvalidPhoneError → 400 en el controller).
  const to = toMxDigits(phone);
  if (!to) {
    throw new InvalidPhoneError(`Cannot normalize phone to 10 MX digits: ${phone}`);
  }

  const result = await sendOtpCode({ phone: to, code, channel: "sms", purpose });

  console.log(
    `[sms] OTP sent purpose=${purpose} to=+52${to} action=${result.action} ` +
      `ref=${result.reference || "-"}${result.throttled ? " (throttled)" : ""}`
  );

  return {
    success: true,
    messageSid: result.reference || null,
    status: result.state || "pending",
    throttled: !!result.throttled,
  };
};

module.exports = {
  sendOtpViaSms,
  // Errors (re-exportados para convenience de los callers)
  OtpProviderError,
  // Nombre histórico: auth.controller hace `instanceof TwilioError`.
  TwilioError: OtpProviderError,
  InvalidPhoneError,
};
