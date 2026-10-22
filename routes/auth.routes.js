// Router de Autenticación
// Montado en /auth (no bajo /api).
const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  signupController,
  loginController,
  appleLoginController,
  logoutController,
  requestActivationController,
  verifyOtpController,
  activateAccountController,
  verifyController,
  refreshController,
  registerStaffFcmToken,
  changePasswordController,
  requestPasswordReset,
  verifyPasswordResetOtp,
  resetPassword,
  updateMyNotificationPreferences,
} = require("../controllers/auth.controller");
const { isAuthenticated } = require("../middleware/jwt.middleware");

const { Router } = express;
const router = Router();

// Rate limiter para el endpoint de solicitud de OTP.
// Limita a 5 solicitudes por hora por IP para evitar SMS bombing.
const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many OTP requests. Please try again in an hour.",
  },
});

// Rate limiter para login con Sign in with Apple (Guideline 4.8).
// 20/h por IP: cada intento puede forzar un fetch del JWKS de Apple
// (aunque jose cachea), así que limitamos abuso. Es más permisivo que
// el de OTP porque un hogar/red NAT puede tener varios intentos
// legítimos de familiares con cuentas distintas.
const appleLoginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many sign-in attempts. Please try again later.",
  },
});

// POST /auth/signup — crear usuario (staff o tutor pre-registrado)
router.post("/signup", signupController);

// POST /auth/login — login universal: phoneNumber + password (todos los roles)
router.post("/login", loginController);

// POST /auth/apple — login con Sign in with Apple (Guideline 4.8:
// opción de login de terceros equivalente al OTP de WhatsApp).
// Verifica el identityToken contra JWKS de Apple y entra con la cuenta
// provisionada cuyo correo coincida (rate-limited).
router.post("/apple", appleLoginLimiter, appleLoginController);

// POST /auth/logout — limpia la cookie HttpOnly
router.post("/logout", logoutController);

// POST /auth/refresh — sin JWT propio: el refresh token en body ES la
// credencial. El controller hace la validación y rotación contra la DB
// (incluye detección de reuso y revocación de family).
router.post("/refresh", refreshController);

// POST /auth/request-activation — tutor o staff no-admin pide OTP por WhatsApp (rate-limited)
router.post("/request-activation", otpRequestLimiter, requestActivationController);

// POST /auth/verify-otp — valida OTP sin activar la cuenta (tutor o staff no-admin)
router.post("/verify-otp", verifyOtpController);

// POST /auth/activate-account — tutor o staff no-admin verifica OTP y establece password
router.post("/activate-account", activateAccountController);

// GET /auth/verify — decodificar JWT (requiere token)
router.get("/verify", isAuthenticated, verifyController);

// POST /auth/fcm-token — registrar token FCM para notificaciones del staff
router.post("/fcm-token", isAuthenticated, registerStaffFcmToken);

// PUT /auth/change-password — cambiar contraseña (cualquier usuario autenticado)
router.put("/change-password", isAuthenticated, changePasswordController);

// POST /auth/forgot-password/request — solicitar OTP para recuperar contraseña por WhatsApp (rate-limited)
router.post(
  "/forgot-password/request",
  otpRequestLimiter,
  requestPasswordReset
);

// POST /auth/forgot-password/verify — validar OTP de recuperación
router.post("/forgot-password/verify", verifyPasswordResetOtp);

// POST /auth/forgot-password/reset — asignar nueva contraseña usando OTP
router.post("/forgot-password/reset", resetPassword);

// PUT /auth/me/notification-preferences — activar/desactivar WhatsApp para el usuario actual
router.put("/me/notification-preferences", isAuthenticated, updateMyNotificationPreferences);

module.exports = router;
