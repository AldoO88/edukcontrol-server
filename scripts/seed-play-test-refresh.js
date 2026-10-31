// scripts/seed-play-test-refresh.js
// ---------------------------------------------------------------------
// Refresca los datos "de HOY" del tenant de PRUEBA ("Escuela de Prueba
// EdukControl", cct 13TST0001A) en la BD indicada en MONGO_URI, para
// que los dashboards y pantallas se vean vivos durante la grabación del
// video de revisión de Apple (Guideline 2.1) y las pruebas de testers.
//
// Crea (TODO es idempotente: si ya existe, se omite):
//   1. ClassSchedule  → horario real del turno (módulos del turno
//      matutino) por asignación de maestro, Lun-Sáb (la demo incluye
//      sábado para poder grabar el video cualquier día), para que:
//        - el dashboard del maestro muestre "clase en curso" y el
//          día completo (getTeacherDashboard lee ClassSchedule),
//        - el horario semanal del tutor tenga clases
//          (getMyStudentSchedule / getGroupSchedule).
//   2. AttendanceLog  → entradas/salidas de HOY por alumno con las DOS
//      convenciones documentadas en utils/school-time.js:
//        - presentes/on_time y late → instante UTC REAL de tap
//          (07:05/07:50 CST → 13:05Z/13:50Z),
//        - faltas del cron → HORA PARED forzada a UTC (07:30Z),
//      respetando el rango [00:00Z, 24:00Z) que usan los contadores
//      (utils/school-day-attendance.js y los dashboards del tutor).
//   3. ConductLog     → 1 demérito + 1 mérito en los hijos del tutor
//      demo, para que la pestaña "Conducta" del tutor no esté vacía.
//   4. Citation       → 1 citatorio PENDIENTE (futuro) + 1 HISTÓRICO
//      completado, para el feed de Avisos del tutor y Citatorios del
//      staff.
//
// SEGURIDAD (multi-tenant):
//   - Aborta ANTES de escribir si el tenant 13TST0001A no existe en la
//     BD: nunca toca la escuela real (13DST0049E).
//   - TODAS las escrituras filtran por school = _id del tenant prueba.
//
// CONVENCIONES DE FECHA:
//   - Reloj escolar con ADMS_TZ_OFFSET_MINUTES (default -360, México).
//   - "Hoy" se calcula con toSchoolDate(new Date()) → el script debe
//     re-ejecutarse el MISMO día de la grabación si ya pasó un día
//     (los horarios son estables; asistencia/conducta/citatorios son
//     "de hoy").
//   - Las SALIDAS (exit) solo se crean si la hora escolar ya pasó las
//     13:00; si se corre de mañana, re-ejecutar en la tarde las agrega.
//
// USO:
//   MONGO_URI="mongodb+srv://..." node scripts/seed-play-test-refresh.js
//
// (En este repo .env, MONGO_URI apunta al Mongo LOCAL y MONGO_URI_ATLAS
//  a producción; para este refresh correr con MONGO_URI=<valor de
//  MONGO_URI_ATLAS>.)
// ---------------------------------------------------------------------

require("dotenv").config();
const mongoose = require("mongoose");

const School = require("../models/School.model");
const SchoolShift = require("../models/SchoolShift.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const ClassSchedule = require("../models/ClassSchedule.model");
const Student = require("../models/Student.model");
const Guardian = require("../models/Guardian.model");
const User = require("../models/User.model");
const AttendanceLog = require("../models/AttendanceLog.model");
const ConductLog = require("../models/ConductLog.model");
const Citation = require("../models/Citation.model");

const { toSchoolDate, getSchoolOffsetMinutes } = require("../utils/school-time");

// CCT del tenant de prueba. Si no existe en la BD → abortar (guardia).
const TEST_CCT = "13TST0001A";

// Días laborables del horario de la DEMO (convención JS: 1=lun … 6=sáb).
// La "Escuela de Prueba EdukControl" tiene jornada de sábado incluida a
// propósito para que la grabación del video de revisión pueda hacerse
// cualquier día de la semana sin que el dashboard del maestro muestre
// "0 clases" (solo cambia el dayOfWeek de los slots; la lógica del
// backend no distingue).
const WEEKDAYS = [1, 2, 3, 4, 5, 6];

// Patrones de días alternos para las asignaciones "extras" de un mismo
// maestro (cuando hay más asignaciones que módulos disponibles y no se
// quiere que el mismo maestro aparezca en dos grupos a la vez).
const ALT_DAY_PATTERNS = [[1, 3, 5], [2, 4, 6]];

// Convierte una hora PARED de la escuela (Y/M/D h:min en horario local)
// al instante UTC real equivalente (convención 1 de school-time.js).
const schoolWallToUtc = (y, m, d, h, min) =>
  new Date(Date.UTC(y, m, d, h, min) - getSchoolOffsetMinutes() * 60000);

// Imprime un recuento simple "etiqueta: n" para el resumen final.
const say = (label, n) => console.log(`  - ${label}: ${n}`);

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[refresh] Falta MONGO_URI en el entorno.");
    process.exit(1);
  }
  console.log("[refresh] Conectando a:", uri.replace(/\/\/[^@]+@/, "//***@"));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  try {
    // --- Guardia multi-tenant: solo el tenant de prueba ---------------
    const school = await School.findOne({ cct: TEST_CCT });
    if (!school) {
      console.error(
        `[refresh] ABORTADO: no existe la escuela con cct ${TEST_CCT} en esta BD. ` +
          "No se escribió nada (protección de la escuela real)."
      );
      process.exit(1);
    }
    const schoolId = school._id;
    const yearId = school.current_school_year_id;
    if (!yearId) {
      console.error("[refresh] ABORTADO: la escuela de prueba no tiene ciclo activo.");
      process.exit(1);
    }
    console.log(`[refresh] Tenant OK: ${school.name} (${TEST_CCT}) _id=${schoolId}`);

    // Reloj escolar de HOY (Componentes getUTC* = fecha escolar).
    const schoolNow = toSchoolDate(new Date());
    const Y = schoolNow.getUTCFullYear();
    const M = schoolNow.getUTCMonth();
    const D = schoolNow.getUTCDate();
    const todayDow = schoolNow.getUTCDay(); // 0=dom…6=sáb
    const nowMinutes = schoolNow.getUTCHours() * 60 + schoolNow.getUTCMinutes();
    console.log(
      `[refresh] Hoy (reloj escolar): ${Y}-${String(M + 1).padStart(2, "0")}-` +
        `${String(D).padStart(2, "0")} (día ${todayDow}), ${schoolNow.getUTCHours()}:${String(schoolNow.getUTCMinutes()).padStart(2, "0")}`
    );

    // Rango del día calendario escolar en UTC [00:00Z, 24:00Z) — el
    // MISMO que usan countTodayAttendanceByStatus y los dashboards.
    const dayStartUtc = new Date(Date.UTC(Y, M, D));
    const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

    // --- Catálogos del tenant ----------------------------------------
    const shift = await SchoolShift.findOne({ school: schoolId, isActive: true })
      .sort({ createdAt: 1 });
    if (!shift || !Array.isArray(shift.timeBlocks) || shift.timeBlocks.length === 0) {
      console.error("[refresh] ABORTADO: el tenant no tiene turno con timeBlocks.");
      process.exit(1);
    }
    // Módulos de clase reales (excluye receso/almuerzo), en orden.
    const classBlocks = shift.timeBlocks
      .filter((b) => !b.isBreak)
      .sort((a, b) => a.order - b.order);
    console.log(`[refresh] Turno "${shift.name}" con ${classBlocks.length} módulos de clase.`);

    const tutorUser = await User.findOne({ phoneNumber: "7710000003" });
    const prefectUser = await User.findOne({ phoneNumber: "7710000004" });
    const teacherUser = await User.findOne({ phoneNumber: "7710000002" });
    if (!tutorUser || !prefectUser || !teacherUser) {
      console.error("[refresh] ABORTADO: faltan usuarios demo (tutor/prefecto/maestro).");
      process.exit(1);
    }
    const guardian = await Guardian.findOne({ school: schoolId, phone: "7710000003" });
    // Hijos del tutor demo (los screens del tutor deben verse poblados).
    const childrenIds = new Set((guardian && guardian.students || []).map(String));

    // =================================================================
    // 1) ClassSchedule — horario por asignación (idempotente)
    // =================================================================
    // Regla de distribución (evita que el MISMO maestro aparezca en dos
    // grupos en el mismo módulo del mismo día):
    //   - Cada maestro ordena sus asignaciones y las reparte secuencial
    //     por los módulos de clase (una asignación = un módulo, Lun-Vie).
    //   - Si supera el número de módulos, las "extras" caen en el ÚLTIMO
    //     módulo con patrón de días alterno (L-X-V / M-J), de modo que
    //     nunca coinciden en el mismo día con la asignación principal.
    const teacherSubjects = await TeacherSubject.find({
      school: schoolId,
      school_year_id: yearId,
    }).sort({ group_id: 1, _id: 1 });

    let schedulesCreated = 0;
    const byTeacher = new Map();
    for (const ts of teacherSubjects) {
      const key = String(ts.teacher_id);
      if (!byTeacher.has(key)) byTeacher.set(key, []);
      byTeacher.get(key).push(ts);
    }

    for (const [, list] of byTeacher) {
      const nBlocks = classBlocks.length;
      for (let i = 0; i < list.length; i += 1) {
        const ts = list[i];
        let block;
        let days;
        if (i < nBlocks) {
          block = classBlocks[i];
          days = WEEKDAYS;
        } else {
          // Asignación extra: último módulo + patrón alterno.
          block = classBlocks[nBlocks - 1];
          days = ALT_DAY_PATTERNS[(i - nBlocks) % ALT_DAY_PATTERNS.length];
        }
        const slots = days.map((dayOfWeek) => ({
          dayOfWeek,
          timeBlockRefs: [block._id],
          classroom: null,
        }));

        const res = await ClassSchedule.updateOne(
          {
            school: schoolId,
            school_year_id: yearId,
            group_id: ts.group_id,
            subject_id: ts.subject_id,
            teacher_id: ts.teacher_id,
          },
          {
            $set: {
              school_shift_id: shift._id,
              scheduleSlots: slots,
              isActive: true,
            },
          },
          { upsert: true }
        );
        if (res.upsertedCount) schedulesCreated += 1;
      }
    }
    console.log("[refresh] 1) ClassSchedule");
    say("asignaciones procesadas", teacherSubjects.length);
    say("horarios nuevos (upsert)", schedulesCreated);

    // =================================================================
    // 2) AttendanceLog — asistencia de HOY (idempotente por alumno)
    // =================================================================
    const students = await Student.find({ school: schoolId }).sort({ first_name: 1 });

    // Reparto: hijos del tutor → siempre presentes (on_time); del resto,
    // uno late, los dos últimos faltas, el resto presentes.
    const others = students.filter((s) => !childrenIds.has(String(s._id)));
    const absentSet = new Set(
      others.slice(-2).map(String)
    );
    const lateId = String(others[0] && others[0]._id);

    let entriesCreated = 0;
    let exitsCreated = 0;
    let skips = 0;

    for (let k = 0; k < students.length; k += 1) {
      const student = students[k];
      const id = String(student._id);

      // Idempotencia: si ya hay entry de HOY para este alumno, no tocar.
      const existing = await AttendanceLog.exists({
        school: schoolId,
        student_id: student._id,
        event_type: "entry",
        event_time: { $gte: dayStartUtc, $lt: dayEndUtc },
      });
      if (existing) {
        skips += 1;
        continue;
      }

      if (absentSet.has(id)) {
        // Ausencia del cron: HORA PARED forzada a UTC (07:30Z), tal como
        // markAbsencesForSchool (convención 2 de school-time.js).
        await AttendanceLog.create({
          school: schoolId,
          student_id: student._id,
          event_time: new Date(Date.UTC(Y, M, D, 7, 30)),
          event_type: "entry",
          device: "Cron de ausencias",
          verificationMode: "MANUAL",
          status: "absent",
          notification_sent: false,
        });
        entriesCreated += 1;
        continue;
      }

      const isLate = id === lateId;
      // Tap real: instante UTC real de la hora escolar (convención 1).
      // on_time: 07:05 + k min (≤ 07:30 = hora de inicio del turno);
      // late:    07:50 (> 07:30).
      const eventTime = isLate
        ? schoolWallToUtc(Y, M, D, 7, 50)
        : schoolWallToUtc(Y, M, D, 7, 5 + k);

      await AttendanceLog.create({
        school: schoolId,
        student_id: student._id,
        event_time: eventTime,
        event_type: "entry",
        device: "Taquilla RFID (demo)",
        verificationMode: "RFID",
        status: isLate ? "late" : "on_time",
        notification_sent: false,
      });
      entriesCreated += 1;

      // Salida (event_type "exit", status null por modelo): solo si la
      // hora escolar YA pasó las 13:00, para no registrar salidas
      // futuras si el script corre de mañana (re-ejecutar en la tarde).
      if (nowMinutes >= 13 * 60) {
        const exitExists = await AttendanceLog.exists({
          school: schoolId,
          student_id: student._id,
          event_type: "exit",
          event_time: { $gte: dayStartUtc, $lt: dayEndUtc },
        });
        if (!exitExists) {
          await AttendanceLog.create({
            school: schoolId,
            student_id: student._id,
            // 14:35 CST (fin del turno 14:30 + salida típica) → 20:35Z.
            event_time: schoolWallToUtc(Y, M, D, 14, 35),
            event_type: "exit",
            device: "Taquilla RFID (demo)",
            verificationMode: "RFID",
            notification_sent: false,
          });
          exitsCreated += 1;
        }
      }
    }

    console.log("[refresh] 2) AttendanceLog (hoy)");
    say("entradas nuevas", entriesCreated);
    say(
      "salidas nuevas",
      `${exitsCreated}${nowMinutes < 13 * 60 ? " (se agregan al re-ejecutar en la tarde)" : ""}`
    );
    say("alumnos ya con entrada hoy (omitidos)", skips);

    // =================================================================
    // 3) ConductLog — 1 demérito + 1 mérito en los hijos del tutor
    // =================================================================
    // incident_date como instante UTC real (convención 1): hoy 10:00 /
    // 09:30 hora escolar.
    const [childA, childB] = students.filter((s) => childrenIds.has(String(s._id)));
    let conductCreated = 0;

    const conductPlan = [
      {
        student: childB, // Carlos → demérito
        eventType: "demerit",
        severity: "minor",
        points_impact: 5,
        description: "Uso de celular en el aula",
        details:
          "Se retiró el dispositivo durante la clase; se informa a la familia para su seguimiento.",
        incident_date: schoolWallToUtc(Y, M, D, 10, 0),
        reported_by: prefectUser._id,
      },
      {
        student: childA, // Ana → mérito
        eventType: "merit",
        severity: null,
        points_impact: 5,
        description: "Participación proactiva",
        details:
          "Respondió participaciones y apoyó a sus compañeros durante la sesión.",
        incident_date: schoolWallToUtc(Y, M, D, 9, 30),
        reported_by: teacherUser._id,
      },
    ];

    for (const item of conductPlan) {
      if (!item.student) continue;
      const exists = await ConductLog.exists({
        school: schoolId,
        student_id: item.student._id,
        description: item.description,
        incident_date: { $gte: dayStartUtc, $lt: dayEndUtc },
      });
      if (exists) continue;
      await ConductLog.create({
        school: schoolId,
        student_id: item.student._id,
        school_year_id: yearId,
        eventType: item.eventType,
        severity: item.severity,
        points_impact: item.points_impact,
        description: item.description,
        details: item.details,
        incident_date: item.incident_date,
        reported_by: item.reported_by,
        status: "active",
      });
      conductCreated += 1;
    }

    console.log("[refresh] 3) ConductLog");
    say("eventos nuevos", conductCreated);

    // =================================================================
    // 4) Citation — 1 pendiente (futuro) + 1 histórico completado
    // =================================================================
    // scheduledDate: instante UTC REAL (se migró de wall-clock en
    // 2026-10-14, ver utils/school-time.js).
    let citationsCreated = 0;

    // Próximo día hábil a +2 días (si cae fin de semana → lunes).
    const addDays = (n) => {
      const base = new Date(Date.UTC(Y, M, D + n));
      let dow = base.getUTCDay();
      while (dow === 0 || dow === 6) {
        base.setUTCDate(base.getUTCDate() + 1);
        dow = base.getUTCDay();
      }
      return base;
    };
    const plus2 = addDays(2);
    const pendingDate = schoolWallToUtc(
      plus2.getUTCFullYear(),
      plus2.getUTCMonth(),
      plus2.getUTCDate(),
      10,
      0
    );

    const minus7 = new Date(Date.UTC(Y, M, D - 7));
    const pastDate = schoolWallToUtc(
      minus7.getUTCFullYear(),
      minus7.getUTCMonth(),
      minus7.getUTCDate(),
      9,
      0
    );

    const citationPlan = [
      {
        student: childB, // Carlos → pendiente
        creator: prefectUser._id,
        scheduledDate: pendingDate,
        location: "Dirección — Sala de juntas",
        type: "behavioral",
        reason: "Bajo desempeño en Matemáticas — reunión con la familia",
        status: "pending",
      },
      {
        student: childA, // Ana → histórico completado
        creator: teacherUser._id,
        scheduledDate: pastDate,
        location: "Conferencia del grupo 1A",
        type: "academic",
        reason: "Seguimiento de calificaciones del primer trimestre",
        status: "completed",
      },
    ];

    for (const c of citationPlan) {
      if (!c.student) continue;
      const exists = await Citation.exists({
        school: schoolId,
        student: c.student._id,
        reason: c.reason,
      });
      if (exists) continue;
      await Citation.create({
        school: schoolId,
        schoolYear: yearId,
        student: c.student._id,
        creator: c.creator,
        scheduledDate: c.scheduledDate,
        location: c.location,
        type: c.type,
        reason: c.reason,
        subject: null,
        status: c.status,
        rescheduleRequested: false,
        rescheduleReason: null,
      });
      citationsCreated += 1;
    }

    console.log("[refresh] 4) Citation");
    say("citatorios nuevos", citationsCreated);

    // --- Resumen de estado actual del tenant --------------------------
    console.log("[refresh] Estado final del tenant:");
    say("ClassSchedule", await ClassSchedule.countDocuments({ school: schoolId }));
    say("AttendanceLog total", await AttendanceLog.countDocuments({ school: schoolId }));
    say(
      "AttendanceLog de hoy",
      await AttendanceLog.countDocuments({
        school: schoolId,
        event_time: { $gte: dayStartUtc, $lt: dayEndUtc },
      })
    );
    say("ConductLog", await ConductLog.countDocuments({ school: schoolId }));
    say("Citation", await Citation.countDocuments({ school: schoolId }));
    console.log("[refresh] Listo.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("[refresh] ERROR:", err);
  process.exit(1);
});
