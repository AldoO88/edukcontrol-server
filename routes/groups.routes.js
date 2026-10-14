// Router de Grupos
// Endpoints bajo /api/groups. Todos requieren JWT.
// Escritura: admin o registrar. Lectura: cualquier rol del personal.
const express = require("express");
const {
  getAllGroups,
  createGroup,
  importTemplatesFromCatalog,
  getGroupById,
  updateGroup,
  deleteGroup,
  getGroupStudents,
  getGroupSchedule,
} = require("../controllers/groups.controller");
const { isAuthenticated } = require("../middleware/jwt.middleware");
const { authorize } = require("../middleware/authorize.middleware");
const {
  attachSchoolContext,
  attachActiveSchoolYear,
} = require("../middleware/tenant-context.middleware");

const { Router } = express;
const router = Router();

router.use(isAuthenticated);

// GET /api/groups — listar todos los grupos (con filtros opcionales school_year_id, grade, section)
router.get(
  "/",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getAllGroups
);

// POST /api/groups — crear un grupo. super_admin incluido: el panel web
// (ConfigWizard y "Agregar grupos" del ciclo) clona plantillas como super_admin.
router.post("/", authorize("admin", "principal", "registrar", "super_admin"), createGroup);

// POST /api/groups/import-templates — clona plantillas de grupo (catálogo
// de la escuela) al ciclo indicado. Dedupe por grade+section contra los
// grupos ya existentes del ciclo. DEBE ir antes que /:groupId.
router.post(
  "/import-templates",
  authorize("admin", "registrar", "super_admin"),
  importTemplatesFromCatalog
);

// GET /api/groups/:groupId/students — DEBE ir antes que /:groupId
router.get(
  "/:groupId/students",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getGroupStudents
);

// GET /api/groups/:groupId/schedule — horario semanal del grupo
router.get(
  "/:groupId/schedule",
  attachSchoolContext,
  attachActiveSchoolYear,
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getGroupSchedule
);

// GET /api/groups/:groupId — detalle de un grupo
router.get(
  "/:groupId",
  authorize("admin", "principal", "registrar", "teacher", "prefect", "social_worker", "super_admin"),
  getGroupById
);

// PUT /api/groups/:groupId — actualizar un grupo
router.put(
  "/:groupId",
  authorize("admin", "principal", "registrar", "super_admin"),
  updateGroup
);

// DELETE /api/groups/:groupId — eliminar un grupo
router.delete(
  "/:groupId",
  authorize("admin", "principal", "registrar", "super_admin"),
  deleteGroup
);

module.exports = router;
