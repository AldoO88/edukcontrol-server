// Controlador de Grupos
// Operaciones CRUD sobre el recurso Group, con aislamiento multi-tenant.
const mongoose = require("mongoose");
const Group = require("../models/Group.model");
const Enrollment = require("../models/Enrollment.model");
const ClassSchedule = require("../models/ClassSchedule.model");
const SchoolShift = require("../models/SchoolShift.model");
const Student = require("../models/Student.model");

const DAYS_NAMES = {
  0: "Domingo",
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
};

// Scope multi-tenant compartido (soporta ?school= para super_admin).
const { tenantFilter } = require("../utils/school-scope");

// GET /api/groups
// Query params opcionales:
//   - school: acota a esa escuela (solo super_admin)
//   - school_year_id: filtra por ciclo específico (ObjectId de SchoolYear)
//   - grade: filtra por grado (1, 2, 3)
//   - section: filtra por sección (case-insensitive)
const getAllGroups = async (req, res, next) => {
  try {
    const filter = { ...tenantFilter(req) };
    if (req.query.school_year_id && mongoose.Types.ObjectId.isValid(req.query.school_year_id)) {
      filter.school_year_id = req.query.school_year_id;
    }
    if (req.query.grade) {
      const g = parseInt(req.query.grade, 10);
      if (!Number.isNaN(g)) filter.grade = g;
    }
    if (req.query.section) {
      filter.section = String(req.query.section).toUpperCase();
    }

    const groups = await Group.find(filter)
      .populate("head_teacher_id", "name last_name email role")
      .populate("school_year_id", "name startDate endDate isActive")
      .sort({ grade: 1, section: 1 });
    res.status(200).json(groups);
  } catch (error) {
    next(error);
  }
};

// POST /api/groups
const createGroup = async (req, res, next) => {
  try {
    const isSuperAdmin = req.payload.role === "super_admin";
    const payload = { ...req.body };

    if (isSuperAdmin) {
      if (!payload.school) {
        return res
          .status(400)
          .json({ message: "school is required in body for super_admin." });
      }
    } else {
      payload.school = req.payload.schoolId;
    }

    const newGroup = await Group.create(payload);
    res.status(201).json(newGroup);
  } catch (error) {
    next(error);
  }
};

// GET /api/groups/:groupId
const getGroupById = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    const group = await Group.findOne({
      _id: groupId,
      ...tenantFilter(req),
    })
      .populate("head_teacher_id", "name last_name email role")
      .populate("school_year_id", "name startDate endDate isActive");

    if (!group) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    res.status(200).json(group);
  } catch (error) {
    next(error);
  }
};

// PUT /api/groups/:groupId
const updateGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    if (req.payload.role !== "super_admin") {
      delete req.body.school;
    }

    const updated = await Group.findOneAndUpdate(
      { _id: groupId, ...tenantFilter(req) },
      req.body,
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/groups/:groupId
const deleteGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    const deleted = await Group.findOneAndDelete({
      _id: groupId,
      ...tenantFilter(req),
    });

    if (!deleted) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    res.status(200).json({ message: "Group deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// GET /api/groups/:groupId/students
// Devuelve TODOS los estudiantes que estuvieron (o están) en este grupo,
// a lo largo de todos los ciclos escolares. Usa la junction table Enrollment
// para resolver la lista histórica, e incluye el status de cada uno
// (enrolled/graduated/withdrawn/transferred).
//
// Útil para: "¿Quiénes estaban en 1°A en 2023-2024?" o "¿Cuántos alumnos
// pasaron por este grupo en total?"
const getGroupStudents = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    // Verificar que el grupo existe y pertenece al tenant
    const group = await Group.findOne({
      _id: groupId,
      ...tenantFilter(req),
    });
    if (!group) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    // Buscar alumnos del grupo.
    // Para grupos regulares: via Enrollment (histórico).
    // Para grupos taller: via Student.workshop_group_id.
    let items = [];

    if (group.type === "taller") {
      // Grupo taller: alumnos asignados via Student.workshop_group_id
      const tallerStudents = await Student.find({
        school: group.school,
        status: "active",
        workshop_group_id: groupId,
      })
        .select("_id")
        .lean();

      const tallerStudentIds = tallerStudents.map((s) => s._id);

      if (tallerStudentIds.length > 0) {
        items = await Enrollment.find({
          student_id: { $in: tallerStudentIds },
          cycle_status: "enrolled",
        })
          .populate("student_id", "controlNumber first_name last_name status photoUrl current_group_id")
          .populate("school_year_id", "name startDate endDate isActive")
          .sort({ createdAt: -1 });
      }
    } else {
      // Grupo regular: buscar alumnos via Enrollment (histórico)
      items = await Enrollment.find({ group_id: groupId })
        .populate("student_id", "controlNumber first_name last_name status photoUrl current_group_id")
        .populate("school_year_id", "name startDate endDate isActive")
        .sort({ createdAt: -1 });
    }

    res.status(200).json({
      group: {
        _id: group._id,
        grade: group.grade,
        section: group.section,
        school_year_id: group.school_year_id,
        shift: group.shift,
      },
      items,
      total: items.length,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/groups/:groupId/schedule
// Devuelve el horario semanal de un grupo agrupado por día.
// Para grupos regulares, fusiona el horario del grupo de origen con el de los
// grupos taller de los alumnos (Tecnología se imparte en talleres transversales).
const getGroupSchedule = async (req, res, next) => {
  try {
    
    const { groupId } = req.params;
    console.log(groupId);
    const schoolId = req.school;
    const schoolYearId = req.schoolYear;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    const group = await Group.findOne({ _id: groupId, ...tenantFilter(req) }).lean();
    if (!group) {
      return res.status(404).json({ message: `No group with id: ${groupId}` });
    }

    // 1. Buscar IDs únicos de grupos taller de los alumnos de este grupo
    const tallerGroupIds = [];
    if (group.type === "regular") {
      const tallerStudents = await Student.find({
        school: schoolId,
        status: "active",
        workshop_group_id: { $ne: null },
      })
        .select("workshop_group_id")
        .lean();

      // Solo los que tienen enrollment en este grupo
      const enrollments = await Enrollment.find({
        school: schoolId,
        group_id: groupId,
        school_year_id: schoolYearId,
        cycle_status: "enrolled",
      })
        .select("student_id")
        .lean();

      const enrolledStudentIds = new Set(enrollments.map((e) => String(e.student_id)));
      for (const s of tallerStudents) {
        if (enrolledStudentIds.has(String(s._id))) {
          tallerGroupIds.push(s.workshop_group_id);
        }
      }
    }

    // 2. Buscar ClassSchedule del grupo de origen + grupos taller
    const groupIdsToFetch = [new mongoose.Types.ObjectId(groupId)];
    for (const tgId of tallerGroupIds) {
      groupIdsToFetch.push(tgId);
    }

    const schedules = await ClassSchedule.find({
      school: schoolId,
      school_year_id: schoolYearId,
      group_id: { $in: groupIdsToFetch },
      isActive: true,
    })
      .populate("subject_id", "code name classificationType color icon")
      .populate("teacher_id", "name last_name")
      .populate("school_shift_id", "name shift startTime endTime timeBlocks")
      .lean();

    if (schedules.length === 0) {
      return res.status(200).json({
        group: {
          _id: group._id,
          grade: group.grade,
          section: group.section,
          label: `${group.grade}°${group.section}`,
          shift: group.shift,
          type: group.type || "regular",
        },
        shift_info: null,
        schedule: {},
      });
    }

    // Set de IDs de grupos taller para marcar las sesiones
    const tallerGroupIdSet = new Set(tallerGroupIds.map(String));

    // Recopilar SchoolShifts únicos
    const shiftMap = new Map();
    for (const s of schedules) {
      if (s.school_shift_id && !shiftMap.has(String(s.school_shift_id._id))) {
        shiftMap.set(String(s.school_shift_id._id), s.school_shift_id);
      }
    }

    // Construir horario agrupado por día (1=Lunes…5=Viernes)
    const scheduleByDay = {};

    for (let day = 1; day <= 5; day++) {
      const dayClasses = [];

      for (const sched of schedules) {
        const shift = sched.school_shift_id;
        if (!shift || !sched.scheduleSlots) continue;

        const isTaller = tallerGroupIdSet.has(String(sched.group_id));

        for (const slot of sched.scheduleSlots) {
          if (slot.dayOfWeek !== day) continue;

          // Resolver timeBlocks del slot
          const wanted = new Set(slot.timeBlockRefs.map(String));
          const blocks = (shift.timeBlocks || [])
            .filter((b) => wanted.has(String(b._id)))
            .sort((a, b) => a.order - b.order);
          if (blocks.length === 0) continue;

          dayClasses.push({
            subject_id: sched.subject_id?._id || null,
            subject: sched.subject_id?.name || null,
            subject_code: sched.subject_id?.code || null,
            classificationType: sched.subject_id?.classificationType || null,
            color: sched.subject_id?.color || null,
            icon: sched.subject_id?.icon || null,
            teacher: sched.teacher_id
              ? `${sched.teacher_id.name} ${sched.teacher_id.last_name || ""}`.trim()
              : null,
            start: blocks[0].startTime,
            end: blocks[blocks.length - 1].endTime,
            startMinutes:
              parseInt(blocks[0].startTime.split(":")[0]) * 60 +
              parseInt(blocks[0].startTime.split(":")[1]),
            endMinutes:
              parseInt(blocks[blocks.length - 1].endTime.split(":")[0]) * 60 +
              parseInt(blocks[blocks.length - 1].endTime.split(":")[1]),
            block_count: blocks.length,
            block_names: blocks.map((b) => b.name),
            classroom: slot.classroom || null,
            is_taller: isTaller,
          });
        }
      }

      // Inyectar recesos
      for (const [, shift] of shiftMap) {
        for (const block of shift.timeBlocks) {
          if (block.isBreak) {
            dayClasses.push({
              type: "receso",
              subject_id: null,
              subject: null,
              subject_code: null,
              classificationType: null,
              teacher: null,
              start: block.startTime,
              end: block.endTime,
              startMinutes:
                parseInt(block.startTime.split(":")[0]) * 60 +
                parseInt(block.startTime.split(":")[1]),
              endMinutes:
                parseInt(block.endTime.split(":")[0]) * 60 +
                parseInt(block.endTime.split(":")[1]),
              block_count: 0,
              block_names: [block.name],
              classroom: null,
              is_taller: false,
            });
          }
        }
      }

      // Ordenar por hora de inicio
      dayClasses.sort((a, b) => a.startMinutes - b.startMinutes);
      scheduleByDay[day] = dayClasses;
    }

    // Deduplicar entradas de taller por subject_id + start + end
    for (const day of Object.keys(scheduleByDay)) {
      const seen = new Set();
      scheduleByDay[day] = scheduleByDay[day].filter((entry) => {
        if (!entry.is_taller) return true;
        const key = `${entry.subject_id}-${entry.start}-${entry.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Info del turno
    const firstShift = schedules[0]?.school_shift_id;
    const shiftInfo = firstShift
      ? {
          name: firstShift.name,
          shift: firstShift.shift,
          start: firstShift.startTime,
          end: firstShift.endTime,
        }
      : null;
      
    res.status(200).json({
      group: {
        _id: group._id,
        grade: group.grade,
        section: group.section,
        label: `${group.grade}°${group.section}`,
        shift: group.shift,
        type: group.type || "regular",
      },
      shift_info: shiftInfo,
      schedule: scheduleByDay,
    });
    
  } catch (error) {
    console.error("getGroupSchedule error:", error);
    next(error);
  }
};

module.exports = {
  getAllGroups,
  createGroup,
  getGroupById,
  updateGroup,
  deleteGroup,
  getGroupStudents,
  getGroupSchedule,
};
