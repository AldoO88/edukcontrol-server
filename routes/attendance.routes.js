// Router de Asistencia
// Endpoints bajo /api/attendance.
// /device-trigger usa API key del dispositivo; el resto usa JWT.
const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  deviceTriggerController,
  getAttendanceLogsController,
  getDailyHistoryController,
  getDayDetailController,
  manualOverrideController,
} = require("../controllers/attendance.controller");
const {
  markAbsencesController,
  justifyAttendanceLogController,
} = require("../controllers/attendance-mark-absences.controller");
const { isAuthenticated } = require("../middleware/jwt.middleware");
const { authorize } = require("../middleware/authorize.middleware");
const { verifyDeviceApiKey } = require("../middleware/device.middleware");

const { Router } = express;
const router = Router();

// Rate limiter más estricto para el endpoint de dispositivos:
// 300 peticiones por minuto por IP (los lectores pueden hacer polling).
const deviceLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Ventana de 1 minuto
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many device requests, please slow down." },
});

// POST /api/attendance/device-trigger
// Lo consumen los lectores RFID/cámaras. Auth: API key del dispositivo.
router.post(
  "/device-trigger",
  deviceLimiter,
  verifyDeviceApiKey,
  deviceTriggerController
);

// GET /api/attendance/logs
// Consulta del historial. Auth: JWT + cualquier rol del personal
// (+ super_admin desde 2026-10-17: la web de monitoreo de asistencia
// hace drill-down por día contra este endpoint con ?school=).
router.get(
  "/logs",
  isAuthenticated,
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getAttendanceLogsController
);

// GET /api/attendance/daily-history
// Historial AGREGADO por día (presentes/retardos/faltas) para el
// monitoreo web. Auth: JWT + roles admin-like + super_admin (la web
// navega como super_admin con ?school=; el admin de escuela sale del
// JWT). Ver comentario completo en el controller.
router.get(
  "/daily-history",
  isAuthenticated,
  authorize("admin", "principal", "registrar", "super_admin"),
  getDailyHistoryController
);

// GET /api/attendance/day-detail
// Detalle de UN día — un renglón por alumno activo (foto, nombre,
// grupo, entrada, salida, estatus). Auth: mismos roles admin-like que
// daily-history; la web lo llama al hacer click en un renglón.
router.get(
  "/day-detail",
  isAuthenticated,
  authorize("admin", "principal", "registrar", "super_admin"),
  getDayDetailController
);

// POST /api/attendance/mark-absences
// Marcación manual de ausencias (fallback del cronjob).
// Auth: JWT + admin/registrar/super_admin.
router.post(
  "/mark-absences",
  isAuthenticated,
  authorize("admin", "registrar", "super_admin"),
  markAbsencesController
);

// PUT /api/attendance/logs/:logId/justify
// Justifica una ausencia. Auth: JWT + admin/registrar.
router.put(
  "/logs/:logId/justify",
  isAuthenticated,
  authorize("admin", "registrar", "social_worker"),
  justifyAttendanceLogController
);

// POST /api/attendance/manual-override
// Override manual de asistencia. Auth: JWT + admin/registrar/principal/prefect/super_admin.
router.post(
  "/manual-override",
  isAuthenticated,
  authorize("admin", "registrar", "principal", "prefect", "super_admin"),
  manualOverrideController
);

module.exports = router;
