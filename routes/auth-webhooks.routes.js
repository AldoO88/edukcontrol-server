// Router de webhooks relacionados a auth/OTP.
// Hoy soporta:
//   - POST /auth/webhooks/twilio/whatsapp-status
//     Twilio manda un POST form-encoded cuando un WhatsApp cambia de
//     estado (sent/delivered/read/failed/undelivered).
//
// NO requiere JWT: Twilio no puede hacer login. La autenticación es la
// firma X-Twilio-Signature (HMAC-SHA1 con TWILIO_AUTH_TOKEN sobre la URL
// exacta que configuramos como statusCallback + los params form, ordenados
// por clave) — validada por verifyTwilioSignature antes del handler.
const express = require("express");
const twilio = require("twilio");
const { Router } = express;
const router = Router();

const { twilioStatusWebhook } = require("../controllers/webhooks.controller");

// Twilio manda application/x-www-form-urlencoded por default.
// express.urlencoded() está habilitado globalmente en config/index.js,
// así que req.body ya viene parseado (y es lo que se firma).

// Verifica X-Twilio-Signature contra TWILIO_AUTH_TOKEN y la URL EXACTA
// que le pasamos a Twilio en statusCallback (= TWILIO_STATUS_CALLBACK_URL,
// whatsapp.service.js:181 — Twilio firma la URL a la que POSTea).
// Sin esas dos vars no hay qué validar: se acepta con warning (igual no
// llegarían callbacks legítimos si Twilio nunca recibió statusCallback).
const verifyTwilioSignature = (req, res, next) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const expectedUrl = (process.env.TWILIO_STATUS_CALLBACK_URL || "").trim();
  const signature = req.get("X-Twilio-Signature") || "";

  if (!authToken || !expectedUrl) {
    console.warn(
      "[twilio-webhook] TWILIO_AUTH_TOKEN o TWILIO_STATUS_CALLBACK_URL sin setear — se omite la validación de firma."
    );
    return next();
  }

  let isValid = false;
  try {
    isValid = twilio.validateRequest(
      authToken,
      signature,
      expectedUrl,
      req.body || {}
    );
  } catch (err) {
    // URL mal formada u otro error del validador → firma inválida.
    console.error(`[twilio-webhook] Error validando firma: ${err.message}`);
  }

  if (!isValid) {
    console.warn(
      `[twilio-webhook] Firma inválida (ip=${req.ip} url=${expectedUrl}).`
    );
    return res.status(403).json({ message: "Invalid Twilio signature." });
  }
  return next();
};

// GET — health check (sin firma: solo prueba de alcanzabilidad)
router.get("/twilio/whatsapp-status", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Twilio WhatsApp status webhook endpoint is reachable.",
  });
});

// POST — callback real (aquí SÍ se exige la firma de Twilio)
router.post("/twilio/whatsapp-status", verifyTwilioSignature, twilioStatusWebhook);

module.exports = router;
