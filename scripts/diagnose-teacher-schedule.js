// scripts/diagnose-teacher-schedule.js
// ---------------------------------------------------------------------
// Diagnóstico READ-ONLY del horario de un maestro vs. "Clases de hoy"
// del dashboard.
//
// Contexto: el dashboard (GET /api/teacher-subjects/me/dashboard) arma
// la lista "Clases de hoy" filtrando los ClassSchedule del maestro por:
//   (a) teacher_id = maestro
//   (b) isActive = true
//   (c) school_year_id = ciclo activo de la escuela
//   (d) slot.dayOfWeek === día de HOY (reloj escolar)
//   (e) slot.timeBlockRefs resuelve contra school_shift_id.timeBlocks
//       (si NO resuelve, la clase se descarta EN SILENCIO)
// La pantalla "Horario" semanal usa la MISMA query pero NO filtra por
// día — por eso una clase puede verse en Horario y faltar en Hoy.
//
// Este script imprime, para el maestro indicado:
//   1. Sus ClassSchedule del ciclo activo: materia, grupo, estado y
//      CADA slot con dayOfWeek + día legible + horario resuelto, y
//      WARNING si timeBlockRefs no resuelve o falta el turno.
//   2. Todos los ClassSchedule de grupos taller "OFIMATICA" (cualquier
//      maestro, mismo ciclo) — para detectar docs duplicados/asignados
//      a otro docente.
//   3. Sus TeacherSubjects (qué puede dar).
//   4. Los grupos taller OFIMATIC de la escuela (head_teacher_id).
//
// NO ESCRIBE NADA. Seguro contra producción.
//
// Flags:
//   TEACHER_EMAIL=<email>   Maestro a diagnosticar (si su cuenta tiene email).
//   TEACHER_PHONE=<10dgt>   Alternativa confiable (el login es por teléfono).
//   TEACHER_NAME=<nombre>   Último recurso (match parcial, p. ej. "Aldo";
//                           puede devolver varios).
//   SCHOOL_ID=<oid>         Limita la búsqueda de escuelas (opcional).
//
// Uso:
//   MONGO_URI="mongodb+srv://..." TEACHER_PHONE=7712036159 \
//     node scripts/diagnose-teacher-schedule.js

require("dotenv").config();

const mongoose = require("mongoose");
const School = require("../models/School.model");
const SchoolYear = require("../models/SchoolYear.model");
const ClassSchedule = require("../models/ClassSchedule.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const Group = require("../models/Group.model");
const User = require("../models/User.model");
// Registrados para los populate() de ClassSchedule (subject_id y
// school_shift_id): sin require, mongoose lanza MissingSchemaError.
require("../models/Subject.model");
require("../models/SchoolShift.model");

const TEACHER_EMAIL = process.env.TEACHER_EMAIL || null;
const TEACHER_PHONE = process.env.TEACHER_PHONE || null;
const TEACHER_NAME = process.env.TEACHER_NAME || null;
const SCHOOL_ID = process.env.SCHOOL_ID || null;

// Días de la semana en español (misma numeración que Date.getDay():
// 0 = domingo … 6 = sábado).
const DAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

// toMinutes("07:30") → 450. Igual que en el controller.
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

// Línea legible de un slot: "Miercoles(3): 12:50-14:30 [2 bloques]"
// o "Miercoles(3): ⚠ refs NO resuelven (4 refs → 0 bloques)".
const describeSlot = (slot, shift) => {
  const day = `${DAY_NAMES[slot.dayOfWeek] || "?"}(${slot.dayOfWeek})`;
  const refs = (slot.timeBlockRefs || []).map(String);
  const blocks = shift
    ? (shift.timeBlocks || [])
        .filter((b) => refs.includes(String(b._id)))
        .sort((a, b) => a.order - b.order)
    : [];
  const classroom = slot.classroom ? ` aula=${slot.classroom}` : "";
  if (!shift) {
    return `${day}: ⚠ SIN school_shift_id → se omite en Hoy${classroom}`;
  }
  if (blocks.length === 0) {
    return `${day}: ⚠ ${refs.length} refs → 0 bloques resueltos → se omite en Hoy${classroom}`;
  }
  const start = blocks[0].startTime;
  const end = blocks[blocks.length - 1].endTime ?? "?";
  return `${day}: ${start}-${end} [${blocks.length} bloque(s)]${classroom}`;
};

const describeSchedule = (sched) => {
  const subject = sched.subject_id
    ? `${sched.subject_id.name} (${sched.subject_id.code || "s/código"})`
    : "SIN MATERIA";
  const group = sched.group_id
    ? `${sched.group_id.grade}°${sched.group_id.section} [${sched.group_id.type || "regular"}]`
    : "SIN GRUPO";
  const teacher = sched.teacher_id
    ? `${sched.teacher_id.name || ""} ${sched.teacher_id.last_name || ""} (${sched.teacher_id._id})`
    : "SIN MAESTRO";
  const lines = [
    `• ${subject} → ${group} | maestro: ${teacher}`,
    `  _id=${sched._id}  isActive=${sched.isActive}  cycle=${sched.school_year_id}`,
  ];
  for (const slot of sched.scheduleSlots || []) {
    lines.push(`  - ${describeSlot(slot, sched.school_shift_id)}`);
  }
  return lines.join("\n");
};

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("ERROR: MONGO_URI no está definido en el entorno.");
    process.exit(1);
  }
  if (!TEACHER_EMAIL && !TEACHER_PHONE && !TEACHER_NAME) {
    console.error("ERROR: define TEACHER_EMAIL, TEACHER_PHONE (preferido) o TEACHER_NAME.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  try {
    console.log("=== Diagnóstico: horario de maestro vs. Clases de hoy ===");
    console.log(`Fecha del servidor: ${new Date().toISOString()} (día ${new Date().getDay()})`);

    // -----------------------------------------------------------------
    // 1. Maestro
    // -----------------------------------------------------------------
    // Prioridad: teléfono (login real de staff/tutores) > email (opcional
    // en el modelo) > nombre (match parcial, puede devolver varios).
    let userFilter = null;
    if (TEACHER_PHONE) {
      userFilter = { phoneNumber: TEACHER_PHONE };
    } else if (TEACHER_EMAIL) {
      userFilter = { email: TEACHER_EMAIL };
    } else {
      userFilter = { name: new RegExp(String(TEACHER_NAME).trim(), "i") };
    }
    const teachers = await User.find(userFilter)
      .select("name last_name email role school")
      .lean();
    if (teachers.length === 0) {
      console.log("\nNo se encontró ningún usuario con ese filtro. Saliendo.");
      return;
    }
    for (const t of teachers) {
      console.log(
        `\n[Maestro] ${t.name} ${t.last_name || ""} <${t.email}> role=${t.role} _id=${t._id} school=${t.school}`
      );
    }
    const teacher = teachers[0];
    if (teachers.length > 1) {
      console.log(`(hay ${teachers.length} coincidencias; se diagnostica la primera)`);
    }

    // -----------------------------------------------------------------
    // 2. Escuela + ciclo activo
    // -----------------------------------------------------------------
    const schoolFilter = SCHOOL_ID
      ? { _id: new mongoose.Types.ObjectId(SCHOOL_ID) }
      : { _id: teacher.school };
    const school = await School.findOne(schoolFilter)
      .select("name cct current_school_year_id")
      .lean();
    if (!school) {
      console.log("No se encontró la escuela del maestro. Saliendo.");
      return;
    }
    console.log(`[Escuela] ${school.name} (cct ${school.cct}) _id=${school._id}`);

    const years = await SchoolYear.find({
      school: school._id,
      isActive: true,
    })
      .select("_id name startDate endDate")
      .lean();
    if (years.length === 0) {
      console.log("⚠ La escuela NO tiene ciclo activo (school_year_id activo).");
    }
    for (const y of years) {
      console.log(`[Ciclo activo] ${y.name} _id=${y._id} (${y.startDate} → ${y.endDate})`);
    }
    const yearIds = years.map((y) => y._id);

    // -----------------------------------------------------------------
    // 3. ClassSchedule del maestro (ciclo activo) — el insumo directo
    //    del dashboard y del Horario semanal.
    // -----------------------------------------------------------------
    const schedules = await ClassSchedule.find({
      school: school._id,
      school_year_id: { $in: yearIds },
      teacher_id: teacher._id,
    })
      .populate("group_id", "grade section type")
      .populate("subject_id", "name code")
      .populate("teacher_id", "name last_name")
      .populate("school_shift_id", "timeBlocks")
      .lean();

    console.log(`\n--- ClassSchedule del maestro en el ciclo (total: ${schedules.length}) ---`);
    if (schedules.length === 0) {
      console.log("⚠ SIN ClassSchedule: el dashboard y el Horario estarían vacíos.");
    }
    for (const sched of schedules) {
      console.log(describeSchedule(sched));
    }

    // Foco: ¿qué tiene el maestro el día de hoy (getDay() del servidor)?
    const today = new Date().getDay();
    const todaySlots = [];
    for (const sched of schedules) {
      for (const slot of sched.scheduleSlots || []) {
        if (slot.dayOfWeek === today) todaySlots.push({ sched, slot });
      }
    }
    console.log(`\n--- Slots del MAESTRO en el día de hoy = ${DAY_NAMES[today]}(${today}) ---`);
    if (todaySlots.length === 0) {
      console.log("⚠ NINGÚN slot cae hoy → 'Clases de hoy' no lo mostrará.");
    }
    for (const { sched, slot } of todaySlots) {
      console.log(`  - ${describeSlot(slot, sched.school_shift_id)} | ${sched.subject_id?.name || "?"} → ${sched.group_id ? `${sched.group_id.grade}°${sched.group_id.section}` : "?"}`);
    }

    // -----------------------------------------------------------------
    // 4. ClassSchedule de talleres OFIMATICA (cualquier maestro) —
    //    detecta docs duplicados o asignados a otro docente.
    // -----------------------------------------------------------------
    const ofimaticaGroups = await Group.find({
      school: school._id,
      school_year_id: { $in: yearIds },
      type: "taller",
      section: /OFIMATIC/i,
    })
      .select("grade section head_teacher_id isActive")
      .lean();

    console.log(`\n--- Grupos taller OFIMATICA del ciclo (total: ${ofimaticaGroups.length}) ---`);
    for (const g of ofimaticaGroups) {
      console.log(
        `• ${g.grade}°${g.section} _id=${g._id} isActive=${g.isActive} head_teacher_id=${g.head_teacher_id || "null"}`
      );
    }

    const tallerIds = ofimaticaGroups.map((g) => g._id);
    const tallerSchedules = tallerIds.length
      ? await ClassSchedule.find({
          school: school._id,
          school_year_id: { $in: yearIds },
          group_id: { $in: tallerIds },
        })
          .populate("group_id", "grade section type")
          .populate("subject_id", "name code")
          .populate("teacher_id", "name last_name")
          .populate("school_shift_id", "timeBlocks")
          .lean()
      : [];

    console.log(`\n--- ClassSchedule de talleres OFIMATICA (total: ${tallerSchedules.length}) ---`);
    if (tallerSchedules.length === 0) {
      console.log("⚠ NINGÚN horario cargado para talleres OFIMATICA.");
    }
    for (const sched of tallerSchedules) {
      console.log(describeSchedule(sched));
    }

    // -----------------------------------------------------------------
    // 5. TeacherSubjects del maestro (qué PUEDE dar según permisos)
    // -----------------------------------------------------------------
    const ts = await TeacherSubject.find({
      school: school._id,
      school_year_id: { $in: yearIds },
      teacher_id: teacher._id,
    })
      .populate("subject_id", "name code classificationType")
      .populate("group_id", "grade section type")
      .lean();

    console.log(`\n--- TeacherSubjects del maestro (total: ${ts.length}) ---`);
    for (const t of ts) {
      const g = t.group_id ? `${t.group_id.grade}°${t.group_id.section}[${t.group_id.type || "regular"}]` : "?";
      const s = t.subject_id ? `${t.subject_id.name}[${t.subject_id.classificationType || "?"}]` : "?";
      console.log(`• ${s} → ${g} _id=${t._id}`);
    }

    console.log("\n=== Fin del diagnóstico (sin escrituras) ===");
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
