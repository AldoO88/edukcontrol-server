// Servicio de SMS OTP vía Twilio — CANAL PRINCIPAL de entrega de códigos.
//
// Contexto (corrección Guideline 4.2.3(i) — App Store Review, 2026-10-27):
// antes los OTPs solo salían por WhatsApp, y el revisor de Apple tuvo que
// INSTALAR WhatsApp para poder activar su cuenta → rechazo por exigir una
// app de terceros. Ahora el código se envía SIEMPRE por SMS (canal
// nativo del sistema, no requiere instalar nada) y, como canal
// ADICIONAL, por WhatsApp cuando el usuario dio consentimiento
// (ver services/otp-delivery.service.js).
//
// Remitente: TWILIO_SMS_FROM (número con capacidad SMS; en producción
// el número MX +525629162116 de la consola Twilio).
//
// Errores Twilio comunes de SMS:
//   21211  - Invalid 'To' phone number
//   21601  - Invalid 'From' phone number (remitente sin capacidad SMS)
//   21606  - 'From' no pertenece a esta cuenta Twilio
//
// Reutiliza las clases de error y el formateo E.164 de
// whatsapp.service.js para que los controllers hagan un único
// set de `instanceof` checks al mapear a HTTP status.

const twilio = require("twilio");
const {
  toE164MX,
  TwilioError,
  InvalidPhoneError,
} = require("./whatsapp.service");

// =====================================================================
// OTP_ECHO: mismo bypass que whatsapp.service.js — si OTP_ECHO está
// activo, NO se contacta Twilio y el código se imprime en consola
// (`[otp-echo] ...`). Útil para probar flujos sin remitente SMS.
// ⚠️ NUNCA dejar activo en producción con usuarios reales.
// =====================================================================
const isOtpEchoEnabled = () => {
  const v = process.env.OTP_ECHO;
  if (!v) return false;
  return ["1", "true", "console", "yes", "on"].includes(String(v).toLowerCase());
};

// Inicialización lazy (mismo patrón que whatsapp.service.js): no rompe
// el arranque del server si las credenciales aún no están configuradas.
let twilioClient = null;

const getClient = () => {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new TwilioError(
      "TWILIO_CONFIG_MISSING",
      "Twilio credentials missing. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env"
    );
  }
  twilioClient = twilio(sid, token);
  return twilioClient;
};

// Mapea errores crudos de Twilio a nuestros errores semánticos.
const mapSmsError = (err) => {
  const code = err?.code;
  const msg = err?.message || "Twilio SMS error";
  if (code === 21211 || code === 21601 || code === 21606) {
    return new InvalidPhoneError(msg);
  }
  return new TwilioError(code ?? "SMS_SEND_FAILED", msg);
};

// sendOtpViaSms(phone, code, purpose)
// phone:   10 dígitos MX (o ya E.164)
// code:    6 dígitos (string)
// purpose: 'activation' | 'password_reset' (metadata para logs)
//
// Returns { success: true, messageSid, status } en éxito.
// Throws TwilioError (o subclase) en error.
const sendOtpViaSms = async (phone, code, purpose = "activation") => {
  const to = toE164MX(phone);

  // Modo echo: loguear el código y devolver éxito sin tocar Twilio.
  if (isOtpEchoEnabled()) {
    console.warn(
      `[otp-echo] OTP_ECHO activo — SMS DESHABILITADO, code en consola: ` +
        `purpose=${purpose} to=${to} code=${code}`
    );
    return { success: true, messageSid: "echo", status: "echo", echoed: true };
  }

  const from = process.env.TWILIO_SMS_FROM;
  if (!from) {
    // TwilioError → el controller lo mapea a 503 (falta de config
    // es un problema del servidor, no del usuario).
    throw new TwilioError(
      "SMS_SENDER_MISSING",
      "TWILIO_SMS_FROM missing in .env (número con capacidad SMS, ej. +525629162116)."
    );
  }

  try {
    const client = getClient();
    const message = await client.messages.create({
      from,
      to,
      body: `Tu código de verificación de EdukControl es ${code}. Caduca en 10 minutos. No lo compartas.`,
    });

    console.log(
      `[sms] OTP sent purpose=${purpose} to=${to} sid=${message.sid} status=${message.status}`
    );

    return { success: true, messageSid: message.sid, status: message.status };
  } catch (err) {
    // Los TwilioError de config (getClient / sender missing) ya vienen
    // mapeados; los crudos de la API se traducen aquí.
    if (err instanceof TwilioError) throw err;
    console.error(
      `[sms] sendOtpViaSms failed purpose=${purpose} to=${to} ` +
        `code=${err?.code} message=${err?.message}`
    );
    throw mapSmsError(err);
  }
};

module.exports = {
  sendOtpViaSms,
  // Errors (re-exportados para convenience de los callers)
  TwilioError,
  InvalidPhoneError,
};
