// Controlador de Announcements (Avisos)
// CRUD staff para el recurso Announcement. El tutor CONSUME los avisos vía
// el feed unificado `GET /api/guardians/me/announcements` (en
// guardians.controller.js); este controller es la cara de ESCRITURA del
// recurso.
//
// Multi-tenant estricto: cada query filtra por la escuela del usuario.
// super_admin puede operar cross-tenant (debe especificar `school` en el
// body al crear).
//
// Reglas de alcance (validadas en este controller, no en el modelo — la DB
// solo persiste el resultado, como dice el comentario del modelo):
//   - admin / principal / registrar / super_admin  → alcance completo
//   - prefect / social_worker                       → alcance completo
//   - teacher                                       → alcance limitado:
//     solo puede avisar a grupos donde tiene un TeacherSubject activo en
//     el schoolYear del aviso, o a estudiantes inscritos en esos grupos.
const mongoose = require("mongoose");
const Announcement = require("../models/Announcement.model");
const Student = require("../models/Student.model");
const Group = require("../models/Group.model");
const SchoolYear = require("../models/SchoolYear.model");
const School = require("../models/School.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const Enrollment = require("../models/Enrollment.model");
const notificationService = require("../services/notification.service");

const tenantFilter = (req) =>
  req.payload.role === "super_admin"
    ? {}
    : { school: req.payload.schoolId };

// Roles que pueden crear / editar avisos. La validación fina del alcance
// del teacher se hace en `validateTeacherScope`.
const REPORTER_ROLES = [
  "admin",
  "principal",
  "registrar",
  "teacher",
  "prefect",
  "social_worker",
  "super_admin",
];

// Roles con poder de editar/borrar avisos AJENOS. Los demás roles (teacher,
// prefect, social_worker) solo pueden editar/borrar los avisos que ELLOS
// publicaron (sender === req.payload._id).
const ADMIN_ROLES = ["admin", "principal", "registrar", "super_admin"];

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

// Valida que el teacher solo apunte a grupos que efectivamente enseña en
// el ciclo escolar del aviso. Devuelve { valid, message?, teacherGroupIds }.
const validateTeacherScope = async (
  teacherId,
  schoolId,
  schoolYearId,
  targetType,
  targetGroups,
  targetStudents
) => {
  // 1) Grupos del teacher en este ciclo (vía TeacherSubject).
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

  if (targetType === "general") {
    return { valid: true, teacherGroupIds };
  }

  if (targetType === "group") {
    const invalid = (targetGroups || []).filter(
      (g) => !teacherGroupIds.has(String(g))
    );
    if (invalid.length > 0) {
      return {
        valid: false,
        message: `You can only target groups you teach. Out-of-scope group ids: ${invalid.join(", ")}.`,
      };
    }
    return { valid: true, teacherGroupIds };
  }

  if (targetType === "student") {
    if (!Array.isArray(targetStudents) || targetStudents.length === 0) {
      return { valid: true, teacherGroupIds };
    }
    // Para cada student, buscamos su Enrollment del ciclo y validamos que
    // su group_id esté en el set del teacher.
    const enrollments = await Enrollment.find({
      student_id: { $in: targetStudents },
      school: schoolId,
      school_year_id: schoolYearId,
    })
      .select("student_id group_id")
      .lean();
    const studentToGroup = new Map();
    for (const e of enrollments) {
      studentToGroup.set(String(e.student_id), String(e.group_id));
    }
    const invalid = [];
    const noEnrollment = [];
    for (const sid of targetStudents) {
      const gid = studentToGroup.get(String(sid));
      if (!gid) {
        noEnrollment.push(String(sid));
        continue;
      }
      if (!teacherGroupIds.has(gid)) {
        invalid.push(String(sid));
      }
    }
    if (noEnrollment.length > 0) {
      return {
        valid: false,
        message: `Some students have no enrollment in this school year: ${noEnrollment.join(", ")}.`,
      };
    }
    if (invalid.length > 0) {
      return {
        valid: false,
        message: `You can only target students in groups you teach. Out-of-scope student ids: ${invalid.join(", ")}.`,
      };
    }
    return { valid: true, teacherGroupIds };
  }

  return { valid: false, message: `Invalid targetType: ${targetType}.` };
};

// Helper: normaliza un array de ObjectId-ish a string[]. Filtra entradas
// inválidas devolviendo { validIds, invalid }.
const normalizeIdArray = (arr) => {
  const validIds = [];
  const invalid = [];
  if (!Array.isArray(arr)) return { validIds, invalid };
  for (const v of arr) {
    if (mongoose.Types.ObjectId.isValid(v)) validIds.push(String(v));
    else invalid.push(v);
  }
  return { validIds, invalid };
};

// Helper: popula los campos estándar del announcement para devolver en la
// respuesta (sender, targetGroups, targetStudents, schoolYear).
const populateAnnouncement = (query) =>
  query
    .populate("sender", "name last_name role")
    .populate("targetGroups", "grade section shift school_year_id")
    .populate("targetStudents", "first_name last_name photoUrl")
    .populate("schoolYear", "name startDate endDate isActive");

// =====================================================================
// POST /api/announcements
// Crea un aviso. Body:
//   {
//     title:            string (required)
//     message:          string (required)
//     priority:         "informative" | "urgent"        (default "informative")
//     targetType:       "general" | "group" | "student" (required)
//     targetGroups:     [ObjectId]   (required si targetType === "group")
//     targetStudents:   [ObjectId]   (required si targetType === "student")
//     schoolYear:       ObjectId     (default al ciclo activo)
//     school:           ObjectId     (solo super_admin; default su JWT schoolId)
//     expiresAt:        ISO date     (opcional; null = sin vencimiento)
//   }
const createAnnouncement = async (req, res, next) => {
  try {
    const isSuperAdmin = req.payload.role === "super_admin";
    const {
      title,
      message,
      priority,
      targetType,
      targetGroups,
      targetStudents,
      schoolYear,
      expiresAt,
    } = req.body;

    // 1) School: del body si super_admin, sino del JWT.
    const school = isSuperAdmin ? req.body.school : req.payload.schoolId;
    if (!school) {
      return res.status(400).json({ message: "school is required." });
    }
    if (!mongoose.Types.ObjectId.isValid(school)) {
      return res.status(400).json({ message: "Invalid school id." });
    }

    // 2) SchoolYear: del body o del activo de la escuela.
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

    // 3) Validaciones de campos básicos.
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "title is required." });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "message is required." });
    }
    if (
      priority !== undefined &&
      !["informative", "urgent"].includes(priority)
    ) {
      return res
        .status(400)
        .json({ message: 'priority must be "informative" or "urgent".' });
    }
    if (!["general", "group", "student"].includes(targetType)) {
      return res.status(400).json({
        message: 'targetType must be "general", "group" or "student".',
      });
    }

    // 4) Normalizar y validar los arrays según targetType.
    let normGroups = { validIds: [], invalid: [] };
    let normStudents = { validIds: [], invalid: [] };
    if (targetType === "group") {
      normGroups = normalizeIdArray(targetGroups);
      if (normGroups.invalid.length > 0) {
        return res.status(400).json({
          message: `Invalid targetGroup ids: ${normGroups.invalid.join(", ")}.`,
        });
      }
      if (normGroups.validIds.length === 0) {
        return res.status(400).json({
          message: "targetGroups must be a non-empty array when targetType is 'group'.",
        });
      }
    }
    if (targetType === "student") {
      normStudents = normalizeIdArray(targetStudents);
      if (normStudents.invalid.length > 0) {
        return res.status(400).json({
          message: `Invalid targetStudent ids: ${normStudents.invalid.join(", ")}.`,
        });
      }
      if (normStudents.validIds.length === 0) {
        return res.status(400).json({
          message: "targetStudents must be a non-empty array when targetType is 'student'.",
        });
      }
    }

    // 5) Validar que los targets existan y pertenezcan a la misma escuela
    //    (anti cross-tenant leak).
    if (targetType === "group" && normGroups.validIds.length > 0) {
      const found = await Group.find({
        _id: { $in: normGroups.validIds },
        school,
      })
        .select("_id")
        .lean();
      if (found.length !== normGroups.validIds.length) {
        return res.status(400).json({
          message:
            "Some targetGroups do not exist or belong to a different school.",
        });
      }
    }
    if (targetType === "student" && normStudents.validIds.length > 0) {
      const found = await Student.find({
        _id: { $in: normStudents.validIds },
        school,
      })
        .select("_id")
        .lean();
      if (found.length !== normStudents.validIds.length) {
        return res.status(400).json({
          message:
            "Some targetStudents do not exist or belong to a different school.",
        });
      }
    }

    // 6) Validar el alcance del teacher (si aplica).
    if (req.payload.role === "teacher") {
      const scopeCheck = await validateTeacherScope(
        req.payload._id,
        school,
        schoolYearId,
        targetType,
        normGroups.validIds,
        normStudents.validIds
      );
      if (!scopeCheck.valid) {
        return res.status(403).json({ message: scopeCheck.message });
      }
    }

    // 7) Crear el doc.
    const announcement = await Announcement.create({
      school,
      schoolYear: schoolYearId,
      sender: req.payload._id,
      title: String(title).trim(),
      message: String(message).trim(),
      priority: priority || "informative",
      targetType,
      targetGroups: targetType === "group" ? normGroups.validIds : [],
      targetStudents: targetType === "student" ? normStudents.validIds : [],
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    // 8) Devolver con populate.
    const populated = await populateAnnouncement(
      Announcement.findById(announcement._id)
    ).lean();

    // 9) Disparar push a los tutores afectados (async, mismo patrón que
    //    citations y attendance). Solo si Firebase está inicializado;
    //    la función lo maneja internamente y devuelve { dispatched: 0, reason }.
    //    Además, si el aviso es GENERAL, notifica también al staff de la
    //    escuela (campanita + push; el autor queda excluido). Los avisos
    //    a grupo/alumno no disparan push a staff (solo feed).
    process.nextTick(() => {
      (async () => {
        try {
          const result = await notificationService.sendAnnouncementNotification(
            populated
          );
          if (result && result.dispatched > 0) {
            console.log(
              `[announcements] Push notifications dispatched for ${populated._id} (${result.dispatched}/${result.tokens || 0} tokens)`
            );
          } else {
            console.log(
              `[announcements] No push notifications dispatched for ${populated._id}: ${
                result && result.reason ? result.reason : "unknown"
              }`
            );
          }
        } catch (err) {
          console.error(
            `[announcements] Background notification error for ${populated._id}: ${err.message}`
          );
        }

        try {
          const staffResult =
            await notificationService.sendStaffAnnouncementNotification(
              populated
            );
          if (staffResult && staffResult.persisted > 0) {
            console.log(
              `[announcements] Staff notification for ${populated._id}: persisted=${staffResult.persisted} dispatched=${staffResult.dispatched}/${staffResult.tokens || 0} tokens`
            );
          } else if (
            staffResult &&
            staffResult.reason &&
            staffResult.reason !== "not_general"
          ) {
            console.log(
              `[announcements] No staff notification for ${populated._id}: ${staffResult.reason}`
            );
          }
        } catch (err) {
          console.error(
            `[announcements] Staff notification error for ${populated._id}: ${err.message}`
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
// GET /api/announcements
// Lista paginada. Staff únicamente. Filtros:
//   - targetType       ("general" | "group" | "student")
//   - priority         ("informative" | "urgent")
//   - sender           (ObjectId de User)
//   - schoolYear       (ObjectId; default = ciclo activo)
//   - from, to         (rango sobre createdAt)
//   - includeExpired   ("true" para incluir vencidos; default "false")
//   - page, limit      (limit max 100)
const getAllAnnouncements = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      targetType,
      priority,
      sender,
      schoolYear,
      from,
      to,
      includeExpired = "false",
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter = { ...tenantFilter(req) };

    if (targetType) {
      if (!["general", "group", "student"].includes(targetType)) {
        return res.status(400).json({
          message: 'targetType must be "general", "group" or "student".',
        });
      }
      filter.targetType = targetType;
    }
    if (priority) {
      if (!["informative", "urgent"].includes(priority)) {
        return res
          .status(400)
          .json({ message: 'priority must be "informative" or "urgent".' });
      }
      filter.priority = priority;
    }
    if (sender && mongoose.Types.ObjectId.isValid(sender)) {
      filter.sender = sender;
    }
    if (schoolYear && mongoose.Types.ObjectId.isValid(schoolYear)) {
      filter.schoolYear = schoolYear;
    } else if (req.payload.schoolId) {
      // Default al ciclo activo de la escuela del caller.
      const activeSY = await resolveActiveSchoolYear(req.payload.schoolId);
      if (activeSY) filter.schoolYear = activeSY;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "from is not a valid date." });
        }
        filter.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "to is not a valid date." });
        }
        filter.createdAt.$lte = d;
      }
    }
    if (includeExpired !== "true") {
      // Excluir vencidos por default.
      filter.$or = [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } },
      ];
    }

    const [items, total] = await Promise.all([
      populateAnnouncement(Announcement.find(filter))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Announcement.countDocuments(filter),
    ]);

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
// GET /api/announcements/:id
// Detalle de un aviso. Staff únicamente.
const getAnnouncementById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    const announcement = await populateAnnouncement(
      Announcement.findOne({ _id: id, ...tenantFilter(req) })
    ).lean();

    if (!announcement) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    res.status(200).json(announcement);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PUT /api/announcements/:id
// Edita un aviso. Solo el sender original o un admin/principal/registrar
// pueden editar. Body parcial con los mismos campos que create.
const updateAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    const existing = await Announcement.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    const isSender = String(existing.sender) === String(req.payload._id);
    const isAdmin = ADMIN_ROLES.includes(req.payload.role);
    if (!isSender && !isAdmin) {
      return res.status(403).json({
        message: "Only the sender or admin can update this announcement.",
      });
    }

    // Whitelist de campos editables. NO permitimos cambiar `school` ni
    // `schoolYear` ni `sender` (son inmutables post-creación).
    const allowed = [
      "title",
      "message",
      "priority",
      "targetType",
      "targetGroups",
      "targetStudents",
      "expiresAt",
    ];
    const update = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    }

    // Si cambia el alcance, normalizar y re-validar.
    const newTargetType = update.targetType || existing.targetType;
    let newTargetGroups =
      update.targetGroups !== undefined
        ? update.targetGroups
        : existing.targetGroups;
    let newTargetStudents =
      update.targetStudents !== undefined
        ? update.targetStudents
        : existing.targetStudents;

    if (
      update.targetType !== undefined ||
      update.targetGroups !== undefined ||
      update.targetStudents !== undefined
    ) {
      // Normalizar ObjectIds.
      if (newTargetType === "group") {
        const norm = normalizeIdArray(newTargetGroups);
        if (norm.invalid.length > 0) {
          return res.status(400).json({
            message: `Invalid targetGroup ids: ${norm.invalid.join(", ")}.`,
          });
        }
        if (norm.validIds.length === 0) {
          return res.status(400).json({
            message:
              "targetGroups must be a non-empty array when targetType is 'group'.",
          });
        }
        newTargetGroups = norm.validIds;
        // Validar que existan y sean de la misma escuela.
        const found = await Group.find({
          _id: { $in: newTargetGroups },
          school: existing.school,
        })
          .select("_id")
          .lean();
        if (found.length !== newTargetGroups.length) {
          return res.status(400).json({
            message:
              "Some targetGroups do not exist or belong to a different school.",
          });
        }
      } else {
        newTargetGroups = [];
      }
      if (newTargetType === "student") {
        const norm = normalizeIdArray(newTargetStudents);
        if (norm.invalid.length > 0) {
          return res.status(400).json({
            message: `Invalid targetStudent ids: ${norm.invalid.join(", ")}.`,
          });
        }
        if (norm.validIds.length === 0) {
          return res.status(400).json({
            message:
              "targetStudents must be a non-empty array when targetType is 'student'.",
          });
        }
        newTargetStudents = norm.validIds;
        const found = await Student.find({
          _id: { $in: newTargetStudents },
          school: existing.school,
        })
          .select("_id")
          .lean();
        if (found.length !== newTargetStudents.length) {
          return res.status(400).json({
            message:
              "Some targetStudents do not exist or belong to a different school.",
          });
        }
      } else {
        newTargetStudents = [];
      }

      // Re-validar el alcance del teacher (si el caller es teacher).
      if (req.payload.role === "teacher") {
        const scopeCheck = await validateTeacherScope(
          req.payload._id,
          existing.school,
          existing.schoolYear,
          newTargetType,
          newTargetType === "group" ? newTargetGroups : [],
          newTargetType === "student" ? newTargetStudents : []
        );
        if (!scopeCheck.valid) {
          return res.status(403).json({ message: scopeCheck.message });
        }
      }
    }

    // Aplicar cambios. El pre("validate") del modelo re-valida la
    // coherencia targetType ↔ arrays.
    if (update.title !== undefined) existing.title = String(update.title).trim();
    if (update.message !== undefined) existing.message = String(update.message).trim();
    if (update.priority !== undefined) existing.priority = update.priority;
    if (update.targetType !== undefined) existing.targetType = newTargetType;
    if (update.targetGroups !== undefined || update.targetType !== undefined) {
      existing.targetGroups = newTargetType === "group" ? newTargetGroups : [];
    }
    if (update.targetStudents !== undefined || update.targetType !== undefined) {
      existing.targetStudents = newTargetType === "student" ? newTargetStudents : [];
    }
    if (update.expiresAt !== undefined) {
      existing.expiresAt = update.expiresAt ? new Date(update.expiresAt) : null;
    }
    await existing.save();

    const populated = await populateAnnouncement(
      Announcement.findById(existing._id)
    ).lean();
    res.status(200).json(populated);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// DELETE /api/announcements/:id
// Borrado físico. Solo el sender original o un admin/principal/registrar
// pueden borrar. Los tutores NO pueden borrar (ni siquiera los suyos
// porque no los crean — son consumers).
const deleteAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    const existing = await Announcement.findOne({
      _id: id,
      ...tenantFilter(req),
    });
    if (!existing) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    const isSender = String(existing.sender) === String(req.payload._id);
    const isAdmin = ADMIN_ROLES.includes(req.payload.role);
    if (!isSender && !isAdmin) {
      return res.status(403).json({
        message: "Only the sender or admin can delete this announcement.",
      });
    }

    await existing.deleteOne();
    res.status(200).json({ message: "Announcement deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// GET /api/announcements/me
// Devuelve los avisos relevantes para el maestro logueado:
//   - tab="mine"       → avisos que él publicó (sender = yo)
//   - tab="general"    → avisos generales de la escuela (targetType = "general")
//   - sin tab / otro   → ambos combinados (mis publicaciones + generales)
// Filtros opcionales: priority, from, to, page, limit.
const getMyAnnouncements = async (req, res, next) => {
  try {
    const {
      tab,
      priority,
      from,
      to,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Ciclo activo de la escuela.
    let schoolYearFilter = {};
    if (req.payload.schoolId) {
      const activeSY = await resolveActiveSchoolYear(req.payload.schoolId);
      if (activeSY) schoolYearFilter = { schoolYear: activeSY };
    }

    const baseFilter = {
      ...tenantFilter(req),
      ...schoolYearFilter,
      // Excluir vencidos por default.
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    };

    if (priority) {
      if (!["informative", "urgent"].includes(priority)) {
        return res
          .status(400)
          .json({ message: 'priority must be "informative" or "urgent".' });
      }
      baseFilter.priority = priority;
    }

    if (from || to) {
      baseFilter.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "from is not a valid date." });
        }
        baseFilter.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: "to is not a valid date." });
        }
        baseFilter.createdAt.$lte = d;
      }
    }

    // Construir filtro según el tab.
    let filter;
    const validTabs = ["mine", "general"];
    const resolvedTab = validTabs.includes(tab) ? tab : null;

    if (resolvedTab === "mine") {
      filter = { ...baseFilter, sender: req.payload._id };
    } else if (resolvedTab === "general") {
      filter = { ...baseFilter, targetType: "general" };
    } else {
      // Ambos: mis publicaciones + generales.
      filter = {
        ...baseFilter,
        $or: [
          { sender: req.payload._id },
          { targetType: "general" },
        ],
      };
    }

    const [items, total] = await Promise.all([
      populateAnnouncement(Announcement.find(filter))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Announcement.countDocuments(filter),
    ]);

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
  createAnnouncement,
  getAllAnnouncements,
  getAnnouncementById,
  updateAnnouncement,
  deleteAnnouncement,
  getMyAnnouncements,
  REPORTER_ROLES,
  ADMIN_ROLES,
};
