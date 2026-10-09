// =====================================================================
// controllers/webhooks.controller.js
// ---------------------------------------------------------------------
// Webhooks externos.
// Hoy soporta:
//   - Twilio WhatsApp status callbacks (delivery/read/failed)
//     Twilio manda un POST form-encoded con campos como:
//       MessageSid, MessageStatus, ErrorCode, ErrorMessage, To, From
//     Configurar TWILIO_STATUS_CALLBACK_URL en .env apuntando a
//     /auth/webhooks/twilio/whatsapp-status.
// =====================================================================

const User = require("../models/User.model");
const Guardian = require("../models/Guardian.model");
const whatsappService = require("../services/whatsapp.service");

// POST /auth/webhooks/twilio/whatsapp-status
// (la firma X-Twilio-Signature se valida en la ruta, antes de llegar aquí)
// Body (form-encoded, Twilio default):
//   MessageSid   — ID único del mensaje
//   MessageStatus — queued | sent | delivered | read | failed | undelivered
//   ErrorCode    — código numérico si falló (63007, 63016, etc.)
//   ErrorMessage — mensaje legible del error
//   To, From     — números
//
// Twilio espera 2xx rápido. Si respondemos con error, Twilio reintenta
// hasta 50 veces — así que SIEMPRE respondemos 200 rápido, y procesamos
// async en el callback.
const twilioStatusWebhook = async (req, res, next) => {
  try {
    // Responder inmediatamente a Twilio (no debe esperar nuestro I/O).
    res.status(200).json({ received: true });

    const {
      MessageSid,
      MessageStatus,
      ErrorCode,
      ErrorMessage,
      To,
    } = req.body || {};

    if (!MessageSid || !MessageStatus) {
      console.warn(
        "[twilio-webhook] Missing MessageSid or MessageStatus. Skipping."
      );
      return;
    }

    console.log(
      `[twilio-webhook] sid=${MessageSid} status=${MessageStatus} to=${To} code=${ErrorCode || "-"} msg=${ErrorMessage || "-"}`
    );

    // Si Twilio reporta fallo por usuario no opted-in (63007) o sesión
    // WhatsApp no encontrada (63038), sincronizamos el opt-in a false
    // para que el usuario no pueda seguir intentando hasta que lo
    // reactive explícitamente desde su perfil.
    if (
      MessageStatus === "failed" ||
      MessageStatus === "undelivered"
    ) {
      if (ErrorCode === "63007" || ErrorCode === "63038") {
        const normalizedPhone = whatsappService.toE164MX(
          String(To || "").replace(/^whatsapp:/, "")
        );

        // Buscar por phoneNumber (User) o phone (Guardian)
        await User.updateMany(
          { phoneNumber: String(To || "").replace(/\D/g, "").slice(-10) },
          {
            $set: {
              "notification_prefs.whatsapp.opted_in": false,
              "notification_prefs.whatsapp.opted_in_at": null,
            },
          }
        );
        await Guardian.updateMany(
          { phone: String(To || "").replace(/\D/g, "").slice(-10) },
          {
            $set: {
              "notification_prefs.whatsapp.opted_in": false,
              "notification_prefs.whatsapp.opted_in_at": null,
            },
          }
        );
        console.warn(
          `[twilio-webhook] Marked opt-in=false due to ${ErrorCode} for ${normalizedPhone}`
        );
      }
    }

    // Aquí se podría persistir el status en una colección
    // OtpDeliveryLog para auditoría. Por ahora solo loggeamos.
  } catch (error) {
    // Ya respondimos 200 al cliente de Twilio, así que cualquier error
    // en el procesamiento solo lo loggeamos.
    console.error("[twilio-webhook] Error processing status:", error);
  }
};

module.exports = {
  twilioStatusWebhook,
};
