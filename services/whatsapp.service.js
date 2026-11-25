// Servicio de WhatsApp OTP vía SMS Masivos (integración oficial
// "remitente Authenticate").
//
// Migración 2026-11-25: antes iba por Twilio + plantilla Meta
// (AUTHENTICATION). Con SMS Masivos el canal whatsapp NO requiere
// cuenta de WhatsApp Business ni plantilla aprobada por Meta: la
// integración Authenticate es "todo en uno" y usa su plantilla fija de
// verificación. El API ignora company/message cuando channel=whatsapp;
// el código (`code_custom`) SÍ va embebido en esa plantilla.
//
// El envío real vive en smsmasivos.service.js (POST /v2/otp con
// code_custom). Acá quedan:
//   - OTP_ECHO (bypass de prueba, mismo comportamiento que sms.service)
//   - toE164MX (lo usa webhooks.controller.js para parsear el webhook
//     legacy de Twilio, que sigue activo hasta la Fase 4 de limpieza)
//   - Re-export de las clases de error con sus nombres históricos
//     (`TwilioError` = alias de OtpProviderError) para NO romper los
//     `instanceof` de auth.controller.
//
// Consentimiento WhatsApp: opcional desde la corrección 4.2.3(i) de
// Apple. El OTP se envía SIEMPRE por SMS; WhatsApp va además cuando el
// usuario eligió el canal (delivery_channel=whatsapp) — ver
// services/otp-delivery.service.js. El 451 de la era Twilio se dejó de
// responder.

const {
  sendOtpCode,
  OtpProviderError,
  InvalidPhoneError,
} = require("./smsmasivos.service");

// =====================================================================
// OTP_ECHO: si OTP_ECHO está activo, NO se contacta al proveedor y el
// código se imprime en consola (`[otp-echo] ...`). Útil para probar
// flujos sin gastar saldo.
// ⚠️ NUNCA dejar activo en producción con usuarios reales.
// =====================================================================
const isOtpEchoEnabled = () => {
  const v = process.env.OTP_ECHO;
  if (!v) return false;
  return ["1", "true", "console", "yes", "on"].includes(String(v).toLowerCase());
};

// toE164MX(phone) — usado por webhooks.controller.js (webhook Twilio
// legacy, Fase 4) para parsear el "To" del mensaje entrante.
// Acepta formatos comunes en MX:
//   "5512345678", "+525512345678", "525512345678", "+5215512345678"
// Devuelve null si no se puede normalizar (evita crashes de DB).
const toE164MX = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) return `+52${digits.slice(3)}`;
  return `+${digits}`;
};

// sendOtpViaWhatsApp(phone, code, purpose)
// phone:   10 dígitos MX (o ya E.164 / con +52)
// code:    6 dígitos (string) — code_custom embebido en la plantilla
// purpose: 'activation' | 'password_reset'
//
// Returns { success: true, messageSid, status, throttled? } en éxito.
// Throws OtpProviderError (→503) o InvalidPhoneError (→400).
const sendOtpViaWhatsApp = async (phone, code, purpose = "activation") => {
  // Modo echo: loguear el código y devolver éxito sin tocar el proveedor.
  if (isOtpEchoEnabled()) {
    console.warn(
      `[otp-echo] OTP_ECHO activo — WHATSAPP DESHABILITADO, code en consola: ` +
        `purpose=${purpose} to=${phone} code=${code}`
    );
    return { success: true, messageSid: "echo", status: "echo", echoed: true };
  }

  const result = await sendOtpCode({
    phone,
    code,
    channel: "whatsapp",
    purpose,
  });

  console.log(
    `[whatsapp] OTP sent purpose=${purpose} to=${phone} action=${result.action} ` +
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
  sendOtpViaWhatsApp,
  // Utilidad compartida (webhooks.controller.js — webhook Twilio legacy).
  toE164MX,
  // Errors — nombres históricos para los `instanceof` de auth.controller:
  OtpProviderError,
  TwilioError: OtpProviderError, // alias (era el error del SDK Twilio)
  InvalidPhoneError,
};
