// =====================================================================
// controllers/director.controller.js
// ---------------------------------------------------------------------
// Controlador del Director (rol principal).
// Dashboard propio con métricas globales de la escuela.
// =====================================================================

const mongoose = require("mongoose");
const User = require("../models/User.model");
const School = require("../models/School.model");
const Group = require("../models/Group.model");
const Student = require("../models/Student.model");
const ClassAttendance = require("../models/ClassAttendance.model");
const Announcement = require("../models/Announcement.model");
const Citation = require("../models/Citation.model");
const ConductLog = require("../models/ConductLog.model");
const ExitPass = require("../models/ExitPass.model");
// Helper de fecha escolar: el label "currentDate" del dashboard debe leerse
// en la hora de la escuela, no en la del servidor (en prod/UTC se desfasaba
// al día siguiente entre las 18:00 y 24:00 h locales).
const { formatSchoolDate } = require("../utils/school-time");

// =====================================================================
// GET /api/director/dashboard
// Devuelve métricas globales de la escuela para el dashboard del Director:
//   - Datos del director + escuela + ciclo activo
//   - Estadísticas: total alumnos, total maestros, total grupos
//   - Asistencia del día: presentes, retardos, faltas
//   - Reportes de conducta recientes
//   - Citatorios pendientes
//   - Pases de salida pendientes
// =====================================================================
const getDirectorDashboard = async (req, res, next) => {
  try {
    const directorId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Datos del director + escuela en paralelo
    const [user, schoolDoc] = await Promise.all([
      User.findById(directorId)
        .select("name last_name email phoneNumber role school sex")
        .lean(),
      School.findById(schoolId)
        .select("name cct logoUrl isActive current_school_year_id")
        .populate("current_school_year_id", "name startDate endDate isActive")
        .lean(),
    ]);

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    if (!schoolDoc) {
      return res.status(404).json({ message: "School not found." });
    }

    const currentSchoolYear = schoolDoc.current_school_year_id || null;

    // 2. Estadísticas generales en paralelo
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [
      totalStudents,
      maleCount,
      femaleCount,
      totalGroups,
      totalTeachers,
      todayAttendance,
    ] = await Promise.all([
      // Total alumnos activos
      Student.countDocuments({ school: schoolId, status: "active" }),
      // Niños
      Student.countDocuments({ school: schoolId, status: "active", sex: "male" }),
      // Niñas
      Student.countDocuments({ school: schoolId, status: "active", sex: "female" }),
      // Total grupos regulares del ciclo
      Group.countDocuments({ school: schoolId, school_year_id: schoolYearId, type: "regular" }),
      // Total maestros activos
      User.countDocuments({ school: schoolId, role: "teacher", isActive: { $ne: false } }),
      // Asistencia de hoy
      ClassAttendance.find({
        school: schoolId,
        school_year_id: schoolYearId,
        date: { $gte: today, $lt: tomorrow },
      }).select("summary").lean(),
    ]);

    // Calcular stats de asistencia del día
    let dayPresent = 0;
    let dayRetard = 0;
    let dayAbsent = 0;
    for (const att of todayAttendance) {
      dayPresent += att.summary?.present || 0;
      dayRetard += att.summary?.retard || 0;
      dayAbsent += att.summary?.absent || 0;
    }

    // 3. Reportes de conducta recientes (últimos 5)
    const recentConductLogs = await ConductLog.find({
      school: schoolId,
      school_year_id: schoolYearId,
      status: "active",
    })
      .select("eventType severity description incident_date student_id reported_by")
      .populate("student_id", "first_name last_name")
      .populate("reported_by", "name last_name")
      .sort({ incident_date: -1 })
      .limit(5)
      .lean();

    // 4. Citatorios pendientes (conteo)
    const pendingCitationsCount = await Citation.countDocuments({
      school: schoolId,
      schoolYear: schoolYearId,
      status: "pending",
    });

    // 5. Avisos recientes (últimos 5)
    const recentAnnouncements = await Announcement.find({
      school: schoolId,
      schoolYear: schoolYearId,
    })
      .select("title message priority targetType sender createdAt")
      .populate("sender", "name last_name")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // 6. Pases de salida pendientes (conteo)
    const pendingExitPassesCount = await ExitPass.countDocuments({
      school: schoolId,
      status: "pending",
    });

    const directorName = `${user.name || ""} ${user.last_name || ""}`.trim();

    res.status(200).json({
      director: {
        name: directorName,
        fullName: directorName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        role: user.role,
        sex: user.sex,
      },
      school: {
        name: schoolDoc.name,
        cct: schoolDoc.cct,
        logoUrl: schoolDoc.logoUrl,
        cycle: currentSchoolYear?.name || null,
        school_year_id: currentSchoolYear?._id || schoolYearId || null,
      },
      // Fecha de HOY leída en la escuela (offset explícito, no el TZ del
      // servidor): en prod (UTC) este label se desfasaba tras las 18:00 h.
      currentDate: formatSchoolDate(today, "es-MX", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
      stats: {
        totalStudents,
        maleCount,
        femaleCount,
        totalGroups,
        totalTeachers,
        dayPresent,
        dayRetard,
        dayAbsent,
        dayTotal: dayPresent + dayRetard + dayAbsent,
      },
      recentConductLogs: recentConductLogs.map((c) => ({
        _id: c._id,
        eventType: c.eventType,
        severity: c.severity,
        description: c.description,
        incidentDate: c.incident_date,
        studentName: c.student_id
          ? `${c.student_id.last_name || ""} ${c.student_id.first_name || ""}`.trim()
          : "Desconocido",
        reportedBy: c.reported_by
          ? `${c.reported_by.last_name || ""} ${c.reported_by.name || ""}`.trim()
          : "Desconocido",
      })),
      pendingCitationsCount,
      recentAnnouncements: recentAnnouncements.map((a) => ({
        _id: a._id,
        title: a.title,
        message: a.message,
        priority: a.priority,
        targetType: a.targetType,
        sender: a.sender
          ? `${a.sender.last_name || ""} ${a.sender.name || ""}`.trim()
          : "Desconocido",
        createdAt: a.createdAt,
      })),
      pendingExitPassesCount,
    });
  } catch (error) {
    console.error("getDirectorDashboard error:", error);
    next(error);
  }
};

module.exports = {
  getDirectorDashboard,
};
