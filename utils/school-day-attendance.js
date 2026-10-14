// utils/school-day-attendance.js
// ---------------------------------------------------------------------
// Conteo de asistencia de HOY a nivel escuela desde los lectores
// (AttendanceLog: RFID/cara/taps manuales), con alumnos ÚNICOS por status.
//
// Por qué NO ClassAttendance (bug 2026-10-14): los dashboards de
// prefecto/director/trabajadora social sumaban `ClassAttendance.summary`
// (pase de lista por materia), pero ese módulo apenas se está usando —
// en un día real había 0 sesiones — mientras los lectores ya registran
// cientos de eventos. Resultado: "Asistencia de hoy: Presentes 0,
// Faltas 0" en la app.
//
// Rango del día: se usa el reloj de la escuela (offset explícito vía
// toSchoolDate, NO el TZ del servidor) para construir el día calendario
// escolar y filtrar `event_time` en [00:00Z, 24:00Z) de ese día. Ese
// rango cubre las DOS convenciones de almacenamiento del backend
// (ver utils/school-time.js):
//   - taps reales (instante UTC real): 07:00-14:30 CST → 13:00-20:30Z.
//   - ausencias del cron (wall-clock forzado a UTC): cutoff 07:30 →
//     guardado como 07:30Z del mismo día calendario.
// Un alumno puede tener como máximo un entry por día (el servicio de
// asistencia revierte absent→on_time actualizando el MISMO doc), así
// que agrupar por (student_id, status) no sobre-cuenta.
// ---------------------------------------------------------------------

const AttendanceLog = require("../models/AttendanceLog.model");
const { toSchoolDate } = require("./school-time");

// Retorna { dayPresent, dayRetard, dayAbsent, dayTotal }:
//   - dayPresent: alumnos que ESTUVIERON (on_time + late).
//   - dayRetard:  subconjunto de dayPresent con status "late" (informativo).
//   - dayAbsent:  alumnos marcados "absent" por el cron/hoy.
//   - dayTotal:   dayPresent + dayAbsent (registros del día; NO se suma
//                 dayRetard porque ya está dentro de dayPresent).
const countTodayAttendanceByStatus = async (schoolId) => {
  // Fecha de HOY leída en el reloj de la escuela (offset explícito).
  const schoolNow = toSchoolDate(new Date());
  // Día calendario escolar como rango UTC [00:00Z, 24:00Z).
  const dayStartUtc = new Date(
    Date.UTC(
      schoolNow.getUTCFullYear(),
      schoolNow.getUTCMonth(),
      schoolNow.getUTCDate()
    )
  );
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  // Alumnos únicos por status: agrupa primero por (alumno, status) y
  // luego cuenta, así un alumno con dos docs (caso edge) cuenta 1 vez
  // por status.
  const byStatus = await AttendanceLog.aggregate([
    {
      $match: {
        school: schoolId,
        event_type: "entry",
        status: { $in: ["on_time", "late", "absent"] },
        event_time: { $gte: dayStartUtc, $lt: dayEndUtc },
      },
    },
    { $group: { _id: { student: "$student_id", status: "$status" } } },
    { $group: { _id: "$_id.status", n: { $sum: 1 } } },
  ]);

  let dayOnTime = 0;
  let dayLate = 0;
  let dayAbsent = 0;
  for (const row of byStatus) {
    if (row._id === "on_time") dayOnTime = row.n;
    else if (row._id === "late") dayLate = row.n;
    else if (row._id === "absent") dayAbsent = row.n;
  }

  const dayPresent = dayOnTime + dayLate;
  return {
    dayPresent,
    dayRetard: dayLate,
    dayAbsent,
    dayTotal: dayPresent + dayAbsent,
  };
};

module.exports = { countTodayAttendanceByStatus };
