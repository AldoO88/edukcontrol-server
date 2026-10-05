// Controlador de Guardian (Tutor)
// CRUD sobre la colección de tutores/guardianes. Tenant-scoped.
// El propio tutor puede consultar/editar su perfil; admin/registrar puede
// gestionar cualquier tutor de su escuela.
const mongoose = require("mongoose");
const Guardian = require("../models/Guardian.model");
const User = require("../models/User.model");
const Student = require("../models/Student.model");
const School = require("../models/School.model");
const Grade = require("../models/Grade.model");
const Enrollment = require("../models/Enrollment.model");
const AttendanceLog = require("../models/AttendanceLog.model");
const ConductLog = require("../models/ConductLog.model");
const Announcement = require("../models/Announcement.model");
const Citation = require("../models/Citation.model");
const ClassSchedule = require("../models/ClassSchedule.model");
const SchoolShift = require("../models/SchoolShift.model");
const Subject = require("../models/Subject.model");
const cache = require("../services/cache.service");
const notificationService = require("../services/notification.service");
const { ensureTutorUser } = require("../services/tutor-account.service");
const {
  getConductConfig,
  clampScore,
} = require("../services/conduct.service");

const DASHBOARD_TTL = parseInt(process.env.CACHE_TTL_DASHBOARD || "300", 10); // esta linea de codigo es para que el tiempo de vida del cache sea configurable via variable de entorno, con un valor por defecto de 300 segundos (5 minutos) si no se especifica.

const tenantFilter = (req) =>
  req.payload.role === "super_admin"
    ? {}
    : { school: req.payload.schoolId };

const ADMIN_LIKE_ROLES = ["admin", "registrar", "super_admin"];

// School para queries de enrollments (filtros de la pantalla Padres y
// stats por ciclo): usa la del JWT si existe (admin de escuela —
// siempre tenant-safe). Si es `null` (super_admin, que navega
// cross-tenant y el front SIEMPRE está dentro de una escuela/ciclo),
// deriva el `school` del SchoolYear indicado.
const schoolForYear = async (db, payloadSchoolId, yearOid) => {
  if (payloadSchoolId) return payloadSchoolId;
  if (!yearOid) return null;
  const year = await db
    .collection("schoolyears")
    .findOne({ _id: yearOid }, { projection: { school: 1 } });
  return year?.school || null;
};

// Helper: valida que cada studentId exista, pertenezca a la misma escuela
// y (opcional) esté activo. Devuelve los docs o lanza error.
// Cascada de User.isActive según el estado de los Guardian del mismo
// tutor. Regla: un tutor tiene `User.isActive=false` ⇔ NO tiene
// NINGÚN Guardian activo (isActive !== false). Así un tutor dado de
// baja en TODAS sus tutorías no puede entrar al dashboard / app.
//
// Si tiene ≥1 Guardian activo, su cuenta se mantiene (o se reactiva) a
// `User.isActive=true`. Esto sincroniza ambos lados sin que el admin
// tenga que tocar la cuenta User manualmente.
const syncUserActiveFromGuardians = async (userId) => {
  if (!userId) return;
  const activeCount = await Guardian.countDocuments({
    user_id: userId,
    isActive: { $ne: false },
  });
  const shouldBeActive = activeCount > 0;
  await User.updateOne(
    { _id: userId },
    { $set: { isActive: shouldBeActive } }
  );
};

const validateStudentIds = async (studentIds, school) => {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return [];
  const validIds = studentIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (validIds.length !== studentIds.length) {
    throw new Error("All student_ids must be valid ObjectIds.");
  }
  const students = await Student.find({
    _id: { $in: validIds },
    school,
  }).select("_id");
  if (students.length !== validIds.length) {
    throw new Error(
      "Some student_ids do not exist or belong to a different school."
    );
  }
  return validIds;
};

// GET /api/guardians
// Listar tutores. Filtros opcionales: user_id, student_id, search
// (regex por nombre/phone), phone (exacto 10 dígitos, usa el índice
// único {school, phone} — recomendado para auto-detección en el form
// de alta de alumno).
const getAllGuardians = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      user_id,
      student_id,
      search,
      phone,
      status,
      no_students,
      group_id,
      taller_id,
      school_year_id,
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const filter = { ...tenantFilter(req) };
    if (user_id && mongoose.Types.ObjectId.isValid(user_id)) {
      filter.user_id = user_id;
    }
    if (student_id && mongoose.Types.ObjectId.isValid(student_id)) {
      filter.students = student_id;
    }
    // Búsqueda exacta por teléfono (índice {school, phone}). Más
    // precisa que el regex `search` cuando el form tiene 10 dígitos.
    if (phone && /^\d{10}$/.test(String(phone).trim())) {
      filter.phone = String(phone).trim();
    } else if (search) {
      const safe = String(search).trim();
      const regex = new RegExp(
        safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      filter.$or = [{ name: regex }, { lastname: regex }, { phone: regex }];
    }
    // status=active|inactive|all (default: all)
    if (status === "active") {
      filter.isActive = { $ne: false };
    } else if (status === "inactive") {
      filter.isActive = false;
    }
    // no_students=1 filtra los tutores sin alumnos vinculados
    // (huérfanos tras un import sin teléfono o un desvincular masivo).
    if (String(no_students) === "1") {
      filter.$and = [
        { $or: [{ students: { $size: 0 } }, { students: { $exists: false } }] },
      ];
    }

    // Filtros por grupo/taller (pantalla Padres): resuelven el ciclo
    // (param `school_year_id` o el `current_school_year_id` del School
    // del tenant), luego derivan los `student_id`s que corresponden.
    // El set se intersecta si vienen ambos (tutor con al menos un hijo
    // en ese grupo Y en ese taller).
    const wantsGroup = group_id && mongoose.Types.ObjectId.isValid(String(group_id));
    const wantsTaller = taller_id && mongoose.Types.ObjectId.isValid(String(taller_id));
    if (wantsGroup || wantsTaller) {
      const db = mongoose.connection.db;
      // Resolver school_year_id para el filtro de enrollment (el taller
      // vive en `Student.workshop_group_id` y no depende del ciclo).
      let yearOid = null;
      if (school_year_id && mongoose.Types.ObjectId.isValid(String(school_year_id))) {
        yearOid = new mongoose.Types.ObjectId(String(school_year_id));
      } else if (req.payload.schoolId) {
        const school = await db.collection("schools").findOne(
          { _id: req.payload.schoolId },
          { projection: { current_school_year_id: 1 } }
        );
        yearOid = school?.current_school_year_id || null;
      }

      const idsByGroup = new Set();
      const idsByTaller = new Set();

      if (wantsGroup && yearOid) {
        const groupOid = new mongoose.Types.ObjectId(String(group_id));
        const enrollmentSchool = await schoolForYear(
          db,
          req.payload.schoolId,
          yearOid
        );
        const studentIds = enrollmentSchool
          ? await db.collection("enrollments").distinct("student_id", {
              school: enrollmentSchool,
              school_year_id: yearOid,
              group_id: groupOid,
              cycle_status: "enrolled",
            })
          : [];
        studentIds.forEach((id) => idsByGroup.add(String(id)));
      }
      if (wantsTaller) {
        const tallerOid = new mongoose.Types.ObjectId(String(taller_id));
        const studentIds = await db.collection("students").distinct("_id", {
          ...tenantFilter(req),
          workshop_group_id: tallerOid,
        });
        studentIds.forEach((id) => idsByTaller.add(String(id)));
      }

      let finalIds;
      if (wantsGroup && wantsTaller) {
        finalIds = [...idsByGroup].filter((id) => idsByTaller.has(id));
      } else if (wantsGroup) {
        finalIds = [...idsByGroup];
      } else {
        finalIds = [...idsByTaller];
      }
      // Si el set derivado está vacío (grupo sin matriculados / taller
      // sin alumnos), respondemos vacío sin reintentar el filtro.
      if (finalIds.length === 0) {
        return res.status(200).json({ items: [], total: 0, page: pageNum, limit: limitNum, pages: 0 });
      }
      filter.students = { $in: finalIds };
    }

    const skip = (pageNum - 1) * limitNum;
    const [items, total] = await Promise.all([
      Guardian.find(filter)
        .populate("user_id", "name email role isActive")
        .populate("students", "controlNumber first_name last_name")
        .sort({ name: 1 })
        .skip(skip)
        .limit(limitNum),
      Guardian.countDocuments(filter),
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

// GET /api/guardians/stats
// Devuelve métricas del módulo de tutores para la pantalla "Padres".
// Pensado para una sola request por carga (4 cifras en una pasada).
// Acepta `?school_year_id=<oid>` opcional para resolver el ciclo de
// `con_hijos_en_ciclo` (lo manda el front, que siempre navega dentro
// de una escuela/ciclo — necesario para super_admin, sin schoolId).
//
// Cifras (todas tenant-scoped):
//   total                — todos los Guardian de la escuela
//   activos              — con isActive !== false (null/missing cuentan
//                          como activos — coincide con backfill
//                          backfill-guardian-active.js)
//   dados_de_baja        — isActive === false
//   con_hijos_en_ciclo   — con ≥1 Student que tenga Enrollment con
//                          cycle_status "enrolled" en el ciclo activo
//                          de la escuela
//   sin_alumnos          — students[] vacío o ausente
//   con_cuenta_activa    — su User.role=tutor existe y User.isActive=true
//   alumnos_sin_tutor    — Student con school de la escuela cuyo _id
//                          no aparece en ningún Guardian.students de
//                          la escuela (incluye activos y desactivados)
const getGuardiansStats = async (req, res, next) => {
  try {
    const tenant = tenantFilter(req);
    const db = mongoose.connection.db;
    const { school_year_id } = req.query;

    // Ciclo para el corte `con_hijos_en_ciclo`: el `school_year_id`
    // recibido si es válido, o el `current_school_year_id` del School
    // del tenant (admin de escuela). super_admin sin param → null
    // (corte queda en 0, como antes).
    let activeSchoolYearId = null;
    if (school_year_id && mongoose.Types.ObjectId.isValid(String(school_year_id))) {
      activeSchoolYearId = new mongoose.Types.ObjectId(String(school_year_id));
    } else if (req.payload.schoolId) {
      const school = await db
        .collection("schools")
        .findOne({ _id: req.payload.schoolId }, { projection: { current_school_year_id: 1 } });
      activeSchoolYearId = school?.current_school_year_id || null;
    }

    const [
      total,
      ativos,
      dadosDeBaja,
      sinAlumnos,
      conCuentaActivaAgg,
      allLinkedStudents,
    ] = await Promise.all([
      Guardian.countDocuments(tenant),
      Guardian.countDocuments({ ...tenant, isActive: { $ne: false } }),
      Guardian.countDocuments({ ...tenant, isActive: false }),
      Guardian.countDocuments({
        ...tenant,
        $or: [{ students: { $size: 0 } }, { students: { $exists: false } }],
      }),
      Guardian.aggregate([
        { $match: { ...tenant, user_id: { $ne: null } } },
        {
          $lookup: {
            from: "users",
            localField: "user_id",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        { $match: { "user.isActive": true } },
        { $count: "n" },
      ]),
      Guardian.distinct("students", {
        ...tenant,
        students: { $exists: true, $ne: [] },
      }),
    ]);

    const conCuentaActiva = conCuentaActivaAgg[0]?.n || 0;

    // Filtrar ObjectIds inválulos que pueden haber quedado en
    // arrays (defensivo, no debería pasar).
    const linkedStudentIds = allLinkedStudents
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(String(id)));

    let conHijosEnCiclo = 0;
    let alumnosSinTutor = 0;

    if (activeSchoolYearId) {
      // Padres con ≥1 hijo con enrollment "enrolled" en el ciclo activo.
      // school = la del JWT, o la del ciclo si es super_admin (schoolId
      // null) — ver schoolForYear.
      const enrollmentSchool = await schoolForYear(
        db,
        req.payload.schoolId,
        activeSchoolYearId
      );
      const enrolled = enrollmentSchool
        ? await db.collection("enrollments").distinct("student_id", {
            school: enrollmentSchool,
            school_year_id: activeSchoolYearId,
            cycle_status: "enrolled",
          })
        : [];
      const enrolledSet = new Set(enrolled.map((id) => String(id)));
      conHijosEnCiclo = await Guardian.countDocuments({
        ...tenant,
        isActive: { $ne: false },
        students: { $in: Array.from(enrolledSet).map((s) => new mongoose.Types.ObjectId(s)) },
      });
    }

    // Alumnos sin tutor: todos los students activos del tenant que no
    // aparecen en la lista linked (vinculados por cualquier guardian,
    // activo o no — refleja "huérfanos" actuales).
    if (linkedStudentIds.length > 0) {
      alumnosSinTutor = await Student.countDocuments({
        ...tenant,
        _id: { $nin: linkedStudentIds },
      });
    } else {
      alumnosSinTutor = await Student.countDocuments(tenant);
    }

res.status(200).json({
      total,
      ativos,
      dados_de_baja: dadosDeBaja,
      sin_alumnos: sinAlumnos,
      con_cuenta_activa: conCuentaActiva,
      con_hijos_en_ciclo: conHijosEnCiclo,
      alumnos_sin_tutor: alumnosSinTutor,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me
// Devuelve los guardianes del usuario autenticado (útil para el tutor).
// Filtra los dados de baja (isActive === false) — un tutor desactivado
// no debe ver el dashboard con datos viejos de sus hijos.
const getMyGuardians = async (req, res, next) => {
  try {
    const items = await Guardian.find({
      ...tenantFilter(req),
      user_id: req.payload._id,
      isActive: { $ne: false },
    }).populate("students", "controlNumber first_name last_name");
    res.status(200).json({ items, total: items.length });
  } catch (error) {
    next(error);
  }
};

// POST /api/guardians
// Crea un tutor. Solo admin/registrar/super_admin.
//
// Body: { name, lastname?, phone, relationship, school?, user_id?, students? }
//
// Garantías de este endpoint:
//   - Si ya existe un Guardian con el mismo `{school, phone}` (otro
//     hijo del mismo papá), lo REUSA y solo le suma el nuevo
//     `students` al array existente. Esto evita chocar con el índice
//     único `{school, phone}` cuando se registran hermanos.
//   - Tras crear/reusar, intenta vincular/crear un User tutor
//     (`ensureTutorUser`). Si el celular ya está registrado con otro
//     perfil (teacher/admin/etc), el Guardian queda creado pero el
//     padre no podrá activarse con ese número → devolvemos
//     `{ warning: "Teléfono ya registrado" }` en la respuesta 201
//     para que el frontend lo muestre.
//   - El opt-in de WhatsApp queda en `true` (source `admin_form`)
//     porque la escuela ya capturó el dato del papá; sin opt-in el
//     flujo de activación devolvería 451. El webhook STOP de Twilio
//     sigue siendo la vía de baja.
const createGuardian = async (req, res, next) => {
  try {
    const { name, lastname, phone, relationship, user_id, students } = req.body;

    if (!name || !phone || !relationship) {
      return res
        .status(400)
        .json({ message: "name, phone, and relationship are required." });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ message: "phone must be 10 digits." });
    }

    // School: del body si lo pasan (super_admin), o del JWT
    const school = req.payload.schoolId || req.body.school;
    if (!school) {
      return res
        .status(400)
        .json({ message: "school is required (provide it in body for super_admin)." });
    }

    // Validar user_id si se pasa (vía signup u otro flujo).
    if (user_id) {
      if (!mongoose.Types.ObjectId.isValid(user_id)) {
        return res.status(400).json({ message: "Invalid user_id." });
      }
      const userExists = await User.findById(user_id);
      if (!userExists) {
        return res.status(404).json({ message: "User not found." });
      }
    }

    // Validar students
    let validStudents = [];
    if (students && students.length > 0) {
      try {
        validStudents = await validateStudentIds(students, school);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }

    // --------------------------------------------------------
    // REUSO / CREACIÓN DEL GUARDIAN
    // --------------------------------------------------------
    // El índice único `{school, phone}` impide tener 2 Guardians
    // con el mismo celular en la misma escuela. Si llegamos aquí
    // registrando un nuevo alumno y el papá ya tiene Guardian
    // (p.ej. hermano mayor), reusamos el mismo y le sumamos el
    // nuevo student.
    let guardian = await Guardian.findOne({ school, phone });
    let reused = false;
    if (guardian) {
      reused = true;
      // El teléfono es el identificador de identidad del tutor. Si
      // ya existe un Guardian con ese {school, phone} NO pisamos sus
      // datos personales (name/lastname/relationship): un typo en el
      // alta de un hermano no debe corromper al padre. Solo
      // completamos campos vacíos para no dejar el registro a medias.
      // Nunca tocamos `user_id` ni `notification_prefs` del existente.
      const fillIfEmpty =
        (name && (!guardian.name || !guardian.name.trim()) && name.trim()) ||
        (lastname && lastname.trim() && (!guardian.lastname || !guardian.lastname.trim())) ||
        (relationship && (!guardian.relationship || !guardian.relationship.trim()) && relationship.trim());
      if (fillIfEmpty) {
        if (!guardian.name || !guardian.name.trim()) guardian.name = name.trim();
        if (!guardian.lastname || !guardian.lastname.trim()) guardian.lastname = lastname.trim();
        if (!guardian.relationship || !guardian.relationship.trim()) guardian.relationship = relationship.trim();
        await guardian.save();
      }
      if (validStudents.length > 0) {
        // Suma el nuevo student al array del Guardian (mirror del
        // lado Student.guardians) y también a los Students (para
        // que `Student.populate("guardians")` lo muestre).
        await Guardian.updateOne(
          { _id: guardian._id },
          { $addToSet: { students: { $each: validStudents } } }
        );
        await Student.updateMany(
          { _id: { $in: validStudents } },
          { $addToSet: { guardians: guardian._id } }
        );
        guardian = await Guardian.findById(guardian._id);
      }
    } else {
      guardian = await Guardian.create({
        school,
        name,
        lastname: lastname && lastname.trim() ? lastname.trim() : "",
        phone,
        relationship,
        user_id: user_id || null,
        students: validStudents,
        notification_prefs: {
          whatsapp: {
            opted_in: true,
            opted_in_at: new Date(),
            source: "admin_form",
          },
        },
      });

      if (validStudents.length > 0) {
        await Student.updateMany(
          { _id: { $in: validStudents } },
          { $addToSet: { guardians: guardian._id } }
        );
      }
    }

    // --------------------------------------------------------
    // SYNC A USER (activación con OTP desde login)
    // --------------------------------------------------------
    const tutorResult = await ensureTutorUser({
      school,
      name: guardian.name,
      lastname: guardian.lastname,
      phone: guardian.phone,
    });

    let warning = null;
    if (tutorResult.ok) {
      // Vincular User al Guardian (idempotente).
      if (
        guardian.user_id?.toString() !== tutorResult.user._id.toString()
      ) {
        guardian.user_id = tutorResult.user._id;
        await guardian.save();
      }
      // Heredamos el opt-in al Guardian también (por si se creó
      // primero el Guardian sin opt-in explícito).
      if (!guardian.notification_prefs?.whatsapp?.opted_in) {
        await Guardian.updateOne(
          { _id: guardian._id },
          {
            $set: {
              "notification_prefs.whatsapp": {
                opted_in: true,
                opted_in_at: new Date(),
                source: "admin_form",
              },
            },
          }
        );
      }
    } else if (tutorResult.reason === "phone_taken") {
      warning = tutorResult.message; // "Teléfono ya registrado"
    } else if (tutorResult.reason === "missing_args") {
      // No debería pasar (validamos antes), pero por seguridad:
      warning = "No se pudo crear la cuenta del tutor";
    }

    const status = reused ? 200 : 201;
    const payload = guardian.toObject();
    res.status(status).json(warning ? { ...payload, warning } : payload);
  } catch (error) {
    next(error);
  }
};

// POST /api/guardians/:guardianId/students
// Vincula uno o más alumnos a un tutor ya existente por ID, sin
// necesidad de mandar nombre/teléfono (porque el tutor ya los tiene).
// Útil cuando el admin elige al tutor desde la modal "Buscar tutor
// existente" del formulario de alta de alumno. Es ADITIVO: nunca
// reemplaza el array `students` del tutor, solo suma con $addToSet
// (hermanos se conservan). El índice único `{school, phone}` sigue
// garantizando que no haya dos Guardians con el mismo celular.
//
// Auth: admin, registrar, super_admin (igual que createGuardian).
// Tenant: el guardian debe pertenecer a la escuela del JWT, si no
// responde 404 (mismo patrón que el resto de la API).
//
// Safety net: si el guardian no tiene `user_id` aún (caso raro,
// creado por un flujo sin ensureTutorUser), intenta vincular uno
// con `ensureTutorUser` para que el papá pueda activar su cuenta.
// No modifica `name`/`lastname`/`relationship`/`notification_prefs`.
const assignStudentsToGuardian = async (req, res, next) => {
  try {
    const { guardianId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(guardianId)) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    const guardian = await Guardian.findOne({
      _id: guardianId,
      ...tenantFilter(req),
    });
    if (!guardian) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    const body = req.body || {};
    const rawIds = Array.isArray(body.student_ids)
      ? body.student_ids
      : body.student_id
        ? [body.student_id]
        : [];
    if (rawIds.length === 0) {
      return res.status(400).json({ message: "student_ids is required." });
    }

    let validIds = [];
    try {
      validIds = await validateStudentIds(rawIds, guardian.school);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }
    if (validIds.length === 0) {
      return res.status(400).json({ message: "student_ids is required." });
    }

    // Mirror en ambos lados: agregamos al array del tutor y al de
    // cada alumno. `$addToSet` evita duplicar si el alumno ya estaba
    // vinculado por un import previo o por una llamada anterior.
    await Guardian.updateOne(
      { _id: guardian._id },
      { $addToSet: { students: { $each: validIds } } }
    );
    await Student.updateMany(
      { _id: { $in: validIds } },
      { $addToSet: { guardians: guardian._id } }
    );

    // Safety: si por algún motivo el tutor no tiene User (caso de
    // un Guardian creado fuera del flujo normal), intentamos crear
    // uno. Esto es idempotente — si ya existe, solo sincroniza.
    if (!guardian.user_id) {
      const tutRes = await ensureTutorUser({
        school: guardian.school,
        name: guardian.name,
        lastname: guardian.lastname,
        phone: guardian.phone,
      });
      if (tutRes.ok) {
        guardian.user_id = tutRes.user._id;
        await guardian.save();
      }
      // Si tutRes.ok === false (phone_taken u otro), no bloqueamos
      // la asignación — el tutor ya quedó vinculado a los alumnos.
    }

    // Refrescamos el guardian con `students` populado para devolver
    // el conteo nuevo al front (para que muestre el aviso "ahora
    // tiene N alumnos").
    const fresh = await Guardian.findById(guardian._id)
      .populate("user_id", "name email role isActive phoneNumber")
      .populate("students", "controlNumber first_name last_name");

    res.status(200).json(fresh);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/guardians/:guardianId/students/:studentId
// Desvincula UN estudiante del tutor (cambio de tutor puntual).
// Aplica `$pull` en ambos lados (student.guardians y guardian.students)
// — espejo de la lógica de deleteGuardian pero a nivel de UNO.
//
// Permisos: admin/registrar/super_admin. Valida tenant por la
// combinación de ambos ids.
const unassignStudentFromGuardian = async (req, res, next) => {
  try {
    const { guardianId, studentId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(guardianId) ||
      !mongoose.Types.ObjectId.isValid(studentId)
    ) {
      return res.status(404).json({ message: "Guardian or student not found." });
    }
    if (!ADMIN_LIKE_ROLES.includes(req.payload.role)) {
      return res.status(403).json({
        message: "Only admin/registrar can unassign students.",
      });
    }

    const tenant = tenantFilter(req);
    const guardian = await Guardian.findOne({ _id: guardianId, ...tenant });
    if (!guardian) {
      return res.status(404).json({ message: "Guardian not found." });
    }
    const student = await Student.findOne({ _id: studentId, ...tenant });
    if (!student) {
      return res.status(404).json({ message: "Student not found." });
    }

    // Idempotente: si no estaba vinculado, devolvemos 200 con un mensaje
    // explicativo sin tocar DB.
    const wasLinked = guardian.students.some(
      (id) => String(id) === String(studentId)
    );

    if (wasLinked) {
      await Guardian.updateOne(
        { _id: guardian._id },
        { $pull: { students: studentId } }
      );
      await Student.updateOne(
        { _id: studentId },
        { $pull: { guardians: guardian._id } }
      );
    }

    res.status(200).json({
      message: wasLinked
        ? "Student unassigned from guardian."
        : "Student was not linked to this guardian (no-op).",
      guardianId,
      studentId,
      wasLinked,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/:guardianId
const getGuardianById = async (req, res, next) => {
  try {
    const { guardianId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(guardianId)) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    const guardian = await Guardian.findOne({
      _id: guardianId,
      ...tenantFilter(req),
    })
      .populate("user_id", "name email role isActive phoneNumber")
      .populate("students", "controlNumber first_name last_name");

    if (!guardian) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    res.status(200).json(guardian);
  } catch (error) {
    next(error);
  }
};

// PUT /api/guardians/:guardianId
// Solo el propio tutor o admin.
const updateGuardian = async (req, res, next) => {
  try {
    const { guardianId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(guardianId)) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    const guardian = await Guardian.findOne({
      _id: guardianId,
      ...tenantFilter(req),
    });

    if (!guardian) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    // Permisos: el User dueño del guardian, o admin
    const isOwner =
      guardian.user_id && String(guardian.user_id) === String(req.payload._id);
    const isAdmin = ADMIN_LIKE_ROLES.includes(req.payload.role);
    if (!isOwner && !isAdmin) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this guardian." });
    }

    // Validar phone si se actualiza
    if (req.body.phone !== undefined) {
      if (!/^\d{10}$/.test(req.body.phone)) {
        return res.status(400).json({ message: "phone must be 10 digits." });
      }
    }

    // Validar user_id si se actualiza
    if (req.body.user_id !== undefined && req.body.user_id !== null) {
      if (!mongoose.Types.ObjectId.isValid(req.body.user_id)) {
        return res.status(400).json({ message: "Invalid user_id." });
      }
      const userExists = await User.findById(req.body.user_id);
      if (!userExists) {
        return res.status(404).json({ message: "User not found." });
      }
    }

    // Validar isActive (solo admin/registrar/super_admin pueden cambiar
// el estado del registro). Transicionar a `false` desvincula TODOS
// los hijos del tutor y desactiva su cuenta User si queda sin
// guardians activos (para que no entre al dashboard). Transicionar a
// `true` reactiva la cuenta User si existía y estaba dada de baja.
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== "boolean") {
        return res.status(400).json({ message: "isActive must be boolean." });
      }
      if (!isAdmin) {
        return res.status(403).json({
          message: "Only admin/registrar can change isActive.",
        });
      }
      const wasActive = guardian.isActive !== false;
      const becomingInactive = wasActive && req.body.isActive === false;
      const becomingActive = !wasActive && req.body.isActive === true;
      if (becomingInactive) {
        // Desvincular todos los hijos (ambos lados)
        const studentIds = guardian.students.map((s) => s);
        if (studentIds.length > 0) {
          await Student.updateMany(
            { _id: { $in: studentIds } },
            { $pull: { guardians: guardian._id } }
          );
          await Guardian.updateOne(
            { _id: guardian._id },
            { $set: { students: [] } }
          );
        }
      }
      // Reactivar el User tutor si quedó libre (no hay otros
      // guardian activos con ese user_id). La inactivación la hace
      // automáticamente `syncUserActiveFromGuardians` después del save.
    }

    // Validar students si se actualiza
    if (req.body.students !== undefined) {
      let validStudents = [];
      try {
        validStudents = await validateStudentIds(
          req.body.students,
          guardian.school
        );
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }

      // Sincronizar el lado Student: quitar este guardian de los que ya no están
      // y agregarlo a los nuevos
      const oldStudents = guardian.students.map((s) => String(s));
      const newStudents = validStudents.map((s) => String(s));
      const toRemove = oldStudents.filter((s) => !newStudents.includes(s));
      const toAdd = newStudents.filter((s) => !oldStudents.includes(s));

      if (toRemove.length > 0) {
        await Student.updateMany(
          { _id: { $in: toRemove } },
          { $pull: { guardians: guardian._id } }
        );
      }
      if (toAdd.length > 0) {
        await Student.updateMany(
          { _id: { $in: toAdd } },
          { $addToSet: { guardians: guardian._id } }
        );
      }

      guardian.students = validStudents;
    }

    // Aplicar el resto de cambios (excepto students, ya manejado)
    const { students: _ignore, notification_prefs: _ignorePrefs, ...rest } = req.body;
    Object.assign(guardian, rest);
    await guardian.save();

    // Sincronizar el User tutor cuando cambió isActive (en cualquier
    // dirección). Si el tutor se desactivó y ya no queda asociado a
    // ningún guardian activo, su cuenta User también pasa a
    // isActive=false (login → 403). Si se reactivó y su User estaba
    // bajado, lo subimos.
    if (req.body.isActive !== undefined && guardian.user_id) {
      await syncUserActiveFromGuardians(guardian.user_id);
    }

    // Opt-in WhatsApp: aplicar explícitamente (no vía Object.assign porque
    // notification_prefs es un subdoc y se debe respetar la forma canónica).
    if (req.body.whatsapp_opt_in !== undefined) {
      const newOptedIn = req.body.whatsapp_opt_in === true || req.body.whatsapp_opt_in === "true";
      guardian.notification_prefs = {
        ...(guardian.notification_prefs?.toObject?.() || guardian.notification_prefs || {}),
        whatsapp: {
          opted_in: newOptedIn,
          opted_in_at: newOptedIn ? new Date() : null,
          source: newOptedIn ? "admin_form" : "self_profile",
        },
      };
      await guardian.save();
    }

    res.status(200).json(guardian);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/guardians/:guardianId
// Solo admin/registrar.
const deleteGuardian = async (req, res, next) => {
  try {
    const { guardianId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(guardianId)) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    if (!ADMIN_LIKE_ROLES.includes(req.payload.role)) {
      return res
        .status(403)
        .json({ message: "Only admin/registrar can delete guardians." });
    }

    const guardian = await Guardian.findOneAndDelete({
      _id: guardianId,
      ...tenantFilter(req),
    });

    if (!guardian) {
      return res.status(404).json({ message: "Guardian not found." });
    }

    // Limpiar el lado Student: quitar este guardian del array guardians
    if (guardian.students && guardian.students.length > 0) {
      await Student.updateMany(
        { _id: { $in: guardian.students } },
        { $pull: { guardians: guardian._id } }
      );
    }

    res.status(200).json({ message: "Guardian deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// POST /api/guardians/me/fcm-token
// El tutor (autenticado) registra o actualiza el FCM token de su dispositivo
// móvil. Actualiza TODOS los Guardian records vinculados a su user_id
// (un tutor puede ser guardián de varios hijos → mismo fcm_token para todos).
// Body: { fcm_token: "abc123...", device_id?: "pixel-7" }
//
// NOTA PARA LA APP MÓVIL:
//   Firebase puede rotar el fcm_token mientras la app está instalada
//   (restore desde backup, reinstalación, etc.). La app DEBE suscribirse
//   al callback `onTokenRefresh` de Firebase Messaging y re-llamar a este
//   endpoint cada vez que reciba un token nuevo. Si no, los push dejan de
//   llegar silenciosamente cuando el token rotó.
const registerFcmToken = async (req, res, next) => {
  try {
    const { fcm_token, device_id } = req.body;

    if (!fcm_token || typeof fcm_token !== "string") {
      return res
        .status(400)
        .json({ message: "fcm_token is required and must be a string." });
    }

    // FCM tokens suelen ser > 100 chars de base64. Validación laxa.
    if (fcm_token.trim().length < 20) {
      return res
        .status(400)
        .json({ message: "fcm_token looks invalid (too short)." });
    }

    const result = await Guardian.updateMany(
      {
        user_id: req.payload._id,
        ...tenantFilter(req),
      },
      {
        $set: {
          fcm_token: fcm_token.trim(),
          ...(device_id ? { last_device_id: device_id } : {}),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "No guardian records found for this user.",
      });
    }

    res.status(200).json({
      message: "FCM token registered successfully.",
      guardians_updated: result.modifiedCount,
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/guardians/me/fcm-token
// El tutor limpia su FCM token (logout, desinstalación, etc.) para dejar
// de recibir push. Pone fcm_token = null en todos sus Guardian records.
const clearFcmToken = async (req, res, next) => {
  try {
    const result = await Guardian.updateMany(
      {
        user_id: req.payload._id,
        ...tenantFilter(req),
      },
      { $set: { fcm_token: null } }
    );

    res.status(200).json({
      message: "FCM token cleared.",
      guardians_updated: result.modifiedCount,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/students/:studentId/grades
// Devuelve las calificaciones de un hijo específico del tutor autenticado.
// Reutiliza la lógica del summary (promedio, by_subject, by_period,
// by_year, final_grade) — todo calculado on-the-fly.
//
// Query params opcionales:
//   - school_year_id: filtra por ciclo (default: el más reciente por startDate)
//   - gradingPeriod: ObjectId del período específico
//   - subject_id: ObjectId de la materia específica
//
// Pre-requisitos (manejados por middlewares previos del router):
//   - attachSchoolContext       → req.school
//   - attachActiveSchoolYear    → req.schoolYear
//   - requireGuardianOf         → valida parentesco + adjunta req.guardian
const getMyStudentGrades = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { school_year_id, gradingPeriod, subject_id } = req.query;

    // Seguridad: garantizada por los middlewares previos.
    // req.guardian trae el doc del Guardian (con `relationship`) ya cargado.

    // Buscar las Enrollments del student (multi-tenant vía req.school)
    const enrollmentFilter = { student_id: studentId, school: req.school };
    const enrollments = await Enrollment.find(enrollmentFilter)
      .select("_id school_year_id group_id")
      .populate("school_year_id", "name startDate");
    if (enrollments.length === 0) {
      return res.status(200).json({
        student_id: studentId,
        items: [],
        summary: {
          total_grades: 0,
          average: null,
          by_subject: [],
          by_period: [],
          by_year: [],
          final_grade: null,
        },
      });
    }

    // Construir la lista de grades con filtros
    const enrollmentIds = enrollments.map((e) => e._id);
    const gradeFilter = { enrollment_id: { $in: enrollmentIds } };
    if (school_year_id && mongoose.Types.ObjectId.isValid(school_year_id)) {
      gradeFilter.school_year_id = school_year_id;
    }
    if (gradingPeriod && mongoose.Types.ObjectId.isValid(gradingPeriod)) {
      gradeFilter.gradingPeriod = gradingPeriod;
    }
    if (subject_id && mongoose.Types.ObjectId.isValid(subject_id)) {
      gradeFilter.subject_id = subject_id;
    }

    const grades = await Grade.find(gradeFilter)
      .populate("enrollment_id", "group_id cycle_status")
      .populate("school_year_id", "name startDate endDate isActive")
      .populate("subject_id", "code name")
      .populate("gradingPeriod", "name order")
      .populate("graded_by", "name email role")
      .sort({ subject_id: 1, period_order: 1 });

    // Orden final: ciclo más reciente primero (por startDate real)
    grades.sort((a, b) => {
      const aDate = a.school_year_id ? new Date(a.school_year_id.startDate) : 0;
      const bDate = b.school_year_id ? new Date(b.school_year_id.startDate) : 0;
      return bDate - aDate;
    });

    // Calcular el summary del año específico (o el más reciente por startDate)
    const sortedEnrollments = [...enrollments].sort(
      (a, b) =>
        new Date(b.school_year_id?.startDate || 0) -
        new Date(a.school_year_id?.startDate || 0)
    );
    const targetSchoolYear = school_year_id
      ? sortedEnrollments.find(
          (e) => String(e.school_year_id?._id) === String(school_year_id)
        )?.school_year_id
      : sortedEnrollments[0].school_year_id;
    const targetEnrollmentIds = targetSchoolYear
      ? enrollments
          .filter(
            (e) => String(e.school_year_id?._id) === String(targetSchoolYear._id)
          )
          .map((e) => e._id)
      : [];

    // Traer TODAS las grades del student (cross-year) para by_year y final_grade
    const allGrades = await Grade.find({
      enrollment_id: { $in: enrollmentIds },
    }).populate("subject_id", "code name").populate("gradingPeriod", "name order");

    // by_year
    const enrollmentYear = new Map();
    for (const e of enrollments) {
      if (e.school_year_id) enrollmentYear.set(String(e._id), e.school_year_id);
    }
    const byYearMap = new Map();
    for (const g of allGrades) {
      const sy = enrollmentYear.get(String(g.enrollment_id));
      if (!sy) continue;
      const key = String(sy._id);
      if (!byYearMap.has(key)) byYearMap.set(key, { schoolYear: sy, grades: [] });
      byYearMap.get(key).grades.push(g);
    }
    const byYear = [...byYearMap.values()]
      .sort((a, b) => new Date(a.schoolYear.startDate) - new Date(b.schoolYear.startDate))
      .map(({ schoolYear, grades: gs }) => {
        const sum = gs.reduce((s, g) => s + g.value, 0);
        const avg = gs.length > 0 ? sum / gs.length : null;
        const periodMap = {};
        for (const g of gs) {
          const pKey = g.period_order;
          if (!periodMap[pKey]) periodMap[pKey] = { sum: 0, count: 0, name: g.gradingPeriod?.name || `Periodo ${pKey}` };
          periodMap[pKey].sum += g.value;
          periodMap[pKey].count += 1;
        }
        const byPeriodInYear = Object.entries(periodMap)
          .map(([p, { sum, count, name }]) => ({
            period: parseInt(p, 10),
            name,
            average: Math.round((sum / count) * 100) / 100,
            count,
          }))
          .sort((a, b) => a.period - b.period);
        return {
          school_year_id: schoolYear._id,
          school_year: schoolYear.name,
          average: avg !== null ? Math.round(avg * 100) / 100 : null,
          total_grades: gs.length,
          by_period: byPeriodInYear,
        };
      });

    const yearAverages = byYear.map((y) => y.average).filter((a) => a !== null);
    const finalGrade =
      yearAverages.length >= 3
        ? Math.round(
            (yearAverages.reduce((s, a) => s + a, 0) / yearAverages.length) * 100
          ) / 100
        : null;

    // Summary del año/periodo consultado
    const targetGrades = grades.filter((g) => {
      if (
        targetSchoolYear &&
        String(g.school_year_id?._id || g.school_year_id) !== String(targetSchoolYear._id)
      )
        return false;
      if (gradingPeriod && mongoose.Types.ObjectId.isValid(gradingPeriod) &&
          String(g.gradingPeriod?._id || g.gradingPeriod) !== String(gradingPeriod))
        return false;
      return true;
    });

    let summary = {
      school_year_id: targetSchoolYear ? targetSchoolYear._id : null,
      school_year: targetSchoolYear ? targetSchoolYear.name : null,
      total_grades: 0,
      average: null,
      by_subject: [],
      by_period: [],
    };
    if (targetGrades.length > 0) {
      const total = targetGrades.reduce((s, g) => s + g.value, 0);
      const average = total / targetGrades.length;
      const bySubjectMap = {};
      for (const g of targetGrades) {
        const subjectKey = String(g.subject_id?._id || g.subject_id);
        const subjectName = g.subject_id?.name || subjectKey;
        if (!bySubjectMap[subjectKey]) bySubjectMap[subjectKey] = { name: subjectName, sum: 0, count: 0 };
        bySubjectMap[subjectKey].sum += g.value;
        bySubjectMap[subjectKey].count += 1;
      }
      const bySubject = Object.entries(bySubjectMap)
        .map(([id, { name, sum, count }]) => ({
          subject_id: id,
          subject: name,
          average: sum / count,
          count,
        }))
        .sort((a, b) => b.average - a.average);
      const byPeriodMap = {};
      for (const g of targetGrades) {
        const pKey = g.period_order;
        if (!byPeriodMap[pKey]) byPeriodMap[pKey] = { sum: 0, count: 0, name: g.gradingPeriod?.name || `Periodo ${pKey}` };
        byPeriodMap[pKey].sum += g.value;
        byPeriodMap[pKey].count += 1;
      }
      const byPeriod = Object.entries(byPeriodMap)
        .map(([p, { sum, count, name }]) => ({
          period: parseInt(p, 10),
          name,
          average: sum / count,
          count,
        }))
        .sort((a, b) => a.period - b.period);
      summary = {
        school_year_id: targetSchoolYear ? targetSchoolYear._id : null,
        school_year: targetSchoolYear ? targetSchoolYear.name : null,
        gradingPeriod: gradingPeriod || null,
        total_grades: targetGrades.length,
        average: Math.round(average * 100) / 100,
        by_subject: bySubject.map((s) => ({
          ...s,
          average: Math.round(s.average * 100) / 100,
        })),
        by_period: byPeriod.map((p) => ({
          ...p,
          average: Math.round(p.average * 100) / 100,
        })),
      };
    }

    // Construir grades_matrix: tabla cruzada de materias × períodos
    // Para la pantalla de calificaciones del tutor
    const gradesMatrix = [];
    const matrixBySubject = new Map();

    for (const g of targetGrades) {
      const subjectKey = String(g.subject_id?._id || g.subject_id);
      const subjectName = g.subject_id?.name || subjectKey;
      const periodOrder = g.period_order;

      if (!matrixBySubject.has(subjectKey)) {
        matrixBySubject.set(subjectKey, {
          subject_id: subjectKey,
          subject: subjectName,
          periods: {},
        });
      }
      const row = matrixBySubject.get(subjectKey);
      // Solo guardar si hay calificación
      if (g.value !== null && g.value !== undefined) {
        row.periods[periodOrder] = g.value;
      }
    }

    // Agregar fila de promedio general
    const avgRow = {
      subject_id: null,
      subject: "Promedio",
      periods: {},
    };

    // Calcular promedio por período
    const periodTotals = {};
    for (const [_, row] of matrixBySubject) {
      for (const [period, value] of Object.entries(row.periods)) {
        if (!periodTotals[period]) periodTotals[period] = { sum: 0, count: 0 };
        periodTotals[period].sum += value;
        periodTotals[period].count += 1;
      }
    }
    for (const [period, { sum, count }] of Object.entries(periodTotals)) {
      avgRow.periods[period] = Math.round((sum / count) * 100) / 100;
    }

    // Convertir a array y ordenar por nombre de materia
    for (const [_, row] of matrixBySubject) {
      gradesMatrix.push(row);
    }
    gradesMatrix.sort((a, b) => a.subject.localeCompare(b.subject));
    gradesMatrix.push(avgRow);

    res.status(200).json({
      student_id: studentId,
      relationship: req.guardian.relationship,
      items: grades,
      grades_matrix: gradesMatrix,
      summary: {
        ...summary,
        by_year: byYear,
        final_grade: finalGrade,
        total_years: byYear.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/students/:studentId/schedule
// Devuelve el horario semanal del estudiante para el ciclo activo.
// Agrupa las clases por día de la semana (1=lun … 6=sáb), resolviendo
// los timeBlocks del SchoolShift para obtener startTime/endTime.
//
// Query params opcionales:
//   - school_year_id: ciclo específico (default: el ciclo activo de la escuela)
//
// Pre-requisitos (middlewares):
//   - attachSchoolContext, attachActiveSchoolYear, requireGuardianOf
const DAYS_NAMES = {
  0: "DOM",
  1: "LUN",
  2: "MAR",
  3: "MIÉ",
  4: "JUE",
  5: "VIE",
  6: "SÁB",
};

const getMyStudentSchedule = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { school_year_id } = req.query;

    const yearId = school_year_id || req.schoolYear;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    // 1. Buscar la Enrollment del estudiante para el ciclo objetivo
    const enrollmentFilter = {
      student_id: studentId,
      school: req.school,
    };
    if (yearId) enrollmentFilter.school_year_id = yearId;

    const enrollment = await Enrollment.findOne(enrollmentFilter)
      .select("_id group_id school_year_id")
      .populate("group_id", "grade section shift")
      .populate("school_year_id", "name startDate endDate");

    if (!enrollment) {
      return res.status(200).json({
        student_id: studentId,
        school_year: null,
        group: null,
        schedule: {},
        message: "No enrollment found for this student.",
      });
    }

    const group = enrollment.group_id;
    const schoolYear = enrollment.school_year_id;

    if (!group) {
      return res.status(200).json({
        student_id: studentId,
        school_year: schoolYear ? { _id: schoolYear._id, name: schoolYear.name } : null,
        group: null,
        schedule: {},
        message: "Student has no group assigned.",
      });
    }

    // 1b. Obtener el grupo TALLER del estudiante (Grupo transversal de Tecnología).
    //     Su horario se carga aparte y se FUSIONA con el del grupo de origen:
    //     en los bloques de taller el alumno sale de su grupo de origen y asiste
    //     a su taller, así que sin esto el horario mostraría huecos.
    const student = await Student.findOne({ _id: studentId, school: req.school }).lean();

    // 2. Buscar los ClassSchedule del grupo (de origen) y del taller para este ciclo
    const groupIds = [group._id];
    if (student && student.workshop_group_id) {
      groupIds.push(student.workshop_group_id);
    }

    const schedules = await ClassSchedule.find({
      school: req.school,
      school_year_id: schoolYear._id,
      group_id: { $in: groupIds },
      isActive: true,
    })
      .populate("subject_id", "code name color icon")
      .populate("teacher_id", "name last_name")
      .populate("school_shift_id", "name shift startTime endTime timeBlocks");

    // 3. Construir el horario agrupado por día
    const scheduleByDay = {};

    for (const cs of schedules) {
      const shift = cs.school_shift_id;
      if (!shift || !cs.scheduleSlots) continue;

      // Marcar si la sesión pertenece al grupo taller del estudiante
      const isTaller =
        student &&
        student.workshop_group_id &&
        String(cs.group_id) === String(student.workshop_group_id);

      for (const slot of cs.scheduleSlots) {
        const day = slot.dayOfWeek;
        if (!scheduleByDay[day]) scheduleByDay[day] = [];

        // Resolver los timeBlocks de este slot
        const blocks = shift.resolveBlocks(slot.timeBlockRefs);
        if (blocks.length === 0) continue;

        // Tomar el primero y último para definir el rango horario
        const firstBlock = blocks[0];
        const lastBlock = blocks[blocks.length - 1];

        scheduleByDay[day].push({
          subject_id: cs.subject_id?._id || null,
          subject: cs.subject_id?.name || null,
          subject_code: cs.subject_id?.code || null,
          color: cs.subject_id?.color || null,
          icon: cs.subject_id?.icon || null,
          teacher: cs.teacher_id
            ? `${cs.teacher_id.name} ${cs.teacher_id.last_name || ""}`.trim()
            : null,
          start: firstBlock.startTime,
          end: lastBlock.endTime,
          classroom: slot.classroom || null,
          block_count: blocks.length,
          block_names: blocks.map((b) => b.name),
          is_taller: isTaller || false,
        });
      }
    }

    // 4. Inyectar el/los receso(s) de la campana (SchoolShift con isBreak: true)
    //    en cada día con clases, para que el front lo muestre como fila aparte.
    const breakBlocks = schedules[0]?.school_shift_id?.timeBlocks
      ? schedules[0].school_shift_id.timeBlocks.filter((b) => b.isBreak)
      : [];
    if (breakBlocks.length > 0) {
      for (const day of Object.keys(scheduleByDay)) {
        for (const br of breakBlocks) {
          scheduleByDay[day].push({
            type: "receso",
            subject_id: null,
            subject: null,
            subject_code: null,
            teacher: null,
            start: br.startTime,
            end: br.endTime,
            classroom: null,
            block_count: 0,
            block_names: [br.name],
            is_taller: false,
          });
        }
      }
    }

    // 5. Ordenar cada día por hora de inicio
    for (const day of Object.keys(scheduleByDay)) {
      scheduleByDay[day].sort((a, b) => a.start.localeCompare(b.start));
    }

    // 6. Agregar los nombres de día para el front
    const scheduleWithDays = {};
    for (const [day, classes] of Object.entries(scheduleByDay)) {
      scheduleWithDays[day] = {
        day_name: DAYS_NAMES[day] || `DÍA ${day}`,
        classes,
      };
    }

    res.status(200).json({
      student_id: studentId,
      school_year: schoolYear
        ? { _id: schoolYear._id, name: schoolYear.name }
        : null,
      group: {
        _id: group._id,
        grade: group.grade,
        section: group.section,
        shift: group.shift,
        type: group.type || "regular",
      },
      taller_group:
        student && student.workshop_group_id
          ? { _id: student.workshop_group_id }
          : null,
      shift_info: schedules.length > 0 && schedules[0].school_shift_id
        ? {
            name: schedules[0].school_shift_id.name,
            start: schedules[0].school_shift_id.startTime,
            end: schedules[0].school_shift_id.endTime,
          }
        : null,
      schedule: scheduleWithDays,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/students/:studentId/attendance/summary
// Resumen de asistencia del estudiante para el ciclo activo:
// porcentaje, conteo por tipo (asistencias/faltas/retardos),
// y lista de inasistencias recientes.
//
// Lógica de clasificación por día:
//   - Sin ningún entry → falta
//   - Primer entry después de la hora de tolerancia → retardo
//   - Primer entry a tiempo → asistencia
//
// Query params opcionales:
//   - school_year_id: ciclo específico (default: el activo de la escuela)
//   - late_threshold: hora de tolerancia en formato "HH:mm" (default: "08:00")
//
// Pre-requisitos (middlewares):
//   - attachSchoolContext, attachActiveSchoolYear, requireGuardianOf
const getMyStudentAttendanceSummary = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { school_year_id, late_threshold = "08:00" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const yearId = school_year_id || req.schoolYear;

    // 1. Obtener el rango de fechas del ciclo escolar
    const SchoolYear = require("../models/SchoolYear.model");
    const schoolYear = await SchoolYear.findOne({
      _id: yearId,
      school: req.school,
    }).lean();

    if (!schoolYear) {
      return res.status(404).json({ message: "School year not found." });
    }

    const yearStart = new Date(schoolYear.startDate);
    const yearEnd = new Date(schoolYear.endDate);
    const now = new Date();

    // 2. Traer todos los logs del estudiante en el ciclo
    const logs = await AttendanceLog.find({
      school: req.school,
      student_id: studentId,
      event_time: { $gte: yearStart, $lte: now },
    }).sort({ event_time: 1 }).lean();

    // 3. Agrupar por día (YYYY-MM-DD) y clasificar
    const dayMap = new Map(); // "2025-08-20" → { entry: Date, exit: Date }
    for (const log of logs) {
      const dayKey = log.event_time.toISOString().split("T")[0];
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, {});
      const day = dayMap.get(dayKey);
      if (log.event_type === "entry" && !day.entry) day.entry = log.event_time;
      if (log.event_type === "exit") day.exit = log.event_time;
    }

    // 4. Clasificar cada día
    const [thresholdHour, thresholdMin] = late_threshold.split(":").map(Number);
    const thresholdMinutes = thresholdHour * 60 + thresholdMin;

    let totalAssists = 0;
    let totalAbsences = 0;
    let totalDelays = 0;
    const recentAbsences = [];

    for (const [dayKey, day] of dayMap) {
      if (!day.entry) {
        // Sin entry = falta
        totalAbsences++;
        recentAbsences.push({
          date: dayKey,
          type: "absence",
          label: "Falta Injustificada",
          description: "Sin registro de entrada.",
        });
      } else {
        // Calcular si llegó tarde
        const entryTime = new Date(day.entry);
        const entryMinutes = entryTime.getHours() * 60 + entryTime.getMinutes();
        if (entryMinutes > thresholdMinutes) {
          totalDelays++;
        } else {
          totalAssists++;
        }
      }
    }

    // Ordenar inasistencias por fecha descendente (más recientes primero)
    recentAbsences.sort((a, b) => b.date.localeCompare(a.date));

    // 5. Calcular porcentaje (retardos cuentan como asistencia)
    const totalDays = dayMap.size;
    const totalAttended = totalAssists + totalDelays;
    const percentage = totalDays > 0
      ? Math.round((totalAttended / totalDays) * 10000) / 100
      : null;

    // 6. Determinar label de progreso
    let progressLabel = null;
    if (percentage !== null) {
      if (percentage >= 95) progressLabel = "Excelente";
      else if (percentage >= 85) progressLabel = "Bueno";
      else if (percentage >= 75) progressLabel = "Regular";
      else progressLabel = "Necesita mejorar";
    }

    res.status(200).json({
      student_id: studentId,
      school_year: {
        _id: schoolYear._id,
        name: schoolYear.name,
        start: schoolYear.startDate,
        end: schoolYear.endDate,
      },
      summary: {
        percentage,
        total_assists: totalAssists,
        total_absences: totalAbsences,
        total_delays: totalDelays,
        total_days: totalDays,
        progress_label: progressLabel,
        late_threshold,
      },
      recent_absences: recentAbsences.slice(0, 10),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/students/:studentId/attendance/history
// Historial de entradas/salidas agrupado por día.
// Devuelve los últimos N días con su entrada, salida y estado.
//
// Query params opcionales:
//   - school_year_id: ciclo específico (default: el activo)
//   - days: cuántos días hacia atrás (default: 30, max: 90)
//   - late_threshold: hora de tolerancia (default: "08:00")
//
// Pre-requisitos (middlewares):
//   - attachSchoolContext, attachActiveSchoolYear, requireGuardianOf
const getMyStudentAttendanceHistory = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { school_year_id, days: daysParam, late_threshold = "08:00" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const yearId = school_year_id || req.schoolYear;
    const daysBack = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90);

    // 1. Obtener el rango de fechas
    const SchoolYear = require("../models/SchoolYear.model");
    const schoolYear = await SchoolYear.findOne({
      _id: yearId,
      school: req.school,
    }).lean();

    if (!schoolYear) {
      return res.status(404).json({ message: "School year not found." });
    }

    const yearStart = new Date(schoolYear.startDate);
    const now = new Date();
    // Calcular fecha límite (daysBack días atrás o inicio del ciclo)
    const limitDate = new Date(now);
    limitDate.setDate(limitDate.getDate() - daysBack);
    const startDate = limitDate > yearStart ? limitDate : yearStart;

    // 2. Traer logs del rango
    const logs = await AttendanceLog.find({
      school: req.school,
      student_id: studentId,
      event_time: { $gte: startDate, $lte: now },
    }).sort({ event_time: 1 }).lean();

    // 3. Agrupar por día
    const dayMap = new Map();
    for (const log of logs) {
      const dayKey = log.event_time.toISOString().split("T")[0];
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, { entries: [], exits: [] });
      const day = dayMap.get(dayKey);
      if (log.event_type === "entry") day.entries.push(log.event_time);
      else day.exits.push(log.event_time);
    }

    // 4. Construir respuesta ordenada por fecha descendente
    const [thresholdHour, thresholdMin] = late_threshold.split(":").map(Number);
    const thresholdMinutes = thresholdHour * 60 + thresholdMin;

    const history = [];
    for (const [dayKey, day] of dayMap) {
      // Primera entrada y última salida del día
      const firstEntry = day.entries.length > 0 ? day.entries[0] : null;
      const lastExit = day.exits.length > 0 ? day.exits[day.exits.length - 1] : null;

      // Determinar estado
      let status = "NO_ENTRY";
      if (firstEntry) {
        const entryMinutes = firstEntry.getHours() * 60 + firstEntry.getMinutes();
        status = entryMinutes > thresholdMinutes ? "DELAY" : "ON_TIME";
      }

      const formatTime = (d) => {
        if (!d) return null;
        return d.toLocaleTimeString("es-MX", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
      };

      const formatDate = (d) => {
        return d.toLocaleDateString("es-MX", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      };

      history.push({
        date: dayKey,
        date_formatted: formatDate(new Date(dayKey + "T12:00:00")),
        entry: formatTime(firstEntry),
        exit: formatTime(lastExit),
        status,
        status_label: status === "ON_TIME" ? "A TIEMPO" :
                      status === "DELAY" ? "RETARDO" : "SIN REGISTRO",
      });
    }

    // Ordenar por fecha descendente (más reciente primero)
    history.sort((a, b) => b.date.localeCompare(a.date));

    res.status(200).json({
      student_id: studentId,
      school_year: {
        _id: schoolYear._id,
        name: schoolYear.name,
      },
      days_requested: daysBack,
      history,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/dashboard
// Devuelve TODA la data que el front del tutor necesita para mostrar
// el dashboard en una sola request: perfil del padre, datos de la escuela
// (logo + nombre) y los estudiantes asignados.
//
// Auth: cualquier user autenticado (típicamente role=tutor; super_admin
// también puede ver su propio dashboard que devolvería sin estudiantes).
const getMyDashboard = async (req, res, next) => {
  try {
    // Cache key por userId + period
    const cacheKey = cache.keys.dashboard(req.payload._id, req.query.period);
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }

    // 1. Perfil del User (necesitamos phoneNumber e isActive que NO
    //    están en el JWT, solo en la DB)
    const user = await User.findById(req.payload._id)
      .select("name email last_name phoneNumber role school isActive")
      .lean();

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // 2. Datos de la escuela + ciclo activo.
    //    req.school y req.schoolYear vienen de los middlewares previos
    //    (attachSchoolContext + attachActiveSchoolYear) — ya validados.
    //    Solo nos falta la query para popular los campos del school doc
    //    y del schoolYear doc que el front necesita en la respuesta.
    const school = await School.findById(req.school)
      .select("name cct logoUrl isActive current_school_year_id")
      .populate("current_school_year_id", "name startDate endDate isActive")
      .lean();
    const currentSchoolYear = school ? school.current_school_year_id : null;

    // 3. Estudiantes asignados
    //    Buscamos los Guardian records del user, colectamos los student_ids
    //    y luego hacemos un solo find() con populate del current_group_id.
    const guardianRecords = await Guardian.find({
      user_id: req.payload._id,
    })
      .select("students relationship")
      .lean();

    // Aplanar la lista de student_ids (puede haber duplicados si el tutor
    // tiene 2+ Guardian records apuntando al mismo student — los deduplicamos)
    const studentIdSet = new Set();
    const relationshipByStudent = new Map();
    for (const g of guardianRecords) {
      if (!g.students) continue;
      for (const sid of g.students) {
        const key = String(sid);
        studentIdSet.add(key);
        // Si un student tiene múltiples relationships, priorizamos la primera
        if (!relationshipByStudent.has(key)) {
          relationshipByStudent.set(key, g.relationship);
        }
      }
    }

    let students = [];
    if (studentIdSet.size > 0) {
      // Filtrar por tenant (no devolver estudiantes de otras escuelas)
      const studentFilter = {
        _id: { $in: [...studentIdSet] },
      };
      if (req.payload.role !== "super_admin" && user.school) {
        studentFilter.school = user.school;
      }

      let studentDocs = await Student.find(studentFilter)
        .select("controlNumber first_name last_name status photoUrl current_group_id school")
        .populate({
          path: "current_group_id",
          select: "grade section school_year_id shift",
          populate: { path: "school_year_id", select: "name startDate endDate isActive" },
        })
        .sort({ last_name: 1, first_name: 1 })
        .lean();

      // Nota: NO filtramos/excluimos students cuyo current_group_id no
      // coincida con el ciclo activo — el tutor siempre debe ver a sus
      // hijos en el dashboard. El grado/grupo del ciclo actual se resuelve
      // abajo a partir de la Enrollment del ciclo (fuente de verdad); si no
      // existe, se usa current_group_id como fallback (ver paso 3b).

      // Capitalizar la primera letra del shift para mostrar "Matutino"
      const capitalize = (s) =>
        s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

      // Enriquecer con la relationship del tutor
      students = studentDocs.map((s) => {
        const g = s.current_group_id;
        const groupLabel =
          g && g.grade && g.section && g.shift
            ? `${g.grade}°${g.section} - Turno ${capitalize(g.shift)}`
            : null;
        return {
          _id: s._id,
          controlNumber: s.controlNumber,
          first_name: s.first_name,
          last_name: s.last_name,
          status: s.status,
          photo_url: s.photoUrl,
          // Datos de grado/grupo del estudiante (fallback desde
          // Student.current_group_id). Se sobrescribe abajo (paso 3b) con la
          // Enrollment del ciclo escolar activo, que es la fuente de verdad.
          // Si el student no tiene current_group_id, queda en null.
          current_group: g
            ? {
                _id: g._id,
                grade: g.grade,
                section: g.section,
                school_year_id: g.school_year_id ? g.school_year_id._id : null,
                school_year: g.school_year_id ? g.school_year_id.name : null,
                shift: g.shift,
              }
            : null,
          // Label pre-formateado para mostrar en el front sin transformar
          group_label: groupLabel,
          relationship: relationshipByStudent.get(String(s._id)) || null,
          // academic_summary se agrega abajo (después del batch query)
          academic_summary: null,
          // last_event: se agrega abajo (después del batch query)
          last_event: null,
          // KPIs del Guardian Dashboard. Se inicializan con valores neutros
          // y se sobreescriben en los bloques 3b/3c con los datos reales.
          kpis: {
            attendance: {
              percentage: null,
              attended_days: 0,
              total_school_days: 0,
              source: null,
            },
            cumulative_gpa: null,
            conduct: {
              score: null,
              baseline: null,
              floor: null,
              signed_total: 0,
              total_events: 0,
              demerits_count: 0,
              merits_count: 0,
            },
          },
        };
      });

      // 3a. Último evento de asistencia por student — 1 query batch
      if (students.length > 0) {
        const studentIds = students.map((s) => s._id);
        // Aggregation: para cada student, el evento más reciente
        const latestEvents = await AttendanceLog.aggregate([
          { $match: { student_id: { $in: studentIds } } },
          { $sort: { event_time: -1 } },
          {
            $group: {
              _id: "$student_id",
              event_type: { $first: "$event_type" },
              event_time: { $first: "$event_time" },
              device: { $first: "$device" },
            },
          },
        ]);
        const eventByStudent = new Map();
        for (const ev of latestEvents) {
          eventByStudent.set(String(ev._id), {
            event_type: ev.event_type,
            // Label legible para mostrar directo en el front sin transformar
            event_type_label: ev.event_type === "entry" ? "Entrada" : "Salida",
            event_time: ev.event_time,
            device: ev.device || null,
            // is_currently_in_institution: derivado
            // entry = "dentro", exit = "fuera"
            is_currently_in_institution: ev.event_type === "entry",
          });
        }
        for (const s of students) {
          s.last_event = eventByStudent.get(String(s._id)) || null;
        }
      }

      // 3b. Grupo del ciclo actual + resumen académico (PROM.) — 1 query batch
      if (students.length > 0) {
        const studentIds = students.map((s) => s._id);
        // Buscar las Enrollments de estos students (del año activo o de todos
        // si no hay year activo)
        const enrollmentFilter = { student_id: { $in: studentIds } };
        if (currentSchoolYear) enrollmentFilter.school_year_id = currentSchoolYear._id;
        const enrollments = await Enrollment.find(enrollmentFilter)
          .select("_id student_id school_year_id group_id")
          .populate("school_year_id", "name")
          .populate("group_id", "grade section shift");
        const enrollmentByStudent = new Map();
        for (const e of enrollments) {
          // Si hay múltiples Enrollments del mismo student (raro), tomar la del año actual
          if (
            !enrollmentByStudent.has(String(e.student_id)) ||
            (currentSchoolYear && String(e.school_year_id?._id) === String(currentSchoolYear._id))
          ) {
            enrollmentByStudent.set(String(e.student_id), e);
          }
        }

        // Grado/grupo del ciclo actual: la Enrollment es la fuente de verdad
        // (no Student.current_group_id, que puede quedar desactualizado).
        // Si el student no tiene Enrollment para el ciclo activo, se deja el
        // fallback que ya trae current_group_id (ver mapeo inicial de students).
        const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
        for (const student of students) {
          const enr = enrollmentByStudent.get(String(student._id));
          const g = enr ? enr.group_id : null;
          if (!g) continue; // sin Enrollment de este ciclo: se conserva el fallback
          student.current_group = {
            _id: g._id,
            grade: g.grade,
            section: g.section,
            school_year_id: enr.school_year_id ? enr.school_year_id._id : null,
            school_year: enr.school_year_id ? enr.school_year_id.name : null,
            shift: g.shift,
          };
          student.group_label =
            g.grade && g.section && g.shift
              ? `${g.grade}°${g.section} - Turno ${capitalize(g.shift)}`
              : null;
        }

        // Buscar las grades de esas Enrollments (1 query)
        const enrollmentIds = enrollments.map((e) => e._id);
        const grades = await Grade.find({
          enrollment_id: { $in: enrollmentIds },
        })
          .select("enrollment_id value subject_id period_order school_year_id")
          .populate("subject_id", "code name")
          .populate("gradingPeriod", "name order");

        // Agrupar grades por student_id
        const gradesByStudent = new Map();
        for (const e of enrollments) {
          if (!gradesByStudent.has(String(e.student_id))) {
            gradesByStudent.set(String(e.student_id), []);
          }
        }
        const enrollmentToStudent = new Map();
        const enrollmentYear = new Map();
        for (const e of enrollments) {
          enrollmentToStudent.set(String(e._id), String(e.student_id));
          enrollmentYear.set(String(e._id), e.school_year_id);
        }
        for (const g of grades) {
          const sid = enrollmentToStudent.get(String(g.enrollment_id));
          if (sid) {
            gradesByStudent.get(sid).push(g);
          }
        }

        // Calcular el resumen para cada student
        const studentMap = new Map(students.map((s) => [String(s._id), s]));
        for (const [sid, gs] of gradesByStudent) {
          const student = studentMap.get(sid);
          if (!student) continue;
          if (gs.length === 0) {
            student.academic_summary = {
              school_year_id: currentSchoolYear ? currentSchoolYear._id : null,
              school_year: currentSchoolYear ? currentSchoolYear.name : null,
              total_grades: 0,
              average: null,
              status: "no_grades",
            };
            // cumulative_gpa ya está en null por la inicialización
            continue;
          }
          const sum = gs.reduce((s, g) => s + g.value, 0);
          const average = sum / gs.length;
          // Por materia (usar subject_id poblado)
          const bySubject = {};
          for (const g of gs) {
            const subjectKey = String(g.subject_id?._id || g.subject_id);
            const subjectName = g.subject_id?.name || subjectKey;
            if (!bySubject[subjectKey]) bySubject[subjectKey] = { name: subjectName, sum: 0, count: 0 };
            bySubject[subjectKey].sum += g.value;
            bySubject[subjectKey].count += 1;
          }
          const bestSubject = Object.entries(bySubject)
            .map(([id, { name, sum, count }]) => ({
              subject_id: id,
              subject: name,
              average: sum / count,
            }))
            .sort((a, b) => b.average - a.average)[0];

          // Promedio Acumulado (KPI #2): media de los promedios por
          // trimestre EVALUADO. Un trimestre cuenta como evaluado si tiene
          // >= 1 Grade en period_order ∈ {1,2,3}. Si ninguno evaluado → null.
          // period_order=0 (calificación final de año) NO se incluye aquí.
          const trimesterBuckets = { 1: { sum: 0, count: 0 }, 2: { sum: 0, count: 0 }, 3: { sum: 0, count: 0 } };
          for (const g of gs) {
            if (g.period_order === 1 || g.period_order === 2 || g.period_order === 3) {
              trimesterBuckets[g.period_order].sum += g.value;
              trimesterBuckets[g.period_order].count += 1;
            }
          }
          const evaluatedAverages = [1, 2, 3]
            .map((p) => trimesterBuckets[p])
            .filter((b) => b.count > 0)
            .map((b) => b.sum / b.count);
          if (evaluatedAverages.length > 0) {
            const cumulative =
              evaluatedAverages.reduce((acc, v) => acc + v, 0) /
              evaluatedAverages.length;
            student.kpis.cumulative_gpa = Math.round(cumulative * 100) / 100;
          }

          const fallbackYear = enrollmentYear.get(String(gs[0].enrollment_id));
          student.academic_summary = {
            school_year_id: currentSchoolYear
              ? currentSchoolYear._id
              : fallbackYear?._id || null,
            school_year: currentSchoolYear
              ? currentSchoolYear.name
              : fallbackYear?.name || null,
            total_grades: gs.length,
            average: Math.round(average * 100) / 100,
            best_subject: bestSubject
              ? { subject_id: bestSubject.subject_id, subject: bestSubject.subject, average: Math.round(bestSubject.average * 100) / 100 }
              : null,
            // Detalle por trimestre (útil para el front aunque no se use hoy)
            by_trimester: [1, 2, 3].map((p) => {
              const b = trimesterBuckets[p];
              return {
                period: p,
                average: b.count > 0 ? Math.round((b.sum / b.count) * 100) / 100 : null,
                evaluated: b.count > 0,
                grades_count: b.count,
              };
            }),
            evaluated_trimesters: evaluatedAverages.length,
            status: "ok",
          };
        }
      }

      // 3c. KPIs del Guardian Dashboard — attendance % y conduct score.
      // cumulative_gpa ya se calculó dentro del bloque 3b (necesita las grades
      // en memoria). Acá calculamos los otros dos con batches paralelos.
      if (students.length > 0 && currentSchoolYear && school) {
        const studentIds = students.map((s) => s._id);
        const schoolId = school._id;
        const yearId = currentSchoolYear._id;
        const yearStart = currentSchoolYear.startDate
          ? new Date(currentSchoolYear.startDate)
          : null;
        const now = new Date();

        // ----- KPI #1: % Asistencia -----
        // Denominador: días distintos del ciclo en los que la escuela
        // tuvo AL MENOS 1 evento de asistencia (proxy de "día lectivo").
        // Esto funciona sin un SchoolDay explícito; si en el futuro se
        // agrega un calendario escolar formal, se prefiere ese lookup.
        const dateRangeMatch = yearStart
          ? { $gte: yearStart, $lte: now }
          : { $lte: now };

        const tenantDaysAgg = await AttendanceLog.aggregate([
          { $match: { school: schoolId, event_time: dateRangeMatch } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$event_time" },
              },
            },
          },
        ]);
        const totalSchoolDays = tenantDaysAgg.length;
        const tenantDaySet = new Set(tenantDaysAgg.map((d) => d._id));

        if (totalSchoolDays > 0) {
          // Días con al menos 1 'entry' por estudiante (dentro del ciclo)
          const studentEntryDaysAgg = await AttendanceLog.aggregate([
            {
              $match: {
                school: schoolId,
                student_id: { $in: studentIds },
                event_type: "entry",
                event_time: dateRangeMatch,
              },
            },
            {
              $group: {
                _id: {
                  student: "$student_id",
                  day: {
                    $dateToString: { format: "%Y-%m-%d", date: "$event_time" },
                  },
                },
              },
            },
          ]);
          // Set de días-entry por student
          const studentDaySet = new Map();
          for (const row of studentEntryDaysAgg) {
            const key = String(row._id.student);
            if (!studentDaySet.has(key)) studentDaySet.set(key, new Set());
            studentDaySet.get(key).add(row._id.day);
          }
          for (const s of students) {
            const daySet = studentDaySet.get(String(s._id)) || new Set();
            // Intersección: solo cuentan los días que la escuela SÍ tuvo
            // evento Y el alumno tuvo un entry
            let attended = 0;
            for (const d of daySet) {
              if (tenantDaySet.has(d)) attended += 1;
            }
            const percentage = Math.round((attended / totalSchoolDays) * 10000) / 100;
            s.kpis.attendance = {
              percentage,
              attended_days: attended,
              total_school_days: totalSchoolDays,
              source: "derived_from_attendance_logs",
            };
          }
        }
        // Si totalSchoolDays == 0, dejamos los defaults (null) ya inicializados

        // ----- KPI #3: Score de Conducta (ledger-style: merits + demerits) -----
        // score = clamp(baseline + sum(merits) - sum(demerits), floor, baseline)
        // La aggregation aplica el signo dentro del $group con $cond:
        //   merit   → +points_impact
        //   demerit → -points_impact
        const conductConfig = await getConductConfig(schoolId);
        const conductAgg = await ConductLog.aggregate([
          {
            $match: {
              school: schoolId,
              student_id: { $in: studentIds },
              status: "active",
            },
          },
          {
            $group: {
              _id: "$student_id",
              signedTotal: {
                $sum: {
                  $cond: [
                    { $eq: ["$eventType", "merit"] },
                    "$points_impact",
                    { $multiply: ["$points_impact", -1] },
                  ],
                },
              },
              total_events: { $sum: 1 },
              demerits_count: {
                $sum: { $cond: [{ $eq: ["$eventType", "demerit"] }, 1, 0] },
              },
              merits_count: {
                $sum: { $cond: [{ $eq: ["$eventType", "merit"] }, 1, 0] },
              },
            },
          },
        ]);
        const conductByStudent = new Map(
          conductAgg.map((c) => [
            String(c._id),
            {
              signedTotal: c.signedTotal,
              total_events: c.total_events,
              demerits_count: c.demerits_count,
              merits_count: c.merits_count,
            },
          ])
        );
        for (const s of students) {
          const c = conductByStudent.get(String(s._id)) || {
            signedTotal: 0,
            total_events: 0,
            demerits_count: 0,
            merits_count: 0,
          };
          const rawScore = conductConfig.baseline + c.signedTotal;
          const score = clampScore(rawScore, conductConfig);
          s.kpis.conduct = {
            score,
            baseline: conductConfig.baseline,
            floor: conductConfig.floor,
            // Detalle para que el front pueda mostrar "X demerits, Y merits"
            signed_total: c.signedTotal,
            total_events: c.total_events,
            demerits_count: c.demerits_count,
            merits_count: c.merits_count,
          };
        }
      }
    }

    // 4. Stats básicos (útiles para el dashboard)
    const total = students.length;
    const active = students.filter((s) => s.status === "active").length;
    const inactive = total - active;

    // Construir la response una sola vez (para cachear y responder)
    const responseBody = {
      user: {
        _id: user._id,
        name: user.name,
        last_name: user.last_name,
        // Saludo pre-formateado para mostrar directo en el front.
        // Si el user no tiene last_name, mostramos solo el name.
        greeting: user.last_name
          ? `${user.name} ${user.last_name}`
          : user.name,
        email: user.email,
        phone_number: user.phoneNumber,
        role: user.role,
        is_active: user.isActive,
      },
      school: school
        ? {
            _id: school._id,
            name: school.name,
            cct: school.cct,
            logo_url: school.logoUrl,
            is_active: school.isActive,
            current_school_year_id: currentSchoolYear ? currentSchoolYear._id : null,
            current_school_year: currentSchoolYear ? currentSchoolYear.name : null,
          }
        : null,
      students,
      stats: {
        total_students: total,
        active_students: active,
        inactive_students: inactive,
      },
    };

    // Guardar en cache (best-effort: si Redis no está, el response sale igual)
    await cache.set(cacheKey, responseBody, DASHBOARD_TTL);
    res.setHeader("X-Cache", "MISS");
    console.log("Datos del body",responseBody);
    return res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/announcements
// Feed unificado de avisos + citatorios para el tutor autenticado.
// Sirve la pantalla "Avisos" del app móvil. Filtra por audiencia:
//   - targetType="general"  → toda la escuela (broadcast)
//   - targetType="group"    → solo si el grupo está en targetGroups
//                              y el grupo es el current_group_id de alguno
//                              de los hijos del tutor
//   - targetType="student"  → solo si el student está en targetStudents
//                              y es hijo del tutor
// También filtra citatorios cuyo `student` sea hijo del tutor y que estén
// en status pending o confirmed (los completed/no_show no se muestran
// como avisos pendientes).
//
// Query params:
//   - student_id (opcional): si viene, filtra a un hijo específico. El
//     tutor DEBE ser Guardian del student; si no, 403.
//   - school_year_id (opcional): default al ciclo activo de la escuela.
//   - limit (opcional): cap del feed (default 50, max 200).
//
// Auth: cualquier user autenticado con tenant context (tutor típico).
// El tutor con 0 hijos registrados recibe items=[].

// ----------------------------------------------------------------
// Helper compartido: enriquece la `audience` de un Announcement.
// Asume que el doc ya tiene los populates de targetGroups (con
// school_year_id populado), targetStudents (con controlNumber) y
// sender. Usado tanto por el feed como por el detail para mantener
// el shape consistente.
// Devuelve: { type, summary, groups: [...], students: [...] }
//   - groups[i]   → { _id, grade, section, shift, school_year_id,
//                     school_year, label, full_label }
//   - students[i] → { _id, first_name, last_name, photoUrl, controlNumber }
//   - summary     → string pre-formateado para mostrar en el front
// ----------------------------------------------------------------
const shiftLabel = (s) =>
  s === "matutino" ? "Matutino" : s === "vespertino" ? "Vespertino" : s;

const enrichAnnouncementAudience = (a) => {
  const groups = (a.targetGroups || []).map((g) => {
    const sy = g.school_year_id;
    return {
      _id: g._id,
      grade: g.grade,
      section: g.section,
      shift: g.shift,
      school_year_id: sy && typeof sy === "object" ? sy._id : sy,
      school_year: sy && typeof sy === "object" ? sy : null,
      label: g.grade && g.section ? `${g.grade}°${g.section}` : null,
      full_label:
        g.grade && g.section
          ? `${g.grade}°${g.section} - ${shiftLabel(g.shift)}`
          : null,
    };
  });

  const students = (a.targetStudents || []).map((s) => ({
    _id: s._id,
    first_name: s.first_name,
    last_name: s.last_name,
    photoUrl: s.photoUrl,
    controlNumber: s.controlNumber,
  }));

  const summary = (() => {
    if (a.targetType === "general") return "Toda la escuela";
    if (a.targetType === "group") {
      const labels = groups.map((g) => g.full_label).filter(Boolean);
      if (labels.length === 0) return "Grupos específicos";
      if (labels.length === 1) return labels[0];
      if (labels.length === 2) return labels.join(" y ");
      return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
    }
    if (a.targetType === "student") {
      const names = students.map(
        (s) => `${s.first_name} ${s.last_name}`.trim()
      );
      if (names.length === 0) return "Alumnos específicos";
      if (names.length === 1) return names[0];
      if (names.length === 2) return names.join(" y ");
      return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
    }
    return null;
  })();

  return { type: a.targetType, summary, groups, students };
};

// Filtra audience.students para que solo incluya los hijos del tutor
// autenticado. Evita exponer nombres de otros alumnos en targetType="student".
const filterAudienceForGuardian = (audience, studentIdSet) => {
  if (audience.type !== "student") return audience;

  const filtered = audience.students.filter((s) =>
    studentIdSet.has(String(s._id))
  );

  const names = filtered.map(
    (s) => `${s.first_name} ${s.last_name}`.trim()
  );
  let summary;
  if (names.length === 0) {
    summary = "Alumnos específicos";
  } else if (names.length === 1) {
    summary = names[0];
  } else if (names.length === 2) {
    summary = names.join(" y ");
  } else {
    summary = `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
  }

  return { ...audience, students: filtered, summary };
};


const getMyAnnouncements = async (req, res, next) => {
  try {
    const { student_id, school_year_id, limit } = req.query;
    const targetSchoolYearId = school_year_id || req.schoolYear;
    const limitNum = Math.min(
      Math.max(parseInt(limit, 10) || 50, 1),
      200
    );

    // 1) Hijos del tutor (mismo patrón que getMyDashboard).
    const guardianRecords = await Guardian.find({
      user_id: req.payload._id,
      school: req.school,
    })
      .select("students")
      .lean();
    const studentIdSet = new Set();
    for (const g of guardianRecords) {
      if (!g.students) continue;
      for (const sid of g.students) studentIdSet.add(String(sid));
    }
    const allStudentIds = [...studentIdSet];
    if (allStudentIds.length === 0) {
      return res.status(200).json({ items: [], total: 0 });
    }

    // 2) Filtro por student_id (chips "Todos" vs un hijo específico).
    let filterStudentIds = allStudentIds;
    if (student_id !== undefined && student_id !== null && student_id !== "") {
      if (!mongoose.Types.ObjectId.isValid(student_id)) {
        return res.status(400).json({ message: "Invalid student_id." });
      }
      if (!studentIdSet.has(String(student_id))) {
        return res.status(403).json({
          message: "You are not a guardian of this student.",
        });
      }
      filterStudentIds = [String(student_id)];
    }

    // 3) Datos de los hijos + sus current_group_id (para el audience filter
    //    de avisos por grupo). Una sola query.
    const students = await Student.find({
      _id: { $in: filterStudentIds },
      school: req.school,
    })
      .select("_id first_name last_name photoUrl current_group_id")
      .lean();
    const studentById = new Map();
    const currentGroupIds = new Set();
    for (const s of students) {
      studentById.set(String(s._id), s);
      if (s.current_group_id) {
        currentGroupIds.add(String(s.current_group_id));
      }
    }

    // 4) Anuncios: audiencia en (general, group intersect, student intersect)
    //    y no vencidos. En paralelo con los citatorios.
    const now = new Date();
    const announcementFilter = {
      school: req.school,
      schoolYear: targetSchoolYearId,
      $and: [
        {
          $or: [
            { targetType: "general" },
            {
              targetType: "student",
              targetStudents: { $in: filterStudentIds },
            },
            // Si no hay grupos resueltos, evitamos meter un $in:[] que
            // MongoDB trata como "no match". Mejor: si currentGroupIds
            // está vacío, esta rama queda inerte.
            ...(currentGroupIds.size > 0
              ? [
                  {
                    targetType: "group",
                    targetGroups: { $in: [...currentGroupIds] },
                  },
                ]
              : []),
          ],
        },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ],
    };

    // 5) Citatorios: solo de los hijos del tutor y no completados/cancelados.
    const citationFilter = {
      school: req.school,
      schoolYear: targetSchoolYearId,
      student: { $in: filterStudentIds },
      status: { $in: ["pending", "confirmed"] },
    };

    const [announcements, citations] = await Promise.all([
      Announcement.find(announcementFilter)
        .populate("sender", "name last_name role")
        .populate({
          path: "targetGroups",
          select: "grade section shift school_year_id",
          populate: {
            path: "school_year_id",
            select: "name startDate endDate isActive",
          },
        })
        .populate(
          "targetStudents",
          "first_name last_name photoUrl controlNumber"
        )
        .sort({ createdAt: -1 })
        .lean(),
      Citation.find(citationFilter)
        .populate("creator", "name last_name role")
        .sort({ scheduledDate: -1 })
        .lean(),
    ]);

    // 6) Formatear al shape unificado que el front espera.
    const items = [];

    for (const a of announcements) {
      const sender = a.sender
        ? {
            _id: a.sender._id,
            name: a.sender.name,
            last_name: a.sender.last_name,
            role: a.sender.role,
          }
        : null;
      items.push({
        _id: a._id,
        kind: "announcement",
        priority: a.priority, // "informative" | "urgent"
        title: a.title,
        message: a.message,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        sender,
        // Audience enriquecida: type, summary, groups[] (con full_label
        // y school_year populado), students[] (con controlNumber).
        audience: filterAudienceForGuardian(enrichAnnouncementAudience(a), studentIdSet),
        // eventDate unifica la fecha para sort/display en el front
        eventDate: a.createdAt,
      });
    }

    for (const c of citations) {
      const s = studentById.get(String(c.student));
      const creator = c.creator
        ? {
            _id: c.creator._id,
            name: c.creator.name,
            last_name: c.creator.last_name,
            role: c.creator.role,
          }
        : null;
      items.push({
        _id: c._id,
        kind: "citation",
        type: c.type, // "academic" | "behavioral" | "administrative"
        location: c.location,
        reason: c.reason,
        scheduledDate: c.scheduledDate,
        status: c.status, // "pending" | "confirmed"
        student: s
          ? {
              _id: s._id,
              first_name: s.first_name,
              last_name: s.last_name,
              photoUrl: s.photoUrl,
            }
          : null,
        creator,
        eventDate: c.scheduledDate,
      });
    }

    // 7) Sort unificado por eventDate DESC, luego cap al limit.
    items.sort((a, b) => new Date(b.eventDate) - new Date(a.eventDate));
    const trimmed = items.slice(0, limitNum);

    res.status(200).json({
      items: trimmed,
      total: items.length,
      truncated: items.length > trimmed.length,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/guardians/me/students/:studentId/citations/:citationId/confirm
// El tutor (Guardian del student) confirma que ASISTIRÁ a la cita.
// Solo permite la transición pending → confirmed. Para `confirmed`,
// `completed` y `no_show` respondemos 409.
// El middleware requireGuardianOf valida que el usuario autenticado es
// Guardian del student. El controller valida que el citatorio pertenece
// a ese student.
//
// NOTA: El User model ahora tiene fcm_token. Se envía push al staff creator
// cuando el tutor confirma un citatorio.
const confirmMyCitation = async (req, res, next) => {
  try {
    const { studentId, citationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(citationId)) {
      return res
        .status(404)
        .json({ message: `No citation with id: ${citationId}` });
    }

    // 1) Verificar que el citatorio existe y pertenece al student.
    //    Filtro multi-tenant por req.school (inyectado por attachSchoolContext).
    const citation = await Citation.findOne({
      _id: citationId,
      student: studentId,
      school: req.school,
    });
    if (!citation) {
      return res
        .status(404)
        .json({ message: `No citation with id: ${citationId} for this student.` });
    }

    // 2) Solo permitimos la transición pending → confirmed desde el tutor.
    if (citation.status !== "pending") {
      return res.status(409).json({
        message: `Cannot confirm citation in status "${citation.status}". Only "pending" citations can be confirmed by the tutor.`,
      });
    }

    citation.status = "confirmed";
    await citation.save();

    // 3) Devolver el citatorio actualizado con populate.
    const populated = await Citation.findById(citation._id)
      .populate("student", "first_name last_name photoUrl controlNumber")
      .populate("creator", "name last_name role")
      .populate("schoolYear", "name startDate endDate isActive")
      .lean();

    // 4) Notificar al staff creator que el tutor confirmó (async).
    process.nextTick(() => {
      (async () => {
        try {
          const guardianName = `${req.payload.name || ""} ${req.payload.last_name || ""}`.trim();
          const result = await notificationService.sendCitationConfirmedNotification(
            populated,
            guardianName
          );
          if (result && result.dispatched > 0) {
            console.log(
              `[citations] Confirmation notification dispatched for citation ${citationId} to staff ${populated.creator?._id}`
            );
          } else {
            console.log(
              `[citations] No confirmation notification dispatched: ${result?.reason || "unknown"}`
            );
          }
        } catch (err) {
          console.error(
            `[citations] Background confirmation notification error for citation ${citationId}: ${err.message}`
          );
        }
      })();
    });

    res.status(200).json({
      message: "Citation confirmed successfully.",
      citation: populated,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/announcements/:id
// Detalle de UN aviso para el tutor. Devuelve el aviso si y solo si la
// audiencia matchea con al menos uno de los hijos del tutor:
//   - targetType="general"  → siempre (si pertenece a la escuela)
//   - targetType="group"    → si algún hijo del tutor tiene current_group_id
//                              en targetGroups
//   - targetType="student"  → si algún targetStudent es hijo del tutor
// Si el aviso no existe O no le corresponde al tutor, respondemos 404
// (sin filtrar la existencia del ID).
//
// Devuelve el doc Announcement con los ENRICHMENTS del helper
// `enrichAnnouncementAudience` spread a nivel raíz:
//   - targetType           → mismo del modelo
//   - targetGroups[i]      → { _id, grade, section, shift, school_year_id,
//                              school_year, label, full_label }
//   - targetStudents[i]    → { _id, first_name, last_name, photoUrl, controlNumber }
//   - audienceSummary      → string pre-formateado
const getMyAnnouncementById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    // 1) Fetch el aviso (multi-tenant).
    const announcement = await Announcement.findOne({
      _id: id,
      school: req.school,
    })
      .populate("sender", "name last_name role")
      .populate({
        path: "targetGroups",
        select: "grade section shift school_year_id",
        populate: {
          path: "school_year_id",
          select: "name startDate endDate isActive",
        },
      })
      .populate(
        "targetStudents",
        "first_name last_name photoUrl controlNumber"
      )
      .populate("schoolYear", "name startDate endDate isActive")
      .lean();

    if (!announcement) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    // 2) Hijos del tutor.
    const guardianRecords = await Guardian.find({
      user_id: req.payload._id,
      school: req.school,
    })
      .select("students")
      .lean();
    const studentIdSet = new Set();
    for (const g of guardianRecords) {
      if (!g.students) continue;
      for (const sid of g.students) studentIdSet.add(String(sid));
    }
    if (studentIdSet.size === 0) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    // 3) Audience match.
    let hasAccess = false;
    if (announcement.targetType === "general") {
      hasAccess = true;
    } else if (announcement.targetType === "group") {
      const students = await Student.find({
        _id: { $in: [...studentIdSet] },
        school: req.school,
      })
        .select("current_group_id")
        .lean();
      const groupIds = new Set();
      for (const s of students) {
        if (s.current_group_id) groupIds.add(String(s.current_group_id));
      }
      const targetGroupIds = (announcement.targetGroups || []).map((g) =>
        String(g._id || g)
      );
      hasAccess = targetGroupIds.some((gid) => groupIds.has(gid));
    } else if (announcement.targetType === "student") {
      const targetStudentIds = (announcement.targetStudents || []).map((s) =>
        String(s._id || s)
      );
      hasAccess = targetStudentIds.some((sid) => studentIdSet.has(sid));
    }

    if (!hasAccess) {
      return res
        .status(404)
        .json({ message: `No announcement with id: ${id}` });
    }

    // 4) Enrichment: spread del helper a nivel raíz, con filtro de privacidad.
    const audience = filterAudienceForGuardian(
      enrichAnnouncementAudience(announcement),
      studentIdSet
    );

    res.status(200).json({
      ...announcement,
      targetType: audience.type,
      targetGroups: audience.groups,
      targetStudents: audience.students,
      audienceSummary: audience.summary,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/guardians/me/citations/:id
// Detalle de UN citatorio para el tutor. Devuelve el citatorio si y solo
// si el `student` del citatorio es hijo del tutor autenticado. Si no
// existe o no le corresponde, respondemos 404 (sin filtrar existencia).
const getMyCitationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    const citation = await Citation.findOne({
      _id: id,
      school: req.school,
    })
      .populate("student", "first_name last_name photoUrl controlNumber")
      .populate("creator", "name last_name role")
      .populate("schoolYear", "name startDate endDate isActive")
      .lean();

    if (!citation) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    // Verificar que el tutor es Guardian del student del citatorio.
    const studentId = citation.student?._id || citation.student;
    const guardian = await Guardian.findOne({
      user_id: req.payload._id,
      school: req.school,
      students: studentId,
    })
      .select("_id")
      .lean();

    if (!guardian) {
      return res.status(404).json({ message: `No citation with id: ${id}` });
    }

    res.status(200).json(citation);
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PATCH /api/guardians/me/students/:studentId/citations/:citationId/request-reschedule
// El tutor solicita reagendar una cita. Body: { reason: string (required) }
//
// Solo permite pending o confirmed. Marca rescheduleRequested: true
// y rescheduleReason. Envía push notification al staff creator.
const requestCitationReschedule = async (req, res, next) => {
  try {
    const { studentId, citationId } = req.params;
    const { reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(citationId)) {
      return res
        .status(404)
        .json({ message: `No citation with id: ${citationId}` });
    }

    // Validar reason
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: "reason is required." });
    }
    const reasonTrim = String(reason).trim();
    if (reasonTrim.length > 500) {
      return res
        .status(400)
        .json({ message: "reason must be at most 500 characters." });
    }

    // 1) Verificar que el citatorio existe y pertenece al student.
    const citation = await Citation.findOne({
      _id: citationId,
      student: studentId,
      school: req.school,
    });
    if (!citation) {
      return res
        .status(404)
        .json({ message: `No citation with id: ${citationId} for this student.` });
    }

    // 2) Solo permitimos pending o confirmed
    if (!["pending", "confirmed"].includes(citation.status)) {
      return res.status(409).json({
        message: `Cannot request reschedule for citation in status "${citation.status}". Only "pending" or "confirmed" citations can be rescheduled.`,
      });
    }

    // 3) Marcar solicitud de reagendación
    citation.rescheduleRequested = true;
    citation.rescheduleReason = reasonTrim;
    await citation.save();

    // 4) Devolver el citatorio actualizado
    const populated = await Citation.findById(citation._id)
      .populate("student", "first_name last_name photoUrl controlNumber")
      .populate("creator", "name last_name role")
      .populate("schoolYear", "name startDate endDate isActive")
      .lean();

    // 5) Notificar al staff creator sobre la solicitud (async)
    process.nextTick(() => {
      (async () => {
        try {
          const guardianName = `${req.payload.name || ""} ${req.payload.last_name || ""}`.trim();
          const result = await notificationService.sendCitationRescheduleRequestNotification(
            populated,
            guardianName,
            reasonTrim
          );
          if (result && result.dispatched > 0) {
            console.log(
              `[citations] Reschedule request notification dispatched for citation ${citationId} to staff ${populated.creator?._id}`
            );
          } else {
            console.log(
              `[citations] No reschedule request notification dispatched: ${result?.reason || "unknown"}`
            );
          }
        } catch (err) {
          console.error(
            `[citations] Background notification error for reschedule request: ${err.message}`
          );
        }
      })();
    });

    res.status(200).json({
      message: "Reschedule request submitted successfully.",
      citation: populated,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllGuardians,
  getGuardiansStats,
  getMyGuardians,
  createGuardian,
  getGuardianById,
  updateGuardian,
  deleteGuardian,
  registerFcmToken,
  clearFcmToken,
  getMyDashboard,
  getMyStudentGrades,
  getMyStudentSchedule,
  getMyStudentAttendanceSummary,
  getMyStudentAttendanceHistory,
  getMyAnnouncements,
  confirmMyCitation,
  requestCitationReschedule,
  getMyAnnouncementById,
  getMyCitationById,
  assignStudentsToGuardian,
  unassignStudentFromGuardian,
};
