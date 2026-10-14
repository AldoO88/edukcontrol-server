// Controlador de Asignaciones Maestro-Materia-Grupo (TeacherSubject)
// CRUD de la matriz de permisos: qué maestro enseña qué materia a qué
// grupo en qué año. Es la base para que un teacher solo pueda calificar
// a los alumnos donde efectivamente da clase.
const mongoose = require("mongoose");
const TeacherSubject = require("../models/TeacherSubject.model");
const User = require("../models/User.model");
const Group = require("../models/Group.model");
const Subject = require("../models/Subject.model");
const School = require("../models/School.model");
const ClassSchedule = require("../models/ClassSchedule.model");
const SchoolShift = require("../models/SchoolShift.model");
const Student = require("../models/Student.model");
const Enrollment = require("../models/Enrollment.model");
const ClassAttendance = require("../models/ClassAttendance.model");
const GradingPeriod = require("../models/GradingPeriod.model");
const EvaluationType = require("../models/EvaluationType.model");
const EvaluationGrade = require("../models/EvaluationGrade.model");
const GradeRule = require("../models/GradeRule.model");
const GradeClosing = require("../models/GradeClosing.model");
const Citation = require("../models/Citation.model");
const Announcement = require("../models/Announcement.model");
const Guardian = require("../models/Guardian.model");
const ConductLog = require("../models/ConductLog.model");
const { toMinutes } = require("../models/SchoolShift.model");
// Helper de hora escolar: este controller decide "clase actual/completada"
// y muestra fecha/hora actuales — TODO debe leerse en la hora de la escuela,
// no en la del servidor (en prod/UTC el dashboard del maestro mostraba la
// hora UTC y marcaba la materia equivocada durante 6h).
const { toSchoolDate } = require("../utils/school-time");

const tenantFilter = (req) =>
  req.payload.role === "super_admin"
    ? {}
    : { school: req.payload.schoolId };

// isComboClosed(schoolId, schoolYearId, groupId, subjectId, periodId, teacherId)
// ---------------------------------------------------------------------
// Verifica si un combo grupo+materia+período tiene un GradeClosing
// registrado. Retorna true si está cerrado, false si está abierto.
const isComboClosed = async (schoolId, schoolYearId, groupId, subjectId, periodId, teacherId) => {
  const closing = await GradeClosing.findOne({
    school: schoolId,
    school_year_id: schoolYearId,
    group_id: groupId,
    subject_id: subjectId,
    period_id: periodId,
    teacher_id: teacherId,
  }).lean();
  return !!closing;
};

// GET /api/teacher-subjects
// Lista las asignaciones. Filtros: ?teacher_id, ?group_id, ?subject_id, ?school_year_id
const getAllTeacherSubjects = async (req, res, next) => {
  try {
    const filter = { ...tenantFilter(req) };
    if (req.query.teacher_id && mongoose.Types.ObjectId.isValid(req.query.teacher_id)) {
      filter.teacher_id = req.query.teacher_id;
    }
    if (req.query.group_id && mongoose.Types.ObjectId.isValid(req.query.group_id)) {
      filter.group_id = req.query.group_id;
    }
    if (req.query.subject_id && mongoose.Types.ObjectId.isValid(req.query.subject_id)) {
      filter.subject_id = req.query.subject_id;
    }
    if (req.query.school_year_id && mongoose.Types.ObjectId.isValid(req.query.school_year_id)) {
      filter.school_year_id = req.query.school_year_id;
    }

    const assignments = await TeacherSubject.find(filter)
      .populate("teacher_id", "name last_name email role phoneNumber")
      .populate("subject_id", "code name")
      .populate("group_id", "grade section school_year_id shift")
      .populate("school_year_id", "name startDate endDate isActive")
      .sort({ "teacher_id.name": 1 });

    res.status(200).json({ items: assignments, total: assignments.length });
  } catch (error) {
    next(error);
  }
};

// POST /api/teacher-subjects
// Crea una asignación. Auth: admin/registrar.
const createTeacherSubject = async (req, res, next) => {
  try {
    const { teacher_id, subject_id, group_id, school_year_id } = req.body;

    if (!teacher_id || !subject_id || !group_id || !school_year_id) {
      return res
        .status(400)
        .json({ message: "teacher_id, subject_id, group_id, school_year_id are required." });
    }
    if (!mongoose.Types.ObjectId.isValid(teacher_id)) {
      return res.status(400).json({ message: "Invalid teacher_id." });
    }
    if (!mongoose.Types.ObjectId.isValid(subject_id)) {
      return res.status(400).json({ message: "Invalid subject_id." });
    }
    if (!mongoose.Types.ObjectId.isValid(group_id)) {
      return res.status(400).json({ message: "Invalid group_id." });
    }
    if (!mongoose.Types.ObjectId.isValid(school_year_id)) {
      return res.status(400).json({ message: "Invalid school_year_id." });
    }

    // Verificar que el teacher existe y es role=teacher
    const teacher = await User.findById(teacher_id);
    if (!teacher) {
      return res.status(404).json({ message: "Teacher not found." });
    }
    if (teacher.role !== "teacher" && teacher.role !== "admin" && teacher.role !== "registrar") {
      return res
        .status(400)
        .json({ message: `User with role '${teacher.role}' cannot be assigned as teacher.` });
    }

    // Verificar que la materia existe y pertenece al tenant
    const subject = await Subject.findOne({
      _id: subject_id,
      ...tenantFilter(req),
    });
    if (!subject) {
      return res.status(404).json({ message: "Subject not found in this tenant." });
    }

    // Verificar que el group existe y pertenece al tenant
    const group = await Group.findOne({
      _id: group_id,
      ...tenantFilter(req),
    });
    if (!group) {
      return res.status(404).json({ message: "Group not found in this tenant." });
    }
    if (group.school_year_id.toString() !== school_year_id) {
      return res
        .status(400)
        .json({ message: `Group school_year_id (${group.school_year_id}) doesn't match the assignment (${school_year_id}).` });
    }

    const school = req.payload.schoolId || req.body.school;
    const assignment = await TeacherSubject.create({
      school: school || group.school,
      teacher_id,
      subject_id,
      group_id,
      school_year_id,
    });

    // Auto-set de head_teacher_id en grupos taller (gap de UI):
    // al asignar una materia WORKSHOP (ej. Tecnología) contra un grupo
    // taller sin maestro, seteamos el head_teacher al maestro recién
    // asignado. El dropdown de Horarios exige que cada grupo taller tenga
    // head_teacher_id + TeacherSubject (ese mismo maestro) para mostrar
    // Tecnología transversal; sin esto una escuela montada 100% por la web
    // queda bloqueada (ningún form web setea head_teacher_id).
    // Best-effort: no falla la creación del TS si el update del grupo falla.
    if (group.type === "taller" && subject.classificationType === "WORKSHOP" && !group.head_teacher_id) {
      try {
        await Group.updateOne(
          { _id: group._id, head_teacher_id: null },
          { $set: { head_teacher_id: teacher_id } }
        );
      } catch (headErr) {
        console.warn(
          `[teacher-subjects] No se pudo auto-setear head_teacher_id en grupo taller ${group._id}:`,
          headErr.message
        );
      }
    }

    res.status(201).json(assignment);
  } catch (error) {
    // Duplicate key (mismo teacher+subject+group+year)
    if (error.code === 11000) {
      return res.status(409).json({
        message: "This teacher is already assigned to this subject/group/year.",
      });
    }
    next(error);
  }
};

// DELETE /api/teacher-subjects/:id
const deleteTeacherSubject = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Assignment not found." });
    }
    const deleted = await TeacherSubject.findOneAndDelete({
      _id: id,
      ...tenantFilter(req),
    });
    if (!deleted) {
      return res.status(404).json({ message: "Assignment not found." });
    }
    res.status(200).json({ message: "Assignment deleted successfully." });
  } catch (error) {
    next(error);
  }
};

// GET /api/teacher-subjects/me/dashboard
// Devuelve datos del maestro para su dashboard: escuela, horario del día, clase en curso
const getTeacherDashboard = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Datos del maestro + escuela + ciclo activo en paralelo
    const [user, schoolDoc] = await Promise.all([
      User.findById(teacherId)
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

    // 2. Horario del maestro para el día de hoy
    const now = new Date();
    // Reloj de la escuela (mismo instante, corrido al offset de la escuela).
    // Se lee SIEMPRE con getters getUTC* → idéntico en dev y en prod.
    const schoolNow = toSchoolDate(now);
    const today = schoolNow.getUTCDay(); // 0=domingo...6=sábado (día ESCOLAR)
    const currentMinutes =
      schoolNow.getUTCHours() * 60 + schoolNow.getUTCMinutes(); // hora ESCOLAR

    // Buscar todos los ClassSchedule del maestro en este ciclo
    const schedules = await ClassSchedule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      teacher_id: teacherId,
      isActive: true,
    })
      .populate("group_id", "grade section shift")
      .populate("subject_id", "code name")
      .populate("school_shift_id", "timeBlocks")
      .lean();

    // Filtrar solo los slots de hoy
    const todayClasses = [];
    for (const sched of schedules) {
      for (const slot of sched.scheduleSlots) {
        if (slot.dayOfWeek === today) {
          // Resolver los timeBlocks del SchoolShift
          const shift = sched.school_shift_id;
          const blocks = shift
            ? shift.timeBlocks.filter((b) =>
                slot.timeBlockRefs.map(String).includes(String(b._id))
              )
            : [];

          if (blocks.length > 0) {
            // Ordenar bloques por order
            blocks.sort((a, b) => a.order - b.order);
            const startTime = blocks[0].startTime;
            const endTime = blocks[blocks.length - 1].endTime;
            const startMin = toMinutes(startTime);
            const endMin = toMinutes(endTime);

            todayClasses.push({
              subject: sched.subject_id
                ? { _id: sched.subject_id._id, code: sched.subject_id.code, name: sched.subject_id.name }
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
              startMinutes: startMin,
              endMinutes: endMin,
              classroom: slot.classroom || null,
            });
          }
        }
      }
    }

    // Ordenar por hora de inicio
    todayClasses.sort((a, b) => a.startMinutes - b.startMinutes);

    // 3. Determinar clase en curso, completadas y resto del día
    let currentClass = null;
    const completedClasses = [];
    const restOfDay = [];

    for (const cls of todayClasses) {
      if (currentMinutes >= cls.startMinutes && currentMinutes < cls.endMinutes) {
        currentClass = { ...cls, status: "current" };
        completedClasses.push({ ...cls, status: "completed" });
      } else if (currentMinutes >= cls.endMinutes) {
        completedClasses.push({ ...cls, status: "completed" });
      } else {
        restOfDay.push({ ...cls, status: "upcoming" });
      }
    }

    // 4. Formatear fechas en español (componentes ESCOLARES vía schoolNow)
    const days = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const months = [
      "enero", "febrero", "marzo", "abril", "mayo", "junio",
      "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
    ];
    const dateStr = `${days[schoolNow.getUTCDay()]}, ${schoolNow.getUTCDate()} de ${months[schoolNow.getUTCMonth()]}`;

    // Formatear hora actual en 12h.
    // `date` debe ser el reloj ESCOLAR (schoolNow, ver toSchoolDate): se lee
    // con getUTC* para no depender del TZ del servidor.
    const formatTime12 = (date) => {
      let h = date.getUTCHours();
      const m = date.getUTCMinutes().toString().padStart(2, "0");
      const ampm = h >= 12 ? "p.m." : "a.m.";
      h = h % 12 || 12;
      return `${h}:${m} ${ampm}`;
    };

    // 5. Construir respuesta
    res.status(200).json({
      // Datos del maestro
      teacher: {
        _id: user._id,
        name: user.name,
        last_name: user.last_name,
        fullName: `${user.name} ${user.last_name || ""}`.trim(),
        email: user.email,
        phoneNumber: user.phoneNumber,
        sex: user.sex || null,
      },
      // Datos de la escuela
      school: {
        _id: schoolDoc._id,
        name: schoolDoc.name,
        cct: schoolDoc.cct,
        logoUrl: schoolDoc.logoUrl,
        isActive: schoolDoc.isActive,
      },
      currentSchoolYear,
      // Fecha y hora
      currentDate: dateStr,
      currentTime: formatTime12(schoolNow),
      // Horario del día
      todaySchedule: {
        totalClasses: todayClasses.length,
        completedClasses,
        currentClass,
        restOfDay,
        allClasses: todayClasses.map((cls) => {
          if (currentMinutes >= cls.startMinutes && currentMinutes < cls.endMinutes) {
            return { ...cls, status: "current" };
          } else if (currentMinutes >= cls.endMinutes) {
            return { ...cls, status: "completed" };
          }
          return { ...cls, status: "upcoming" };
        }),
      },
    });
  } catch (error) {
    console.error("getTeacherDashboard error:", error);
    next(error);
  }
};

// GET /api/teacher-subjects/me/groups/:groupId/students
// Devuelve los alumnos inscritos en un grupo para tomar asistencia
const getGroupStudents = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { groupId } = req.params;
    const { subject_id } = req.query;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ message: "Invalid group ID." });
    }

    // 1. Verificar que el grupo existe y pertenece a la escuela
    const group = await Group.findOne({
      _id: groupId,
      school: schoolId,
      school_year_id: schoolYearId,
    }).lean();

    if (!group) {
      return res.status(404).json({ message: "Group not found." });
    }

    // 2. Verificar que el maestro tiene una asignación (TeacherSubject) para este grupo
    const assignmentFilter = {
      school: schoolId,
      teacher_id: teacherId,
      group_id: groupId,
      school_year_id: schoolYearId,
    };
    if (subject_id) {
      assignmentFilter.subject_id = subject_id;
    }
    const assignment = await TeacherSubject.findOne(assignmentFilter).lean();

    if (!assignment) {
      return res.status(403).json({ message: "You are not assigned to this group." });
    }

    // 3. Obtener los alumnos del grupo
    // Para grupos regulares: busca via Enrollment.
    // Para grupos taller: busca via Student.workshop_group_id.
    let students = [];
    const isTaller = group.type === "taller";

    if (isTaller) {
      // Grupo taller: alumnos asignados via Student.workshop_group_id
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: groupId,
      })
        .select("first_name last_name controlNumber photoUrl rfid_card biometricId workshop_group_id")
        .lean();

      // Buscar enrollment activa de cada alumno para obtener su grupo de origen
      const tallerStudentIds = tallerStudents.map((s) => s._id);
      const tallerEnrollments = await Enrollment.find({
        school: schoolId,
        student_id: { $in: tallerStudentIds },
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("group_id", "grade section")
        .lean();

      // Mapa: studentId → label del grupo de origen (ej: "1°A")
      const originGroupMap = {};
      for (const e of tallerEnrollments) {
        if (e.group_id) {
          originGroupMap[String(e.student_id)] = `${e.group_id.grade}°${e.group_id.section}`;
        }
      }

      students = tallerStudents.map((s) => ({
        _id: s._id,
        first_name: s.first_name,
        last_name: s.last_name,
        fullName: `${s.first_name} ${s.last_name || ""}`.trim(),
        controlNumber: s.controlNumber,
        photoUrl: s.photoUrl || null,
        rfid_card: s.rfid_card || null,
        biometricId: s.biometricId || null,
        originGroup: originGroupMap[String(s._id)] || null,
      }));
    } else {
      // Grupo regular: alumnos via Enrollment
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupId,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("student_id", "first_name last_name controlNumber photoUrl rfid_card biometricId")
        .lean();

      students = enrollments
        .map((e) => e.student_id)
        .filter(Boolean)
        .map((s) => ({
          _id: s._id,
          first_name: s.first_name,
          last_name: s.last_name,
          fullName: `${s.first_name} ${s.last_name || ""}`.trim(),
          controlNumber: s.controlNumber,
          photoUrl: s.photoUrl || null,
          rfid_card: s.rfid_card || null,
          biometricId: s.biometricId || null,
          originGroup: null,
        }));
    }

    students.sort((a, b) => (a.last_name || "").localeCompare(b.last_name || "") || (a.first_name || "").localeCompare(b.first_name || ""));

    // 4. Verificar si cada alumno pasó por el biométrico hoy (entry event)
    const AttendanceLog = require("../models/AttendanceLog.model");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const studentIds = students.map((s) => s._id);

    // Buscar primer evento de entrada (entry) de hoy para cada alumno
    const todayEntries = await AttendanceLog.aggregate([
      {
        $match: {
          student_id: { $in: studentIds },
          school: new mongoose.Types.ObjectId(schoolId),
          event_type: "entry",
          event_time: { $gte: today, $lt: tomorrow },
        },
      },
      {
        $group: {
          _id: "$student_id",
          firstEntry: { $min: "$event_time" },
        },
      },
    ]);

    // Mapa: studentId → hora de entrada
    const entryMap = new Map();
    for (const entry of todayEntries) {
      entryMap.set(String(entry._id), entry.firstEntry);
    }

    // 5. Verificar si ya existe asistencia guardada para esta clase hoy
    const ClassAttendance = require("../models/ClassAttendance.model");
    const resolvedSubjectId = subject_id || (assignment ? String(assignment.subject_id) : null);

    const existingAttendance = await ClassAttendance.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: resolvedSubjectId,
      teacher_id: teacherId,
      date: today,
    }).lean();

    // Mapa: studentId → registro de asistencia existente
    const attendanceMap = new Map();
    if (existingAttendance && existingAttendance.records) {
      for (const record of existingAttendance.records) {
        attendanceMap.set(String(record.student_id), {
          status: record.status,
          location: record.location,
          note: record.note,
        });
      }
    }
    if (!existingAttendance) {
      console.log("No existing attendance found for group:", groupId, "subject:", resolvedSubjectId, "teacher:", teacherId, "date:", today);
    }


    // 6. Formatear respuesta
    const groupLabel = `${group.grade}°${group.section}`;

    res.status(200).json({
      group: {
        _id: group._id,
        grade: group.grade,
        section: group.section,
        label: groupLabel,
        shift: group.shift,
      },
      subject_id: resolvedSubjectId,
      // Si ya existe asistencia, incluir el ID para actualizar
      attendance_id: existingAttendance ? existingAttendance._id : null,
      // Si ya existe asistencia, incluir startTime y endTime originales
      startTime: existingAttendance ? existingAttendance.startTime : null,
      endTime: existingAttendance ? existingAttendance.endTime : null,
      students: students.map((s) => {
        const entryTime = entryMap.get(String(s._id));
        const savedAttendance = attendanceMap.get(String(s._id));
        return {
          _id: s._id,
          first_name: s.first_name,
          last_name: s.last_name,
          fullName: `${s.first_name} ${s.last_name || ""}`.trim(),
          controlNumber: s.controlNumber,
          photoUrl: s.photoUrl || null,
          rfid_card: s.rfid_card || null,
          biometricId: s.biometricId || null,
          // Grupo de origen (solo para talleres, null en regulares)
          originGroup: s.originGroup || null,
          // Estado del biométrico (si pasó por el lector)
          checked_in: !!entryTime,
          entry_time: entryTime || null,
          // Asistencia guardada previamente (si existe)
          saved_status: savedAttendance ? savedAttendance.status : null,
          saved_location: savedAttendance ? savedAttendance.location : null,
          saved_note: savedAttendance ? savedAttendance.note : null,
        };
      }),
      total: students.length,
    });

    console.log("getGroupStudents response:", {
      group: {
        _id: group._id,
        grade: group.grade,
        section: group.section,
        label: groupLabel,
        shift: group.shift,
      }
    });
  } catch (error) {
    console.error("getGroupStudents error:", error);
    next(error);
  }
};

// POST /api/teacher-subjects/me/attendance
// Registra el pase de lista de una clase
const saveAttendance = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    const {
      group_id,
      subject_id,
      class_schedule_id,
      date,
      startTime,
      endTime,
      records, // [{ student_id, status, note? }]
    } = req.body;

    // 1. Validaciones básicas
    if (!group_id || !subject_id || !date || !records || !Array.isArray(records)) {
      return res.status(400).json({
        message: "group_id, subject_id, date, and records array are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(group_id)) {
      return res.status(400).json({ message: "Invalid group_id." });
    }
    if (!mongoose.Types.ObjectId.isValid(subject_id)) {
      return res.status(400).json({ message: "Invalid subject_id." });
    }

    // 2. Verificar que el maestro tiene asignatura para este grupo+materia
    const assignment = await TeacherSubject.findOne({
      school: schoolId,
      teacher_id: teacherId,
      group_id,
      subject_id,
      school_year_id: schoolYearId,
    }).lean();

    if (!assignment) {
      return res.status(403).json({
        message: "You are not assigned to teach this subject in this group.",
      });
    }

    // 3. Validar que todos los student_ids sean válidos y pertenezcan al grupo
    const studentIds = records.map((r) => r.student_id);
    const validIds = studentIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length !== studentIds.length) {
      return res.status(400).json({ message: "All student_ids must be valid ObjectIds." });
    }

    const enrollments = await Enrollment.find({
      school: schoolId,
      group_id,
      school_year_id: schoolYearId,
      student_id: { $in: validIds },
      cycle_status: "enrolled",
    }).lean();

    if (enrollments.length !== validIds.length) {
      return res.status(400).json({
        message: "Some students are not enrolled in this group.",
      });
    }

    // 4. Validar statuses
    const validStatuses = ["present", "retard", "absent"];
    for (const record of records) {
      if (!validStatuses.includes(record.status)) {
        return res.status(400).json({
          message: `Invalid status '${record.status}'. Must be: present, retard, or absent.`,
        });
      }
    }

    // 5. Preparar fecha (solo día, sin hora)
    const attendanceDate = new Date(date);
    attendanceDate.setHours(0, 0, 0, 0);

    // 6. Calcular resumen
    const summary = {
      total: records.length,
      present: records.filter((r) => r.status === "present").length,
      retard: records.filter((r) => r.status === "retard").length,
      absent: records.filter((r) => r.status === "absent").length,
    };

    // 7. Upsert: si ya existe attendance para esta clase el mismo día, actualizar
    const ClassAttendance = require("../models/ClassAttendance.model");
    
    const attendance = await ClassAttendance.findOneAndUpdate(
      {
        school: schoolId,
        school_year_id: schoolYearId,
        group_id,
        subject_id,
        teacher_id: teacherId,
        date: attendanceDate,
      },
      {
        school: schoolId,
        school_year_id: schoolYearId,
        group_id,
        subject_id,
        teacher_id: teacherId,
        class_schedule_id: class_schedule_id || null,
        date: attendanceDate,
        startTime: startTime || null,
        endTime: endTime || null,
        records: records.map((r) => ({
          student_id: r.student_id,
          status: r.status,
          location: r.location || (r.status === "present" ? "in_school" : "absent"),
          note: r.note || null,
        })),
        summary,
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    res.status(201).json({
      message: "Attendance saved successfully.",
      attendance: {
        _id: attendance._id,
        date: attendance.date,
        group_id: attendance.group_id,
        subject_id: attendance.subject_id,
        summary: attendance.summary,
        recordsCount: attendance.records.length,
      },
    });
     console.log("Group attendance saved:", {
      attendanceId: attendance._id,
      group_id,
      subject_id,
      date: attendanceDate,
      recordsCount: attendance.records.length,
    });
  } catch (error) {
    console.error("saveAttendance error:", error);
    next(error);
  }
};

// GET /api/teacher-subjects/me/groups
// Devuelve los grupos asignados al maestro con sus alumnos (para crear avisos y citatorios).
// Para grupos regulares: busca alumnos via Enrollment.
// Para grupos taller: busca alumnos via Student.workshop_group_id.
const getMyGroups = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Buscar asignaciones del teacher en este ciclo
    const assignments = await TeacherSubject.find({
      school: schoolId,
      teacher_id: teacherId,
      school_year_id: schoolYearId,
    })
      .populate("group_id", "grade section shift school_year_id type")
      .populate("subject_id", "code name isTutoria")
      .lean();

    // 2. Agrupar por grupo
    const groupMap = new Map();
    for (const a of assignments) {
      const gid = String(a.group_id._id);
      if (!groupMap.has(gid)) {
        groupMap.set(gid, {
          _id: a.group_id._id,
          grade: a.group_id.grade,
          section: a.group_id.section,
          label: `${a.group_id.grade}°${a.group_id.section}`,
          shift: a.group_id.shift,
          type: a.group_id.type || "regular",
          subjects: [],
          students: [],
        });
      }
      const group = groupMap.get(gid);
      // Deduplicar materias
      if (!group.subjects.find((s) => String(s._id) === String(a.subject_id._id))) {
        group.subjects.push({ _id: a.subject_id._id, code: a.subject_id.code, name: a.subject_id.name, isTutoria: a.subject_id.isTutoria || false });
      }
    }

    // 3. Separar grupos regulares y talleres
    const regularGroupIds = [];
    const tallerGroupIds = [];
    for (const [gid, group] of groupMap) {
      if (group.type === "taller") {
        tallerGroupIds.push(new mongoose.Types.ObjectId(gid));
      } else {
        regularGroupIds.push(new mongoose.Types.ObjectId(gid));
      }
    }

    // 4. Buscar alumnos de grupos regulares via Enrollment
    if (regularGroupIds.length > 0) {
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: { $in: regularGroupIds },
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("student_id", "first_name last_name photoUrl guardians")
        .lean();

      for (const e of enrollments) {
        if (!e.student_id) continue;
        const group = groupMap.get(String(e.group_id));
        if (group) {
          group.students.push({
            _id: e.student_id._id,
            first_name: e.student_id.first_name,
            last_name: e.student_id.last_name,
            fullName: `${e.student_id.first_name} ${e.student_id.last_name || ""}`.trim(),
            photoUrl: e.student_id.photoUrl || null,
            guardians: e.student_id.guardians || [],
          });
        }
      }
    }

    // 5. Buscar alumnos de grupos taller via Student.workshop_group_id
    if (tallerGroupIds.length > 0) {
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: { $in: tallerGroupIds },
      })
        .select("first_name last_name photoUrl workshop_group_id guardians")
        .lean();

      // 5b. Buscar enrollment activa de cada alumno para obtener su grupo de origen
      const tallerStudentIds = tallerStudents.map((s) => s._id);
      const tallerEnrollments = await Enrollment.find({
        school: schoolId,
        student_id: { $in: tallerStudentIds },
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("group_id", "grade section")
        .lean();

      // Mapa: studentId → "1°A", "2°C", etc.
      const studentOriginGroupMap = {};
      for (const e of tallerEnrollments) {
        if (e.group_id) {
          studentOriginGroupMap[String(e.student_id)] = `${e.group_id.grade}°${e.group_id.section}`;
        }
      }

      for (const s of tallerStudents) {
        const group = groupMap.get(String(s.workshop_group_id));
        if (group) {
          group.students.push({
            _id: s._id,
            first_name: s.first_name,
            last_name: s.last_name,
            fullName: `${s.first_name} ${s.last_name || ""}`.trim(),
            photoUrl: s.photoUrl || null,
            originGroup: studentOriginGroupMap[String(s._id)] || null,
            guardians: s.guardians || [],
          });
        }
      }
    }

    // 6. Obtener tutores de todos los alumnos
    const allStudentGuardians = [];
    for (const [, group] of groupMap) {
      for (const student of group.students) {
        if (student.guardians && student.guardians.length > 0) {
          allStudentGuardians.push(...student.guardians);
        }
      }
    }

    const guardiansMap = {};
    if (allStudentGuardians.length > 0) {
      const uniqueGuardianIds = [...new Set(allStudentGuardians.map(String))];
      const guardians = await Guardian.find({
        _id: { $in: uniqueGuardianIds },
        school: schoolId,
      }).select("name lastname relationship phone").lean();

      for (const guardian of guardians) {
        guardiansMap[String(guardian._id)] = {
          _id: guardian._id,
          fullName: [guardian.name, guardian.lastname].filter(Boolean).join(" "),
          relationship: guardian.relationship,
          phone: guardian.phone || null,
        };
      }
    }

    // 7. Agregar guardian a cada alumno y ordenar por apellido
    const groups = [...groupMap.values()].map((g) => ({
      ...g,
      students: g.students.map((s) => {
        const primaryGuardianId = s.guardians && s.guardians.length > 0
          ? String(s.guardians[0])
          : null;
        const studentObj = {
          _id: s._id,
          first_name: s.first_name,
          last_name: s.last_name,
          fullName: `${s.first_name} ${s.last_name || ""}`.trim(),
          photoUrl: s.photoUrl || null,
          guardian: primaryGuardianId ? guardiansMap[primaryGuardianId] || null : null,
        };
        if (s.originGroup !== undefined) {
          studentObj.originGroup = s.originGroup;
        }
        return studentObj;
      }).sort((a, b) => (a.last_name || "").localeCompare(b.last_name || "")),
      totalStudents: g.students.length,
    }));

    res.status(200).json({ groups });
  } catch (error) {
    console.error("getMyGroups error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/schedule
// Devuelve el horario semanal completo del maestro agrupado por día.
// Los módulos consecutivos de la misma materia se fusionan en un solo
// registro (ej: 07:30-09:10 Tecnología I = 2 módulos).
// Incluye recesos del SchoolShift y estadísticas.
const getTeacherSchedule = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Buscar todos los ClassSchedule del maestro en este ciclo
    const schedules = await ClassSchedule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      teacher_id: teacherId,
      isActive: true,
    })
      .populate("group_id", "grade section shift type")
      .populate("subject_id", "code name color icon")
      .populate("school_shift_id", "timeBlocks moduleDurationMinutes")
      .lean();

    if (schedules.length === 0) {
      return res.status(200).json({
        stats: { weeklyHours: 0, groupsCount: 0, freeHoursWeekly: 0 },
        schedule: { 1: [], 2: [], 3: [], 4: [], 5: [] },
        today: new Date().getDay(),
      });
    }

    // 2. Recopilar todos los SchoolShifts únicos para inyectar recesos
    const shiftMap = new Map();
    for (const s of schedules) {
      if (s.school_shift_id && !shiftMap.has(String(s.school_shift_id._id))) {
        shiftMap.set(String(s.school_shift_id._id), s.school_shift_id);
      }
    }

    // 3. Procesar cada día de la semana (1=Lunes...5=Viernes)
    const scheduleByDay = {};
    const groupsSet = new Set();
    let totalModules = 0;

    for (let day = 1; day <= 5; day++) {
      const dayClasses = [];

      for (const sched of schedules) {
        for (const slot of sched.scheduleSlots) {
          if (slot.dayOfWeek !== day) continue;

          const shift = sched.school_shift_id;
          if (!shift) continue;

          // Resolver bloques del slot (manualmente porque .lean() quita métodos)
          const wanted = new Set(slot.timeBlockRefs.map(String));
          const blocks = (shift.timeBlocks || [])
            .filter((b) => wanted.has(String(b._id)))
            .sort((a, b) => a.order - b.order);
          if (blocks.length === 0) continue;

          const startTime = blocks[0].startTime;
          const endTime = blocks[blocks.length - 1].endTime;
          const blockCount = blocks.length;

          // Registrar grupo único
          if (sched.group_id) {
            groupsSet.add(String(sched.group_id._id));
          }

          // Contar módulos para estadísticas
          totalModules += blockCount;

          dayClasses.push({
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
                  type: sched.group_id.type || "regular",
                }
              : null,
            startTime,
            endTime,
            startMinutes: toMinutes(startTime),
            endMinutes: toMinutes(endTime),
            blockCount,
            classroom: slot.classroom || null,
            isBreak: false,
            isFree: false,
            is_taller: (sched.group_id?.type) === "taller",
          });
        }
      }

      // 4. Inyectar recesos del SchoolShift (solo uno por turno)
      const breakBlocks = [];
      for (const [, shift] of shiftMap) {
        for (const block of shift.timeBlocks) {
          if (block.isBreak) {
            breakBlocks.push({
              subject: null,
              group: null,
              startTime: block.startTime,
              endTime: block.endTime,
              startMinutes: toMinutes(block.startTime),
              endMinutes: toMinutes(block.endTime),
              blockCount: 1,
              classroom: null,
              isBreak: true,
              isFree: false,
              is_taller: false,
            });
          }
        }
      }

      // 5. Inyectar bloques libres (timeBlocks del turno no ocupados por clases)
      const occupiedBlockIds = new Set();
      for (const entry of dayClasses) {
        // Marcar bloques ocupados por sus startTime/endTime
        for (let m = entry.startMinutes; m < entry.endMinutes; m++) {
          occupiedBlockIds.add(m);
        }
      }

      const freeBlocks = [];
      for (const [, shift] of shiftMap) {
        for (const block of shift.timeBlocks) {
          if (block.isBreak) continue;
          const blockStart = toMinutes(block.startTime);
          const blockEnd = toMinutes(block.endTime);

          // Verificar si el bloque completo está libre
          let isOccupied = false;
          for (let m = blockStart; m < blockEnd; m++) {
            if (occupiedBlockIds.has(m)) {
              isOccupied = true;
              break;
            }
          }

          if (!isOccupied) {
            freeBlocks.push({
              subject: null,
              group: null,
              startTime: block.startTime,
              endTime: block.endTime,
              startMinutes: blockStart,
              endMinutes: blockEnd,
              blockCount: 1,
              classroom: null,
              isBreak: false,
              isFree: true,
              is_taller: false,
            });
          }
        }
      }

      // Combinar clases + recesos + libres y ordenar por hora de inicio
      const allEntries = [...dayClasses, ...breakBlocks, ...freeBlocks].sort(
        (a, b) => a.startMinutes - b.startMinutes
      );

      scheduleByDay[day] = allEntries;
    }

    // 5. Calcular estadísticas
    const weeklyHours = totalModules;
    const today = new Date().getDay();

    // Horas libres en la semana = (bloques del turno × 5 días) - bloques asignados
    let totalShiftBlocksPerDay = 0;
    for (const [, shift] of shiftMap) {
      for (const block of shift.timeBlocks) {
        if (!block.isBreak) {
          totalShiftBlocksPerDay++;
        }
      }
    }
    const totalShiftBlocksWeekly = totalShiftBlocksPerDay * 5;
    const freeHoursWeekly = totalShiftBlocksWeekly - weeklyHours;

    res.status(200).json({
      stats: {
        weeklyHours,
        groupsCount: groupsSet.size,
        freeHoursWeekly,
      },
      schedule: scheduleByDay,
      today,
    });
  } catch (error) {
    console.error("getTeacherSchedule error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/attendance-summary
// Devuelve resumen de asistencia del maestro: estadísticas, top alumnos
// con más inasistencias y top alumnos con más retardos. Filtrable por
// grupo y período de evaluación (GradingPeriod).
const getTeacherAttendanceSummary = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { period_id, group_id } = req.query;

    // 1. Obtener grupos del teacher via TeacherSubject
    const assignments = await TeacherSubject.find({
      school: schoolId,
      teacher_id: teacherId,
      school_year_id: schoolYearId,
    })
      .populate("group_id", "grade section type")
      .populate("subject_id", "code name")
      .lean();

    // Construir lista de grupos del teacher
    const teacherGroups = [];
    const groupSubjectMap = new Map(); // groupId -> { subject, group }
    for (const a of assignments) {
      if (!a.group_id) continue;
      const gid = String(a.group_id._id);
      if (!groupSubjectMap.has(gid)) {
        groupSubjectMap.set(gid, {
          group: { _id: a.group_id._id, grade: a.group_id.grade, section: a.group_id.section, label: `${a.group_id.grade}°${a.group_id.section}`, type: a.group_id.type || "regular" },
          subject: a.subject_id ? { _id: a.subject_id._id, code: a.subject_id.code, name: a.subject_id.name } : null,
        });
        teacherGroups.push(new mongoose.Types.ObjectId(gid));
      }
    }

    // 2. Calcular rango de fechas según período de evaluación
    const now = new Date();
    let fromDate;
    let periodName = null;

    if (period_id && mongoose.Types.ObjectId.isValid(period_id)) {
      // Buscar el GradingPeriod por ID
      const GradingPeriod = require("../models/GradingPeriod.model");
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
      // Ajustar para incluir todo el día de endDate
      toDate.setHours(23, 59, 59, 999);
      periodName = gradingPeriod.name;
    } else {
      // Sin período específico: todo el ciclo escolar hasta hoy
      const SchoolYear = require("../models/SchoolYear.model");
      const schoolYear = await SchoolYear.findById(schoolYearId).select("startDate").lean();
      fromDate = schoolYear ? new Date(schoolYear.startDate) : new Date(now.getFullYear(), now.getMonth() - 3, 1);
    }

    // 3. Consultar ClassAttendance del teacher en el rango
    const attendanceFilter = {
      school: schoolId,
      school_year_id: schoolYearId,
      teacher_id: teacherId,
      date: { $gte: fromDate, $lte: now },
    };
    if (group_id && mongoose.Types.ObjectId.isValid(group_id)) {
      attendanceFilter.group_id = new mongoose.Types.ObjectId(group_id);
    } else {
      attendanceFilter.group_id = { $in: teacherGroups };
    }

    const attendances = await ClassAttendance.find(attendanceFilter)
      .populate("group_id", "grade section type")
      .populate("subject_id", "code name")
      .lean();

    // 4. Calcular estadísticas globales
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
    const absenceCountMap = new Map(); // studentId -> { count, groupName, subjectName }
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
    const retardCountMap = new Map(); // studentId -> { count, groupName, subjectName }
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

    // 7. Lista de grupos para los filtros del front
    const groupsList = [...groupSubjectMap.values()].map((v) => v.group);

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
    console.error("getTeacherAttendanceSummary error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/groups-with-schedule
// Devuelve los grupos del maestro con horario, aula y macroCategory
// para la pantalla "Mis Grupos y Asignaturas" del front.
const getMyGroupsWithSchedule = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const today = new Date().getDay();

    // 1. Buscar asignaciones del teacher en este ciclo
    const assignments = await TeacherSubject.find({
      school: schoolId,
      teacher_id: teacherId,
      school_year_id: schoolYearId,
    })
      .populate("group_id", "grade section shift type")
      .populate("subject_id", "code name macroCategory isTutoria color icon")
      .lean();

    if (assignments.length === 0) {
      return res.status(200).json({ groups: [] });
    }

    // 2. Agrupar por grupo+subject (un grupo puede tener varias materias)
    const groupSubjectMap = new Map(); // "groupId_subjectId" -> { group, subject }
    const groupIds = new Set();
    for (const a of assignments) {
      if (!a.group_id || !a.subject_id) continue;
      const gid = String(a.group_id._id);
      const sid = String(a.subject_id._id);
      const key = `${gid}_${sid}`;
      groupIds.add(gid);
      if (!groupSubjectMap.has(key)) {
        groupSubjectMap.set(key, {
          group: {
            _id: a.group_id._id,
            grade: a.group_id.grade,
            section: a.group_id.section,
            label: `${a.group_id.grade}°${a.group_id.section}`,
            type: a.group_id.type || "regular",
            tallerName: a.group_id.type === "taller" ? a.group_id.section : null,
          },
          subject: {
            _id: a.subject_id._id,
            code: a.subject_id.code,
            name: a.subject_id.name,
            macroCategory: a.subject_id.macroCategory || null,
            isTutoria: a.subject_id.isTutoria || false,
            color: a.subject_id.color || null,
            icon: a.subject_id.icon || null,
          },
        });
      }
    }

    // 3. Buscar ClassSchedule del teacher para obtener horarios y aulas
    const schedules = await ClassSchedule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      teacher_id: teacherId,
      isActive: true,
    })
      .populate("group_id", "grade section type")
      .populate("subject_id", "code name macroCategory")
      .populate("school_shift_id", "timeBlocks")
      .lean();

    // 4. Para cada ClassSchedule, resolver timeBlocks y construir horario
    // Mapa: "groupId_subjectId" -> [{ dayOfWeek, startTime, endTime, classroom, dayName }]
    const scheduleByGroupSubject = new Map();
    const dayNames = { 0: "Domingo", 1: "Lunes", 2: "Martes", 3: "Miércoles", 4: "Jueves", 5: "Viernes", 6: "Sábado" };

    for (const sched of schedules) {
      if (!sched.group_id || !sched.subject_id || !sched.school_shift_id) continue;
      const gid = String(sched.group_id._id);
      const sid = String(sched.subject_id._id);
      const key = `${gid}_${sid}`;

      for (const slot of sched.scheduleSlots) {
        // Resolver timeBlockRefs del slot
        const wanted = new Set(slot.timeBlockRefs.map(String));
        const blocks = (sched.school_shift_id.timeBlocks || [])
          .filter((b) => wanted.has(String(b._id)))
          .sort((a, b) => a.order - b.order);
        if (blocks.length === 0) continue;

        const startTime = blocks[0].startTime;
        const endTime = blocks[blocks.length - 1].endTime;

        if (!scheduleByGroupSubject.has(key)) {
          scheduleByGroupSubject.set(key, []);
        }
        scheduleByGroupSubject.get(key).push({
          dayOfWeek: slot.dayOfWeek,
          dayName: dayNames[slot.dayOfWeek] || `Día ${slot.dayOfWeek}`,
          startTime,
          endTime,
          classroom: slot.classroom || null,
          isToday: slot.dayOfWeek === today,
        });
      }
    }

    // 5. Buscar conteo de alumnos por grupo
    const regularGroupIds = [];
    const tallerGroupIds = [];
    for (const gid of groupIds) {
      const groupData = [...groupSubjectMap.values()].find(
        (v) => String(v.group._id) === gid
      );
      if (groupData && groupData.group.type === "taller") {
        tallerGroupIds.push(new mongoose.Types.ObjectId(gid));
      } else {
        regularGroupIds.push(new mongoose.Types.ObjectId(gid));
      }
    }

    const studentCountMap = new Map(); // groupId -> count

    // Regulares via Enrollment
    if (regularGroupIds.length > 0) {
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: { $in: regularGroupIds },
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .select("group_id")
        .lean();

      for (const e of enrollments) {
        const gid = String(e.group_id);
        studentCountMap.set(gid, (studentCountMap.get(gid) || 0) + 1);
      }
    }

    // Talleres via Student.workshop_group_id
    if (tallerGroupIds.length > 0) {
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: { $in: tallerGroupIds },
      })
        .select("workshop_group_id")
        .lean();

      for (const s of tallerStudents) {
        const gid = String(s.workshop_group_id);
        studentCountMap.set(gid, (studentCountMap.get(gid) || 0) + 1);
      }
    }

    // 6. Construir respuesta: un entry por group+subject
    const result = [];
    for (const [key, { group, subject }] of groupSubjectMap) {
      const scheduleEntries = scheduleByGroupSubject.get(key) || [];
      const totalStudents = studentCountMap.get(String(group._id)) || 0;

      // Seleccionar el horario del día de hoy si existe, si no el primero
      const todaySchedule = scheduleEntries.find((s) => s.isToday);
      const primarySchedule = todaySchedule || scheduleEntries[0] || null;

      result.push({
        _id: group._id,
        label: group.label,
        type: group.type,
        tallerName: group.tallerName || null,
        subject,
        totalStudents,
        schedule: primarySchedule,
        allSchedules: scheduleEntries.length > 1 ? scheduleEntries : undefined,
      });
    }

    // Ordenar por grado y sección
    result.sort((a, b) => {
      const labelA = a.label || "";
      const labelB = b.label || "";
      return labelA.localeCompare(labelB, "es", { numeric: true });
    });
    console.log("Result:",  result);

    res.status(200).json({ groups: result });
  } catch (error) {
    console.error("getMyGroupsWithSchedule error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/grading-periods
// Devuelve los períodos de evaluación del ciclo activo.
const getGradingPeriods = async (req, res, next) => {
  try {
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    const periods = await GradingPeriod.find({
      school: schoolId,
      school_year_id: schoolYearId,
    })
      .select("name order startDate endDate isClosed")
      .sort({ order: 1 })
      .lean();

    res.status(200).json({ periods });
  } catch (error) {
    console.error("getGradingPeriods error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/attendance-sessions
// Devuelve las sesiones de asistencia de un grupo+materia en un período,
// más la lista de alumnos del grupo.
const getAttendanceSessions = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id } = req.query;

    if (!group_id || !subject_id || !period_id) {
      return res.status(400).json({ message: "group_id, subject_id, and period_id are required." });
    }

    if (!mongoose.Types.ObjectId.isValid(group_id) || !mongoose.Types.ObjectId.isValid(subject_id) || !mongoose.Types.ObjectId.isValid(period_id)) {
      return res.status(400).json({ message: "Invalid group_id, subject_id, or period_id." });
    }

    // 1. Buscar sesiones de asistencia filtradas por period_id directamente
    const sessions = await ClassAttendance.find({
      school: schoolId,
      school_year_id: schoolYearId,
      teacher_id: teacherId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      period_id: new mongoose.Types.ObjectId(period_id),
    })
      .populate("records.student_id", "first_name last_name photoUrl")
      .sort({ date: 1 })
      .lean();

    // 3. Formatear sesiones con nombres de alumnos
    const formattedSessions = sessions.map((s) => ({
      _id: s._id,
      date: s.date,
      dateFormatted: formatDate(s.date),
      records: s.records.map((r) => ({
        student_id: r.student_id?._id || r.student_id,
        status: r.status,
        studentName: r.student_id
          ? `${r.student_id.last_name || ""} ${r.student_id.first_name || ""}`.trim()
          : "Desconocido",
        photoUrl: r.student_id?.photoUrl || null,
      })),
      summary: s.summary,
    }));

    // 4. Obtener alumnos activos del grupo
    const groupId = new mongoose.Types.ObjectId(group_id);
    let students = [];

    // Verificar si es grupo taller
    const group = await Group.findById(groupId).select("type").lean();
    const isTaller = group && group.type === "taller";

    if (isTaller) {
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: groupId,
      })
        .select("first_name last_name photoUrl")
        .lean();

      students = tallerStudents.map((s) => ({
        _id: s._id,
        fullName: `${s.last_name || ""} ${s.first_name || ""}`.trim(),
        photoUrl: s.photoUrl || null,
      }));
    } else {
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupId,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("student_id", "first_name last_name photoUrl")
        .lean();

      students = enrollments
        .filter((e) => e.student_id)
        .map((e) => ({
          _id: e.student_id._id,
          fullName: `${e.student_id.last_name || ""} ${e.student_id.first_name || ""}`.trim(),
          photoUrl: e.student_id.photoUrl || null,
        }));
    }

    // Ordenar alumnos por apellido
    students.sort((a, b) => (a.fullName || "").localeCompare(b.fullName || "", "es"));

    res.status(200).json({ sessions: formattedSessions, students });
  } catch (error) {
    console.error("getAttendanceSessions error:", error);
    next(error);
  }
};

// Helper: formatear fecha a "DD/MM/YYYY"
function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// =====================================================================
// POST /api/teacher-subjects/me/attendance-sessions
// Crea una nueva sesión de asistencia con todos los alumnos en "presente".
const createAttendanceSession = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, date, period_id } = req.body;

    if (!group_id || !subject_id || !date) {
      return res.status(400).json({ message: "group_id, subject_id, and date are required." });
    }

    if (!mongoose.Types.ObjectId.isValid(group_id) || !mongoose.Types.ObjectId.isValid(subject_id)) {
      return res.status(400).json({ message: "Invalid group_id or subject_id." });
    }

    if (period_id && !mongoose.Types.ObjectId.isValid(period_id)) {
      return res.status(400).json({ message: "Invalid period_id." });
    }

    // 1. Validar que el teacher tiene TeacherSubject para group+subject
    const assignment = await TeacherSubject.findOne({
      school: schoolId,
      teacher_id: teacherId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      school_year_id: schoolYearId,
    }).lean();

    if (!assignment) {
      return res.status(403).json({ message: "You are not assigned to teach this subject in this group." });
    }

    // 2. Normalizar fecha a midnight
    const attendanceDate = new Date(date);
    attendanceDate.setHours(0, 0, 0, 0);

    // 3. Verificar si ya existe sesión para esta fecha
    const existing = await ClassAttendance.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      teacher_id: teacherId,
      date: attendanceDate,
    }).lean();

    if (existing) {
      return res.status(409).json({ message: "A session already exists for this date. Use PATCH to update." });
    }

    // 4. Obtener alumnos activos del grupo
    const groupId = new mongoose.Types.ObjectId(group_id);
    let studentIds = [];

    const group = await Group.findById(groupId).select("type").lean();
    const isTaller = group && group.type === "taller";

    if (isTaller) {
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: groupId,
      }).select("_id").lean();
      studentIds = tallerStudents.map((s) => s._id);
    } else {
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupId,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      }).select("student_id").lean();
      studentIds = enrollments.map((e) => e.student_id).filter(Boolean);
    }

    if (studentIds.length === 0) {
      return res.status(400).json({ message: "No active students found in this group." });
    }

    // 5. Crear sesión con todos en "presente"
    const records = studentIds.map((sid) => ({
      student_id: sid,
      status: "present",
      location: "in_school",
    }));

    const summary = {
      total: records.length,
      present: records.length,
      retard: 0,
      absent: 0,
      justified: 0,
    };

    const session = await ClassAttendance.create({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: new mongoose.Types.ObjectId(subject_id),
      teacher_id: teacherId,
      period_id: period_id ? new mongoose.Types.ObjectId(period_id) : null,
      date: attendanceDate,
      records,
      summary,
    });

    res.status(201).json({
      session: {
        _id: session._id,
        date: session.date,
        dateFormatted: formatDate(session.date),
        records: session.records,
        summary: session.summary,
      },
    });
  } catch (error) {
    console.error("createAttendanceSession error:", error);
    next(error);
  }
};

// =====================================================================
// PATCH /api/teacher-subjects/me/attendance-sessions/:sessionId/records/:studentId
// Actualiza el status de un alumno en una sesión de asistencia.
const updateAttendanceRecord = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const { sessionId, studentId } = req.params;
    const { status } = req.body;

    const validStatuses = ["present", "retard", "absent", "justified"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${validStatuses.join(", ")}` });
    }

    if (!mongoose.Types.ObjectId.isValid(sessionId) || !mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: "Invalid sessionId or studentId." });
    }

    // 1. Buscar la sesión y verificar que pertenece al teacher
    const session = await ClassAttendance.findOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      school: schoolId,
      teacher_id: teacherId,
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found." });
    }

    // 2. Verificar que el alumno existe en la sesión
    const recordIndex = session.records.findIndex(
      (r) => String(r.student_id) === studentId
    );

    if (recordIndex === -1) {
      return res.status(404).json({ message: "Student not found in this session." });
    }

    // 3. Actualizar status del alumno
    session.records[recordIndex].status = status;
    if (status === "justified" || status === "absent") {
      session.records[recordIndex].location = "absent";
    } else if (status === "present" || status === "retard") {
      session.records[recordIndex].location = "in_school";
    }

    // 4. Recalcular summary
    const counts = { present: 0, retard: 0, absent: 0, justified: 0 };
    for (const record of session.records) {
      counts[record.status] = (counts[record.status] || 0) + 1;
    }
    session.summary = {
      total: session.records.length,
      present: counts.present,
      retard: counts.retard,
      absent: counts.absent,
      justified: counts.justified,
    };

    await session.save();

    res.status(200).json({
      message: "Status updated",
      session: {
        _id: session._id,
        date: session.date,
        dateFormatted: formatDate(session.date),
        records: session.records.map((r) => ({
          student_id: r.student_id,
          status: r.status,
        })),
        summary: session.summary,
      },
    });
  } catch (error) {
    console.error("updateAttendanceRecord error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/grade-config
// Devuelve la configuración de promedio para un grupo+materia+período.
const getGradeConfig = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id } = req.query;

    if (!group_id || !subject_id || !period_id) {
      return res.status(400).json({ message: "group_id, subject_id, and period_id are required." });
    }

    const config = await GradeRule.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      period_id: new mongoose.Types.ObjectId(period_id),
      teacher_id: teacherId,
    }).lean();

    res.status(200).json({ config: config || { averagingRule: "simple" } });
  } catch (error) {
    console.error("getGradeConfig error:", error);
    next(error);
  }
};

// =====================================================================
// PUT /api/teacher-subjects/me/grade-config
// Crea o actualiza la configuración de promedio (simple/weighted).
const upsertGradeConfig = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id, averagingRule } = req.body;

    if (!group_id || !subject_id || !period_id || !averagingRule) {
      return res.status(400).json({ message: "group_id, subject_id, period_id, and averagingRule are required." });
    }

    if (!["simple", "weighted"].includes(averagingRule)) {
      return res.status(400).json({ message: "averagingRule must be 'simple' or 'weighted'." });
    }

    const config = await GradeRule.findOneAndUpdate(
      {
        school: schoolId,
        school_year_id: schoolYearId,
        group_id: new mongoose.Types.ObjectId(group_id),
        subject_id: new mongoose.Types.ObjectId(subject_id),
        period_id: new mongoose.Types.ObjectId(period_id),
        teacher_id: teacherId,
      },
      {
        $set: {
          school: schoolId,
          school_year_id: schoolYearId,
          group_id: new mongoose.Types.ObjectId(group_id),
          subject_id: new mongoose.Types.ObjectId(subject_id),
          period_id: new mongoose.Types.ObjectId(period_id),
          teacher_id: teacherId,
          averagingRule,
        },
      },
      { new: true, upsert: true, runValidators: true }
    );

    res.status(200).json({ config });
  } catch (error) {
    console.error("upsertGradeConfig error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/evaluation-types
// Lista las columnas de evaluación para un grupo+materia+período.
const getEvaluationTypes = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id } = req.query;

    if (!group_id || !subject_id || !period_id) {
      return res.status(400).json({ message: "group_id, subject_id, and period_id are required." });
    }

    const evaluationTypes = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      period_id: new mongoose.Types.ObjectId(period_id),
      teacher_id: teacherId,
    })
      .sort({ order: 1 })
      .lean();

    res.status(200).json({ evaluationTypes });
  } catch (error) {
    console.error("getEvaluationTypes error:", error);
    next(error);
  }
};

// =====================================================================
// POST /api/teacher-subjects/me/evaluation-types
// Crea una columna de evaluación (normal o extra).
const createEvaluationType = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id, name, abbreviation, type, percentage, maxPoints } = req.body;

    if (!group_id || !subject_id || !period_id || !name || !abbreviation || !type) {
      return res.status(400).json({ message: "group_id, subject_id, period_id, name, abbreviation, and type are required." });
    }

    if (!["normal", "extra"].includes(type)) {
      return res.status(400).json({ message: "type must be 'normal' or 'extra'." });
    }

    if (type === "normal" && (percentage === undefined || percentage === null)) {
      return res.status(400).json({ message: "percentage is required for normal evaluations." });
    }

    if (type === "extra" && (maxPoints === undefined || maxPoints === null)) {
      return res.status(400).json({ message: "maxPoints is required for extra evaluations." });
    }

    // Validar teacher assignment
    const assignment = await TeacherSubject.findOne({
      school: schoolId,
      teacher_id: teacherId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      school_year_id: schoolYearId,
    }).lean();

    if (!assignment) {
      return res.status(403).json({ message: "You are not assigned to teach this subject in this group." });
    }

    // Verificar que el trimestre no esté cerrado para este combo.
    if (await isComboClosed(schoolId, schoolYearId, group_id, subject_id, period_id, teacherId)) {
      return res.status(403).json({
        message: "El trimestre está cerrado para este combo. Desbloquea para editar.",
      });
    }

    // Calcular order: siguiente en la secuencia
    const existingCount = await EvaluationType.countDocuments({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      period_id: new mongoose.Types.ObjectId(period_id),
      teacher_id: teacherId,
    });

    const evaluationType = await EvaluationType.create({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: new mongoose.Types.ObjectId(group_id),
      subject_id: new mongoose.Types.ObjectId(subject_id),
      period_id: new mongoose.Types.ObjectId(period_id),
      teacher_id: teacherId,
      name,
      abbreviation: abbreviation.toUpperCase().slice(0, 4),
      type,
      percentage: type === "normal" ? percentage : null,
      maxPoints: type === "extra" ? maxPoints : null,
      order: existingCount,
    });

    res.status(201).json({ evaluationType });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "An evaluation with this abbreviation already exists for this class." });
    }
    console.error("createEvaluationType error:", error);
    next(error);
  }
};

// =====================================================================
// DELETE /api/teacher-subjects/me/evaluation-types/:evaluationTypeId
// Elimina una columna de evaluación y todas sus calificaciones asociadas.
const deleteEvaluationType = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { evaluationTypeId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(evaluationTypeId)) {
      return res.status(400).json({ message: "Invalid evaluationTypeId." });
    }

    // Buscar el evaluation type antes de eliminar para obtener el combo.
    const evaluationType = await EvaluationType.findOne({
      _id: new mongoose.Types.ObjectId(evaluationTypeId),
      school: schoolId,
      teacher_id: teacherId,
    }).lean();

    if (!evaluationType) {
      return res.status(404).json({ message: "Evaluation type not found." });
    }

    // Verificar que el trimestre no esté cerrado para este combo.
    if (await isComboClosed(schoolId, schoolYearId, evaluationType.group_id, evaluationType.subject_id, evaluationType.period_id, teacherId)) {
      return res.status(403).json({
        message: "El trimestre está cerrado para este combo. Desbloquea para editar.",
      });
    }

    // Eliminar el evaluation type.
    await EvaluationType.deleteOne({ _id: evaluationType._id });

    // Eliminar todas las calificaciones asociadas.
    await EvaluationGrade.deleteMany({
      evaluation_type_id: new mongoose.Types.ObjectId(evaluationTypeId),
      school: schoolId,
    });

    res.status(200).json({ message: "Evaluation type and associated grades deleted." });
  } catch (error) {
    console.error("deleteEvaluationType error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/grades
// Devuelve la matriz completa de calificaciones: alumnos × evaluaciones.
const getGrades = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id } = req.query;

    if (!group_id || !subject_id || !period_id) {
      return res.status(400).json({ message: "group_id, subject_id, and period_id are required." });
    }

    const groupIdObj = new mongoose.Types.ObjectId(group_id);
    const subjectIdObj = new mongoose.Types.ObjectId(subject_id);
    const periodIdObj = new mongoose.Types.ObjectId(period_id);

    // 1. Obtener evaluation types
    const evaluationTypes = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      period_id: periodIdObj,
      teacher_id: teacherId,
    })
      .sort({ order: 1 })
      .lean();

    // 2. Obtener alumnos del grupo
    const group = await Group.findById(groupIdObj).select("type").lean();
    const isTaller = group && group.type === "taller";
    let students = [];

    if (isTaller) {
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: groupIdObj,
      })
        .select("first_name last_name")
        .lean();

      // Obtener enrollments para enrollment_id
      const tallerStudentIds = tallerStudents.map((s) => s._id);
      const tallerEnrollments = await Enrollment.find({
        school: schoolId,
        student_id: { $in: tallerStudentIds },
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      }).lean();

      const enrollmentMap = {};
      for (const e of tallerEnrollments) {
        enrollmentMap[String(e.student_id)] = e._id;
      }

      students = tallerStudents.map((s) => ({
        _id: s._id,
        fullName: `${s.last_name || ""} ${s.first_name || ""}`.trim(),
        photoUrl: s.photoUrl || null,
        enrollment_id: enrollmentMap[String(s._id)] || null,
      }));
    } else {
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupIdObj,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("student_id", "first_name last_name photoUrl")
        .lean();

      students = enrollments
        .filter((e) => e.student_id)
        .map((e) => ({
          _id: e.student_id._id,
          fullName: `${e.student_id.last_name || ""} ${e.student_id.first_name || ""}`.trim(),
          photoUrl: e.student_id.photoUrl || null,
          enrollment_id: e._id,
        }));
    }

    students.sort((a, b) => (a.fullName || "").localeCompare(b.fullName || "", "es"));

    // 3. Obtener todas las calificaciones de estos alumnos en estas evaluaciones
    const evaluationTypeIds = evaluationTypes.map((et) => et._id);
    const studentIds = students.map((s) => s._id);

    const grades = await EvaluationGrade.find({
      school: schoolId,
      evaluation_type_id: { $in: evaluationTypeIds },
      student_id: { $in: studentIds },
    }).lean();

    // 4. Construir mapa: studentId -> evaluationTypeId -> value
    const gradesMap = {};
    for (const g of grades) {
      const sid = String(g.student_id);
      const eid = String(g.evaluation_type_id);
      if (!gradesMap[sid]) gradesMap[sid] = {};
      gradesMap[sid][eid] = g.value;
    }

    // 5. Obtener regla de promedio
    const gradeRule = await GradeRule.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      period_id: periodIdObj,
      teacher_id: teacherId,
    }).lean();

    const averagingRule = gradeRule ? gradeRule.averagingRule : "simple";

    // 6. Calcular promedios por alumno
    const averages = {};
    for (const student of students) {
      const sid = String(student._id);
      const studentGrades = gradesMap[sid] || {};

      let totalNormal = 0;
      let totalWeighted = 0;
      let totalPercentage = 0;
      let totalExtra = 0;
      let hasGrades = false;

      for (const et of evaluationTypes) {
        const eid = String(et._id);
        const value = studentGrades[eid];
        if (value === undefined || value === null) continue;
        hasGrades = true;

        if (et.type === "normal") {
          if (averagingRule === "weighted" && et.percentage) {
            totalWeighted += (value * et.percentage) / 100;
            totalPercentage += et.percentage;
          } else {
            totalNormal += value;
          }
        } else if (et.type === "extra") {
          totalExtra += value;
        }
      }

      if (hasGrades) {
        let average;
        if (averagingRule === "weighted" && totalPercentage > 0) {
          average = totalWeighted + totalExtra;
        } else {
          const normalCount = evaluationTypes.filter(
            (et) => et.type === "normal" && studentGrades[String(et._id)] !== undefined
          ).length;
          average = normalCount > 0 ? totalNormal / normalCount + totalExtra : totalExtra;
        }
        averages[sid] = Math.round(Math.min(average, 10) * 100) / 100;
      }
    }

    res.status(200).json({
      students,
      evaluationTypes,
      grades: gradesMap,
      averages,
      averagingRule,
    });
  } catch (error) {
    console.error("getGrades error:", error);
    next(error);
  }
};

// =====================================================================
// POST /api/teacher-subjects/me/grades
// Guarda una calificación (upsert: student + evaluation).
const saveGrade = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { enrollment_id, evaluation_type_id, value, group_id, subject_id, period_id } = req.body;

    if (!enrollment_id || !evaluation_type_id || value === undefined || value === null) {
      return res.status(400).json({ message: "enrollment_id, evaluation_type_id, and value are required." });
    }

    if (!mongoose.Types.ObjectId.isValid(enrollment_id) || !mongoose.Types.ObjectId.isValid(evaluation_type_id)) {
      return res.status(400).json({ message: "Invalid enrollment_id or evaluation_type_id." });
    }

    // 1. Validar evaluation type
    const evaluationType = await EvaluationType.findOne({
      _id: new mongoose.Types.ObjectId(evaluation_type_id),
      school: schoolId,
      teacher_id: teacherId,
    }).lean();

    if (!evaluationType) {
      return res.status(404).json({ message: "Evaluation type not found." });
    }

    // Usar subject_id/group_id/period_id del body o del evaluationType como fallback
    const resolvedGroupId = group_id ? new mongoose.Types.ObjectId(group_id) : evaluationType.group_id;
    const resolvedSubjectId = subject_id ? new mongoose.Types.ObjectId(subject_id) : evaluationType.subject_id;
    const resolvedPeriodId = period_id ? new mongoose.Types.ObjectId(period_id) : evaluationType.period_id;

    // 2. Validar enrollment
    const enrollment = await Enrollment.findOne({
      _id: new mongoose.Types.ObjectId(enrollment_id),
      school: schoolId,
      cycle_status: "enrolled",
    }).lean();

    if (!enrollment) {
      return res.status(404).json({ message: "Enrollment not found or student is not enrolled." });
    }

    // 3. Verificar que el trimestre no esté cerrado para este combo.
    if (await isComboClosed(schoolId, schoolYearId, resolvedGroupId, resolvedSubjectId, resolvedPeriodId, teacherId)) {
      return res.status(403).json({
        message: "El trimestre está cerrado para este combo. Desbloquea para editar.",
      });
    }

    // 4. Validar rango de calificación
    const maxVal = evaluationType.type === "extra" ? (evaluationType.maxPoints || 1) : 10;
    if (typeof value !== "number" || value < 0 || value > maxVal) {
      return res.status(400).json({ message: `Value must be between 0 and ${maxVal}.` });
    }

    // 4. Upsert
    const grade = await EvaluationGrade.findOneAndUpdate(
      {
        school: schoolId,
        evaluation_type_id: new mongoose.Types.ObjectId(evaluation_type_id),
        enrollment_id: new mongoose.Types.ObjectId(enrollment_id),
      },
      {
        $set: {
          school: schoolId,
          school_year_id: schoolYearId,
          evaluation_type_id: new mongoose.Types.ObjectId(evaluation_type_id),
          enrollment_id: new mongoose.Types.ObjectId(enrollment_id),
          student_id: enrollment.student_id,
          value,
          teacher_id: teacherId,
        },
      },
      { new: true, upsert: true, runValidators: true }
    );

    // 5. Recalcular promedio del alumno SOLO para la materia indicada
    const subjectEvalTypes = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: resolvedGroupId,
      subject_id: resolvedSubjectId,
      period_id: resolvedPeriodId,
      teacher_id: teacherId,
    }).lean();

    const subjectEvalTypeIds = subjectEvalTypes.map((et) => et._id);

    const subjectGrades = await EvaluationGrade.find({
      school: schoolId,
      enrollment_id: new mongoose.Types.ObjectId(enrollment_id),
      evaluation_type_id: { $in: subjectEvalTypeIds },
    }).lean();

    const evalTypeMap = {};
    for (const et of subjectEvalTypes) {
      evalTypeMap[String(et._id)] = et;
    }

    // Obtener gradeRule
    const gradeRule = await GradeRule.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: resolvedGroupId,
      subject_id: resolvedSubjectId,
      period_id: resolvedPeriodId,
      teacher_id: teacherId,
    }).lean();

    const averagingRule = gradeRule ? gradeRule.averagingRule : "simple";

    let totalNormal = 0;
    let totalWeighted = 0;
    let totalPercentage = 0;
    let totalExtra = 0;

    for (const g of subjectGrades) {
      const et = evalTypeMap[String(g.evaluation_type_id)];
      if (!et) continue;

      if (et.type === "normal") {
        if (averagingRule === "weighted" && et.percentage) {
          totalWeighted += (g.value * et.percentage) / 100;
          totalPercentage += et.percentage;
        } else {
          totalNormal += g.value;
        }
      } else if (et.type === "extra") {
        totalExtra += g.value;
      }
    }

    let average;
    if (averagingRule === "weighted" && totalPercentage > 0) {
      average = totalWeighted + totalExtra;
    } else {
      const normalCount = subjectGrades.filter((g) => {
        const et = evalTypeMap[String(g.evaluation_type_id)];
        return et && et.type === "normal";
      }).length;
      average = normalCount > 0 ? totalNormal / normalCount + totalExtra : totalExtra;
    }
    average = Math.round(Math.min(average, 10) * 100) / 100;

    res.status(200).json({
      message: "Grade saved",
      grade: { value: grade.value },
      average,
    });
  } catch (error) {
    console.error("saveGrade error:", error);
    next(error);
  }
};

// =====================================================================
// PUT /api/teacher-subjects/me/evaluation-types/:evaluationTypeId
// Actualiza una columna de evaluación (name, abbreviation, percentage).
const updateEvaluationType = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const { evaluationTypeId } = req.params;
    const { name, abbreviation, percentage } = req.body;

    if (!mongoose.Types.ObjectId.isValid(evaluationTypeId)) {
      return res.status(400).json({ message: "Invalid evaluationTypeId." });
    }

    // 1. Buscar la evaluación y verificar que pertenece al teacher
    const evaluationType = await EvaluationType.findOne({
      _id: new mongoose.Types.ObjectId(evaluationTypeId),
      school: schoolId,
      teacher_id: teacherId,
    });

    if (!evaluationType) {
      return res.status(404).json({ message: "Evaluation type not found." });
    }

    // Verificar que el trimestre no esté cerrado para este combo.
    if (await isComboClosed(schoolId, req.schoolYear, evaluationType.group_id, evaluationType.subject_id, evaluationType.period_id, teacherId)) {
      return res.status(403).json({
        message: "El trimestre está cerrado para este combo. Desbloquea para editar.",
      });
    }

    // 2. Construir cambios (solo campos permitidos)
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (abbreviation !== undefined) updates.abbreviation = abbreviation.toUpperCase().slice(0, 4);
    if (percentage !== undefined) {
      if (evaluationType.type === "extra") {
        return res.status(400).json({ message: "Percentage cannot be set for extra evaluations." });
      }
      updates.percentage = percentage;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No valid fields to update. Send name, abbreviation, or percentage." });
    }

    // 3. Aplicar cambios
    Object.assign(evaluationType, updates);
    await evaluationType.save();

    res.status(200).json({
      message: "Evaluation type updated",
      evaluationType,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "An evaluation with this abbreviation already exists for this class." });
    }
    console.error("updateEvaluationType error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/group-students-summary
// Devuelve el resumen de un grupo+materia+período:
// stats del grupo (promedio, en riesgo, asistencia) y
// lista de alumnos con promedio, asistencia, citatorios y tutor.
const getGroupStudentsSummary = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { group_id, subject_id, period_id } = req.query;

    if (!group_id || !subject_id || !period_id) {
      return res.status(400).json({ message: "group_id, subject_id, and period_id are required." });
    }

    if (!mongoose.Types.ObjectId.isValid(group_id) || !mongoose.Types.ObjectId.isValid(subject_id) || !mongoose.Types.ObjectId.isValid(period_id)) {
      return res.status(400).json({ message: "Invalid group_id, subject_id, or period_id." });
    }

    const groupIdObj = new mongoose.Types.ObjectId(group_id);
    const subjectIdObj = new mongoose.Types.ObjectId(subject_id);
    const periodIdObj = new mongoose.Types.ObjectId(period_id);

    // 1. Scope check: verificar que el teacher tiene TeacherSubject para group+subject
    const assignment = await TeacherSubject.findOne({
      school: schoolId,
      teacher_id: teacherId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      school_year_id: schoolYearId,
    }).lean();

    if (!assignment) {
      return res.status(403).json({ message: "You are not assigned to teach this subject in this group." });
    }

    // 2. Obtener info del grupo y materia
    const [groupDoc, subjectDoc, periodDoc] = await Promise.all([
      Group.findById(groupIdObj).select("grade section type").lean(),
      Subject.findById(subjectIdObj).select("name macroCategory").lean(),
      GradingPeriod.findById(periodIdObj).select("name order").lean(),
    ]);

    if (!groupDoc) {
      return res.status(404).json({ message: "Group not found." });
    }

    const isTaller = groupDoc.type === "taller";
    const groupLabel = `${groupDoc.grade}°${groupDoc.section}`;

    // 3. Obtener alumnos del grupo
    let studentsRaw = [];
    if (isTaller) {
      studentsRaw = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: groupIdObj,
      }).select("first_name last_name controlNumber photoUrl guardians").lean();
    } else {
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupIdObj,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .populate("student_id", "first_name last_name controlNumber photoUrl guardians")
        .lean();
      studentsRaw = enrollments.map((e) => e.student_id).filter(Boolean);
    }

    // Ordenar por apellido y deduplicar por student ID
    const seen = new Set();
    studentsRaw = studentsRaw.filter((s) => {
      const sid = String(s._id);
      if (seen.has(sid)) return false;
      seen.add(sid);
      return true;
    });
    studentsRaw.sort((a, b) => (a.last_name || "").localeCompare(b.last_name || "", "es") || (a.first_name || "").localeCompare(b.first_name || "", "es"));

    const studentIds = studentsRaw.map((s) => s._id);

    if (studentIds.length === 0) {
      return res.status(200).json({
        group: {
          _id: groupIdObj,
          label: groupLabel,
          macroCategory: subjectDoc?.macroCategory || null,
          totalStudents: 0,
        },
        period: periodDoc ? { _id: periodDoc._id, name: periodDoc.name } : null,
        stats: { groupAverage: 0, atRiskCount: 0, attendancePercentage: 0 },
        students: [],
      });
    }

    // 4. Obtener evaluation types del grupo+materia+período
    const evaluationTypes = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      period_id: periodIdObj,
      teacher_id: teacherId,
    }).sort({ order: 1 }).lean();

    // 5. Obtener grade rule
    const gradeRule = await GradeRule.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      period_id: periodIdObj,
      teacher_id: teacherId,
    }).lean();
    const averagingRule = gradeRule ? gradeRule.averagingRule : "simple";

    // 6. Obtener todas las calificaciones de estos alumnos en estas evaluaciones
    const evaluationTypeIds = evaluationTypes.map((et) => et._id);
    const allGrades = await EvaluationGrade.find({
      school: schoolId,
      evaluation_type_id: { $in: evaluationTypeIds },
      student_id: { $in: studentIds },
    }).lean();

    // Mapa: studentId -> evaluationTypeId -> value
    const gradesMap = {};
    for (const g of allGrades) {
      const sid = String(g.student_id);
      const eid = String(g.evaluation_type_id);
      if (!gradesMap[sid]) gradesMap[sid] = {};
      gradesMap[sid][eid] = g.value;
    }

    // 7. Calcular promedio por alumno
    const studentAverages = {};
    for (const student of studentsRaw) {
      const sid = String(student._id);
      const studentGrades = gradesMap[sid] || {};

      let totalNormal = 0;
      let totalWeighted = 0;
      let totalPercentage = 0;
      let totalExtra = 0;
      let hasGrades = false;

      for (const et of evaluationTypes) {
        const eid = String(et._id);
        const value = studentGrades[eid];
        if (value === undefined || value === null) continue;
        hasGrades = true;

        if (et.type === "normal") {
          if (averagingRule === "weighted" && et.percentage) {
            totalWeighted += (value * et.percentage) / 100;
            totalPercentage += et.percentage;
          } else {
            totalNormal += value;
          }
        } else if (et.type === "extra") {
          totalExtra += value;
        }
      }

      if (hasGrades) {
        let average;
        if (averagingRule === "weighted" && totalPercentage > 0) {
          average = totalWeighted + totalExtra;
        } else {
          const normalCount = evaluationTypes.filter(
            (et) => et.type === "normal" && studentGrades[String(et._id)] !== undefined
          ).length;
          average = normalCount > 0 ? totalNormal / normalCount + totalExtra : totalExtra;
        }
        studentAverages[sid] = Math.round(Math.min(average, 10) * 100) / 100;
      }
    }

    // 8. Obtener asistencia por alumno (del grupo+materia+período)
    const attendanceSessions = await ClassAttendance.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      teacher_id: teacherId,
      period_id: periodIdObj,
    }).lean();

    const totalSessions = attendanceSessions.length;
    const studentAttendanceMap = {}; // studentId -> { present: N, total: N }
    for (const sid of studentIds) {
      studentAttendanceMap[String(sid)] = { present: 0, total: 0 };
    }

    for (const session of attendanceSessions) {
      for (const record of session.records) {
        const sid = String(record.student_id);
        if (!studentAttendanceMap[sid]) studentAttendanceMap[sid] = { present: 0, total: 0 };
        studentAttendanceMap[sid].total++;
        if (record.status === "present" || record.status === "retard") {
          studentAttendanceMap[sid].present++;
        }
      }
    }

    const studentAttendancePercentages = {};
    for (const sid of studentIds) {
      const att = studentAttendanceMap[String(sid)];
      studentAttendancePercentages[String(sid)] = att && att.total > 0
        ? Math.round((att.present / att.total) * 100)
        : 0;
    }

    // 9. Obtener citatorios por alumno (del ciclo, excluyendo cancelled/expired)
    const citationCounts = {};
    for (const sid of studentIds) {
      citationCounts[String(sid)] = 0;
    }

    const citations = await Citation.find({
      school: schoolId,
      schoolYear: schoolYearId,
      student: { $in: studentIds },
      status: { $nin: ["cancelled", "expired"] },
    }).select("student").lean();

    for (const c of citations) {
      const sid = String(c.student);
      citationCounts[sid] = (citationCounts[sid] || 0) + 1;
    }

    // 10. Obtener tutores de los alumnos
    const allGuardianIds = [];
    for (const student of studentsRaw) {
      if (student.guardians && student.guardians.length > 0) {
        allGuardianIds.push(...student.guardians);
      }
    }

    let guardiansMap = {};
    if (allGuardianIds.length > 0) {
      const guardians = await Guardian.find({
        _id: { $in: allGuardianIds },
        school: schoolId,
      }).select("name lastname relationship phone students").lean();

      // Para cada alumno, tomar el primer tutor
      for (const student of studentsRaw) {
        const studentGuardianIds = (student.guardians || []).map(String);
        const found = guardians.find((g) => studentGuardianIds.includes(String(g._id)));
        if (found) {
          guardiansMap[String(student._id)] = {
            _id: found._id,
            fullName: [found.name, found.lastname].filter(Boolean).join(" "),
            relationship: found.relationship,
            phone: found.phone || null,
          };
        }
      }
    }

    // 11. Construir lista de alumnos formateada
    const students = studentsRaw.map((s) => {
      const sid = String(s._id);
      const firstName = s.first_name || "";
      const lastName = s.last_name || "";
      const initials = `${(lastName.charAt(0) || "").toUpperCase()}${(firstName.charAt(0) || "").toUpperCase()}`;

      return {
        _id: s._id,
        fullName: `${lastName} ${firstName}`.trim(),
        controlNumber: s.controlNumber || null,
        photoUrl: s.photoUrl || null,
        initials,
        average: studentAverages[sid] !== undefined ? studentAverages[sid] : null,
        attendancePercentage: studentAttendancePercentages[sid] || 0,
        citationsCount: citationCounts[sid] || 0,
        guardian: guardiansMap[sid] || null,
      };
    });

    // 12. Calcular stats del grupo
    const averagesList = Object.values(studentAverages);
    const groupAverage = averagesList.length > 0
      ? Math.round((averagesList.reduce((a, b) => a + b, 0) / averagesList.length) * 100) / 100
      : 0;

    const atRiskCount = averagesList.filter((avg) => avg < 7).length;

    const attendancePercentagesList = Object.values(studentAttendancePercentages);
    const attendancePercentage = attendancePercentagesList.length > 0
      ? Math.round(attendancePercentagesList.reduce((a, b) => a + b, 0) / attendancePercentagesList.length)
      : 0;

    res.status(200).json({
      group: {
        _id: groupIdObj,
        label: groupLabel,
        macroCategory: subjectDoc?.macroCategory || null,
        totalStudents: students.length,
      },
      period: periodDoc ? { _id: periodDoc._id, name: periodDoc.name } : null,
      stats: {
        groupAverage,
        atRiskCount,
        attendancePercentage,
      },
      students,
    });
  } catch (error) {
    console.error("getGroupStudentsSummary error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/student-file
// Devuelve el expediente completo de un alumno en una materia:
// datos del alumno, grupo, materia, métricas, calificaciones por
// trimestre, asistencia y ficha pedagógica.
const getStudentFile = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { student_id, group_id, subject_id } = req.query;

    if (!student_id || !group_id || !subject_id) {
      return res.status(400).json({ message: "student_id, group_id, and subject_id are required." });
    }

    if (!mongoose.Types.ObjectId.isValid(student_id) || !mongoose.Types.ObjectId.isValid(group_id) || !mongoose.Types.ObjectId.isValid(subject_id)) {
      return res.status(400).json({ message: "Invalid student_id, group_id, or subject_id." });
    }

    const studentIdObj = new mongoose.Types.ObjectId(student_id);
    const groupIdObj = new mongoose.Types.ObjectId(group_id);
    const subjectIdObj = new mongoose.Types.ObjectId(subject_id);

    // 1. Scope check
    const assignment = await TeacherSubject.findOne({
      school: schoolId,
      teacher_id: teacherId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      school_year_id: schoolYearId,
    }).lean();

    if (!assignment) {
      return res.status(403).json({ message: "You are not assigned to teach this subject in this group." });
    }

    // 2. Obtener alumno, grupo y materia en paralelo
    const [studentDoc, groupDoc, subjectDoc] = await Promise.all([
      Student.findById(studentIdObj).select("first_name last_name controlNumber photoUrl guardians workshop_group_id").lean(),
      Group.findById(groupIdObj).select("grade section").lean(),
      Subject.findById(subjectIdObj).select("name code classificationType").lean(),
    ]);

    if (!studentDoc) {
      return res.status(404).json({ message: "Student not found." });
    }

    const firstName = studentDoc.first_name || "";
    const lastName = studentDoc.last_name || "";
    const initials = `${(lastName.charAt(0) || "").toUpperCase()}${(firstName.charAt(0) || "").toUpperCase()}`;
    const groupLabel = groupDoc ? `${groupDoc.grade}°${groupDoc.section}` : "?";

    // 2b. Obtener tutor/guardian del alumno
    let primaryGuardian = null;
    if (studentDoc.guardians && studentDoc.guardians.length > 0) {
      const guardian = await Guardian.findOne({
        _id: studentDoc.guardians[0],
        school: schoolId,
      }).select("name lastname relationship phone").lean();

      if (guardian) {
        primaryGuardian = {
          _id: guardian._id,
          fullName: [guardian.name, guardian.lastname].filter(Boolean).join(" "),
          relationship: guardian.relationship,
          phone: guardian.phone || null,
        };
      }
    }

    // 3. Obtener todos los períodos del ciclo
    const periods = await GradingPeriod.find({
      school: schoolId,
      school_year_id: schoolYearId,
    }).select("name order startDate endDate").sort({ order: 1 }).lean();

    // 4. Obtener evaluation types de TODOS los períodos para esta materia+grupo
    const allEvaluationTypes = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      teacher_id: teacherId,
    }).sort({ order: 1 }).lean();

    // 5. Obtener todas las calificaciones del alumno en esta materia
    const allGrades = await EvaluationGrade.find({
      school: schoolId,
      student_id: studentIdObj,
    }).lean();

    // Obtener todos los evaluation types para resolver los IDs
    const evalTypeMap = {};
    for (const et of allEvaluationTypes) {
      evalTypeMap[String(et._id)] = et;
    }

    // 6. Obtener grade rules de todos los períodos
    const gradeRules = await GradeRule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupIdObj,
      subject_id: subjectIdObj,
      teacher_id: teacherId,
    }).lean();

    const gradeRuleMap = {};
    for (const rule of gradeRules) {
      gradeRuleMap[String(rule.period_id)] = rule.averagingRule;
    }

    // 7. Construir grades.trimesters
    const trimesterMap = { 1: "T1", 2: "T2", 3: "T3" };
    const trimesters = {};

    for (const period of periods) {
      const periodKey = trimesterMap[period.order] || `T${period.order}`;
      const periodEvals = allEvaluationTypes.filter(
        (et) => String(et.period_id) === String(period._id)
      );

      if (periodEvals.length === 0) {
        trimesters[periodKey] = null;
        continue;
      }

      const averagingRule = gradeRuleMap[String(period._id)] || "simple";
      const periodGrades = {};

      for (const et of periodEvals) {
        const gradeDoc = allGrades.find(
          (g) => String(g.evaluation_type_id) === String(et._id)
        );
        periodGrades[et.abbreviation || et.name] = {
          weight: et.percentage || et.maxPoints || null,
          score: gradeDoc ? gradeDoc.value : null,
          type: et.type,
        };
      }

      // Calcular promedio del período
      let totalNormal = 0;
      let totalWeighted = 0;
      let totalPercentage = 0;
      let totalExtra = 0;
      let hasGrades = false;

      for (const et of periodEvals) {
        const gradeDoc = allGrades.find(
          (g) => String(g.evaluation_type_id) === String(et._id)
        );
        if (!gradeDoc) continue;
        hasGrades = true;

        if (et.type === "normal") {
          if (averagingRule === "weighted" && et.percentage) {
            totalWeighted += (gradeDoc.value * et.percentage) / 100;
            totalPercentage += et.percentage;
          } else {
            totalNormal += gradeDoc.value;
          }
        } else if (et.type === "extra") {
          totalExtra += gradeDoc.value;
        }
      }

      let periodAverage = null;
      if (hasGrades) {
        if (averagingRule === "weighted" && totalPercentage > 0) {
          periodAverage = totalWeighted + totalExtra;
        } else {
          const normalCount = periodEvals.filter((et) => et.type === "normal").length;
          periodAverage = normalCount > 0 ? totalNormal / normalCount + totalExtra : totalExtra;
        }
        periodAverage = Math.round(Math.min(periodAverage, 10) * 100) / 100;
      }

      trimesters[periodKey] = {
        evaluations: periodGrades,
        average: periodAverage,
        averagingRule,
      };
    }

    // Determinar trimestre actual (el más reciente con datos o el último)
    let currentTrimester = null;
    for (const period of periods) {
      const key = trimesterMap[period.order] || `T${period.order}`;
      if (trimesters[key] && trimesters[key].average !== null) {
        currentTrimester = key;
      }
    }
    if (!currentTrimester && periods.length > 0) {
      currentTrimester = trimesterMap[periods[periods.length - 1].order] || `T${periods[periods.length - 1].order}`;
    }

    // 8. Calcular promedio general (todos los períodos)
    const allPeriodAverages = Object.values(trimesters)
      .filter((t) => t && t.average !== null)
      .map((t) => t.average);

    const overallAverage = allPeriodAverages.length > 0
      ? Math.round((allPeriodAverages.reduce((a, b) => a + b, 0) / allPeriodAverages.length) * 100) / 100
      : 0;

    // 9. Obtener asistencia del alumno en esta materia
    // Para materias WORKSHOP (talleres), buscar en el workshop_group_id del alumno
    const isWorkshop = subjectDoc.classificationType === "WORKSHOP";
    const attendanceGroupId = isWorkshop && studentDoc.workshop_group_id
      ? studentDoc.workshop_group_id
      : groupIdObj;

    const attendanceSessions = await ClassAttendance.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: attendanceGroupId,
      subject_id: subjectIdObj,
    }).sort({ date: -1 }).lean();

    const statusMap = {
      present: "presente",
      retard: "retardo",
      absent: "ausente",
      justified: "justificado",
    };

    let totalPresent = 0;
    let totalAbsent = 0;
    const attendance = [];

    for (const session of attendanceSessions) {
      const record = session.records.find(
        (r) => String(r.student_id) === String(studentIdObj)
      );
      if (!record) continue;

      // Determinar trimestre de la sesión
      const sessionDate = new Date(session.date);
      let sessionPeriod = null;
      for (const period of periods) {
        const start = new Date(period.startDate);
        const end = new Date(period.endDate);
        if (sessionDate >= start && sessionDate <= end) {
          sessionPeriod = period;
          break;
        }
      }
      const sessionTrimester = sessionPeriod
        ? (trimesterMap[sessionPeriod.order] || `T${sessionPeriod.order}`)
        : "T?";

      attendance.push({
        date: formatDate(session.date),
        status: statusMap[record.status] || record.status,
        trimester: sessionTrimester,
      });

      if (record.status === "present" || record.status === "retard") {
        totalPresent++;
      } else if (record.status === "absent") {
        totalAbsent++;
      }
    }

    const totalSessions = attendance.length;
    const attendancePercentage = totalSessions > 0
      ? Math.round((totalPresent / totalSessions) * 100)
      : 0;

    // 10. Respuesta (pedagogical por ahora es null)
    res.status(200).json({
      student: {
        _id: studentDoc._id,
        fullName: `${lastName} ${firstName}`.trim(),
        controlNumber: studentDoc.controlNumber || null,
        photoUrl: studentDoc.photoUrl || null,
        initials,
        guardian: primaryGuardian,
      },
      group: {
        _id: groupDoc._id,
        label: groupLabel,
        section: groupDoc.section,
      },
      subject: {
        _id: subjectDoc._id,
        name: subjectDoc.name,
        code: subjectDoc.code,
      },
      metrics: {
        average: overallAverage,
        attendancePercentage,
        absencesCount: totalAbsent,
      },
      grades: {
        currentTrimester,
        trimesters,
      },
      attendance,
      pedagogical: null,
    });
  } catch (error) {
    console.error("getStudentFile error:", error);
    next(error);
  }
};

// =====================================================================
// GET /api/teacher-subjects/me/student-tutoria-file
// Devuelve el expediente de tutoría de un alumno: todas las materias
// del grupo con promedio, actividades y asistencia por materia,
// más reportes de conducta.
const getStudentTutoriaFile = async (req, res, next) => {
  try {
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;
    const { student_id, group_id } = req.query;

    if (!student_id || !group_id) {
      return res.status(400).json({ message: "student_id and group_id are required." });
    }

    if (!mongoose.Types.ObjectId.isValid(student_id) || !mongoose.Types.ObjectId.isValid(group_id)) {
      return res.status(400).json({ message: "Invalid student_id or group_id." });
    }

    const studentIdObj = new mongoose.Types.ObjectId(student_id);
    const groupIdObj = new mongoose.Types.ObjectId(group_id);

    // 1. Scope check: verificar que el teacher tiene TeacherSubject en este grupo
    const teacherAssignments = await TeacherSubject.find({
      school: schoolId,
      teacher_id: teacherId,
      group_id: groupIdObj,
      school_year_id: schoolYearId,
    }).lean();

    if (teacherAssignments.length === 0) {
      return res.status(403).json({ message: "You are not assigned to this group." });
    }

    // 2. Obtener alumno y grupo
    const [studentDoc, groupDoc] = await Promise.all([
      Student.findById(studentIdObj).select("first_name last_name controlNumber photoUrl workshop_group_id").lean(),
      Group.findById(groupIdObj).select("grade section").lean(),
    ]);

    if (!studentDoc) {
      return res.status(404).json({ message: "Student not found." });
    }

    // 2a. Obtener grupo taller del alumno (si tiene)
    const tallerGroupDoc = studentDoc.workshop_group_id
      ? await Group.findById(studentDoc.workshop_group_id).select("grade section").lean()
      : null;

    const firstName = studentDoc.first_name || "";
    const lastName = studentDoc.last_name || "";
    const initials = `${(lastName.charAt(0) || "").toUpperCase()}${(firstName.charAt(0) || "").toUpperCase()}`;
    const groupLabel = groupDoc ? `${groupDoc.grade}°${groupDoc.section}` : "?";

    // 3. Obtener todos los períodos del ciclo
    const periods = await GradingPeriod.find({
      school: schoolId,
      school_year_id: schoolYearId,
    }).select("name order startDate endDate").sort({ order: 1 }).lean();

    const trimesterMap = { 1: "T1", 2: "T2", 3: "T3" };

    // 4. Obtener TODAS las materias del grupo (via TeacherSubject de TODOS los teachers)
    const allGroupAssignments = await TeacherSubject.find({
      school: schoolId,
      group_id: groupIdObj,
      school_year_id: schoolYearId,
    }).lean();

    const subjectIds = [...new Set(allGroupAssignments.map((a) => String(a.subject_id)))];

    const subjectDocs = await Subject.find({
      _id: { $in: subjectIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select("name code").lean();

    const subjectMap = {};
    for (const s of subjectDocs) {
      subjectMap[String(s._id)] = s;
    }

    // 4a. Obtener materia(s) del taller del alumno (si tiene workshop_group_id)
    const tallerSubjectIdsSet = new Set();

    if (studentDoc.workshop_group_id) {
      const tallerAssignments = await TeacherSubject.find({
        school: schoolId,
        group_id: studentDoc.workshop_group_id,
        school_year_id: schoolYearId,
      }).lean();

      for (const a of tallerAssignments) {
        const subId = String(a.subject_id);
        tallerSubjectIdsSet.add(subId);
        if (!subjectIds.includes(subId)) subjectIds.push(subId);
      }

      const tallerSubjectDocs = await Subject.find({
        _id: { $in: [...tallerSubjectIdsSet].map((id) => new mongoose.Types.ObjectId(id)) },
      }).select("name code").lean();

      for (const s of tallerSubjectDocs) {
        subjectMap[String(s._id)] = s;
      }
    }

    // 5. Obtener todas las evaluaciones de estas materias en todos los períodos
    // Incluir el grupo taller del alumno si tiene taller (las evaluaciones de taller viven bajo el grupo taller)
    const allGroupIds = [groupIdObj];
    if (studentDoc.workshop_group_id) {
      allGroupIds.push(new mongoose.Types.ObjectId(studentDoc.workshop_group_id));
    }

    const allEvaluationTypes = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: { $in: allGroupIds },
      subject_id: { $in: subjectIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).sort({ order: 1 }).lean();

    // 6. Obtener todas las calificaciones del alumno en estas materias
    const allGrades = await EvaluationGrade.find({
      school: schoolId,
      student_id: studentIdObj,
    }).lean();

    // 7. Obtener grade rules
    const gradeRules = await GradeRule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: { $in: allGroupIds },
      subject_id: { $in: subjectIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();

    const gradeRuleMap = {};
    for (const rule of gradeRules) {
      const key = `${String(rule.subject_id)}_${String(rule.period_id)}`;
      gradeRuleMap[key] = rule.averagingRule;
    }

    // 8. Obtener TODAS las sesiones de asistencia del grupo (todas las materias, incluyendo taller)
    const attendanceSessions = await ClassAttendance.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: { $in: allGroupIds },
    }).lean();

    // 9. Obtener conducta del alumno en este ciclo
    const conductLogs = await ConductLog.find({
      school: schoolId,
      student_id: studentIdObj,
      school_year_id: schoolYearId,
      status: "active",
    }).select("eventType severity points_impact description incident_date").sort({ incident_date: -1 }).lean();

    // 9a. Obtener avisos exclusivos del alumno (targetType "student")
    const announcements = await Announcement.find({
      school: schoolId,
      schoolYear: schoolYearId,
      targetType: "student",
      targetStudents: studentIdObj,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .select("title message priority sender createdAt expiresAt")
      .populate("sender", "name role")
      .sort({ createdAt: -1 })
      .lean();

    // 9b. Obtener citatorios del alumno (excluyendo cancelados)
    const studentCitations = await Citation.find({
      school: schoolId,
      schoolYear: schoolYearId,
      student: studentIdObj,
      status: { $ne: "cancelled" },
    })
      .select("scheduledDate location type reason status creator createdAt rescheduleRequested")
      .populate("creator", "name role")
      .sort({ scheduledDate: -1 })
      .lean();

    // 10. Construir trimesters
    const trimesters = {};

    for (const period of periods) {
      const periodKey = trimesterMap[period.order] || `T${period.order}`;
      const periodStart = new Date(period.startDate);
      const periodEnd = new Date(period.endDate);

      // 10a. Materias con promedio, actividades y asistencia por materia
      const subjects = [];

      for (const subjectId of subjectIds) {
        const subjectDoc = subjectMap[subjectId];
        if (!subjectDoc) continue;

        const periodEvals = allEvaluationTypes.filter(
          (et) => String(et.subject_id) === subjectId && String(et.period_id) === String(period._id)
        );

        // Incluir materia aunque no tenga evaluaciones (puede tener asistencia)
        const periodSessions = attendanceSessions.filter(
          (s) => String(s.subject_id) === subjectId
        );

        // Calcular promedio del alumno en esta materia+período
        const averagingRule = gradeRuleMap[`${subjectId}_${String(period._id)}`] || "simple";
        let totalNormal = 0;
        let totalWeighted = 0;
        let totalPercentage = 0;
        let totalExtra = 0;
        let hasGrades = false;

        const activities = [];

        for (const et of periodEvals) {
          const gradeDoc = allGrades.find(
            (g) => String(g.evaluation_type_id) === String(et._id)
          );

          activities.push({
            name: et.name || et.abbreviation,
            date: et.createdAt ? formatDate(et.createdAt) : null,
            grade: gradeDoc ? gradeDoc.value : null,
          });

          if (!gradeDoc) continue;
          hasGrades = true;

          if (et.type === "normal") {
            if (averagingRule === "weighted" && et.percentage) {
              totalWeighted += (gradeDoc.value * et.percentage) / 100;
              totalPercentage += et.percentage;
            } else {
              totalNormal += gradeDoc.value;
            }
          } else if (et.type === "extra") {
            totalExtra += gradeDoc.value;
          }
        }

        let subjectAverage = null;
        if (hasGrades) {
          if (averagingRule === "weighted" && totalPercentage > 0) {
            subjectAverage = totalWeighted + totalExtra;
          } else {
            const normalCount = periodEvals.filter((et) => et.type === "normal").length;
            subjectAverage = normalCount > 0 ? totalNormal / normalCount + totalExtra : totalExtra;
          }
          subjectAverage = Math.round(Math.min(subjectAverage, 10) * 100) / 100;
        }

        // Asistencia por materia en este trimestre
        let subPresent = 0;
        let subAbsent = 0;
        let subTardies = 0;
        let subJustified = 0;

        for (const session of periodSessions) {
          const sessionDate = new Date(session.date);
          if (sessionDate < periodStart || sessionDate > periodEnd) continue;

          const record = session.records.find(
            (r) => String(r.student_id) === String(studentIdObj)
          );
          if (!record) continue;

          if (record.status === "present") subPresent++;
          else if (record.status === "absent") subAbsent++;
          else if (record.status === "retard") subTardies++;
          else if (record.status === "justified") subJustified++;
        }

        subjects.push({
          name: subjectDoc.name,
          isTaller: tallerSubjectIdsSet.has(subjectId),
          average: subjectAverage,
          activities,
          attendance: {
            present: subPresent,
            absences: subAbsent,
            tardies: subTardies,
            justified: subJustified,
          },
        });
      }

      // 10b. Asistencia resumida total del trimestre (todas las materias)
      let present = 0;
      let absent = 0;
      let tardies = 0;
      let justified = 0;

      for (const session of attendanceSessions) {
        const sessionDate = new Date(session.date);
        if (sessionDate < periodStart || sessionDate > periodEnd) continue;

        const record = session.records.find(
          (r) => String(r.student_id) === String(studentIdObj)
        );
        if (!record) continue;

        if (record.status === "present") present++;
        else if (record.status === "absent") absent++;
        else if (record.status === "retard") tardies++;
        else if (record.status === "justified") justified++;
      }

      // Solo incluir trimestre si tiene datos
      const hasData = subjects.length > 0 || (present + absent + tardies + justified) > 0;

      // 10d. Asistencia por materia (array dedicado para el front)
      const attendanceBySubject = subjects
        .filter((s) => {
          const a = s.attendance;
          return a && (a.present + a.absences + a.tardies + a.justified) > 0;
        })
        .map((s) => ({
          name: s.name,
          attendance: s.attendance,
        }));

      trimesters[periodKey] = hasData
        ? { subjects, attendanceBySubject, attendance: { present, absences: absent, tardies, justified } }
        : null;
    }

    // 11. Respuesta
    res.status(200).json({
      student: {
        _id: studentDoc._id,
        fullName: `${lastName} ${firstName}`.trim(),
        controlNumber: studentDoc.controlNumber || null,
        photoUrl: studentDoc.photoUrl || null,
        initials,
      },
      group: {
        _id: groupDoc._id,
        label: groupLabel,
        section: groupDoc.section,
      },
      taller: tallerGroupDoc
        ? { _id: tallerGroupDoc._id, name: tallerGroupDoc.section }
        : null,
      announcements,
      citations: studentCitations,
      conduct: conductLogs.map((log) => ({
        _id: log._id,
        date: formatDate(log.incident_date),
        text: log.description || (log.eventType === "merit" ? "Comportamiento destacado" : "Incidencia registrada"),
      })),
      trimesters,
    });
  } catch (error) {
    console.error("getStudentTutoriaFile error:", error);
    next(error);
  }
};

// ---------------------------------------------------------------------
// closeGrades({ group_id, subject_id, period_id })
// ---------------------------------------------------------------------
// POST /api/teacher-subjects/me/grades/close
//
// Cierra el trimestre para un combo grupo+materia+período. Crea un
// registro GradeClosing con la fecha actual. Si ya existía un cierre
// para el mismo combo, retorna el existente (idempotente).
//
// Body requerido: group_id, subject_id, period_id.
// Auth: JWT + role teacher + attachSchoolContext + attachActiveSchoolYear.
//
// Devuelve { success, data: { closedAt }, message? } o
// { success: false, message }.
const closeGrades = async (req, res, next) => {
  try {
    const { group_id: groupId, subject_id: subjectId, period_id: periodId } = req.body;
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Validar campos requeridos
    if (!groupId || !subjectId || !periodId) {
      return res.status(400).json({
        message: "group_id, subject_id and period_id are required.",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(groupId) ||
      !mongoose.Types.ObjectId.isValid(subjectId) ||
      !mongoose.Types.ObjectId.isValid(periodId)
    ) {
      return res.status(400).json({ message: "Invalid ObjectId provided." });
    }

    // 2. Verificar que existan EvaluationTypes para el combo
    const evalTypeCount = await EvaluationType.countDocuments({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: subjectId,
      period_id: periodId,
      teacher_id: teacherId,
    });

    if (evalTypeCount === 0) {
      return res.status(400).json({
        message: "No hay tipos de evaluación definidos para este combo. Crea al menos uno antes de cerrar.",
      });
    }

    // 2b. Verificar que todos los alumnos tengan calificación en todas
    //     las evaluaciones del período. Primero resolvemos la lista de
    //     alumnos según el tipo de grupo (taller vs regular).
    const groupDoc = await Group.findOne({
      _id: groupId,
      school: schoolId,
      school_year_id: schoolYearId,
    }).lean();

    let studentIds = [];
    if (groupDoc && groupDoc.type === "taller") {
      // Para grupos taller, los alumnos pertenecen vía workshop_group_id.
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: groupId,
      })
        .select("_id")
        .lean();
      studentIds = tallerStudents.map((s) => s._id);
    } else {
      // Para grupos regulares, resolvemos vía Enrollment.
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupId,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .select("student_id")
        .lean();
      studentIds = enrollments.map((e) => e.student_id);
    }

    // Obtener los IDs de los tipos de evaluación del combo.
    const evalTypeIds = await EvaluationType.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: subjectId,
      period_id: periodId,
      teacher_id: teacherId,
    })
      .distinct("_id")
      .lean();

    // Contar calificaciones no nulas para este combo.
    const gradedCount = await EvaluationGrade.countDocuments({
      school: schoolId,
      evaluation_type_id: { $in: evalTypeIds },
      student_id: { $in: studentIds },
      value: { $ne: null },
    });

    // El total requerido es alumnos × evaluaciones.
    const totalRequired = studentIds.length * evalTypeIds.length;
    if (totalRequired > 0 && gradedCount < totalRequired) {
      return res.status(400).json({
        message: `Faltan calificaciones por capturar. ${totalRequired - gradedCount} calificaciones pendientes de ${totalRequired} requeridas.`,
      });
    }

    // 3. Buscar cierre existente (idempotente)
    const existingClosing = await GradeClosing.findOne({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: subjectId,
      period_id: periodId,
      teacher_id: teacherId,
    }).lean();

    if (existingClosing) {
      return res.status(200).json({
        message: "El trimestre ya estaba cerrado para este combo.",
        closedAt: existingClosing.closedAt,
      });
    }

    // 4. Crear el cierre
    const closing = await GradeClosing.create({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: subjectId,
      period_id: periodId,
      teacher_id: teacherId,
      closedAt: new Date(),
    });

    res.status(201).json({
      message: "Trimestre cerrado exitosamente.",
      closedAt: closing.closedAt,
    });
  } catch (error) {
    next(error);
  }
};

// openGrades({ group_id, subject_id, period_id })
// ---------------------------------------------------------------------
// POST /api/teacher-subjects/me/grades/open
//
// Desbloquea el trimestre para un combo grupo+materia+período. Elimina
// el registro GradeClosing existente, permitiendo que el docente vuelva
// a revisar y editar calificaciones.
//
// Body requerido: group_id, subject_id, period_id.
// Auth: JWT + role teacher + attachSchoolContext + attachActiveSchoolYear.
//
// Devuelve { success, message } o { success: false, message }.
const openGrades = async (req, res, next) => {
  try {
    const { group_id: groupId, subject_id: subjectId, period_id: periodId } = req.body;
    const teacherId = req.payload._id;
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    // 1. Validar campos requeridos
    if (!groupId || !subjectId || !periodId) {
      return res.status(400).json({
        message: "group_id, subject_id and period_id are required.",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(groupId) ||
      !mongoose.Types.ObjectId.isValid(subjectId) ||
      !mongoose.Types.ObjectId.isValid(periodId)
    ) {
      return res.status(400).json({ message: "Invalid ObjectId provided." });
    }

    // 2. Buscar y eliminar el cierre existente
    const result = await GradeClosing.findOneAndDelete({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: groupId,
      subject_id: subjectId,
      period_id: periodId,
      teacher_id: teacherId,
    });

    if (!result) {
      return res.status(404).json({
        message: "No se encontró un cierre para este combo.",
      });
    }

    res.status(200).json({
      message: "Trimestre desbloqueado exitosamente.",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllTeacherSubjects,
  createTeacherSubject,
  deleteTeacherSubject,
  getTeacherDashboard,
  getGroupStudents,
  saveAttendance,
  getMyGroups,
  getTeacherSchedule,
  getTeacherAttendanceSummary,
  getMyGroupsWithSchedule,
  getGradingPeriods,
  getAttendanceSessions,
  createAttendanceSession,
  updateAttendanceRecord,
  getGradeConfig,
  upsertGradeConfig,
  getEvaluationTypes,
  createEvaluationType,
  deleteEvaluationType,
  updateEvaluationType,
  getGroupStudentsSummary,
  getStudentFile,
  getStudentTutoriaFile,
  getGrades,
  saveGrade,
  closeGrades,
  openGrades,
};
