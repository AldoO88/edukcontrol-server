// Orquestador de entrega de OTPs — SMS siempre + WhatsApp opcional.
//
// Contexto (corrección Guideline 4.2.3(i) — App Store Review, 2026-10-27):
// el revisor de Apple tuvo que instalar WhatsApp para recibir el código
// de activación → rechazo. Este servicio garantiza que el código SIEMPRE
// salga por SMS (canal nativo, sin instalar apps) y que WhatsApp sea un
// canal ADICIONAL, best-effort, para quienes dieron consentimiento.
//
// Reglas de fallo:
//   - SMS falla, WhatsApp (con consentimiento) sale  → éxito (200).
//   - SMS sale, WhatsApp falla                       → éxito (200);
//     el fallo de WhatsApp solo se loguea (era el canal obligatorio
//     antes; ahora nunca debe tumbar un flujo que sí entregó el código).
//   - Fallan ambos / SMS falla sin consentimiento    → se lanza el error
//     del SMS (el controller lo mapea a HTTP status).
//
// El gate de consentimiento de WhatsApp (451) ya NO bloquea la entrega:
// el consentimiento solo decide si se AÑADE el canal WhatsApp.

const smsService = require("./sms.service");
const whatsappService = require("./whatsapp.service");

// deliverOtp({ phone, code, purpose, sendWhatsApp })
//   phone:        10 dígitos MX (o E.164)
//   code:         6 dígitos (string)
//   purpose:      'activation' | 'password_reset'
//   sendWhatsApp: boolean — el caller calcula el consentimiento
//
// Returns { delivered, channels: { sms, whatsapp }, failures: [...] }.
// Throws TwilioError (o subclase) solo si NINGÚN canal entregó.
const deliverOtp = async ({ phone, code, purpose, sendWhatsApp = false }) => {
  const channels = { sms: null, whatsapp: null };
  const failures = [];

  // --- Canal principal: SMS (siempre) ---
  try {
    channels.sms = await smsService.sendOtpViaSms(phone, code, purpose);
  } catch (err) {
    failures.push({ channel: "sms", error: err });
    console.error(
      `[otp-delivery] SMS failed purpose=${purpose} code=${err?.code} ` +
        `message=${err?.message}`
    );
  }

  // --- Canal adicional: WhatsApp (solo con consentimiento) ---
  if (sendWhatsApp) {
    try {
      channels.whatsapp = await whatsappService.sendOtpViaWhatsApp(
        phone,
        code,
        purpose
      );
    } catch (err) {
      failures.push({ channel: "whatsapp", error: err });
      // Best-effort: si el SMS salió, el usuario recibió el código.
      console.warn(
        `[otp-delivery] WhatsApp failed purpose=${purpose} ` +
          `(best-effort, SMS=${channels.sms ? "ok" : "failed"}) ` +
          `code=${err?.code} message=${err?.message}`
      );
    }
  }

  // Ningún canal entregó → propagar el error original (del SMS, que es
  // el principal) para que el controller lo mapee a HTTP status.
  if (!channels.sms && !channels.whatsapp) {
    const smsFailure = failures.find((f) => f.channel === "sms");
    throw (
      smsFailure?.error ||
      new Error(`OTP delivery failed for purpose=${purpose}`)
    );
  }

  console.log(
    `[otp-delivery] delivered purpose=${purpose} ` +
      `sms=${channels.sms ? "ok" : "-"} ` +
      `whatsapp=${channels.whatsapp ? "ok" : "off"} ` +
      `failures=${failures.length}`
  );

  return { delivered: true, channels, failures };
};

module.exports = { deliverOtp };
