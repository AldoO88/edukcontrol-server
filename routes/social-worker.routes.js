// =====================================================================
// routes/social-worker.routes.js
// ---------------------------------------------------------------------
// Rutas bajo /api/social-worker para funcionalidades del trabajador social.
// =====================================================================

const express = require("express");
const { Router } = express;
const { isAuthenticated } = require("../middleware/jwt.middleware");
const { authorize } = require("../middleware/authorize.middleware");
const {
  attachSchoolContext,
  attachActiveSchoolYear,
} = require("../middleware/tenant-context.middleware");
const {
  getSocialWorkerDashboard,
  getSocialWorkerAttendanceSummary,
  getGroupsSummary,
  getAllTeachers,
  getTeacherDetail,
  getTeacherSchedule,
  getSchoolAbsences,
} = require("../controllers/social-worker.controller");

const {
  getAgreementsByStudent,
  createAgreement,
  updateAgreement,
  getReferralsByStudent,
  createReferral,
  updateReferral,
} = require("../controllers/social-worker-case.controller");

const {
  getExpedientes,
  updateExpedienteStatus,
} = require("../controllers/social-worker-expediente.controller");

const router = Router();

// Todas las rutas requieren JWT + role social_worker
router.use(isAuthenticated);
router.use(authorize("social_worker", "super_admin"));
router.use(attachSchoolContext);
router.use(attachActiveSchoolYear);

// GET /api/social-worker/dashboard — resumen general
router.get("/dashboard", getSocialWorkerDashboard);

// GET /api/social-worker/attendance-summary — asistencia school-wide
router.get("/attendance-summary", getSocialWorkerAttendanceSummary);

// GET /api/social-worker/groups-summary — estadísticas de todos los grupos
router.get("/groups-summary", getGroupsSummary);

// GET /api/social-worker/teachers — lista todos los maestros de la escuela
router.get("/teachers", getAllTeachers);

// GET /api/social-worker/teachers/:teacherId — detalle de un maestro
router.get("/teachers/:teacherId", getTeacherDetail);

// GET /api/social-worker/teacher-schedule/:teacherId — horario de cualquier maestro
router.get("/teacher-schedule/:teacherId", getTeacherSchedule);

// GET /api/social-worker/school-absences — top alumnos con más faltas escolares
router.get("/school-absences", getSchoolAbsences);

// =====================================================================
// EXPEDIENTES (sección web del trabajador social)
// =====================================================================

// GET /api/social-worker/expedientes — padrón del ciclo + estado de
// expediente por alumno + summary global (barra de progreso).
// Query: ?group_id= &status=pending|in_progress|completed &search=
router.get("/expedientes", getExpedientes);

// PATCH /api/social-worker/students/:studentId/expediente-status —
// marcar "completed" o revertir a "in_progress" (manual).
router.patch("/students/:studentId/expediente-status", updateExpedienteStatus);

// =====================================================================
// ACUERDOS CON PADRES
// =====================================================================

// GET /api/social-worker/students/:studentId/agreements — listar acuerdos del alumno
router.get("/students/:studentId/agreements", getAgreementsByStudent);

// POST /api/social-worker/students/:studentId/agreements — crear acuerdo
router.post("/students/:studentId/agreements", createAgreement);

// PATCH /api/social-worker/agreements/:id — actualizar acuerdo
router.patch("/agreements/:id", updateAgreement);

// =====================================================================
// REFERENCIAS A INSTITUCIONES
// =====================================================================

// GET /api/social-worker/students/:studentId/referrals — listar referencias del alumno
router.get("/students/:studentId/referrals", getReferralsByStudent);

// POST /api/social-worker/students/:studentId/referrals — crear referencia
router.post("/students/:studentId/referrals", createReferral);

// PATCH /api/social-worker/referrals/:id — actualizar referencia
router.patch("/referrals/:id", updateReferral);

module.exports = router;
