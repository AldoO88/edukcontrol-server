// Controlador de Ciclos Escolares (SchoolYear)
// CRUD del catálogo de ciclos por escuela + activación del ciclo vigente.
// Tenant-scoped: cada escuela solo ve/gestiona sus propios ciclos.
const mongoose = require("mongoose");
const SchoolYear = require("../models/SchoolYear.model");
const School = require("../models/School.model");
const GroupTemplate = require("../models/GroupTemplate.model");
const Group = require("../models/Group.model");

// Scope multi-tenant compartido: soporta `?school=<oid>` SOLO para
// super_admin (el panel web navega cross-tenant). Para el resto de
// roles el parámetro se ignora y el tenant sale del JWT.
const { tenantFilter } = require("../utils/school-scope");

// GET /api/school-years
const getAllSchoolYears = async (req, res, next) => {
  try {
    const filter = { ...tenantFilter(req) };
    const items = await SchoolYear.find(filter).sort({ startDate: -1 });
    res.status(200).json({ items, total: items.length });
  } catch (error) {
    next(error);
  }
};

// POST /api/school-years
// Body: { name, startDate, endDate, school? (solo super_admin) }
const createSchoolYear = async (req, res, next) => {
  try {
    const isSuperAdmin = req.payload.role === "super_admin";
    const { name, startDate, endDate, workingDays } = req.body;

    if (!name || !startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "name, startDate, and endDate are required." });
    }

    const school = isSuperAdmin ? req.body.school : req.payload.schoolId;
    if (!school) {
      return res
        .status(400)
        .json({ message: "school is required in body for super_admin." });
    }

    const doc = { school, name, startDate, endDate };
    if (Array.isArray(workingDays) && workingDays.length > 0) {
      doc.workingDays = workingDays;
    }

    const newSchoolYear = await SchoolYear.create(doc);

    // Clonar GroupTemplates al nuevo ciclo como Group
    const templates = await GroupTemplate.find({ school });
    let clonedGroups = 0;
    if (templates.length > 0) {
      const groupInserts = templates.map((t) => ({
        school,
        school_year_id: newSchoolYear._id,
        grade: t.grade,
        section: t.section,
        type: t.type || "regular",
        shift: t.shift || "matutino",
      }));
      await Group.insertMany(groupInserts);
      clonedGroups = groupInserts.length;
    }

    res.status(201).json({ ...newSchoolYear.toObject(), clonedGroups });
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "This school year already exists for this school." });
    }
    next(error);
  }
};

// GET /api/school-years/:schoolYearId
const getSchoolYearById = async (req, res, next) => {
  try {
    const { schoolYearId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    const schoolYear = await SchoolYear.findOne({
      _id: schoolYearId,
      ...tenantFilter(req),
    });

    if (!schoolYear) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    res.status(200).json(schoolYear);
  } catch (error) {
    next(error);
  }
};

// PUT /api/school-years/:schoolYearId
const updateSchoolYear = async (req, res, next) => {
  try {
    const { schoolYearId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    if (req.payload.role !== "super_admin") {
      delete req.body.school;
    }
    // isActive se gestiona exclusivamente vía POST /:schoolYearId/activate
    delete req.body.isActive;

    const updated = await SchoolYear.findOneAndUpdate(
      { _id: schoolYearId, ...tenantFilter(req) },
      req.body,
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    res.status(200).json(updated);
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "This school year already exists for this school." });
    }
    next(error);
  }
};

// DELETE /api/school-years/:schoolYearId
const deleteSchoolYear = async (req, res, next) => {
  try {
    const { schoolYearId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    const deleted = await SchoolYear.findOneAndDelete({
      _id: schoolYearId,
      ...tenantFilter(req),
    });

    if (!deleted) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    res.status(200).json({ message: "School year deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// POST /api/school-years/:schoolYearId/activate
// Marca este ciclo como el vigente de su escuela: desactiva cualquier otro
// ciclo activo de la misma escuela y sincroniza School.current_school_year_id.
const activateSchoolYear = async (req, res, next) => {
  try {
    const { schoolYearId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    const schoolYear = await SchoolYear.findOne({
      _id: schoolYearId,
      ...tenantFilter(req),
    });

    if (!schoolYear) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    await SchoolYear.updateMany(
      { school: schoolYear.school, isActive: true },
      { $set: { isActive: false } }
    );
    schoolYear.isActive = true;
    await schoolYear.save();

    await School.findByIdAndUpdate(schoolYear.school, {
      current_school_year_id: schoolYear._id,
    });

    res.status(200).json({
      message: "School year activated successfully.",
      schoolYear,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/school-years/:schoolYearId/deactivate
// Desactiva un ciclo escolar (lo marca como inactivo).
const deactivateSchoolYear = async (req, res, next) => {
  try {
    const { schoolYearId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    const schoolYear = await SchoolYear.findOne({
      _id: schoolYearId,
      ...tenantFilter(req),
    });

    if (!schoolYear) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    if (!schoolYear.isActive) {
      return res
        .status(400)
        .json({ message: "This school year is already inactive." });
    }

    schoolYear.isActive = false;
    await schoolYear.save();

    // Si era el ciclo vigente de la escuela, limpiar la referencia
    const school = await mongoose.model("School").findById(schoolYear.school);
    if (school && String(school.current_school_year_id) === String(schoolYear._id)) {
      school.current_school_year_id = null;
      await school.save();
    }

    res.status(200).json({
      message: "School year deactivated successfully.",
      schoolYear,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllSchoolYears,
  createSchoolYear,
  getSchoolYearById,
  updateSchoolYear,
  deleteSchoolYear,
  activateSchoolYear,
  deactivateSchoolYear,
};

// POST /api/school-years/:schoolYearId/clone
// Clona la configuración del ciclo anterior al nuevo ciclo.
// Copia: SchoolShifts, TeacherSubjects, Groups, GradingPeriods, ClassSchedules.
const SchoolShift = require("../models/SchoolShift.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const GradingPeriod = require("../models/GradingPeriod.model");
const ClassSchedule = require("../models/ClassSchedule.model");

const cloneSchoolYear = async (req, res, next) => {
  try {
    const { schoolYearId } = req.params;
    const { sourceSchoolYearId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(schoolYearId)) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    if (!sourceSchoolYearId || !mongoose.Types.ObjectId.isValid(sourceSchoolYearId)) {
      return res
        .status(400)
        .json({ message: "sourceSchoolYearId is required and must be a valid ObjectId." });
    }

    const targetYear = await SchoolYear.findOne({
      _id: schoolYearId,
      ...tenantFilter(req),
    });

    if (!targetYear) {
      return res
        .status(404)
        .json({ message: `No school year with id: ${schoolYearId}` });
    }

    const sourceYear = await SchoolYear.findOne({
      _id: sourceSchoolYearId,
      ...tenantFilter(req),
    });

    if (!sourceYear) {
      return res
        .status(404)
        .json({ message: `Source school year not found or not in same school.` });
    }

    if (sourceYear.school.toString() !== targetYear.school.toString()) {
      return res
        .status(400)
        .json({ message: "Source and target school years must belong to the same school." });
    }

    const schoolId = targetYear.school;
    const cloned = {};

    // 1. Clonar SchoolShifts
    const sourceShifts = await SchoolShift.find({ school: schoolId, school_year_id: sourceSchoolYearId });
    if (sourceShifts.length > 0) {
      const shiftInserts = sourceShifts.map((s) => ({
        school: schoolId,
        school_year_id: schoolYearId,
        name: s.name,
        shift: s.shift,
        startTime: s.startTime,
        endTime: s.endTime,
        moduleDurationMinutes: s.moduleDurationMinutes,
        gracePeriodMinutes: s.gracePeriodMinutes,
        timeBlocks: s.timeBlocks.map((tb) => ({
          name: tb.name,
          startTime: tb.startTime,
          endTime: tb.endTime,
          isBreak: tb.isBreak,
          order: tb.order,
        })),
      }));
      const insertedShifts = await SchoolShift.insertMany(shiftInserts);
      cloned.shifts = insertedShifts.length;

      // Mapear viejos IDs a nuevos IDs para ClassSchedule
      const shiftIdMap = {};
      sourceShifts.forEach((oldS, i) => {
        shiftIdMap[oldS._id.toString()] = insertedShifts[i]._id.toString();
      });

      // 2. Clonar ClassSchedules (depende de shifts)
      const sourceSchedules = await ClassSchedule.find({
        school_year_id: sourceSchoolYearId,
      }).lean();
      if (sourceSchedules.length > 0) {
        const scheduleInserts = sourceSchedules.map((cs) => ({
          school: schoolId,
          school_year_id: schoolYearId,
          group_id: cs.group_id,
          subject_id: cs.subject_id,
          teacher_id: cs.teacher_id,
          school_shift_id: shiftIdMap[cs.school_shift_id?.toString()] || cs.school_shift_id,
          scheduleSlots: cs.scheduleSlots,
        }));
        const insertedSchedules = await ClassSchedule.insertMany(scheduleInserts);
        cloned.schedules = insertedSchedules.length;
      }
    }

    // 3. Clonar Groups
    const sourceGroups = await Group.find({ school: schoolId, school_year_id: sourceSchoolYearId });
    if (sourceGroups.length > 0) {
      const groupInserts = sourceGroups.map((g) => ({
        school: schoolId,
        school_year_id: schoolYearId,
        grade: g.grade,
        section: g.section,
        type: g.type,
        shift: g.shift,
        head_teacher_id: g.head_teacher_id,
      }));
      const insertedGroups = await Group.insertMany(groupInserts);
      cloned.groups = insertedGroups.length;

      // Mapear viejos IDs a nuevos IDs para TeacherSubject
      const groupIdMap = {};
      sourceGroups.forEach((oldG, i) => {
        groupIdMap[oldG._id.toString()] = insertedGroups[i]._id.toString();
      });

      // 4. Clonar TeacherSubjects (depende de groups)
      const sourceTeacherSubjects = await TeacherSubject.find({
        school: schoolId,
        school_year_id: sourceSchoolYearId,
      });
      if (sourceTeacherSubjects.length > 0) {
        const tsInserts = sourceTeacherSubjects.map((ts) => ({
          school: schoolId,
          school_year_id: schoolYearId,
          teacher_id: ts.teacher_id,
          subject_id: ts.subject_id,
          group_id: groupIdMap[ts.group_id?.toString()] || ts.group_id,
        }));
        const insertedTS = await TeacherSubject.insertMany(tsInserts);
        cloned.teacherSubjects = insertedTS.length;
      }
    }

    // 5. Clonar GradingPeriods
    const sourcePeriods = await GradingPeriod.find({ school: schoolId, school_year_id: sourceSchoolYearId });
    if (sourcePeriods.length > 0) {
      const periodInserts = sourcePeriods.map((p) => ({
        school: schoolId,
        school_year_id: schoolYearId,
        name: p.name,
        order: p.order,
        startDate: p.startDate,
        endDate: p.endDate,
        isClosed: false,
      }));
      const insertedPeriods = await GradingPeriod.insertMany(periodInserts);
      cloned.periods = insertedPeriods.length;
    }

    res.status(201).json({
      message: "School year cloned successfully.",
      cloned,
    });
  } catch (error) {
    next(error);
  }
};

// Agregar al module.exports
module.exports.cloneSchoolYear = cloneSchoolYear;
