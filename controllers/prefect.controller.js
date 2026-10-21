// Controlador del Prefecto
// Endpoints bajo /api/prefect:
//   - GET /dashboard          — resumen general de la escuela
//   - GET /attendance-summary — asistencia school-wide (top inasistencias/retardos)
//   - GET /teacher-schedule/:teacherId — horario de cualquier maestro
const mongoose = require("mongoose");
const User = require("../models/User.model");
const School = require("../models/School.model");
const Group = require("../models/Group.model");
const Student = require("../models/Student.model");
const ClassAttendance = require("../models/ClassAttendance.model");
const ClassSchedule = require("../models/ClassSchedule.model");
const SchoolShift = require("../models/SchoolShift.model");
const GradingPeriod = require("../models/GradingPeriod.model");
const Announcement = require("../models/Announcement.model");
const Citation = require("../models/Citation.model");
const ConductLog = require("../models/ConductLog.model");
const AttendanceLog = require("../models/AttendanceLog.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const Subject = require("../models/Subject.model");
const { toMinutes } = require("../models/SchoolShift.model");
// Helper de fecha escolar: el label "currentDate" del dashboard debe leerse
// en la hora de la escuela, no en la del servidor (en prod/UTC se desfasaba
// al día siguiente entre las 18:00 y 24:00 h locales).
const { formatSchoolDate } = require("../utils/school-time");
// Asistencia de HOY desde los lectores (AttendanceLog), día escolar con
// offset explícito — ver utils/school-day-attendance.js (bug: los
// dashboards sumaban ClassAttendance, que estaba vacío en un día real).
const { countTodayAttendanceByStatus } = require("../utils/school-day-attendance");

// =====================================================================
// GET /api/prefect/dashboard
// Devuelve resumen general de la escuela para el dashboard del prefecto:
//   - Datos del prefecto + escuela + ciclo activo
//   - Estadísticas: total alumnos, total grupos
//   - Asistencia del día: presentes, retardos, faltas
//   - Avisos recientes (últimos 5)
//   - Citatorios pendientes
// =====================================================================
const getPrefectDashboard = async (req, res, next) => {
  try {
    const prefectId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Datos del prefecto + escuela en paralelo
    const [user, schoolDoc] = await Promise.all([
      User.findById(prefectId)
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

    // 2. Estadísticas generales en paralelo.
    // La asistencia del día sale del helper (AttendanceLog de los
    // lectores); el resto son counts en paralelo.
    const [
      totalStudents,
      maleCount,
      femaleCount,
      totalGroups,
      { dayPresent, dayRetard, dayAbsent, dayTotal },
    ] = await Promise.all([
      // Total alumnos activos en el ciclo
      Student.countDocuments({ school: schoolId, status: "active" }),
      // Total alumnos activos — niños
      Student.countDocuments({ school: schoolId, status: "active", sex: "male" }),
      // Total alumnos activos — niñas
      Student.countDocuments({ school: schoolId, status: "active", sex: "female" }),
      // Total grupos regulares del ciclo (excluye talleres)
      Group.countDocuments({ school: schoolId, school_year_id: schoolYearId, type: "regular" }),
      // Asistencia de hoy (lectores RFID/cara, alumnos únicos por status)
      countTodayAttendanceByStatus(schoolId),
    ]);

    // 3. Avisos recientes (últimos 5, de todos los maestros)
    const recentAnnouncements = await Announcement.find({
      school: schoolId,
      schoolYear: schoolYearId,
    })
      .select("title message priority targetType sender createdAt")
      .populate("sender", "name last_name")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // 4. Citatorios pendientes (conteo)
    const pendingCitationsCount = await Citation.countDocuments({
      school: schoolId,
      schoolYear: schoolYearId,
      status: "pending",
    });

    // 5. Reportes de conducta recientes (últimos 5)
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

    const prefectName = `${user.name || ""} ${user.last_name || ""}`.trim();

    res.status(200).json({
      prefect: {
        name: prefectName,
        fullName: prefectName,
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
      // formatSchoolDate aplica el offset internamente al instante real.
      currentDate: formatSchoolDate(new Date(), "es-MX", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
      stats: {
        totalStudents,
        maleCount,
        femaleCount,
        totalGroups,
        dayPresent,
        dayRetard,
        dayAbsent,
        // dayTotal viene del helper: dayPresent (on_time + late) +
        // dayAbsent. Antes era present+retard+absent, lo que CONTABA dos
        // veces los retardos porque ya van incluidos en dayPresent.
        dayTotal,
      },
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
      pendingCitationsCount,
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
    });
  } catch (error) {
    console.error("getPrefectDashboard error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/prefect/attendance-summary
// Resumen de asistencia school-wide. Misma lógica que
// getTeacherAttendanceSummary pero sin filtrar por teacher_id.
// Query params: period_id (opcional), group_id (opcional)
// =====================================================================
const getPrefectAttendanceSummary = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { period_id, group_id } = req.query;

    // 1. Todos los grupos del ciclo
    const allGroups = await Group.find({
      school: schoolId,
      school_year_id: schoolYearId,
    })
      .select("grade section type")
      .lean();

    const groupObjectIds = allGroups.map((g) => new mongoose.Types.ObjectId(g._id));

    // 2. Rango de fechas según período
    const now = new Date();
    let fromDate;
    let periodName = null;

    if (period_id && mongoose.Types.ObjectId.isValid(period_id)) {
      const gradingPeriod = await GradingPeriod.findOne({
        _id: period_id,
        school: schoolId,
        school_year_id: schoolYearId,
      }).select("name startDate endDate").lean();

      if (!gradingPeriod) {
        return res.status(404).json({ message: "Período no encontrado." });
      }
      fromDate = new Date(gradingPeriod.startDate);
      const toDate = new Date(gradingPeriod.endDate);
      toDate.setHours(23, 59, 59, 999);
      periodName = gradingPeriod.name;
    } else {
      const SchoolYear = require("../models/SchoolYear.model");
      const schoolYear = await SchoolYear.findById(schoolYearId).select("startDate").lean();
      fromDate = schoolYear ? new Date(schoolYear.startDate) : new Date(now.getFullYear(), now.getMonth() - 3, 1);
    }

    // 3. Consultar ClassAttendance de TODA la escuela en el rango
    const attendanceFilter = {
      school: schoolId,
      school_year_id: schoolYearId,
      date: { $gte: fromDate, $lte: now },
    };
    if (group_id && mongoose.Types.ObjectId.isValid(group_id)) {
      attendanceFilter.group_id = new mongoose.Types.ObjectId(group_id);
    } else {
      attendanceFilter.group_id = { $in: groupObjectIds };
    }

    const attendances = await ClassAttendance.find(attendanceFilter)
      .populate("group_id", "grade section type")
      .populate("subject_id", "code name")
      .lean();

    // 4. Estadísticas globales
    let totalPresent = 0;
    let totalRetard = 0;
    let totalAbsent = 0;
    let totalStudents = 0;

    for (const att of attendances) {
      totalPresent += att.summary.present || 0;
      totalRetard += att.summary.retard || 0;
      totalAbsent += att.summary.absent || 0;
      totalStudents += att.summary.total || 0;
    }

    const totalSessions = attendances.length;
    const totalAttended = totalPresent + totalRetard;
    const attendancePercentage = totalStudents > 0
      ? Math.round((totalAttended / totalStudents) * 100)
      : 0;

    // 5. Top alumnos con más inasistencias
    const absenceCountMap = new Map();
    for (const att of attendances) {
      const groupName = att.group_id ? `${att.group_id.grade}°${att.group_id.section}` : "?";
      const subjectName = att.subject_id?.name || "?";
      for (const record of att.records) {
        if (record.status === "absent") {
          const sid = String(record.student_id);
          if (!absenceCountMap.has(sid)) {
            absenceCountMap.set(sid, { count: 0, groupName, subjectName });
          }
          absenceCountMap.get(sid).count++;
        }
      }
    }

    const topAbsentEntries = [...absenceCountMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    const topAbsentStudentIds = topAbsentEntries.map(([sid]) => new mongoose.Types.ObjectId(sid));
    const topAbsentStudentsRaw = topAbsentStudentIds.length > 0
      ? await Student.find({ _id: { $in: topAbsentStudentIds } })
          .select("first_name last_name")
          .lean()
      : [];

    const absentNameMap = new Map();
    for (const s of topAbsentStudentsRaw) {
      absentNameMap.set(String(s._id), `${s.last_name || ""} ${s.first_name || ""}`.trim());
    }

    const topAbsentStudents = topAbsentEntries.map(([sid, info]) => ({
      _id: sid,
      fullName: absentNameMap.get(sid) || "Desconocido",
      originGroup: info.groupName,
      subject: info.subjectName,
      absenceCount: info.count,
    }));

    // 6. Top alumnos con más retardos
    const retardCountMap = new Map();
    for (const att of attendances) {
      const groupName = att.group_id ? `${att.group_id.grade}°${att.group_id.section}` : "?";
      const subjectName = att.subject_id?.name || "?";
      for (const record of att.records) {
        if (record.status === "retard") {
          const sid = String(record.student_id);
          if (!retardCountMap.has(sid)) {
            retardCountMap.set(sid, { count: 0, groupName, subjectName });
          }
          retardCountMap.get(sid).count++;
        }
      }
    }

    const topRetardEntries = [...retardCountMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    const topRetardStudentIds = topRetardEntries.map(([sid]) => new mongoose.Types.ObjectId(sid));
    const topRetardStudentsRaw = topRetardStudentIds.length > 0
      ? await Student.find({ _id: { $in: topRetardStudentIds } })
          .select("first_name last_name")
          .lean()
      : [];

    const retardNameMap = new Map();
    for (const s of topRetardStudentsRaw) {
      retardNameMap.set(String(s._id), `${s.last_name || ""} ${s.first_name || ""}`.trim());
    }

    const topRetardStudents = topRetardEntries.map(([sid, info]) => ({
      _id: sid,
      fullName: retardNameMap.get(sid) || "Desconocido",
      originGroup: info.groupName,
      subject: info.subjectName,
      retardCount: info.count,
    }));

    // 7. Lista de grupos para filtros
    const groupsList = allGroups.map((g) => ({
      _id: g._id,
      grade: g.grade,
      section: g.section,
      label: `${g.grade}°${g.section}`,
      type: g.type || "regular",
    }));

    res.status(200).json({
      groups: groupsList,
      periodName,
      stats: {
        attendancePercentage,
        totalSessions,
        totalAbsences: totalAbsent,
      },
      topAbsentStudents,
      topRetardStudents,
    });
  } catch (error) {
    console.error("getPrefectAttendanceSummary error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/prefect/teacher-schedule/:teacherId
// Devuelve el horario semanal de cualquier maestro.
// =====================================================================
const getTeacherScheduleById = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { teacherId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teacherId)) {
      return res.status(400).json({ message: "ID de maestro inválido." });
    }

    // Verificar que el maestro existe y es de esta escuela
    const teacher = await User.findOne({
      _id: teacherId,
      school: schoolId,
      role: "teacher",
    })
      .select("name last_name email")
      .lean();

    if (!teacher) {
      return res.status(404).json({ message: "Maestro no encontrado." });
    }

    // Buscar todos los ClassSchedule del maestro en este ciclo
    const schedules = await ClassSchedule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      teacher_id: new mongoose.Types.ObjectId(teacherId),
      isActive: true,
    })
      .populate("group_id", "grade section shift")
      .populate("subject_id", "code name color icon")
      .populate("school_shift_id", "timeBlocks")
      .lean();

    // Construir horario por día
    const scheduleByDay = {};
    const dayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

    for (const sched of schedules) {
      for (const slot of sched.scheduleSlots) {
        const day = slot.dayOfWeek;
        if (!scheduleByDay[day]) scheduleByDay[day] = [];

        const shift = sched.school_shift_id;
        const blocks = shift
          ? shift.timeBlocks.filter((b) =>
              slot.timeBlockRefs.map(String).includes(String(b._id))
            )
          : [];

        if (blocks.length > 0) {
          blocks.sort((a, b) => a.order - b.order);
          const startTime = blocks[0].startTime;
          const endTime = blocks[blocks.length - 1].endTime;

          scheduleByDay[day].push({
            subject: sched.subject_id
              ? {
                  _id: sched.subject_id._id,
                  code: sched.subject_id.code,
                  name: sched.subject_id.name,
                  color: sched.subject_id.color || null,
                  icon: sched.subject_id.icon || null,
                }
              : null,
            group: sched.group_id
              ? {
                  _id: sched.group_id._id,
                  grade: sched.group_id.grade,
                  section: sched.group_id.section,
                  label: `${sched.group_id.grade}°${sched.group_id.section}`,
                }
              : null,
            startTime,
            endTime,
            startMinutes: toMinutes(startTime),
            endMinutes: toMinutes(endTime),
            classroom: slot.classroom || null,
          });
        }
      }
    }

    // Ordenar cada día por hora de inicio
    for (const day of Object.keys(scheduleByDay)) {
      scheduleByDay[day].sort((a, b) => a.startMinutes - b.startMinutes);
    }

    // Calcular estadísticas
    let weeklyHours = 0;
    const groupsSet = new Set();
    for (const dayClasses of Object.values(scheduleByDay)) {
      for (const cls of dayClasses) {
        weeklyHours += (cls.endMinutes - cls.startMinutes) / 60;
        if (cls.group) groupsSet.add(cls.group._id);
      }
    }

    res.status(200).json({
      teacher: {
        _id: teacher._id,
        name: teacher.name,
        last_name: teacher.last_name,
        fullName: `${teacher.last_name || ""} ${teacher.name || ""}`.trim(),
      },
      schedule: scheduleByDay,
      dayNames,
      stats: {
        weeklyHours: Math.round(weeklyHours * 10) / 10,
        groupsCount: groupsSet.size,
      },
    });
  } catch (error) {
    console.error("getTeacherScheduleById error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/prefect/groups-summary
// Devuelve todos los grupos con estadísticas pre-computadas:
//   - studentCount, maleCount, femaleCount (desde Student)
//   - conductReportCount, demeritCount, meritCount (desde ConductLog)
//   - attendedToday, attendanceRate (desde AttendanceLog, solo hoy y
//     solo status on_time/late — ver paso 4: los logs "absent" que
//     crea el cron de cutoff NO cuentan como asistencia)
// =====================================================================
const getGroupsSummary = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Obtener todos los grupos del ciclo (solo regulares)
    const groups = await Group.find({
      school: schoolId,
      school_year_id: schoolYearId,
      type: "regular",
    })
      .select("grade section shift school_year_id")
      // Orden académico: 1A, 1B, 1C, 1D, 2A, 2B… — grade es numérico
      // (el $sort es numérico, no lexicográfico: 2 < 10) y section
      // alfabético ("A" < "B"). Sin esto el orden era el de inserción
      // en Mongo (pedido del usuario, 2026-10-20).
      .sort({ grade: 1, section: 1 })
      .lean();

    if (groups.length === 0) {
      return res.status(200).json({ groups: [] });
    }

    const groupIds = groups.map((g) => g._id);

    // 2. Agregación de alumnos por grupo (total, masculino, femenino)
    const studentAgg = await Student.aggregate([
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId),
          status: "active",
          current_group_id: { $in: groupIds.map((id) => new mongoose.Types.ObjectId(id)) },
        },
      },
      {
        $group: {
          _id: "$current_group_id",
          total: { $sum: 1 },
          male: { $sum: { $cond: [{ $eq: ["$sex", "male"] }, 1, 0] } },
          female: { $sum: { $cond: [{ $eq: ["$sex", "female"] }, 1, 0] } },
        },
      },
    ]);

    const studentMap = new Map();
    for (const agg of studentAgg) {
      studentMap.set(String(agg._id), {
        studentCount: agg.total,
        maleCount: agg.male,
        femaleCount: agg.female,
      });
    }

    // 3. Agregación de reportes de conducta por grupo (total, deméritos, méritos)
    const conductAgg = await ConductLog.aggregate([
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId),
          school_year_id: new mongoose.Types.ObjectId(schoolYearId),
          status: "active",
        },
      },
      {
        $lookup: {
          from: "students",
          localField: "student_id",
          foreignField: "_id",
          as: "student",
        },
      },
      { $unwind: { path: "$student", preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: "$student.current_group_id",
          total: { $sum: 1 },
          demerits: { $sum: { $cond: [{ $eq: ["$eventType", "demerit"] }, 1, 0] } },
          merits: { $sum: { $cond: [{ $eq: ["$eventType", "merit"] }, 1, 0] } },
        },
      },
    ]);

    const conductMap = new Map();
    for (const agg of conductAgg) {
      conductMap.set(String(agg._id), {
        conductReportCount: agg.total,
        demeritCount: agg.demerits,
        meritCount: agg.merits,
      });
    }

    // 4. Agregación de asistencia de hoy por grupo (alumnos únicos con
    //    entry PRESENTE). status in (on_time, late) es OBLIGATORIO: el
    //    cron de cutoff (registerAbsence en attendance.service.js) crea
    //    logs con event_type "entry" y status "absent" para los que no
    //    pasaron por el lector — sin este filtro, una vez que corre el
    //    cron TODOS los alumnos tienen log de entrada y TODOS los
    //    grupos marcaban 100% aunque hubiera faltas reales (bug
    //    reportado 2026-10-20). Misma convención que el detalle de
    //    asistencia y los dashboards: presente = on_time + late.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const attendanceAgg = await AttendanceLog.aggregate([
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId),
          event_type: "entry",
          event_time: { $gte: today, $lt: tomorrow },
          status: { $in: ["on_time", "late"] },
        },
      },
      {
        $lookup: {
          from: "students",
          localField: "student_id",
          foreignField: "_id",
          as: "student",
        },
      },
      { $unwind: { path: "$student", preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: "$student.current_group_id",
          attendedStudents: { $addToSet: "$student_id" },
        },
      },
      {
        $project: {
          attendedCount: { $size: "$attendedStudents" },
        },
      },
    ]);

    const attendanceMap = new Map();
    for (const agg of attendanceAgg) {
      attendanceMap.set(String(agg._id), agg.attendedCount);
    }

    // 5. Combinar todo en la respuesta
    const result = groups.map((group) => {
      const gid = String(group._id);
      const studentStats = studentMap.get(gid) || { studentCount: 0, maleCount: 0, femaleCount: 0 };
      const conductStats = conductMap.get(gid) || { conductReportCount: 0, demeritCount: 0, meritCount: 0 };
      const attendedToday = attendanceMap.get(gid) || 0;
      const attendanceRate = studentStats.studentCount > 0
        ? Math.round((attendedToday / studentStats.studentCount) * 100)
        : 0;

      return {
        _id: group._id,
        grade: group.grade,
        section: group.section,
        label: `${group.grade}°${group.section}`,
        shift: group.shift,
        ...studentStats,
        ...conductStats,
        attendedToday,
        attendanceRate,
      };
    });

    res.status(200).json({ groups: result });
  } catch (error) {
    console.error("getGroupsSummary error:", error);
    next(error);
  }
};

// ---------------------------------------------------------------------
// getAllTeachersForPrefect()
// ---------------------------------------------------------------------
// GET /api/prefect/teachers
// Lista todos los maestros de la escuela del ciclo activo.
const getAllTeachersForPrefect = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    const teachers = await User.find({
      school: schoolId,
      role: "teacher",
    })
      .select("name last_name email phoneNumber")
      .sort({ last_name: 1, name: 1 })
      .lean();

    // Contar módulos totales por maestro (1 módulo = 1 "hora")
    const hoursAgg = await ClassSchedule.aggregate([
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId),
          school_year_id: new mongoose.Types.ObjectId(schoolYearId),
          isActive: true,
        },
      },
      { $unwind: "$scheduleSlots" },
      { $unwind: "$scheduleSlots.timeBlockRefs" },
      {
        $group: {
          _id: "$teacher_id",
          totalHours: { $sum: 1 },
        },
      },
    ]);

    const hoursMap = new Map(hoursAgg.map(h => [h._id.toString(), h.totalHours]));
    const teachersWithHours = teachers.map(t => ({
      ...t,
      totalHours: hoursMap.get(t._id.toString()) || 0,
    }));

    res.status(200).json({ teachers: teachersWithHours });
  } catch (error) {
    console.error("getAllTeachersForPrefect error:", error);
    next(error);
  }
};

// ---------------------------------------------------------------------
// getTeacherDetailForPrefect()
// ---------------------------------------------------------------------
// GET /api/prefect/teachers/:teacherId
// Detalle de un maestro: datos personales + materias asignadas + grupos.
const getTeacherDetailForPrefect = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { teacherId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teacherId)) {
      return res.status(400).json({ message: "ID de maestro inválido." });
    }

    // Verificar que el maestro existe y pertenece a esta escuela
    const teacher = await User.findOne({
      _id: teacherId,
      school: schoolId,
      role: "teacher",
    })
      .select("name last_name email phoneNumber")
      .lean();

    if (!teacher) {
      return res.status(404).json({ message: "Maestro no encontrado." });
    }

    // Obtener asignaciones del maestro en el ciclo activo
    const assignments = await TeacherSubject.find({
      teacher_id: teacherId,
      school: schoolId,
      school_year_id: schoolYearId,
    })
      .populate("subject_id", "code name color icon")
      .populate("group_id", "grade section")
      .lean();

    // Extraer materias únicas
    const subjectMap = new Map();
    for (const a of assignments) {
      const subId = a.subject_id?._id?.toString() || a.subject_id?.toString();
      const subName = a.subject_id?.name || "Materia";
      const subCode = a.subject_id?.code || "";
      if (subId && !subjectMap.has(subId)) {
        subjectMap.set(subId, {
          _id: subId,
          name: subName,
          code: subCode,
          color: a.subject_id?.color || null,
          icon: a.subject_id?.icon || null,
        });
      }
    }

    // Extraer grupos únicos
    const groupMap = new Map();
    for (const a of assignments) {
      const groupId = a.group_id?._id?.toString() || a.group_id?.toString();
      const groupLabel = a.group_id
        ? `${a.group_id.grade || ""}°${a.group_id.section || ""}`
        : "Grupo";
      if (groupId && !groupMap.has(groupId)) {
        groupMap.set(groupId, { _id: groupId, label: groupLabel });
      }
    }

    res.status(200).json({
      teacher,
      subjects: [...subjectMap.values()],
      assignedGroups: [...groupMap.values()],
    });
  } catch (error) {
    console.error("getTeacherDetailForPrefect error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/prefect/school-absences
// Top alumnos con más faltas escolares (AttendanceLog status=absent).
// Query params: from (ISO date), to (ISO date), group_id
// =====================================================================
const getSchoolAbsences = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { from, to, group_id } = req.query;

    // 1. Rango de fechas: default = inicio del ciclo hasta hoy
    const now = new Date();
    let fromDate;

    if (from) {
      fromDate = new Date(from);
    } else {
      const SchoolYear = require("../models/SchoolYear.model");
      const schoolYear = await SchoolYear.findById(schoolYearId)
        .select("startDate")
        .lean();
      fromDate = schoolYear
        ? new Date(schoolYear.startDate)
        : new Date(now.getFullYear(), now.getMonth() - 3, 1);
    }

    const toDate = to ? new Date(to) : now;
    toDate.setHours(23, 59, 59, 999);

    // 2. Filtro base: asistencias con falta de entrada
    const matchFilter = {
      school: new mongoose.Types.ObjectId(schoolId),
      event_type: "entry",
      status: "absent",
      event_time: { $gte: fromDate, $lte: toDate },
    };

    // 3. Si se filtra por grupo, primero obtener los student_ids de ese grupo
    let studentIdsForGroup = null;
    if (group_id && mongoose.Types.ObjectId.isValid(group_id)) {
      const studentsInGroup = await Student.find({
        school: schoolId,
        current_group_id: new mongoose.Types.ObjectId(group_id),
        status: "active",
      })
        .select("_id")
        .lean();
      studentIdsForGroup = studentsInGroup.map((s) => s._id);
      if (studentIdsForGroup.length === 0) {
        return res.status(200).json({
          summary: { totalAbsences: 0, affectedStudents: 0 },
          topAbsentStudents: [],
        });
      }
      matchFilter.student_id = { $in: studentIdsForGroup };
    }

    // 4. Aggregation: contar faltas por alumno, ordenar descendente
    const aggregation = await AttendanceLog.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: "$student_id",
          absenceCount: { $sum: 1 },
        },
      },
      { $sort: { absenceCount: -1 } },
      { $limit: 20 },
    ]);

    if (aggregation.length === 0) {
      return res.status(200).json({
        summary: { totalAbsences: 0, affectedStudents: 0 },
        topAbsentStudents: [],
      });
    }

    // 5. Poblar datos de alumnos y grupos
    const studentIds = aggregation.map((a) => a._id);
    const students = await Student.find({ _id: { $in: studentIds } })
      .select("first_name last_name controlNumber current_group_id")
      .populate("current_group_id", "grade section")
      .lean();

    const studentMap = new Map();
    for (const s of students) {
      studentMap.set(String(s._id), s);
    }

    // 6. Calcular totales
    const totalAbsences = aggregation.reduce(
      (sum, a) => sum + a.absenceCount,
      0,
    );
    const affectedStudents = aggregation.length;

    // 7. Construir respuesta con ranking
    const topAbsentStudents = aggregation.map((entry, index) => {
      const student = studentMap.get(String(entry._id));
      const group = student?.current_group_id;
      return {
        rank: index + 1,
        _id: String(entry._id),
        fullName: student
          ? `${student.last_name || ""} ${student.first_name || ""}`.trim()
          : "Desconocido",
        controlNumber: student?.controlNumber || null,
        group: group ? `${group.grade}°${group.section}` : null,
        absenceCount: entry.absenceCount,
      };
    });

    res.status(200).json({
      summary: { totalAbsences, affectedStudents },
      topAbsentStudents,
    });
  } catch (error) {
    console.error("getSchoolAbsences error:", error);
    next(error);
  }
};

module.exports = {
  getPrefectDashboard,
  getPrefectAttendanceSummary,
  getTeacherScheduleById,
  getGroupsSummary,
  getAllTeachersForPrefect,
  getTeacherDetailForPrefect,
  getSchoolAbsences,
};
