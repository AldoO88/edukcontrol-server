// =====================================================================
// controllers/social-worker-expediente.controller.js
// ---------------------------------------------------------------------
// Endpoints del EXPEDIENTE del alumno (sección web del trabajador social):
//   - GET   /api/social-worker/expedientes
//         Listado de los alumnos inscritos en el ciclo activo con su
//         estado de expediente + summary global para la barra de
//         progreso. Filtros: ?group_id= &status= &search=
//   - PATCH /api/social-worker/students/:studentId/expediente-status
//         Marca el expediente como "completed" o lo revierte a
//         "in_progress" (decisión manual del trabajador social).
//
// El estado NACE en "pending" y pasa a "in_progress" solo cuando se
// guarda datos vía PATCH /api/students/:id/health (ver
// students.controller#updateStudentHealth). "completed" solo se setea
// desde este controller.
//
// Multi-tenant: req.school / req.schoolYear vienen de
// attachSchoolContext + attachActiveSchoolYear (el router los aplica a
// todas las rutas; super_admin recibe 403 en attachSchoolContext, así
// que estos endpoints son effectively del rol social_worker).
// =====================================================================

const mongoose = require("mongoose");
const Enrollment = require("../models/Enrollment.model");
const Student = require("../models/Student.model");

// =====================================================================
// Helper: label del grupo ("1A", "2B", "3D")
// =====================================================================
const groupLabel = (group) => {
  if (!group) return null;
  const { grade, section } = group;
  if (grade == null || !section) return null;
  return `${grade}${section}`;
};

// =====================================================================
// GET /api/social-worker/expedientes
// Query: group_id (opcional), status (opcional), search (opcional)
// =====================================================================
const getExpedientes = async (req, res, next) => {
  try {
    const { group_id, status, search } = req.query;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // Sin ciclo activo no hay padrón del ciclo → respuesta vacía (el
    // front muestra EmptyState; no es un error).
    if (!schoolYearId) {
      return res.status(200).json({
        items: [],
        summary: { total: 0, pending: 0, in_progress: 0, completed: 0 },
      });
    }

    // Padrón del ciclo: inscripciones vigentes, con alumno + grupo.
    const enrollmentFilter = {
      school: schoolId,
      school_year_id: schoolYearId,
      cycle_status: "enrolled",
    };
    if (group_id && mongoose.Types.ObjectId.isValid(group_id)) {
      enrollmentFilter.group_id = group_id;
    }

    const enrollments = await Enrollment.find(enrollmentFilter)
      .populate({
        path: "student_id",
        select:
          "first_name last_name controlNumber photoUrl expediente_status expediente_last_saved_at expediente_completed_at health_inclusion.alerts",
      })
      .populate({ path: "group_id", select: "grade section" })
      .lean();

    // Summary global (SIN filtros de status/search): la barra de
    // progreso del listado siempre muestra el avance de TODA la escuela.
    const summary = { total: 0, pending: 0, in_progress: 0, completed: 0 };
    const items = [];

    for (const enr of enrollments) {
      const student = enr.student_id;
      // Alumno ausente (borrado o inscripción huérfana) → se omite.
      if (!student) continue;

      const st = student.expediente_status || "pending";
      summary.total += 1;
      if (st === "completed") summary.completed += 1;
      else if (st === "in_progress") summary.in_progress += 1;
      else summary.pending += 1;

      items.push({
        student_id: String(student._id),
        first_name: student.first_name || "",
        last_name: student.last_name || "",
        controlNumber: student.controlNumber || null,
        photoUrl: student.photoUrl || null,
        group: {
          _id: enr.group_id ? String(enr.group_id._id) : null,
          grade: enr.group_id?.grade ?? null,
          section: enr.group_id?.section ?? null,
          label: groupLabel(enr.group_id),
        },
        expediente_status: st,
        expediente_last_saved_at: student.expediente_last_saved_at || null,
        expediente_completed_at: student.expediente_completed_at || null,
        alerts_count: Array.isArray(student.health_inclusion?.alerts)
          ? student.health_inclusion.alerts.length
          : 0,
      });
    }

    // Orden por apellido + nombre (patrón de los listados del front).
    items.sort((a, b) => {
      const ln = a.last_name.localeCompare(b.last_name, "es");
      return ln !== 0 ? ln : a.first_name.localeCompare(b.first_name, "es");
    });

    // ?summary_only=1 → solo el summary global (lo usa el dashboard
    // para la barra de progreso; se ahorra serializar el padrón).
    if (req.query.summary_only === "1") {
      return res.status(200).json({ summary });
    }

    // Filtros server-side (búsqueda por nombre o número de control).
    let filtered = items;
    if (status && ["pending", "in_progress", "completed"].includes(status)) {
      filtered = filtered.filter((i) => i.expediente_status === status);
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(
        (i) =>
          `${i.first_name} ${i.last_name}`.toLowerCase().includes(q) ||
          (i.controlNumber || "").toLowerCase().includes(q)
      );
    }

    res.status(200).json({ items: filtered, summary });
  } catch (error) {
    console.error("getExpedientes error:", error);
    next(error);
  }
};

// =====================================================================
// PATCH /api/social-worker/students/:studentId/expediente-status
// Body: { status: "in_progress" | "completed" }
// =====================================================================
const updateExpedienteStatus = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: "ID de alumno inválido." });
    }
    if (!["in_progress", "completed"].includes(status)) {
      return res.status(400).json({
        message: 'status debe ser "in_progress" o "completed".',
      });
    }

    const student = await Student.findOne({
      _id: studentId,
      school: req.school,
    }).select("expediente_status expediente_completed_at");

    if (!student) {
      return res.status(404).json({ message: "Alumno no encontrado." });
    }

    student.expediente_status = status;
    student.expediente_completed_at =
      status === "completed" ? new Date() : null;
    await student.save();

    res.status(200).json({
      success: true,
      data: {
        studentId: student._id,
        expedienteStatus: student.expediente_status,
        expedienteCompletedAt: student.expediente_completed_at,
      },
    });
  } catch (error) {
    console.error("updateExpedienteStatus error:", error);
    next(error);
  }
};

module.exports = {
  getExpedientes,
  updateExpedienteStatus,
};
