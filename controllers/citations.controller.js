// Controlador de Citation (Citatorio)
// CRUD staff para citatorios formales (reunión obligatoria con un
// padre/tutor sobre un alumno). El tutor CONSUME los citatorios vía el
// feed unificado `GET /api/guardians/me/announcements` (mezclados con los
// avisos); este controller es la cara de ESCRITURA del recurso.
//
// Multi-tenant estricto: cada query filtra por la escuela del usuario.
// super_admin puede operar cross-tenant (debe especificar `school` en el
// body al crear).
//
// Reglas de alcance (validadas en este controller, no en el modelo — la
// DB solo persiste el resultado, como dice el comentario del modelo):
//   - admin / principal / registrar / super_admin  → alcance completo
//   - prefect / social_worker                       → alcance completo
//   - teacher                                       → alcance limitado:
//     solo puede citar a alumnos inscritos en grupos donde tiene un
//     TeacherSubject activo en el schoolYear del citatorio.
//
// Restricciones de negocio (validadas acá, NO en el modelo):
//   - El student DEBE tener al menos un Guardian asociado (sin tutor no
//     se puede citar) → 409 si no tiene.
//   - `scheduledDate` no puede ser en el pasado, salvo para roles
//     administrativos (admin/principal/registrar/super_admin) que
//     podrían necesitar citatorios retroactivos.
const mongoose = require("mongoose");
const Citation = require("../models/Citation.model");
const Student = require("../models/Student.model");
const School = require("../models/School.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const Enrollment = require("../models/Enrollment.model");
const Guardian = require("../models/Guardian.model");
const Subject = require("../models/Subject.model");
const notificationService = require("../services/notification.service");
// Offset escuela↔UTC para normalizar el `scheduledDate` entrante
// (ver parseScheduledDate — convención: instante UTC real desde 2026-10-14).
const { getSchoolOffsetMinutes } = require("../utils/school-time");

// ---------------------------------------------------------------------
// parseScheduledDate(raw) → Date | null
// Convierte el `scheduledDate` entrante a un instante UTC REAL.
//
// Convención FINAL (migración 2026-10-14): `scheduledDate` es instante
// UTC real (cita "10:00" hora escolar → `16:00Z` con offset -360). Con
// eso, todas las comparaciones contra el reloj real (cron de no-show,
// badge VENCIDO del front, filtros from/to) son correctas sin trucos.
//
// El backend acepta los TRES formatos para no romper nada durante el
// rollout de la APK (las builds viejas siguen instaladas en los teléfonos):
//
//   1. Naïve "2026-10-15T10:00[:ss]"  → hora pared escolar. Es lo que
//      manda la app NUEVA. Misma conversión que (2).
//   2. Con "Z" "2026-10-15T10:00:00.000Z" → formato LEGACY de builds
//      viejas: la hora elegida forzada a UTC (`Date.UTC` en la app).
//      Se trata como hora pared escolar y se convierte (se loguea para
//      poder medir cuántas builds viejas quedan activas).
//   3. Con offset explícito "…T10:00:00-06:00" → ISO genuina, instante
//      real tal cual (no manda nadie hoy, pero es lo semanticamente
//      correcto si algún integrador la envía).
//
// Los componentes se parsean a mano (patrón de adms.controller#
// parseDeviceTime) — NUNCA `new Date("naïve")`, que depende del TZ del
// proceso y rompería si alguien corre el server con otro TZ.
// Devuelve null si el string no se puede parsear (el controller responde
// 400 con el mismo mensaje de siempre).
const parseScheduledDate = (raw) => {
  const str = String(raw || "").trim();
  if (!str) return null;

  // (3) Offset explícito ≠ "Z": ISO real, interpretar tal cual.
  if (/[+-]\d{2}:\d{2}$/.test(str)) {
    const parsed = new Date(str);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // (1) Naïve o (2) legacy "Z": hora pared escolar → instante real.
  const isLegacyZ = str.endsWith("Z");
  const core = isLegacyZ ? str.slice(0, -1) : str;
  const m = core.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wallUtc = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0));
  // real = pared − offset (offset=-360 → pared + 6h).
  const real = new Date(wallUtc - getSchoolOffsetMinutes() * 60000);
  if (isLegacyZ) {
    console.log(
      `[citations] scheduledDate legacy (Z) convertido: ${str} → ${real.toISOString()} (build vieja de la APK o integrador)`
    );
  }
  return real;
};

const tenantFilter = (req) =>
  req.payload.role === "super_admin"
    ? {}
    : { school: req.payload.schoolId };

// Roles que pueden crear / editar citatorios. La validación fina del
// alcance del teacher se hace en `validateTeacherScopeForStudent`.
const REPORTER_ROLES = [
  "admin",
  "principal",
  "registrar",
  "teacher",
  "prefect",
  "social_worker",
  "super_admin",
];

const ADMIN_ROLES = ["admin", "principal", "registrar", "super_admin"];

const STAFF_ROLES = [
  "admin",
  "principal",
  "registrar",
  "teacher",
  "prefect",
  "social_worker",
  "super_admin",
];

// Resuelve el ciclo escolar activo de una escuela. Devuelve null si no
// hay uno configurado (el caller debe responder 409 en ese caso).
const resolveActiveSchoolYear = async (schoolId) => {
  if (!schoolId) return null;
  const school = await School.findById(schoolId)
    .select("current_school_year_id")
    .lean();
  if (!school || !school.current_school_year_id) return null;
  return String(school.current_school_year_id);
};

// Valida que el teacher pueda citar al student: el student debe estar
// inscrito en un grupo donde el teacher tiene TeacherSubject activo en
// el schoolYear del citatorio.
const validateTeacherScopeForStudent = async (
  teacherId,
  schoolId,
  schoolYearId,
  studentId
) => {
  // 1) Grupos del teacher en este ciclo.
  const teacherSubjects = await TeacherSubject.find({
    teacher_id: teacherId,
    school: schoolId,
    school_year_id: schoolYearId,
  })
    .select("group_id")
    .lean();
  const teacherGroupIds = new Set(
    teacherSubjects.map((ts) => String(ts.group_id))
  );
  if (teacherGroupIds.size === 0) {
    return {
      valid: false,
      message: "You have no group assignments in this school year.",
    };
  }

  // 2) Enrollment del student en este ciclo (source of truth del grupo).
  const enrollment = await Enrollment.findOne({
    student_id: studentId,
    school: schoolId,
    school_year_id: schoolYearId,
  })
    .select("group_id")
    .lean();
  if (!enrollment) {
    return {
      valid: false,
      message: "Student has no enrollment in this school year.",
    };
  }
  if (!teacherGroupIds.has(String(enrollment.group_id))) {
    return {
      valid: false,
      message: "You can only cite students in groups you teach.",
    };
  }
  return { valid: true };
};

// Helper: popula los campos estándar del citatorio para devolver en la
// respuesta (student, creator, schoolYear).
const populateCitation = (query) =>
  query
    .populate("student", "first_name last_name photoUrl controlNumber")
    .populate("creator", "name last_name role")
    .populate("schoolYear", "name startDate endDate isActive")
    .populate("subject", "code name");

// Helper: enriquece un array de citatorios con groupName buscando la
// Enrollment del student en el schoolYear del citatorio.
const enrichWithGroupName = async (citations) => {
  if (!citations || citations.length === 0) return citations;

  // Recopilar pares (studentId, schoolYearId) únicos.
  const pairs = [];
  for (const c of citations) {
    const studentId = String(c.student?._id || c.student);
    const schoolYearId = String(c.schoolYear?._id || c.schoolYear);
    if (studentId && schoolYearId) {
      pairs.push({ studentId, schoolYearId });
    }
  }

  if (pairs.length === 0) return citations;

  // Buscar enrollments en una sola query.
  const enrollments = await Enrollment.find({
    $or: pairs.map(({ studentId, schoolYearId }) => ({
      student_id: studentId,
      school_year_id: schoolYearId,
    })),
  })
    .populate("group_id", "grade section")
    .lean();

  // Mapa: "studentId-schoolYearId" → groupName
  const groupMap = new Map();
  for (const e of enrollments) {
    const key = `${String(e.student_id)}-${String(e.school_year_id)}`;
    if (e.group_id) {
      groupMap.set(key, `${e.group_id.grade}°${e.group_id.section}`);
    }
  }

  // Asignar groupName a cada citatorio.
  for (const c of citations) {
    const studentId = String(c.student?._id || c.student);
    const schoolYearId = String(c.schoolYear?._id || c.schoolYear);
    const key = `${studentId}-${schoolYearId}`;
    c.groupName = groupMap.get(key) || null;
  }

  return citations;
};

// =====================================================================
// POST /api/citations
// Crea un citatorio. Body:
//   {
//     student:       ObjectId (required)
//     scheduledDate: ISO date (required)
//     type:          "academic" | "behavioral" | "administrative" (required)
//     location:      string, max 200 chars (required)
//     reason:        string, max 1000 chars (required)
//     subject:       ObjectId (optional, ref a Subject)
//     schoolYear:    ObjectId (default al ciclo activo)
//     school:        ObjectId (solo super_admin; default su JWT schoolId)
//   }
const createCitation = async (req, res, next) => {
  try {
    const isSuperAdmin = req.payload.role === "super_admin";
    const {
      student: studentId,
      scheduledDate,
      type,
      reason,
      schoolYear,
      location,
      subject: subjectId,
    } = req.body;

    // 1) School.
    const school = isSuperAdmin ? req.body.school : req.payload.schoolId;
    if (!school) {
      return res.status(400).json({ message: "school is required." });
    }
    if (!mongoose.Types.ObjectId.isValid(school)) {
      return res.status(400).json({ message: "Invalid school id." });
    }

    // 2) Validar student: debe existir y pertenecer a la misma escuela.
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: "Valid student is required." });
    }
    const student = await Student.findOne({ _id: studentId, school })
      .select("_id first_name last_name")
      .lean();
    if (!student) {
      return res
        .status(404)
        .json({ message: "Student not found in this school." });
    }

    // 3) El student debe tener al menos un Guardian (sin tutor no se
    //    puede citar) — regla de negocio del comentario del modelo.
    const guardianCount = await Guardian.countDocuments({
      students: studentId,
      school,
    });
    if (guardianCount === 0) {
      return res.status(409).json({
        message:
          "Student has no guardians registered. Cannot create a citation without a tutor.",
      });
    }

    // 4) SchoolYear.
    let schoolYearId = schoolYear;
    if (!schoolYearId) {
      schoolYearId = await resolveActiveSchoolYear(school);
      if (!schoolYearId) {
        return res.status(409).json({
          message: "No active school year configured for this school.",
        });
      }
    }
    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res.status(400).json({ message: "Invalid schoolYear." });
    }

    // 5) Validar scheduledDate (instante UTC real — ver parseScheduledDate:
    //    acepta formato naïve nuevo y legacy "Z" de builds viejas de la APK).
    if (!scheduledDate) {
      return res.status(400).json({ message: "scheduledDate is required." });
    }
    const scheduledDateObj = parseScheduledDate(scheduledDate);
    if (!scheduledDateObj) {
      return res
        .status(400)
        .json({ message: "scheduledDate is not a valid ISO date." });
    }
    // No se rechaza `scheduledDate` en el pasado. El acceso a este endpoint
    // ya está restringido a REPORTER_ROLES vía el router, así que cualquier
    // staff puede crear citatorios con cualquier fecha — útil para
    // documentar reuniones que ya pasaron (e.g. el staff olvidó crearlo
    // en el momento, o el padre se presentó sin cita previa).
    // El feed del tutor (`/me/announcements`) sigue filtrando por status
    // pending/confirmed, así que un citatorio con fecha muy vieja no satura
    // el feed a menos que siga activo.

    // 6) Validar type.
    if (!["academic", "behavioral", "administrative"].includes(type)) {
      return res.status(400).json({
        message:
          'type must be "academic", "behavioral" or "administrative".',
      });
    }

    // 6b) Validar que el rol pueda crear este tipo de citatorio.
    const roleTypeRestrictions = {
      prefect: ["behavioral", "administrative"],
    };
    const allowedTypesForRole = roleTypeRestrictions[req.payload.role];
    if (allowedTypesForRole && !allowedTypesForRole.includes(type)) {
      return res.status(403).json({
        message: `El rol "${req.payload.role}" no puede crear citatorios de tipo "${type}".`,
      });
    }

    // 7) Validar reason.
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: "reason is required." });
    }
    const reasonTrim = String(reason).trim();
    if (reasonTrim.length > 1000) {
      return res
        .status(400)
        .json({ message: "reason must be at most 1000 characters." });
    }

    // 7b) Validar location.
    if (!location || !String(location).trim()) {
      return res.status(400).json({ message: "location is required." });
    }
    const locationTrim = String(location).trim();
    if (locationTrim.length > 200) {
      return res
        .status(400)
        .json({ message: "location must be at most 200 characters." });
    }

    // 7c) Validar subject (opcional). Si se envía, debe existir y pertenecer a la escuela.
    let subjectObjectId = null;
    if (subjectId) {
      if (!mongoose.Types.ObjectId.isValid(subjectId)) {
        return res.status(400).json({ message: "Invalid subject id." });
      }
      const subject = await Subject.findOne({ _id: subjectId, school })
        .select("_id")
        .lean();
      if (!subject) {
        return res
          .status(404)
          .json({ message: "Subject not found in this school." });
      }
      subjectObjectId = subject._id;
    }

    // 8) Validar el alcance del teacher (si aplica).
    if (req.payload.role === "teacher") {
      const scopeCheck = await validateTeacherScopeForStudent(
        req.payload._id,
        school,
        schoolYearId,
        studentId
      );
      if (!scopeCheck.valid) {
        return res.status(403).json({ message: scopeCheck.message });
      }
    }

    // 9) Crear el doc.
    const citation = await Citation.create({
      school,
      schoolYear: schoolYearId,
      student: studentId,
      creator: req.payload._id,
      scheduledDate: scheduledDateObj,
      type,
      location: locationTrim,
      reason: reasonTrim,
      subject: subjectObjectId,
      status: "pending",
    });

    // 10) Devolver con populate.
    const populated = await populateCitation(
      Citation.findById(citation._id)
    ).lean();

    // 11) Disparar push a los tutores del student (async, después del 201).
    //     El device obtiene una respuesta rápida; las notificaciones se
    //     procesan en background vía process.nextTick (mismo patrón que
    //     attendance.controller.js).
    process.nextTick(() => {
      (async () => {
        try {
          const result = await notificationService.sendCitationNotification(
            populated
          );
          if (result && result.dispatched > 0) {
            console.log(
              `[citations] Push notifications dispatched for citation ${populated._id} (${result.dispatched}/${result.tokens || 0})`
            );
          } else {
            console.log(
              `[citations] No push notifications dispatched for citation ${populated._id}: ${
                result && result.reason ? result.reason : "unknown"
              }`
            );
          }
        } catch (err) {
          console.error(
            `[citations] Background notification error for citation ${populated._id}: ${err.message}`
          );
        }
      })();
    });

    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// GET /api/citations
// Lista paginada. Staff únicamente. Filtros:
//   - status      ("pending" | "confirmed" | "completed" | "no_show")
//   - type        ("academic" | "behavioral" | "administrative")
//   - student     (ObjectId)
//   - creator     (ObjectId)
//   - schoolYear  (ObjectId; default = ciclo activo)
//   - from, to    (rango sobre scheduledDate)
//   - page, limit (limit max 100)
const getAllCitations = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      type,
      student,
      creator,
      schoolYear,
      from,
      to,
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter = { ...tenantFilter(req) };

    if (status) {
      if (!["pending", "confirmed", "completed", "no_show", "cancelled"].includes(status)) {
        return res.status(400).json({
          message:
            'status must be "pending", "confirmed", "completed", "no_show" or "cancelled".',
        });
      }
      filter.status = status;
    }
    if (type) {
      if (!["academic", "behavioral", "administrative"].includes(type)) {
        return res.status(400).json({
          message:
            'type must be "academic", "behavioral" or "administrative".',
        });
      }
      filter.type = type;
    }
    if (student && mongoose.Types.ObjectId.isValid(student)) {
      filter.student = student;
    }
    if (creator && mongoose.Types.ObjectId.isValid(creator)) {
      filter.creator = creator;
    }
    if (schoolYear && mongoose.Types.ObjectId.isValid(schoolYear)) {
      filter.schoolYear = schoolYear;
    } else if (req.payload.schoolId) {
      const activeSY = await resolveActiveSchoolYear(req.payload.schoolId);
      if (activeSY) filter.schoolYear = activeSY;
    }
    if (from || to) {
      filter.scheduledDate = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "from is not a valid date." });
        }
        filter.scheduledDate.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "to is not a valid date." });
        }
        filter.scheduledDate.$lte = d;
      }
    }

    const [items, total] = await Promise.all([
      populateCitation(Citation.find(filter))
        .lean()
        .sort({ scheduledDate: -1 })
        .skip(skip)
        .limit(limitNum),
      Citation.countDocuments(filter),
    ]);

    await enrichWithGroupName(items);

    res.status(200).json({
      items,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum) || 1,
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// GET /api/citations/:id
// Detalle de un citatorio. Staff únicamente.
const getCitationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    const citation = await populateCitation(
      Citation.findOne({ _id: id, ...tenantFilter(req) })
    ).lean();

    if (!citation) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    await enrichWithGroupName([citation]);

    res.status(200).json(citation);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PATCH /api/citations/:id/status
// Cambia el status del citatorio. Body: { status: "pending" | "confirmed" | "completed" | "no_show" | "cancelled" }
//
// Transiciones válidas:
//   pending    → confirmed | completed | no_show | cancelled
//   confirmed  → completed | no_show | cancelled
//   expired    → completed | reschedule (via endpoint separado)
//   completed  → (terminal, no se puede cambiar)
//   no_show    → (terminal, no se puede cambiar)
//   cancelled  → (terminal, no se puede cambiar)
//
// Staff puede hacer cualquier transición válida. El tutor usa otro
// endpoint para `pending → confirmed` desde la app móvil.
const updateCitationStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    if (!["pending", "confirmed", "completed", "no_show", "cancelled", "expired"].includes(status)) {
      return res.status(400).json({
        message:
          'status must be "pending", "confirmed", "completed", "no_show", "cancelled" or "expired".',
      });
    }

    const existing = await Citation.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    const validTransitions = {
      pending: ["confirmed", "completed", "no_show", "cancelled"],
      confirmed: ["completed", "no_show", "cancelled"],
      expired: ["completed"],
      completed: [],
      no_show: [],
      cancelled: [],
    };

    if (!validTransitions[existing.status].includes(status)) {
      return res.status(409).json({
        message: `Invalid status transition: ${existing.status} → ${status}.`,
      });
    }

    existing.status = status;
    await existing.save();

    const populated = await populateCitation(
      Citation.findById(existing._id)
    ).lean();
    res.status(200).json(populated);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// DELETE /api/citations/:id
// Borrado físico. Solo super_admin (auditoría). El flujo normal es
// cambiar el status a completed/no_show; el borrado es de emergencia.
const deleteCitation = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    const existing = await Citation.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    await existing.deleteOne();
    res.status(200).json({ message: "Citation deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PATCH /api/citations/:id/reschedule
// Reagenda un citatorio. Body: { scheduledDate, location? }
//
// Transiciones válidas: pending → pending | confirmed → pending
// Solo el creator o admin pueden reagendar. Teacher solo puede reagendar
// sus propios citatorios. Resetea rescheduleRequested a false.
const rescheduleCitation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scheduledDate, location } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    // Solo pending o confirmed pueden reagendar
    const existing = await Citation.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    if (!["pending", "confirmed"].includes(existing.status)) {
      return res.status(409).json({
        message: `Cannot reschedule citation in status "${existing.status}". Only "pending" or "confirmed" citations can be rescheduled.`,
      });
    }

    // Teacher solo puede reagendar sus propios citatorios
    if (req.payload.role === "teacher" && String(existing.creator) !== String(req.payload._id)) {
      return res.status(403).json({
        message: "You can only reschedule citations you created.",
      });
    }

    // Validar scheduledDate (instante UTC real — ver parseScheduledDate)
    if (!scheduledDate) {
      return res.status(400).json({ message: "scheduledDate is required." });
    }
    const scheduledDateObj = parseScheduledDate(scheduledDate);
    if (!scheduledDateObj) {
      return res
        .status(400)
        .json({ message: "scheduledDate is not a valid ISO date." });
    }

    // Validar location si se envía
    let locationTrim = existing.location;
    if (location !== undefined) {
      if (!location || !String(location).trim()) {
        return res.status(400).json({ message: "location cannot be empty." });
      }
      locationTrim = String(location).trim();
      if (locationTrim.length > 200) {
        return res
          .status(400)
          .json({ message: "location must be at most 200 characters." });
      }
    }

    existing.scheduledDate = scheduledDateObj;
    existing.location = locationTrim;
    existing.status = "pending";
    existing.rescheduleRequested = false;
    existing.rescheduleReason = null;
    await existing.save();

    const populated = await populateCitation(
      Citation.findById(existing._id)
    ).lean();

    // Notificar al tutor sobre la reagendación (async)
    process.nextTick(() => {
      (async () => {
        try {
          const result = await notificationService.sendCitationRescheduledNotification(populated);
          if (result && result.dispatched > 0) {
            console.log(
              `[citations] Reschedule notification dispatched for citation ${populated._id} (${result.dispatched}/${result.tokens || 0})`
            );
          }
        } catch (err) {
          console.error(
            `[citations] Background reschedule notification error for citation ${populated._id}: ${err.message}`
          );
        }
      })();
    });

    res.status(200).json(populated);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PUT /api/citations/:id
// Actualiza campos de un citatorio. Body: { reason?, location?, type?, subject? }
//
// Solo el creator o admin pueden editar. Teacher solo puede editar
// sus propios citatorios. No permite cambiar scheduledDate, student, creator.
// Solo pending o confirmed pueden editarse.
const updateCitation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason, location, type, subject: subjectId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    const existing = await Citation.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    // Solo pending o confirmed pueden editarse
    if (!["pending", "confirmed"].includes(existing.status)) {
      return res.status(409).json({
        message: `Cannot edit citation in status "${existing.status}". Only "pending" or "confirmed" citations can be edited.`,
      });
    }

    // Teacher solo puede editar sus propios citatorios
    if (req.payload.role === "teacher" && String(existing.creator) !== String(req.payload._id)) {
      return res.status(403).json({
        message: "You can only edit citations you created.",
      });
    }

    // Validar reason si se envía
    if (reason !== undefined) {
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ message: "reason cannot be empty." });
      }
      const reasonTrim = String(reason).trim();
      if (reasonTrim.length > 1000) {
        return res
          .status(400)
          .json({ message: "reason must be at most 1000 characters." });
      }
      existing.reason = reasonTrim;
    }

    // Validar location si se envía
    if (location !== undefined) {
      if (!location || !String(location).trim()) {
        return res.status(400).json({ message: "location cannot be empty." });
      }
      const locationTrim = String(location).trim();
      if (locationTrim.length > 200) {
        return res
          .status(400)
          .json({ message: "location must be at most 200 characters." });
      }
      existing.location = locationTrim;
    }

    // Validar type si se envía
    if (type !== undefined) {
      if (!["academic", "behavioral", "administrative"].includes(type)) {
        return res.status(400).json({
          message:
            'type must be "academic", "behavioral" or "administrative".',
        });
      }
      existing.type = type;
    }

    // Validar subject si se envía (opcional, puede ser null para quitar)
    if (subjectId !== undefined) {
      if (subjectId === null) {
        existing.subject = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(subjectId)) {
          return res.status(400).json({ message: "Invalid subject id." });
        }
        const subject = await Subject.findOne({ _id: subjectId, school: existing.school })
          .select("_id")
          .lean();
        if (!subject) {
          return res
            .status(404)
            .json({ message: "Subject not found in this school." });
        }
        existing.subject = subject._id;
      }
    }

    await existing.save();

    const populated = await populateCitation(
      Citation.findById(existing._id)
    ).lean();
    res.status(200).json(populated);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PATCH /api/citations/:id/cancel
// Cancela un citatorio. Body: { reason? }
//
// Solo el creator o admin pueden cancelar. Teacher solo puede cancelar
// sus propios citatorios. Solo pending o confirmed pueden cancelarse.
// Resetea rescheduleRequested a false.
const cancelCitation = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    const existing = await Citation.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    // Solo pending o confirmed pueden cancelarse
    if (!["pending", "confirmed"].includes(existing.status)) {
      return res.status(409).json({
        message: `Cannot cancel citation in status "${existing.status}". Only "pending" or "confirmed" citations can be cancelled.`,
      });
    }

    // Teacher solo puede cancelar sus propios citatorios
    if (req.payload.role === "teacher" && String(existing.creator) !== String(req.payload._id)) {
      return res.status(403).json({
        message: "You can only cancel citations you created.",
      });
    }

    existing.status = "cancelled";
    existing.rescheduleRequested = false;
    existing.rescheduleReason = null;
    await existing.save();

    const populated = await populateCitation(
      Citation.findById(existing._id)
    ).lean();

    // Notificar al tutor sobre la cancelación (async)
    process.nextTick(() => {
      (async () => {
        try {
          const result = await notificationService.sendCitationCancelledNotification(populated);
          if (result && result.dispatched > 0) {
            console.log(
              `[citations] Cancel notification dispatched for citation ${populated._id} (${result.dispatched}/${result.tokens || 0})`
            );
          }
        } catch (err) {
          console.error(
            `[citations] Background cancel notification error for citation ${populated._id}: ${err.message}`
          );
        }
      })();
    });

    res.status(200).json({
      message: "Citation cancelled successfully.",
      citation: populated,
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// GET /api/citations/me
// Devuelve los citatorios creados por el maestro logueado.
// Filtros opcionales: status, type, student, from, to, page, limit.
const getMyCitations = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      type,
      student,
      from,
      to,
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Ciclo activo de la escuela.
    const filter = {
      creator: req.payload._id,
      ...tenantFilter(req),
    };

    if (req.payload.schoolId) {
      const activeSY = await resolveActiveSchoolYear(req.payload.schoolId);
      if (activeSY) filter.schoolYear = activeSY;
    }

    if (status) {
      if (!["pending", "confirmed", "completed", "no_show", "cancelled"].includes(status)) {
        return res.status(400).json({
          message:
            'status must be "pending", "confirmed", "completed", "no_show" or "cancelled".',
        });
      }
      filter.status = status;
    }
    if (type) {
      if (!["academic", "behavioral", "administrative"].includes(type)) {
        return res.status(400).json({
          message:
            'type must be "academic", "behavioral" or "administrative".',
        });
      }
      filter.type = type;
    }
    if (student && mongoose.Types.ObjectId.isValid(student)) {
      filter.student = student;
    }
    if (from || to) {
      filter.scheduledDate = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "from is not a valid date." });
        }
        filter.scheduledDate.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "to is not a valid date." });
        }
         filter.scheduledDate.$lte = d;
       }
     }

     const [items, total] = await Promise.all([
       populateCitation(Citation.find(filter))
         .lean()
         .sort({ scheduledDate: -1 })
         .skip(skip)
         .limit(limitNum),
       Citation.countDocuments(filter),
     ]);

     await enrichWithGroupName(items);

     res.status(200).json({
       items,
       total,
       page: pageNum,
       limit: limitNum,
       pages: Math.ceil(total / limitNum) || 1,
     });
   } catch (error) {
     next(error);
   }
 };

 module.exports = {
  createCitation,
  getAllCitations,
  getCitationById,
  updateCitationStatus,
  deleteCitation,
  getMyCitations,
  rescheduleCitation,
  updateCitation,
  cancelCitation,
  // Exportado solo para pruebas unitarias (formato legacy vs nuevo).
  parseScheduledDate,
  REPORTER_ROLES,
  ADMIN_ROLES,
  STAFF_ROLES,
};
