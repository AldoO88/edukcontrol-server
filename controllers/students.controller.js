// Controlador de Estudiantes
// Operaciones CRUD sobre el recurso Student, con aislamiento multi-tenant.
// Todas las queries se filtran por la escuela del usuario autenticado
// (req.payload.schoolId), salvo para super_admin que ve todas las escuelas.
const mongoose = require("mongoose");
const Student = require("../models/Student.model");
const AssetVersion = require("../models/AssetVersion.model");
const School = require("../models/School.model");
const Group = require("../models/Group.model");
const Enrollment = require("../models/Enrollment.model");
const cloudinary = require("../config/cloudinary");
const {
  uploadBufferWithRetry,
  saveForRetry,
} = require("../services/cloudinary-upload.service");
const { saveWithControlNumberRetry } = require("../services/control-number.service");

// Migra los assets (logos/fotos) de un student de una escuela a otra.
// Usado cuando se cambia el campo `school` de un Student. Renombra los
// assets en Cloudinary (folder) y actualiza los public_ids en DB.
const moveStudentAssets = async (studentId, oldSchoolId, newSchoolId) => {
  // 1. Listar todas las AssetVersion del student
  const versions = await AssetVersion.find({
    entity_type: "student",
    entity_id: studentId,
    deletedAt: null,
  });

  let moved = 0;
  let failed = 0;
  const updates = [];

  for (const v of versions) {
    // Old path: edukcontrol/schools/<old>/students/photo_<sid>_<ts>
    // New path: edukcontrol/schools/<new>/students/photo_<sid>_<ts>
    const oldPath = `edukcontrol/schools/${oldSchoolId}/students/`;
    const newPath = `edukcontrol/schools/${newSchoolId}/students/`;

    if (!v.public_id.startsWith(oldPath)) {
      // Ya está en otro folder (e.g. legacy), no intentar mover
      continue;
    }

    const newPublicId = v.public_id.replace(oldPath, newPath);
    try {
      await cloudinary.uploader.rename(v.public_id, newPublicId, {
        overwrite: false,
        invalidate: true,
      });
      updates.push({ oldId: v.public_id, newId: newPublicId, isCurrent: v.is_current });
      moved++;
    } catch (err) {
      console.error(
        `[student-move] Failed to rename ${v.public_id} → ${newPublicId}: ${err.message}`
      );
      failed++;
    }
  }

  // 2. Actualizar DB
  if (updates.length > 0) {
    for (const u of updates) {
      await AssetVersion.updateOne(
        { public_id: u.oldId },
        { $set: { public_id: u.newId } }
      );
    }

    // 3. Actualizar Student.photoUrl si era la versión actual
    const student = await Student.findById(studentId).select("photoUrl").lean();
    if (student && student.photoUrl) {
      const match = student.photoUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/);
      const currentPublicId = match ? match[1] : null;
      const updateForCurrent = updates.find((u) => u.oldId === currentPublicId);
      if (updateForCurrent) {
        const newUrl = student.photoUrl.replace(
          /\/upload\/(?:v\d+\/)?.+$/,
          `/upload/${updateForCurrent.newId}`
        );
        await Student.updateOne({ _id: studentId }, { $set: { photoUrl: newUrl } });
        console.log(
          `[student-move] Updated Student ${studentId} photoUrl to new folder`
        );
      }
    }
  }

  return { moved, failed };
};

// Helper: devuelve el filtro base de tenant.
// super_admin no filtra; el resto ve solo su escuela.
const tenantFilter = (req) =>
  req.payload.role === "super_admin" ? {} : { school: req.payload.schoolId };

// POST /api/students/register
// Crea un estudiante. El school se asigna automáticamente desde el JWT
// (super_admin puede especificar otro school en el body).
const createStudent = async (req, res, next) => {
  try {
    const isSuperAdmin = req.payload.role === "super_admin";
    const payload = { ...req.body };

    if (isSuperAdmin) {
      // super_admin DEBE especificar la escuela destino en el body
      if (!payload.school) {
        return res
          .status(400)
          .json({ message: "school is required in body for super_admin." });
      }
    } else {
      // Cualquier otro rol: forzar la escuela del usuario autenticado
      payload.school = req.payload.schoolId;
    }

    const newStudent = await Student.create(payload);
    res.status(201).json(newStudent);
  } catch (error) {
    next(error);
  }
};

// GET /api/students
// Lista paginada y filtrada por tenant.
const getAllStudents = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      group,
      search,
      school_year_id,
      sort = "last_name",
      order = "asc",
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    // Filtro base: tenant + opcionales
    const filter = { ...tenantFilter(req) };
    if (status) filter.status = status;
    if (group && mongoose.Types.ObjectId.isValid(group)) {
      filter.current_group_id = group;
    }
    // school_year_id → alumnos inscritos ("enrolled") en ese ciclo.
    // Bajas/translados/graduados del ciclo quedan fuera; sin el parámetro
    // el comportamiento es idéntico al histórico.
    if (school_year_id && mongoose.Types.ObjectId.isValid(school_year_id)) {
      const enrolledIds = await Enrollment.distinct("student_id", {
        ...tenantFilter(req),
        school_year_id,
        cycle_status: "enrolled",
      });
      filter._id = { $in: enrolledIds };
    }
    if (search) {
      const safe = String(search).trim();
      const regex = new RegExp(
        safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      filter.$or = [
        { first_name: regex },
        { last_name: regex },
        { controlNumber: regex },
        { rfid_card: regex },
        { biometricId: regex },
      ];
    }

    const sortOrder = order === "desc" ? -1 : 1;
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      Student.find(filter)
        .populate("current_group_id", "grade section school_year_id head_teacher_id")
        .sort({ [sort]: sortOrder })
        .skip(skip)
        .limit(limitNum),
      Student.countDocuments(filter),
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

// GET /api/students/:studentId
// findOne con filtro de tenant; nunca usa findById solo.
const getStudentById = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const student = await Student.findOne({
      _id: studentId,
      ...tenantFilter(req),
    })
      .populate("current_group_id", "grade section school_year_id head_teacher_id")
      .populate("guardians", "name lastname relationship phone");

    if (!student) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    res.status(200).json(student);
  } catch (error) {
    next(error);
  }
};

// PUT /api/students/:studentId
// findOneAndUpdate con filtro de tenant.
// Si se intenta cambiar el `school`, se valida la nueva escuela y se
// migran los assets de Cloudinary (logos/fotos) al folder de la nueva escuela.
const updateStudent = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    // Verificar si el body intenta cambiar el `school`
    const newSchoolId = req.body.school;
    const isChangingSchool =
      newSchoolId && newSchoolId !== undefined;

    // Solo super_admin puede cambiar el school (los demás lo tienen bloqueado)
    if (isChangingSchool && req.payload.role !== "super_admin") {
      return res.status(403).json({
        message: "Only super_admin can change a student's school.",
      });
    }

    // Validar la nueva escuela si se está cambiando
    if (isChangingSchool) {
      if (!mongoose.Types.ObjectId.isValid(newSchoolId)) {
        return res.status(400).json({ message: "Invalid school id." });
      }
      const newSchool = await School.findById(newSchoolId);
      if (!newSchool) {
        return res.status(404).json({ message: "Target school not found." });
      }
      if (!newSchool.isActive) {
        return res
          .status(400)
          .json({ message: "Cannot move student to an inactive school." });
      }
    }

    // Obtener el student actual (para detectar cambio de school)
    const currentStudent = await Student.findOne({
      _id: studentId,
      ...tenantFilter(req),
    });
    if (!currentStudent) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const oldSchoolId = currentStudent.school ? String(currentStudent.school) : null;
    const schoolChanged =
      isChangingSchool && oldSchoolId && oldSchoolId !== String(newSchoolId);

    // Evitar que un usuario regular cambie el school (extra safety)
    if (req.payload.role !== "super_admin" && isChangingSchool) {
      delete req.body.school;
    }

    // Normalizar "" → null en campos opcionales. La UI envía "" cuando
    // un select/textarea queda sin elegir; el schema rechaza "" en el
    // enum de sex y "" deja data sucia en strings como `address` /
    // `blood_type` (que luego no se persisten limpiamente como null).
    // Si se manda explícitamente `null` también se respeta (no se toca).
    const nullableStringFields = [
      "sex", "phone", "address", "blood_type", "medical_notes",
    ];
    for (const f of nullableStringFields) {
      if (req.body[f] === "") req.body[f] = null;
    }
    if (req.body.date_of_birth === "") req.body.date_of_birth = null;

    // Validar: isFaceEnrolled requiere biometricId
    if (req.body.isFaceEnrolled === true) {
      const bioId = req.body.biometricId !== undefined ? req.body.biometricId : currentStudent.biometricId;
      if (!bioId) {
        return res.status(400).json({
          message: "Se requiere un ID Biométrico para activar el reconocimiento facial.",
        });
      }
    }

    const updated = await Student.findOneAndUpdate(
      { _id: studentId, ...tenantFilter(req) },
      req.body,
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    // Defensivo: `findOneAndUpdate` no dispara los pre-save hooks, así
    // que si el body setea `current_group_id` por primera vez (p.ej.
    // admin lo asigna directo desde el expediente en vez de vía
    // /api/enrollments/:id) el alumno queda sin controlNumber. Si el
    // update nos dejó en ese estado y tenemos school + grupo, generamos
    // el número vía save() — con retry para evitar E11000 si hay
    // generaciones concurrentes. No fallamos la request si el número
    // no se puede generar; el cambio principal ya quedó.
    if (
      updated &&
      !updated.controlNumber &&
      updated.current_group_id &&
      updated.school
    ) {
      try {
        await saveWithControlNumberRetry(updated);
      } catch (err) {
        console.error(
          `[updateStudent] controlNumber retry failed for ${studentId}:`,
          err.message
        );
      }
    }

    // Si cambió el school, migrar los assets a la nueva carpeta
    if (schoolChanged) {
      console.log(
        `[student-move] Student ${studentId} moved from school ${oldSchoolId} to ${newSchoolId}. Migrating assets...`
      );
      try {
        const result = await moveStudentAssets(
          studentId,
          oldSchoolId,
          String(newSchoolId)
        );
        console.log(
          `[student-move] Asset migration: ${result.moved} moved, ${result.failed} failed`
        );
      } catch (err) {
        // Logueamos pero no fallamos el update — la DB ya está actualizada
        console.error(
          `[student-move] Asset migration failed: ${err.message}`
        );
      }
    }

    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/students/:studentId
// findOneAndDelete con filtro de tenant.
const deleteStudent = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const deleted = await Student.findOneAndDelete({
      _id: studentId,
      ...tenantFilter(req),
    });

    if (!deleted) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    res.status(200).json({ message: "Student deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// POST /api/students/:studentId/photo
// Sube (o reemplaza) la foto del estudiante a Cloudinary con transformaciones
// automáticas: cuadrado 300x300 centrado en la cara, WebP, calidad auto.
// Auth: admin/registrar/super_admin (validado en la ruta).
// Body: multipart/form-data con campo "photo" (imagen JPEG/PNG/WebP, ≤5MB).
const uploadStudentPhoto = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: "No image file provided." });
    }

    // Buscar al estudiante con filtro de tenant
    const student = await Student.findOne({
      _id: studentId,
      ...tenantFilter(req),
    });
    if (!student) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    // Opciones de upload a Cloudinary.
    // Cada re-upload crea una nueva versión (no se sobrescribe).
    // El public_id incluye timestamp para que cada versión sea única.
    // El asset anterior queda en Cloudinary como historial; el job
    // scripts/cleanup-orphan-cloudinary-assets.js puede purgar versiones
    // antiguas que ya no están en Student.photoUrl.
    //
    // eager_async + notification_url: Cloudinary procesa las transformaciones
    // async y notifica por webhook cuando termina. La URL base del webhook
    // viene de CLOUDINARY_NOTIFICATION_URL; si no está, fallback al host
    // del request. En desarrollo, dejar CLOUDINARY_NOTIFICATION_URL vacío.
    const notificationUrl = process.env.CLOUDINARY_NOTIFICATION_URL
      ? `${process.env.CLOUDINARY_NOTIFICATION_URL}/api/webhooks/cloudinary`
      : null;

    const uploadOptions = {
      // Folder por escuela para aislar assets en Cloudinary.
      // student.school es el ObjectId de la escuela; usamos el mismo árbol
      // edukcontrol/schools/<id>/... que los logos para que un borrado
      // total de escuela se haga con un solo delete_folder.
      folder: `edukcontrol/schools/${student.school}/students`,
      public_id: `photo_${student._id}_${Date.now()}`,
      overwrite: false,
      invalidate: true,
      resource_type: "image",
      transformation: [
        {
          width: 300,
          height: 300,
          crop: "fill",
          quality: "auto",
          fetch_format: "webp",
        },
      ],
      ...(notificationUrl
        ? { eager_async: true, notification_url: notificationUrl }
        : {}),
    };

    // Subir con reintentos automáticos (3 intentos, backoff 1s/2s/4s).
    // Si TODOS fallan, persistimos en disco para que el job de cron
    // scripts/retry-pending-uploads.js lo reprocese.
    let cloudinaryResult;
    try {
      cloudinaryResult = await uploadBufferWithRetry(
        req.file.buffer,
        uploadOptions
      );
    } catch (err) {
      const saved = saveForRetry(req.file.buffer, uploadOptions, {
        entity_type: "student",
        entity_id: student._id.toString(),
        endpoint: "POST /api/students/:studentId/photo",
        uploaded_by: req.payload._id,
        lastError: err.message,
      });
      console.error(
        `[student-photo] All retries failed for student ${student._id}. Saved to ${saved.filePath}`
      );
      return res.status(502).json({
        message:
          "Upload failed after all retries. File queued for later retry.",
        queued: true,
        path: saved.filePath,
      });
    }

    // Persistir el secure_url en el Student
    student.photoUrl = cloudinaryResult.secure_url;
    await student.save();

    // Versionado: marcar la versión anterior como no-current y crear la nueva
    await AssetVersion.updateMany(
      { entity_type: "student", entity_id: student._id, is_current: true },
      { $set: { is_current: false } }
    );
    await AssetVersion.create({
      entity_type: "student",
      entity_id: student._id,
      public_id: cloudinaryResult.public_id,
      url: cloudinaryResult.secure_url,
      width: cloudinaryResult.width,
      height: cloudinaryResult.height,
      format: cloudinaryResult.format,
      bytes: cloudinaryResult.bytes,
      is_current: true,
      uploaded_by: req.payload._id,
    });

    res.status(200).json({
      message: "Student photo uploaded successfully.",
      student,
      photo: {
        url: cloudinaryResult.secure_url,
        public_id: cloudinaryResult.public_id,
        width: cloudinaryResult.width,
        height: cloudinaryResult.height,
        format: cloudinaryResult.format,
        bytes: cloudinaryResult.bytes,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/students/:studentId/photo/versions
// Lista el historial de versiones de la foto del estudiante.
// Excluye soft-deleted por default.
const getStudentPhotoVersions = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }
    const versions = await AssetVersion.find({
      entity_type: "student",
      entity_id: studentId,
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .populate("uploaded_by", "name email role");
    res.status(200).json({
      items: versions,
      total: versions.length,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/students/:studentId/photo/rollback
// Body: { version_id }
const rollbackStudentPhoto = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { version_id } = req.body;
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }
    if (!version_id || !mongoose.Types.ObjectId.isValid(version_id)) {
      return res.status(400).json({ message: "Valid version_id is required." });
    }

    const target = await AssetVersion.findOne({
      _id: version_id,
      entity_type: "student",
      entity_id: studentId,
    });
    if (!target) {
      return res.status(404).json({ message: "Version not found for this student." });
    }

    const student = await Student.findById(studentId);
    if (!student) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    await AssetVersion.updateMany(
      { entity_type: "student", entity_id: studentId, is_current: true },
      { $set: { is_current: false } }
    );
    target.is_current = true;
    await target.save();

    student.photoUrl = target.url;
    await student.save();

    res.status(200).json({
      message: "Student photo rolled back successfully.",
      student,
      current_version: target,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/students/:studentId/promote
// Promueve un student al siguiente ciclo escolar. Crea una nueva Enrollment
// para el nuevo grupo, marca la anterior como "graduated" y actualiza
// Student.current_group_id.
//
// Body: { new_group_id, school_year_id? }
//   - new_group_id: ObjectId del Group al que se promueve (debe ser del
//     mismo school que el student)
//   - school_year_id: opcional (se infiere del new_group si no se pasa)
//
// Auth: admin/registrar/super_admin (gestión de ciclo escolar)
const promoteStudent = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const { new_group_id, school_year_id } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }
    if (!new_group_id || !mongoose.Types.ObjectId.isValid(new_group_id)) {
      return res.status(400).json({ message: "Valid new_group_id is required." });
    }

    // Verificar tenant del student
    const student = await Student.findOne({
      _id: studentId,
      ...tenantFilter(req),
    });
    if (!student) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    // Verificar que el nuevo grupo existe y pertenece a la misma escuela
    const newGroup = await Group.findById(new_group_id);
    if (!newGroup) {
      return res.status(404).json({ message: "Target group not found." });
    }
    if (newGroup.school.toString() !== student.school.toString()) {
      return res.status(400).json({
        message: "Cannot promote student to a group from a different school.",
      });
    }

    const targetYearId = school_year_id || newGroup.school_year_id.toString();
    if (!mongoose.Types.ObjectId.isValid(targetYearId)) {
      return res.status(400).json({
        message: "Valid school_year_id is required.",
      });
    }

    // Marcar TODAS las Enrollments previas del mismo año como "graduated"
    // (por si quedaron en "enrolled" del ciclo anterior)
    await Enrollment.updateMany(
      { student_id: studentId, school_year_id: { $ne: targetYearId } },
      { $set: { cycle_status: "graduated" } }
    );

    // Buscar si ya existe una Enrollment para este student + group + year
    // (idempotencia: si la operación se ejecuta dos veces, no duplica)
    const existing = await Enrollment.findOne({
      student_id: studentId,
      group_id: new_group_id,
      school_year_id: targetYearId,
    });
    if (existing) {
      // Reactivar la existente (por si estaba withdrawn y se está re-promoviendo)
      existing.cycle_status = "enrolled";
      await existing.save();
    } else {
      // Crear la nueva Enrollment
      await Enrollment.create({
        student_id: studentId,
        group_id: new_group_id,
        school_year_id: targetYearId,
        cycle_status: "enrolled",
      });
    }

    // Actualizar el current_group_id del student
    student.current_group_id = new_group_id;

    // Preservar el taller elegido: el alumno conserva el MISMO taller (p.ej.
    // OFIMÁTICA) en el nuevo grado/ciclo. Se re-apunta workshop_group_id al
    // grupo taller del nuevo ciclo con el mismo nombre de sección.
    if (student.workshop_group_id) {
      const oldWorkshop = await Group.findOne({
        _id: student.workshop_group_id,
        school: student.school,
        type: "taller",
      }).select("section");
      if (oldWorkshop) {
        const newWorkshop = await Group.findOne({
          school: student.school,
          school_year_id: targetYearId,
          grade: newGroup.grade,
          section: oldWorkshop.section,
          type: "taller",
        }).select("_id");
        if (newWorkshop) {
          student.workshop_group_id = newWorkshop._id;
        }
      }
    }

    await student.save();

    // Devolver el student actualizado con su nuevo grupo
    const updated = await Student.findById(studentId).populate(
      "current_group_id",
      "grade section school_year_id shift head_teacher_id"
    );

    res.status(200).json({
      message: "Student promoted successfully.",
      student: updated,
      new_enrollment_school_year_id: targetYearId,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/students/:studentId/enrollments
// Devuelve el historial académico completo del student: todos los ciclos
// en los que estuvo matriculado, con su grupo y status.
//
// Auth: el propio student (futuro), el tutor dueño, o staff.
const getStudentEnrollments = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    // Verificar que el student existe y pertenece al tenant
    const student = await Student.findOne({
      _id: studentId,
      ...tenantFilter(req),
    }).select("_id");
    if (!student) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const enrollments = await Enrollment.find({ student_id: studentId })
      .populate("group_id", "grade section school_year_id shift head_teacher_id")
      .populate("school_year_id", "name startDate endDate isActive");

    // Más reciente primero (por startDate real del ciclo, no por ObjectId)
    enrollments.sort(
      (a, b) =>
        new Date(b.school_year_id?.startDate || 0) -
        new Date(a.school_year_id?.startDate || 0)
    );

    res.status(200).json({
      items: enrollments,
      total: enrollments.length,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/students/:studentId/academic-history
// Vista consolidada del historial académico completo del student.
// Devuelve el student + todas las Enrollments (ordenadas por año) con su
// grupo populado + un resumen por año (ciclo, grado, status).
//
// Útil para la app móvil: "mostrame TODO el recorrido de Juan en la escuela".
const getStudentAcademicHistory = async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const student = await Student.findOne({
      _id: studentId,
      ...tenantFilter(req),
    }).populate(
      "current_group_id",
      "grade section school_year_id shift head_teacher_id"
    );
    if (!student) {
      return res.status(404).json({ message: `No student with id: ${studentId}` });
    }

    const enrollments = await Enrollment.find({ student_id: studentId })
      .populate("group_id", "grade section school_year_id shift head_teacher_id")
      .populate("school_year_id", "name startDate endDate isActive");

    // Más antiguo primero (historial cronológico, por startDate real)
    enrollments.sort(
      (a, b) =>
        new Date(a.school_year_id?.startDate || 0) -
        new Date(b.school_year_id?.startDate || 0)
    );

    // Resumen por año: agrupa Enrollments por school_year_id
    const byYear = {};
    for (const e of enrollments) {
      const sy = e.school_year_id;
      const key = sy ? String(sy._id) : "unknown";
      if (!byYear[key]) {
        byYear[key] = {
          school_year_id: sy ? sy._id : null,
          school_year: sy ? sy.name : null,
          groups: [],
          current_status: e.cycle_status,
        };
      }
      byYear[key].groups.push({
        grade: e.group_id ? e.group_id.grade : null,
        section: e.group_id ? e.group_id.section : null,
        shift: e.group_id ? e.group_id.shift : null,
        cycle_status: e.cycle_status,
      });
      // Status "actual" = el de la Enrollment más reciente de ese año
      // (si hay enrolled, gana sobre graduated)
      if (e.cycle_status === "enrolled" || byYear[key].current_status === "enrolled") {
        byYear[key].current_status = e.cycle_status;
      }
    }

    res.status(200).json({
      student: {
        _id: student._id,
        controlNumber: student.controlNumber,
        first_name: student.first_name,
        last_name: student.last_name,
        status: student.status,
        photo_url: student.photoUrl,
        current_group: student.current_group_id,
      },
      enrollments,
      history_by_year: Object.values(byYear),
      total_cycles: enrollments.length,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/students/promote-bulk
// Promueve MUCHOS students en un solo request. Típico: en septiembre,
// el admin promueve 30 alumnos de 1°A al nuevo 2°A en un click.
//
// Body: {
//   promotions: [
//     { student_id: "...", new_group_id: "..." },
//     { student_id: "...", new_group_id: "..." },
//     ...
//   ],
//   school_year_id: "..."   // opcional, se infiere de los new_group_id
// }
//
// Response 200: { total, succeeded, failed, results: [...] }
//
// Auth: admin/registrar/super_admin
const promoteStudentsBulk = async (req, res, next) => {
  try {
    const { promotions, school_year_id } = req.body;

    if (!Array.isArray(promotions) || promotions.length === 0) {
      return res
        .status(400)
        .json({ message: "promotions must be a non-empty array." });
    }

    if (promotions.length > 500) {
      return res
        .status(400)
        .json({ message: "Maximum 500 promotions per request." });
    }

    // Validar formato de cada item
    for (const p of promotions) {
      if (!p.student_id || !mongoose.Types.ObjectId.isValid(p.student_id)) {
        return res
          .status(400)
          .json({ message: `Invalid student_id in item: ${JSON.stringify(p)}` });
      }
      if (!p.new_group_id || !mongoose.Types.ObjectId.isValid(p.new_group_id)) {
        return res
          .status(400)
          .json({ message: `Invalid new_group_id in item: ${JSON.stringify(p)}` });
      }
    }

    // Procesar cada promoción. Si una falla, sigue con las demás y
    // reporta el error individual.
    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const p of promotions) {
      try {
        const student = await Student.findOne({
          _id: p.student_id,
          ...tenantFilter(req),
        });
        if (!student) {
          results.push({
            student_id: p.student_id,
            new_group_id: p.new_group_id,
            success: false,
            error: "Student not found in this tenant.",
          });
          failed++;
          continue;
        }

        const newGroup = await Group.findById(p.new_group_id);
        if (!newGroup) {
          results.push({
            student_id: p.student_id,
            new_group_id: p.new_group_id,
            success: false,
            error: "Target group not found.",
          });
          failed++;
          continue;
        }

        if (newGroup.school.toString() !== student.school.toString()) {
          results.push({
            student_id: p.student_id,
            new_group_id: p.new_group_id,
            success: false,
            error: "Cross-school promotion not allowed.",
          });
          failed++;
          continue;
        }

        const targetYearId = school_year_id || newGroup.school_year_id.toString();
        if (!mongoose.Types.ObjectId.isValid(targetYearId)) {
          results.push({
            student_id: p.student_id,
            new_group_id: p.new_group_id,
            success: false,
            error: "Invalid school_year_id.",
          });
          failed++;
          continue;
        }

        // Marcar Enrollments previas como graduated
        await Enrollment.updateMany(
          { student_id: p.student_id, school_year_id: { $ne: targetYearId } },
          { $set: { cycle_status: "graduated" } }
        );

        // Crear o reactivar la nueva Enrollment (idempotente)
        const existing = await Enrollment.findOne({
          student_id: p.student_id,
          group_id: p.new_group_id,
          school_year_id: targetYearId,
        });
        if (existing) {
          existing.cycle_status = "enrolled";
          await existing.save();
        } else {
          await Enrollment.create({
            student_id: p.student_id,
            group_id: p.new_group_id,
            school_year_id: targetYearId,
            cycle_status: "enrolled",
          });
        }

        // Actualizar current_group_id
        student.current_group_id = p.new_group_id;
        await student.save();

        results.push({
          student_id: p.student_id,
          new_group_id: p.new_group_id,
          success: true,
          school_year_id: targetYearId,
        });
        succeeded++;
      } catch (itemErr) {
        results.push({
          student_id: p.student_id,
          new_group_id: p.new_group_id,
          success: false,
          error: itemErr.message,
        });
        failed++;
      }
    }

    res.status(200).json({
      total: promotions.length,
      succeeded,
      failed,
      results,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};

// =====================================================================
// GET /api/students/:studentId/health
// Devuelve la ficha de salud e inclusión de un estudiante.
// =====================================================================
const getStudentHealth = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const schoolId = req.payload.schoolId;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: "ID de alumno inválido." });
    }

    const student = await Student.findOne({
      _id: studentId,
      school: schoolId,
    })
      .select("first_name last_name health_inclusion medical_notes")
      .lean();

    if (!student) {
      return res.status(404).json({ message: "Alumno no encontrado." });
    }

    res.status(200).json({
      success: true,
      data: {
        studentId: student._id,
        firstName: student.first_name,
        lastName: student.last_name,
        healthInclusion: student.health_inclusion || null,
        medicalNotes: student.medical_notes || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================================
// PATCH /api/students/:studentId/health
// Actualiza la ficha de salud e inclusión de un estudiante.
// =====================================================================
const updateStudentHealth = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const schoolId = req.payload.schoolId;
    const updates = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: "ID de alumno inválido." });
    }

    const student = await Student.findOne({
      _id: studentId,
      school: schoolId,
    });

    if (!student) {
      return res.status(404).json({ message: "Alumno no encontrado." });
    }

    // Campos permitidos para actualización
    const allowedFields = [
      "learning_style", "style_hint", "diagnosis",
      "disability_type", "disability_severity",
      "medical_conditions", "medications", "allergies",
      "health_insurance",
      "vaccination_authorization", "protection_civil_authorization",
      "family_socioeconomic",
      "emergency_contacts",
      "home_visits",
      "emergency_contact_name", "emergency_contact_phone",
      "emergency_contact_relationship",
      "last_evaluation_date",
      "notes", "alerts", "medical_notes",
    ];

    // Inicializar health_inclusion si no existe
    if (!student.health_inclusion) {
      student.health_inclusion = {};
    }

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === "medical_notes") {
          student.medical_notes = updates[field];
        } else if (field === "alerts") {
          student.health_inclusion.alerts = updates[field];
        } else if (field === "family_socioeconomic") {
          // Merge profundo para family_socioeconomic
          if (!student.health_inclusion.family_socioeconomic) {
            student.health_inclusion.family_socioeconomic = {};
          }
          Object.assign(student.health_inclusion.family_socioeconomic, updates[field]);
        } else if (field === "emergency_contacts" || field === "home_visits") {
          // Arrays: reemplazar completo
          student.health_inclusion[field] = updates[field];
        } else {
          student.health_inclusion[field] = updates[field];
        }
      }
    }

    await student.save();

    res.status(200).json({
      success: true,
      message: "Ficha de salud actualizada correctamente.",
      data: {
        studentId: student._id,
        healthInclusion: student.health_inclusion,
        medicalNotes: student.medical_notes,
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/students/import
// Import students from Excel/CSV. Creates students + enrollments.
const XLSX = require("xlsx");
const Guardian = require("../models/Guardian.model");
const { ensureTutorUser } = require("../services/tutor-account.service");

const importStudentsFromSpreadsheet = async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: "El archivo Excel es requerido." });
    }

    const { school_year_id, school: schoolBody } = req.body || {};
    const isSuperAdmin = req.payload.role === "super_admin";
    const school = isSuperAdmin ? schoolBody : req.payload.schoolId;

    if (!school) {
      return res.status(400).json({ message: "school es requerido (super_admin debe enviarlo en el body)." });
    }

    if (!school_year_id || !mongoose.Types.ObjectId.isValid(school_year_id)) {
      return res.status(400).json({ message: "school_year_id valido es requerido." });
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (err) {
      return res.status(400).json({ message: `Archivo invalido: ${err.message}` });
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ message: "El archivo no tiene hojas." });

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
    if (rows.length === 0) return res.status(400).json({ message: "El archivo no tiene datos." });
    if (rows.length > 500) return res.status(400).json({ message: "Maximo 500 registros por importacion." });

    const normalizeKey = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    const rowKeyMap = (row) => {
      const out = {};
      for (const k of Object.keys(row)) out[normalizeKey(k)] = row[k];
      return out;
    };

    const groups = await Group.find({ school, school_year_id }).select("_id grade section").lean();
    const groupByLabel = new Map();
    for (const g of groups) groupByLabel.set(`${g.grade}${g.section.toUpperCase()}`, g._id.toString());

    const results = [];
    const toCreate = [];

    for (let i = 0; i < rows.length; i++) {
      const keys = rowKeyMap(rows[i]);
      const curp = String(keys.curp || "").trim().toUpperCase();
      const firstName = String(keys.nombre || keys.firstname || keys.first_name || "").trim();
      const lastName = String(keys.apellido || keys.lastname || keys.last_name || "").trim();
      const group = String(keys.grupo || keys.group || "").trim().toUpperCase();

      if (!curp || curp.length !== 18) { results.push({ index: i, status: "error", errors: ["CURP requerida (18 caracteres)"] }); continue; }
      if (!firstName) { results.push({ index: i, status: "error", curp, errors: ["nombre requerido"] }); continue; }
      if (!lastName) { results.push({ index: i, status: "error", curp, errors: ["apellido requerido"] }); continue; }

      const groupId = group ? groupByLabel.get(group) : null;
      if (group && !groupId) { results.push({ index: i, status: "error", curp, group, errors: [`Grupo "${group}" no encontrado`] }); continue; }

      // Heurística de nombres del tutor (cuando no viene
      // `tutor_apellido`): separar la 1ª palabra (nombres) del
      // resto (apellidos). Con un solo token, apellido queda ""
      // y `ensureTutorUser` usará el nombre como fallback de
      // `User.last_name` para no romper el `required` del modelo.
      const guardianNameRaw = String(keys.tutornombre || keys.guardianname || keys.guardian_name || "").trim();
      const guardianLastNameRaw = String(keys.tutorapellido || keys.guardianlastname || keys.guardian_last_name || keys.lastnametutor || "").trim();
      let guardianName = null;
      let guardianLastName = null;
      if (guardianNameRaw) {
        const parts = guardianNameRaw.split(/\s+/).filter(Boolean);
        guardianName = parts.length > 0 ? parts[0] : null;
        guardianLastName = guardianLastNameRaw
          ? guardianLastNameRaw
          : (parts.length > 1 ? parts.slice(1).join(" ") : "");
      }

      toCreate.push({
        index: i, curp, firstName, lastName, groupId,
        sex: String(keys.sexo || keys.sex || "").trim() || null,
        phone: String(keys.telefono || keys.phone || "").trim() || null,
        address: String(keys.direccion || keys.address || "").trim() || null,
        dateOfBirth: String(keys.fechanacimiento || keys.dateofbirth || keys.date_of_birth || "").trim() || null,
        bloodType: String(keys.tiposangre || keys.bloodtype || keys.blood_type || "").trim() || null,
        // Tutor: aceptamos apellido en columna separada
        // (`tutor_apellido` / `guardian_last_name`). Si no viene,
        // partimos el nombre completo: 1ª palabra → nombres, resto
        // → apellidos (convención MX: paternal y maternal en
        // `lastname`). Si solo hay una palabra, el apellido queda
        // vacío y `ensureTutorUser` hace fallback al nombre.
        guardianName,
        guardianLastName,
        guardianPhone: String(keys.tutortelefono || keys.guardianphone || keys.guardian_phone || "").trim() || null,
        guardianRelationship: String(keys.tutorparentesco || keys.guardianrelationship || keys.guardian_relationship || "").trim() || "tutor legal",
      });
    }

    const created = [];
    const warnings = [];
    for (const item of toCreate) {
      try {
        const existing = await Student.findOne({ school, curp: item.curp });
        if (existing) { results.push({ index: item.index, status: "error", curp: item.curp, errors: ["CURP ya existe"] }); continue; }

        // Convert M/F to male/female
        let sex = null;
        const sexRaw = String(item.sex || "").trim().toUpperCase();
        if (sexRaw === "M" || sexRaw === "MASCULINO") sex = "male";
        else if (sexRaw === "F" || sexRaw === "FEMENINO") sex = "female";

        // Create student with current_group_id so pre-save generates controlNumber
        const student = await Student.create({
          school, curp: item.curp, first_name: item.firstName, last_name: item.lastName,
          sex, phone: item.phone || undefined, address: item.address || undefined,
          date_of_birth: item.dateOfBirth || undefined, blood_type: item.bloodType || undefined,
          current_group_id: item.groupId || null,
        });

        let guardian = null;
        let guardianReused = false;
        let guardianWarned = false; // cualquier `warnings.push` de
                                    // esta fila por tutor marca a la
                                    // fila como "ya cubierta por la
                                    // tabla de avisos" → se omite de
                                    // la lista "Alumnos sin tutor".
        if (item.guardianPhone) {
          // --------------------------------------------------------
          // Reuso de hermanos: si ya existe un Guardian con el mismo
          // {school, phone}, lo reusamos y solo le sumamos el nuevo
          // student — sin necesidad de un nombre en la fila. Un typo
          // en el nombre del Excel NO debe pisar los datos del tutor
          // existente (el teléfono es la identidad del tutor).
          // --------------------------------------------------------
          const existingGuardian = await Guardian.findOne({ school, phone: item.guardianPhone });
          if (existingGuardian) {
            guardian = existingGuardian;
            guardianReused = true;
            // Solo rellenamos campos vacíos para no dejar el registro
            // a medias (import sin nombre de tutor → completamos).
            // Nunca pisamos name/lastname/relationship si ya tienen
            // valor: el teléfono identifica al tutor, sus datos son
            // los del primer registro válido.
            const fillIfEmpty =
              (item.guardianName && (!guardian.name || !guardian.name.trim())) ||
              (item.guardianLastName && (!guardian.lastname || !guardian.lastname.trim())) ||
              (item.guardianRelationship && (!guardian.relationship || !guardian.relationship.trim()));
            if (fillIfEmpty) {
              if (item.guardianName && (!guardian.name || !guardian.name.trim())) guardian.name = item.guardianName.trim();
              if (item.guardianLastName && (!guardian.lastname || !guardian.lastname.trim())) guardian.lastname = item.guardianLastName.trim();
              if (item.guardianRelationship && (!guardian.relationship || !guardian.relationship.trim())) guardian.relationship = item.guardianRelationship.trim();
              await guardian.save();
            }
          } else {
            // No existe: para crear uno nuevo el schema requiere
            // `name`. Si la fila del Excel trae teléfono pero sin
            // nombre, reportamos warning en lugar de tragar al alumno
            // sin tutor silenciosamente.
            if (!item.guardianName) {
              warnings.push({
                index: item.index,
                curp: item.curp,
                status: "warning",
                errors: ["Teléfono del tutor sin nombre: tutor no creado (ya existía en DB se habría reusado)."],
              });
              guardianWarned = true;
            } else {
              try {
                guardian = await Guardian.create({
                  school,
                  name: item.guardianName,
                  lastname: item.guardianLastName || "",
                  phone: item.guardianPhone,
                  relationship: item.guardianRelationship,
                  students: [student._id],
                  notification_prefs: {
                    whatsapp: {
                      opted_in: true,
                      opted_in_at: new Date(),
                      source: "imported_seed",
                    },
                  },
                });
              } catch (gErr) {
                // Si falla (índice único, schema, etc), reportamos el
                // warning en vez de tragarlo silenciosamente como
                // antes. El alumno se conserva igualmente.
                warnings.push({
                  index: item.index,
                  curp: item.curp,
                  status: "warning",
                  errors: [
                    `No se pudo crear el tutor (${gErr.code === 11000 ? "teléfono duplicado" : gErr.message})`,
                  ],
                });
                guardianWarned = true;
              }
            }
          }

          if (guardian) {
            // Vincular el guardian al student (réplica de la rama
            // original, pero solo si el guardian existe).
            student.guardians = Array.from(new Set([...(student.guardians || []).map(String), guardian._id.toString()]))
              .map((id) => new mongoose.Types.ObjectId(id));
            await student.save();

            // Mirror: en la rama de REUSO (`existingGuardian`) el
            // tutor ya existía en la DB y NO recibió al alumno en su
            // array `students` (en la rama de alta nueva, eso lo hace
            // el `Guardian.create({ students: [student._id] })`).
            // Sin este $addToSet, el tutor queda "asignado" al alumno
            // por el lado Student pero el conteo de `students` en el
            // Guardian queda desincronizado y la asignación por ID no
            // funcionaría si la escuela cambia de opinión. Misma
            // idempotencia que `POST /api/guardians/:id/students`.
            if (guardianReused) {
              await Guardian.updateOne(
                { _id: guardian._id },
                { $addToSet: { students: student._id } }
              );
            }

            // Crear/vincular User tutor. `phone_taken` no es
            // fatal: el alumno y el guardian se conservan; el
            // administrador verá el warning en el resumen.
            const tutRes = await ensureTutorUser({
              school,
              name: guardian.name,
              lastname: guardian.lastname,
              phone: guardian.phone,
            });
            if (tutRes.ok) {
              if (
                !guardian.user_id ||
                guardian.user_id.toString() !== tutRes.user._id.toString()
              ) {
                guardian.user_id = tutRes.user._id;
                await guardian.save();
              }
              if (!guardian.notification_prefs?.whatsapp?.opted_in) {
                await Guardian.updateOne(
                  { _id: guardian._id },
                  {
                    $set: {
                      "notification_prefs.whatsapp": {
                        opted_in: true,
                        opted_in_at: new Date(),
                        source: "imported_seed",
                      },
                    },
                  }
                );
              }
            } else if (tutRes.reason === "phone_taken") {
              warnings.push({
                index: item.index,
                curp: item.curp,
                status: "warning",
                errors: [tutRes.message],
              });
              guardianWarned = true;
            }
          }
        }

        const enrollment = await Enrollment.create({
          school, school_year_id, student_id: student._id,
          group_id: item.groupId || null, cycle_status: "enrolled",
        });

        const okRow = {
          index: item.index,
          status: "ok",
          curp: item.curp,
          studentId: student._id,
          enrollmentId: enrollment._id,
        };
        // Si se vinculó a un tutor existente por teléfono, lo
        // marcamos para que el admin vea "Tutor reusado: X" en el
        // resumen de la importación (y para distinguirlo del alta
        // de un tutor nuevo).
        if (guardian && guardianReused) {
          okRow.guardian_reused = true;
          okRow.guardian = `${guardian.name}${guardian.lastname ? " " + guardian.lastname : ""}`;
        }
        // Si la fila quedó sin tutor y no se reportó un warning
        // específico para esa fila (teléfono sin nombre, error de
        // creación o `phone_taken`), la añadimos a la lista
        // "Alumnos sin tutor" del resumen para que el admin sepa
        // a quién dar seguimiento. El alumno se conserva igual
        // (es un OK, no un error).
        if (!guardian && !guardianWarned) {
          okRow.guardian_missing = true;
          okRow.student_name = `${item.firstName || ""} ${item.lastName || ""}`.trim();
          okRow.guardian_missing_reason = item.guardianName
            ? "missing_phone"  // tenía nombre del tutor pero faltó el celular
            : "no_data";       // la fila no traía datos de tutor
        }
        // Si la fila no traía columna `grupo`, el alumno y su
        // enrollment nacen sin grupo → el pre-save de Student no puede
        // generar el controlNumber (depende de grade+shift del grupo).
        // Marcamos la fila para que aparezca en "Alumnos sin grupo —
        // número de control pendiente hasta asignar" en el resumen.
        // El alumno se conserva igual; el admin puede asignar el grupo
        // después desde la UI (lo que dispara syncStudentCurrentGroup y
        // genera el número con el último consecutivo del grado).
        if (!item.groupId) {
          okRow.pending_group = true;
          okRow.student_name = `${item.firstName || ""} ${item.lastName || ""}`.trim();
          okRow.pending_group_reason = "no_grupo";
        }
        created.push(okRow);
      } catch (err) {
        results.push({ index: item.index, status: "error", curp: item.curp, errors: [err.code === 11000 ? "Duplicado" : err.message] });
      }
    }

    const allResults = [...results, ...warnings, ...created].sort((a, b) => a.index - b.index);
    res.status(200).json({
      total: rows.length,
      succeeded: created.length,
      failed: results.length,
      warnings: warnings.length,
      results: allResults,
    });
  } catch (error) { next(error); }
};

// =====================================================================
// GET /api/students/export
// Exporta el padrón a Excel (.xlsx): numero de control, nombre completo,
// genero, RFID, grado y grupo. Mismos filtros opcionales que
// getAllStudents (status, group, search, school_year_id) SIN paginación.
// =====================================================================
const exportStudentsToExcel = async (req, res, next) => {
  try {
    const { status, group, search, school_year_id } = req.query;

    const filter = { ...tenantFilter(req) };
    if (status) filter.status = status;
    if (group && mongoose.Types.ObjectId.isValid(group)) {
      filter.current_group_id = group;
    }
    if (school_year_id && mongoose.Types.ObjectId.isValid(school_year_id)) {
      const enrolledIds = await Enrollment.distinct("student_id", {
        ...tenantFilter(req),
        school_year_id,
        cycle_status: "enrolled",
      });
      filter._id = { $in: enrolledIds };
    }
    if (search) {
      const safe = String(search).trim();
      const regex = new RegExp(
        safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      filter.$or = [
        { first_name: regex },
        { last_name: regex },
        { controlNumber: regex },
        { rfid_card: regex },
      ];
    }

    const students = await Student.find(filter)
      .select("controlNumber first_name last_name sex rfid_card current_group_id")
      .populate("current_group_id", "grade section type")
      .sort({ last_name: 1, first_name: 1 })
      .lean();

    // "Masculino"/"Femenino" en minusculas NO revienta el import:
    // importStudentsFromSpreadsheet hace .toUpperCase() y matchea
    // MASCULINO/FEMENINO → male/female, así el export re-importa limpio.
    const genderLabel = { male: "Masculino", female: "Femenino" };
    const rows = students.map((s) => {
      // Grupo en el mismo formato que espera el import (1A, 2D…:
      // `${grade}${section}` — ver groupByLabel en importStudentsFromSpreadsheet)
      const g = s.current_group_id;
      const grade = g && g.grade != null ? g.grade : "";
      const section = g && g.section ? String(g.section).toUpperCase() : "";
      return [
        s.controlNumber || "",
        `${s.last_name || ""} ${s.first_name || ""}`.trim(),
        genderLabel[s.sex] || "",
        s.rfid_card || "",
        grade,
        g && g.grade != null && section ? `${g.grade}${section}` : "",
      ];
    });

    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Numero de Control", "Nombre Completo", "Genero", "RFID", "Grado", "Grupo"],
      ...rows,
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Alumnos");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const filename = `alumnos-${new Date().toISOString().slice(0, 10)}.xlsx`.replace(
      /[^a-zA-Z0-9.-]/g,
      "_"
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createStudent,
  getAllStudents,
  exportStudentsToExcel,
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
};
