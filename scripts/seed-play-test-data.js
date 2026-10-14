// scripts/seed-play-test-data.js
// ---------------------------------------------------------------------
// Seed de datos de PRUEBA para publicación en Google Play.
//
// Crea un tenant SEPARADO ("Escuela de Prueba EdukControl", cct 13TST0001A)
// dentro de la BD indicada en MONGO_URI, para que:
//   1. Los revisores de Google (App Access) y los testers puedan iniciar
//      sesión sin ver los datos reales de la escuela productiva.
//   2. Las capturas de pantalla de la ficha de la tienda muestren
//      pantallas pobladas (dashboard, calificaciones, asistencia, avisos).
//
// NO toca la escuela real (13DST0049E): todo documento creado aquí
// pertenece al tenant de prueba.
//
// Idempotente: cada entidad se busca por su clave natural (cct, teléfono,
// grade+section+año, curp, code, etc.) y solo se inserta si no existe.
//
// USO:
//   MONGO_URI="mongodb+srv://..." node scripts/seed-play-test-data.js
//
// Credenciales creadas (login: teléfono + password, sin OTP):
//   admin:    7710000001 / EdukTest2026!
//   maestro:  7710000002 / EdukTest2026!
//   tutor:    7710000003 / EdukTest2026!
//   prefecto: 7710000004 / EdukTest2026!
//   trabajo social: 7710000005 / EdukTest2026!
// ---------------------------------------------------------------------

require("dotenv").config();
const mongoose = require("mongoose");

const School = require("../models/School.model");
const SchoolYear = require("../models/SchoolYear.model");
const SchoolShift = require("../models/SchoolShift.model");
const User = require("../models/User.model");
const Group = require("../models/Group.model");
const Student = require("../models/Student.model");
const Enrollment = require("../models/Enrollment.model");
const Guardian = require("../models/Guardian.model");
const Subject = require("../models/Subject.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const GradingPeriod = require("../models/GradingPeriod.model");
const Grade = require("../models/Grade.model");
const AttendanceLog = require("../models/AttendanceLog.model");
const Announcement = require("../models/Announcement.model");

// === Configuración del tenant de prueba ==================================
const SCHOOL_DATA = {
  name: "Escuela de Prueba EdukControl",
  cct: "13TST0001A", // formato SEP: 2 dígitos + 3 letras + 4 dígitos + letra
  isActive: true,
  educationalLevels: ["BASIC"],
  address: "Av. de las Pruebas 123, Ciudad de México",
  phoneNumber: "5550001111",
};

const YEAR_DATA = {
  name: "2026-2027",
  startDate: new Date("2026-08-10"),
  endDate: new Date("2027-07-09"),
  isActive: true,
};

const PASSWORD = "EdukTest2026!"; // 14 chars (mínimo del modelo: 8)

const STAFF_USERS = [
  {
    name: "Dana",
    last_name: "Prueba López",
    email: "admin@test.edukcontrol.mx",
    phoneNumber: "7710000001",
    password: PASSWORD,
    role: "admin",
    sex: "female",
  },
  {
    name: "Marco",
    last_name: "Prueba Ruiz",
    email: "maestro@test.edukcontrol.mx",
    phoneNumber: "7710000002",
    password: PASSWORD,
    role: "teacher",
    sex: "male",
    contractedHours: 6,
    appointmentType: "BASE",
  },
  {
    name: "Sofía",
    last_name: "Ruiz Díaz",
    email: "tutor@test.edukcontrol.mx",
    phoneNumber: "7710000003",
    password: PASSWORD,
    role: "tutor",
    sex: "female",
    notification_prefs: {
      whatsapp: {
        opted_in: true,
        opted_in_at: new Date(),
        source: "admin_form",
      },
    },
  },
  {
    name: "Patricia",
    last_name: "Prueba Sánchez",
    email: "prefecto@test.edukcontrol.mx",
    phoneNumber: "7710000004",
    password: PASSWORD,
    role: "prefect",
    sex: "female",
  },
  {
    name: "Raul",
    last_name: "Prueba Mendoza",
    email: "trabajadorsocial@test.edukcontrol.mx",
    phoneNumber: "7710000005",
    password: PASSWORD,
    role: "social_worker",
    sex: "male",
  },
];

// Alumnos ficticios: 8 en 1A, 4 en 2A. CURPs inventadas con formato
// válido de 18 caracteres [A-Z0-9] (no se validan contra RENAPO).
const STUDENTS = [
  { group: 1, first_name: "Ana Lucía", last_name: "García Torres", sex: "female" },
  { group: 1, first_name: "Carlos Eduardo", last_name: "Martínez Ríos", sex: "male" },
  { group: 1, first_name: "Daniela", last_name: "Hernández Cruz", sex: "female" },
  { group: 1, first_name: "Diego Armando", last_name: "López Vargas", sex: "male" },
  { group: 1, first_name: "Fernanda", last_name: "Sánchez Aguilar", sex: "female" },
  { group: 1, first_name: "Jorge Alberto", last_name: "Ramírez Luna", sex: "male" },
  { group: 1, first_name: "Andrea", last_name: "Torres Peña", sex: "female" },
  { group: 1, first_name: "Miguel Ángel", last_name: "Díaz Navarro", sex: "male" },
  { group: 2, first_name: "Paola", last_name: "Jiménez Ortega", sex: "female" },
  { group: 2, first_name: "Ricardo", last_name: "Mendoza Silva", sex: "male" },
  { group: 2, first_name: "Valeria", last_name: "Castillo Rojas", sex: "female" },
  { group: 2, first_name: "Andrés", last_name: "Morales Cano", sex: "male" },
];

// CURP inventada de 18 chars exactos: GAT + NN + 010101 + HDF + RL + 0 + D.
// El dígito final es (i+1) % 10 para que nunca pase de un solo carácter
// (i=9 → "0", sin romper la longitud ni duplicar CURPs: el NN ya es único).
const curpFor = (i) => `GAT${String(i + 1).padStart(2, "0")}010101HDFRL0${(i + 1) % 10}`;

const SUBJECTS = [
  { code: "ESP-01", name: "Español", color: "#0ea5e9" },
  { code: "MAT-01", name: "Matemáticas", color: "#6366f1" },
  { code: "CIE-01", name: "Ciencias", color: "#10b981" },
  { code: "ING-01", name: "Inglés", color: "#f59e0b" },
  { code: "HIS-01", name: "Historia", color: "#f43f5e" },
  { code: "EF-01", name: "Educación Física", color: "#8b5cf6" },
];

// Turno matutino con campana completa (validada por SchoolShift pre-validate).
const SHIFT_DATA = {
  name: "Turno Matutino",
  shift: "matutino",
  startTime: "07:30",
  endTime: "14:30",
  moduleDurationMinutes: 50,
  gracePeriodMinutes: 30,
  isActive: true,
  timeBlocks: [
    { name: "Módulo 1", startTime: "07:30", endTime: "08:20", isBreak: false },
    { name: "Módulo 2", startTime: "08:20", endTime: "09:10", isBreak: false },
    { name: "Receso", startTime: "09:10", endTime: "09:30", isBreak: true },
    { name: "Módulo 3", startTime: "09:30", endTime: "10:20", isBreak: false },
    { name: "Módulo 4", startTime: "10:20", endTime: "11:10", isBreak: false },
    { name: "Módulo 5", startTime: "11:10", endTime: "12:00", isBreak: false },
    { name: "Almuerzo", startTime: "12:00", endTime: "13:00", isBreak: true },
    { name: "Módulo 6", startTime: "13:00", endTime: "13:50", isBreak: false },
    { name: "Módulo 7", startTime: "13:50", endTime: "14:30", isBreak: false },
  ],
};

const GRADING_PERIODS = [
  { name: "Trimestre 1", order: 1, startDate: "2026-08-10", endDate: "2026-11-27" },
  { name: "Trimestre 2", order: 2, startDate: "2026-11-30", endDate: "2027-03-19" },
  { name: "Trimestre 3", order: 3, startDate: "2027-03-22", endDate: "2027-07-02" },
  { name: "Final", order: 0, startDate: "2027-07-06", endDate: "2027-07-06" },
];

const ANNOUNCEMENTS = [
  {
    title: "Inicio del ciclo escolar 2026-2027",
    message:
      "¡Bienvenidos al nuevo ciclo escolar! Les damos la bienvenida a alumnos y familias. Consulten el calendario y los horarios en la app.",
    priority: "informative",
  },
  {
    title: "Reunión general de padres de familia",
    message:
      "Se convoca a una reunión general de padres de familia el próximo viernes a las 17:00 horas en el auditorio de la escuela. Su asistencia es importante.",
    priority: "informative",
  },
];

// Días lectivos (L-V) entre las fechas [from, to] — devuelve Date en UTC.
// Los eventos se construyen en UTC para que el agrupado %Y-%m-%d del
// backend (que usa UTC) coincida con el día local de la escuela.
function workingDays(from, to) {
  const days = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (d <= to) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) days.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("[!] MONGO_URI no está definido (pásala como env var)");
    process.exit(1);
  }

  console.log("Conectando a MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Conectado.\n");

  // 1) ESCUELA (tenant de prueba)
  console.log("🏫 Escuela de prueba...");
  let school = await School.findOne({ cct: SCHOOL_DATA.cct });
  if (!school) {
    school = await School.create(SCHOOL_DATA);
    console.log(`   ✅ Creada: ${school.name} (${school.cct})`);
  } else {
    console.log(`   ⏭️  Ya existe: ${school.name}`);
  }

  // 2) CICLO ESCOLAR + activación
  console.log("\n📅 Ciclo escolar...");
  let year = await SchoolYear.findOne({ school: school._id, name: YEAR_DATA.name });
  if (!year) {
    year = await SchoolYear.create({ school: school._id, ...YEAR_DATA });
    console.log(`   ✅ Creado: ${year.name}`);
  } else {
    console.log(`   ⏭️  Ya existe: ${year.name}`);
  }
  if (!year.isActive) {
    await SchoolYear.updateMany(
      { school: school._id, _id: { $ne: year._id } },
      { $set: { isActive: false } }
    );
    year.isActive = true;
    await year.save();
  }
  if (String(school.current_school_year_id || "") !== String(year._id)) {
    school.current_school_year_id = year._id;
    await school.save();
    console.log("   ✅ School.current_school_year_id sincronizado");
  }

  // 3) TURNO (campana)
  console.log("\n🔔 Turno...");
  let shift = await SchoolShift.findOne({
    school: school._id,
    school_year_id: year._id,
    name: SHIFT_DATA.name,
  });
  if (!shift) {
    shift = await SchoolShift.create({
      school: school._id,
      school_year_id: year._id,
      ...SHIFT_DATA,
    });
    console.log(`   ✅ Creado: ${shift.name}`);
  } else {
    console.log(`   ⏭️  Ya existe: ${shift.name}`);
  }

  // 4) USERS (admin, maestro, tutor) — password directa, sin OTP
  console.log("\n👥 Usuarios...");
  const users = {};
  for (const data of STAFF_USERS) {
    const existing = await User.findOne({ school: school._id, phoneNumber: data.phoneNumber });
    if (existing) {
      users[data.role] = existing;
      console.log(`   ⏭️  Ya existe: ${data.name} (${data.role})`);
      continue;
    }
    const created = await User.create({
      school: school._id,
      name: data.name,
      last_name: data.last_name,
      email: data.email,
      phoneNumber: data.phoneNumber,
      password: data.password,
      role: data.role,
      isActive: true,
      sex: data.sex || null,
      ...(data.contractedHours !== undefined
        ? { contractedHours: data.contractedHours, appointmentType: data.appointmentType }
        : {}),
      ...(data.notification_prefs ? { notification_prefs: data.notification_prefs } : {}),
    });
    users[data.role] = created;
    console.log(`   ✅ Creado: ${data.name} ${data.last_name} (${data.role})`);
  }
  const teacher = users.teacher;
  const tutorUser = users.tutor;

  // 5) GRUPOS (1A y 2A)
  console.log("\n🏫 Grupos...");
  const groups = {};
  for (const g of [
    { grade: 1, section: "A" },
    { grade: 2, section: "A" },
  ]) {
    let group = await Group.findOne({
      school: school._id,
      grade: g.grade,
      section: g.section,
      school_year_id: year._id,
    });
    if (!group) {
      group = await Group.create({
        school: school._id,
        grade: g.grade,
        section: g.section,
        type: "regular",
        school_year_id: year._id,
        shift: "matutino",
        head_teacher_id: g.grade === 1 ? teacher._id : null,
      });
      console.log(`   ✅ Creado: ${g.grade}${g.section}`);
    } else {
      console.log(`   ⏭️  Ya existe: ${g.grade}${g.section}`);
    }
    groups[g.grade] = group;
  }

  // 6) ALUMNOS + INSCRIPCIONES
  console.log("\n🎓 Alumnos e inscripciones...");
  const students = [];
  for (let i = 0; i < STUDENTS.length; i++) {
    const data = STUDENTS[i];
    const group = groups[data.group];
    const curp = curpFor(i);
    let student = await Student.findOne({ school: school._id, curp });
    if (!student) {
      student = await Student.create({
        school: school._id,
        curp,
        first_name: data.first_name,
        last_name: data.last_name,
        sex: data.sex,
        status: "active",
        current_group_id: group._id,
      });
      console.log(`   ✅ ${data.first_name} ${data.last_name} (${data.group}A)`);
    }
    students.push({ student, group });

    let enrollment = await Enrollment.findOne({
      school: school._id,
      student_id: student._id,
      school_year_id: year._id,
    });
    if (!enrollment) {
      enrollment = await Enrollment.create({
        school: school._id,
        student_id: student._id,
        group_id: group._id,
        school_year_id: year._id,
        cycle_status: "enrolled",
      });
    }
    student._enrollment = enrollment;
  }

  // 7) TUTOR (Guardian vinculado a 2 hermanos de 1A)
  console.log("\n👨‍👩‍👦 Tutor/Guardian...");
  const siblings = students
    .filter((s) => s.group.grade === 1)
    .slice(0, 2)
    .map((s) => s.student);
  let guardian = await Guardian.findOne({ school: school._id, phone: "7710000003" });
  if (!guardian) {
    guardian = await Guardian.create({
      school: school._id,
      user_id: tutorUser._id,
      name: "Sofía",
      lastname: "Ruiz Díaz",
      relationship: "Madre",
      phone: "7710000003",
      sex: "female",
      students: siblings.map((s) => s._id),
      isActive: true,
      notification_prefs: {
        whatsapp: { opted_in: true, opted_in_at: new Date(), source: "admin_form" },
      },
    });
    console.log("   ✅ Guardian creado (2 hijos)");
  } else {
    console.log("   ⏭️  Guardian ya existe");
  }
  for (const s of siblings) {
    if (!s.guardians.map(String).includes(String(guardian._id))) {
      s.guardians.push(guardian._id);
      await s.save();
    }
  }

  // 8) MATERIAS
  console.log("\n📚 Materias...");
  const subjects = {};
  for (const data of SUBJECTS) {
    let subject = await Subject.findOne({ school: school._id, code: data.code });
    if (!subject) {
      subject = await Subject.create({
        school: school._id,
        educationalLevel: "BASIC",
        code: data.code,
        name: data.name,
        color: data.color,
        isActive: true,
      });
      console.log(`   ✅ ${data.name}`);
    }
    subjects[data.code] = subject;
  }

  // 9) ASIGNACIONES MAESTRO-MATERIA-GRUPO
  console.log("\n🔗 Asignaciones (TeacherSubject)...");
  const assignments = [
    // Maestro titular de 1A: las 6 materias
    ...SUBJECTS.map((s) => ({ code: s.code, group: 1 })),
    // También da Matemáticas y Español en 2A
    { code: "MAT-01", group: 2 },
    { code: "ESP-01", group: 2 },
  ];
  for (const a of assignments) {
    const existing = await TeacherSubject.findOne({
      teacher_id: teacher._id,
      subject_id: subjects[a.code]._id,
      group_id: groups[a.group]._id,
      school_year_id: year._id,
    });
    if (!existing) {
      await TeacherSubject.create({
        school: school._id,
        teacher_id: teacher._id,
        subject_id: subjects[a.code]._id,
        group_id: groups[a.group]._id,
        school_year_id: year._id,
      });
    }
  }
  console.log(`   ✅ ${assignments.length} asignaciones verificadas`);

  // 10) PERÍODOS DE EVALUACIÓN
  console.log("\n📆 Períodos de evaluación...");
  const periods = {};
  for (const p of GRADING_PERIODS) {
    let period = await GradingPeriod.findOne({
      school: school._id,
      school_year_id: year._id,
      order: p.order,
    });
    if (!period) {
      period = await GradingPeriod.create({
        school: school._id,
        school_year_id: year._id,
        name: p.name,
        order: p.order,
        startDate: new Date(p.startDate),
        endDate: new Date(p.endDate),
        isClosed: false,
      });
      console.log(`   ✅ ${p.name}`);
    }
    periods[p.order] = period;
  }
  const t1 = periods[1];

  // 11) CALIFICACIONES (Trimestre 1)
  console.log("\n💯 Calificaciones (Trimestre 1)...");
  let gradesCreated = 0;
  const gradePlan = [];
  // 1A: las 6 materias
  for (const s of students.filter((x) => x.group.grade === 1)) {
    for (const code of SUBJECTS.map((x) => x.code)) {
      gradePlan.push({ s, code });
    }
  }
  // 2A: solo las 2 materias que da el maestro
  for (const s of students.filter((x) => x.group.grade === 2)) {
    for (const code of ["MAT-01", "ESP-01"]) gradePlan.push({ s, code });
  }
  for (let i = 0; i < gradePlan.length; i++) {
    const { s, code } = gradePlan[i];
    const existing = await Grade.findOne({
      enrollment_id: s.student._enrollment._id,
      subject_id: subjects[code]._id,
      gradingPeriod: t1._id,
    });
    if (existing) continue;
    // Valor determinista entre 7.5 y 10.0 (escala 0-10)
    const value = Math.min(10, 7.5 + ((i * 7 + code.length * 3) % 6) * 0.5);
    await Grade.create({
      school: school._id,
      enrollment_id: s.student._enrollment._id,
      school_year_id: year._id,
      subject_id: subjects[code]._id,
      gradingPeriod: t1._id,
      period_order: 1,
      value,
      graded_by: teacher._id,
      graded_at: new Date("2026-10-05T16:00:00Z"),
    });
    gradesCreated++;
  }
  console.log(`   ✅ ${gradesCreated} calificaciones creadas (0 = ya existían)`);

  // 12) ASISTENCIA — entry+exit de cada día lectivo del ciclo hasta el viernes
  //     anterior. El 2.º alumno de 1A (Miguel) falta los últimos 2 días para
  //     que el KPI de asistencia no quede en un 100% exacto.
  console.log("\n🕒 Asistencia...");
  const existingLogs = await AttendanceLog.countDocuments({ school: school._id });
  if (existingLogs > 0) {
    console.log(`   ⏭️  Ya hay ${existingLogs} logs de asistencia, se omite`);
  } else {
    const days = workingDays(new Date("2026-08-10"), new Date("2026-10-09"));
    const missingStudent = students.find(
      (s) => s.student.first_name === "Miguel Ángel"
    )?.student;
    const lastTwo = days.slice(-2).map((d) => d.toISOString().slice(0, 10));
    const docs = [];
    for (const day of days) {
      const y = day.getUTCFullYear();
      const m = day.getUTCMonth();
      const dd = day.getUTCDate();
      const dayStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      for (let i = 0; i < students.length; i++) {
        const stu = students[i].student;
        if (missingStudent && String(stu._id) === String(missingStudent._id) && lastTwo.includes(dayStr)) {
          continue; // ausente los últimos 2 días
        }
        docs.push({
          school: school._id,
          student_id: stu._id,
          event_time: new Date(Date.UTC(y, m, dd, 13, 35 + (i % 10))), // 07:35-07:44 CST
          event_type: "entry",
          device: "rfid@TEST-DEVICE-01",
          verificationMode: "RFID",
          status: "on_time",
          notification_sent: true,
        });
        docs.push({
          school: school._id,
          student_id: stu._id,
          event_time: new Date(Date.UTC(y, m, dd, 20, 10 + (i % 10))), // 14:10-14:19 CST
          event_type: "exit",
          device: "rfid@TEST-DEVICE-01",
          verificationMode: "RFID",
          status: null,
          notification_sent: true,
        });
      }
    }
    for (let i = 0; i < docs.length; i += 500) {
      await AttendanceLog.insertMany(docs.slice(i, i + 500), { ordered: false });
    }
    console.log(`   ✅ ${docs.length} logs creados (${days.length} días lectivos)`);
  }

  // 13) AVISOS
  console.log("\n📣 Avisos...");
  for (const a of ANNOUNCEMENTS) {
    const existing = await Announcement.findOne({ school: school._id, title: a.title });
    if (existing) continue;
    await Announcement.create({
      school: school._id,
      schoolYear: year._id,
      sender: users.admin._id,
      title: a.title,
      message: a.message,
      priority: a.priority,
      targetType: "general",
      targetGroups: [],
      targetStudents: [],
    });
    console.log(`   ✅ "${a.title}"`);
  }

  // 14) RESUMEN
  console.log("\n=== RESUMEN ===");
  console.log(`Escuela: ${school.name} (cct ${school.cct})`);
  console.log(`Ciclo:   ${year.name} (activo)`);
  console.log(`Usuarios:`);
  for (const u of await User.find({ school: school._id }).sort({ role: 1 })) {
    console.log(`  - ${u.role.padEnd(14)} ${u.phoneNumber} ${u.name} ${u.last_name || ""}`);
  }
  console.log("\nLogins (teléfono + password):");
  console.log("  admin:   7710000001 / EdukTest2026!");
  console.log("  maestro: 7710000002 / EdukTest2026!");
  console.log("  tutor:   7710000003 / EdukTest2026!");
  console.log("  prefecto: 7710000004 / EdukTest2026!");
  console.log("  t.social: 7710000005 / EdukTest2026!");

  await mongoose.disconnect();
  console.log("\nDesconectado.");
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
