// =====================================================================
// appleAuth.service.js
// ---------------------------------------------------------------------
// Verificación del `identityToken` que devuelve Sign in with Apple
// (GSIS, "Sign in with Apple" de iOS 13+). Requerido por la Guideline
// 4.8 del App Store Review: la app usa WhatsApp (Twilio) para crear y
// verificar cuentas —servicio de terceros—, así que debe ofrecer
// también un login de terceros equivalente; Apple indica que su propio
// login cumple los 3 requisitos de privacidad (solo nombre/correo,
// permite ocultar el correo, no rastrea interacciones para publicidad).
//
// Qué verificamos (todo criptográficamente, sin llamar a Apple):
//   - Firma RS256 contra el JWKS público de Apple
//     (https://appleid.apple.com/auth/keys) — resuelto con `jose`,
//     que cachea las keys y las refresca solo cuando Apple rotas
//     (kid desconocido).
//   - `iss` = https://appleid.apple.com
//   - `aud` = bundle id de la app (APPLE_CLIENT_ID) — evita que un
//     token emitido para OTRA app nos sirva para entrar aquí.
//   - `exp` lo valida `jwtVerify` automáticamente.
//
// El identityToken es un JWT de vida corta (1 h) firmado por Apple; NO
// hay server-to-server exchange (no necesitamos client_secret .p8 ni
// refresh tokens de Apple: solo nos interesa identificar al usuario).
// =====================================================================

const { jwtVerify, createRemoteJWKSet } = require("jose");

// JWKS remoto de Apple. `createRemoteJWKSet` trae/cachea las keys y
// respeta Cache-Control; ante un `kid` no visto fuerza un re-fetch.
const jwks = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

// Issuer canónico de Apple (los identityTokens lo traen en `iss`).
const APPLE_ISSUER = "https://appleid.apple.com";

// Audience esperado = bundle id iOS de la app (net.edukcontrol.app).
// Fallback al bundle id conocido si la env falta en Render: el `aud` es
// estable (es el ID de la app en el portal de Apple), así que el
// fallback no degrada la seguridad y evita romper el endpoint por una
// env no seteada. Documentado en .env.example.
const getAudience = () =>
  process.env.APPLE_CLIENT_ID || "net.edukcontrol.app";

// Verifica el identityToken y extrae los claims que interesan.
// Lanza excepción ante cualquier problema (firma, iss, aud, exp) — el
// controller la traduce a 401 genérico sin filtrar detalles.
const verifyIdentityToken = async (identityToken) => {
  const { payload } = await jwtVerify(identityToken, jwks, {
    issuer: APPLE_ISSUER,
    audience: getAudience(),
  });

  // `sub` es el identificador estable de Apple (usuario + app). Sin él
  // no hay llave de vinculación, así que el token es inútil.
  if (!payload.sub) {
    throw new Error("identityToken sin claim 'sub'");
  }

  // `email` puede venir:
  //   - correo real del Apple ID, o
  //   - correo relay privado de Apple (@privaterelay.appleid.com) si el
  //     usuario eligió "Hide My Email" — igual es estable por app y
  //     sirve como llave. Si el usuario lo ocultó del todo, es null.
  // Normalizamos a minúsculas: el campo `email` de User.model ya
  // aplica lowercase/trim al guardar, así que el match debe ir igual.
  const email = payload.email
    ? String(payload.email).toLowerCase().trim()
    : null;

  // Flag de Apple: true si el correo es el relay privado. Lo logueamos
  // (no lo guardamos: no hace falta para el flujo) para poder
  // diagnosticar en Render si un login usa correo privado.
  const isPrivateEmail =
    payload.is_private_email === true ||
    payload.is_private_email === "true";

  return { sub: payload.sub, email, isPrivateEmail };
};

module.exports = {
  verifyIdentityToken,
};
