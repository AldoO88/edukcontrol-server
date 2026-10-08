// Router de Estudiantes
// Endpoints bajo /api/students. Todos requieren JWT.
// Escritura: admin o registrar. Lectura: cualquier rol del personal.
const express = require("express");
const {
  createStudent,
  getAllStudents,
  getStudentById,
  updateStudent,
  deleteStudent,
  uploadStudentPhoto,
  getStudentPhotoVersions,
  rollbackStudentPhoto,
  promoteStudent,
  getStudentEnrollments,
  getStudentAcademicHistory,
  promoteStudentsBulk,
  getStudentHealth,
  updateStudentHealth,
  importStudentsFromSpreadsheet,
  exportStudentsToExcel,
  exportStudentPhotos,
} = require("../controllers/students.controller");
const { isAuthenticated } = require("../middleware/jwt.middleware");
const { authorize } = require("../middleware/authorize.middleware");
const { uploadSingle } = require("../middleware/upload.middleware");
const { uploadSpreadsheetSingle } = require("../middleware/spreadsheet-upload.middleware");

const { Router } = express;
const router = Router();

router.use(isAuthenticated); // Todas las rutas requieren JWT

// POST /api/students/register — crear estudiante
router.post(
  "/register",
  authorize("admin", "registrar", "super_admin"),
  createStudent
);

// GET /api/students — listar con paginación y filtros
router.get(
  "/",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getAllStudents
);

// GET /api/students/export — descarga Excel del padrón — DEBE ir antes que /:studentId
router.get(
  "/export",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  exportStudentsToExcel
);

// GET /api/students/export/photos — ZIP con fotos JPEG por numero de control
router.get(
  "/export/photos",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  exportStudentPhotos
);

// GET /api/students/:studentId — detalle de un estudiante
router.get(
  "/:studentId",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getStudentById
);

// PUT /api/students/:studentId — actualizar un estudiante
router.put(
  "/:studentId",
  authorize("admin", "registrar", "super_admin"),
  updateStudent
);

// DELETE /api/students/:studentId — eliminar un estudiante
router.delete(
  "/:studentId",
  authorize("admin", "registrar", "super_admin"),
  deleteStudent
);

// Rutas con path explícito "photo/...", "promote", "enrollments" — DEBEN
// ir antes que /:studentId (Express matchearía esos segmentos como un ObjectId).
router.post(
  "/:studentId/photo",
  authorize("admin", "registrar", "super_admin"),
  uploadSingle("photo"),
  uploadStudentPhoto
);
router.get("/:studentId/photo/versions", getStudentPhotoVersions);
router.post("/:studentId/photo/rollback", rollbackStudentPhoto);

// GET /api/students/:studentId/health — ficha de salud e inclusión
router.get(
  "/:studentId/health",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker"),
  getStudentHealth
);

// PATCH /api/students/:studentId/health — actualizar ficha de salud e inclusión
router.patch(
  "/:studentId/health",
  authorize("admin", "principal", "social_worker"),
  updateStudentHealth
);

// POST /api/students/:studentId/promote — promover al siguiente ciclo escolar
router.post(
  "/:studentId/promote",
  authorize("admin", "registrar", "super_admin"),
  promoteStudent
);

// GET /api/students/:studentId/enrollments — historial académico
router.get(
  "/:studentId/enrollments",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getStudentEnrollments
);

// GET /api/students/:studentId/academic-history — vista consolidada
router.get(
  "/:studentId/academic-history",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getStudentAcademicHistory
);

// POST /api/students/import — import from Excel — DEBE ir antes que /:studentId
router.post(
  "/import",
  authorize("admin", "registrar", "super_admin"),
  uploadSpreadsheetSingle("file"),
  importStudentsFromSpreadsheet
);

// POST /api/students/promote-bulk — DEBE ir antes que /:studentId
// (Express matchearía "promote-bulk" como un ObjectId si no)
router.post(
  "/promote-bulk",
  authorize("admin", "registrar", "super_admin"),
  promoteStudentsBulk
);

module.exports = router;
