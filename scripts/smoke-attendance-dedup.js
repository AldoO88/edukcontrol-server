// scripts/smoke-attendance-dedup.js
//
// Smoke test manual de la lógica nueva de registerAttendanceEvent:
//   A) Race: dos taps concurrentes del mismo alumno (RFID + cara) → 1 solo log.
//   B) Ventana cross-device (5 min): tap repetido → duplicate, sin 2.º log.
//   C) Fuera de ventana: entry y exit >5 min separados → 2 logs, tipos correctos.
//   D) Clamp anti-futuro: event_time +2h → se guarda ≈ ahora (no futuro).
//   E) Late-arrival: existe absent de hoy → el tap lo revierte a on_time
//      (wasAbsenceOverride) en lugar de crear un exit.
//
// Corre contra una BD local desechable (eduk_control_smoke) y la dropea al
// terminar. NO tocar MONGO_URI de producción con esto.
//
//   node scripts/smoke-attendance-dedup.js

process.env.ADMS_TZ_OFFSET_MINUTES =
  process.env.ADMS_TZ_OFFSET_MINUTES || "-360";
delete process.env.ATTENDANCE_DEDUP_WINDOW_MIN; // default 5 min

const mongoose = require("mongoose");
const AttendanceLog = require("../models/AttendanceLog.model");
const Student = require("../models/Student.model");
const { registerAttendanceEvent } = require("../services/attendance.service");

const SMOKE_URI =
  "mongodb://127.0.0.1:27017/eduk_control_smoke";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label} ${detail}`);
  }
};

const makeStudent = (n) =>
  Student.create({
    school: new mongoose.Types.ObjectId(),
    curp: "XEXX010101MNLUR00" + n, // 18 caracteres alfanuméricos mayúsculas
    first_name: `Smoke${n}`,
    last_name: "Dedup",
    status: "active",
  });

const logsOf = (studentId) =>
  AttendanceLog.find({ student_id: studentId })
    .sort({ event_time: 1 })
    .lean();

async function main() {
  await mongoose.connect(SMOKE_URI);
  await mongoose.connection.dropDatabase();
  console.log(`BD: ${mongoose.connection.name} (dropeada antes de empezar)\n`);

  const base = Date.now();

  // ---- A) race: taps concurrentes, mismo instante, distinto dispositivo ----
  console.log("[A] race: dos taps concurrentes (RFID + FACE)");
  const sa = await makeStudent(1);
  const [ra, rb] = await Promise.all([
    registerAttendanceEvent({
      student: sa,
      eventTime: new Date(base),
      device: "hikvision@test-rfid",
      verificationMode: "RFID",
    }),
    registerAttendanceEvent({
      student: sa,
      eventTime: new Date(base),
      device: "hikvision@test-face",
      verificationMode: "FACE",
    }),
  ]);
  const aLogs = await logsOf(sa._id);
  check("1 solo log creado", aLogs.length === 1, `(${aLogs.length})`);
  check(
    "exactamente un resultado es duplicate",
    [ra, rb].filter((r) => r.duplicate).length === 1
  );
  check("tipo entry", aLogs[0].event_type === "entry", `(${aLogs[0].event_type})`);

  // ---- B) ventana cross-device: tap +3 min después → duplicate ----
  console.log("[B] ventana 5 min: tap repetido a +3 min");
  const sb = await makeStudent(2);
  await registerAttendanceEvent({
    student: sb,
    eventTime: new Date(base),
    device: "reader@1",
    verificationMode: "RFID",
  });
  const rb2 = await registerAttendanceEvent({
    student: sb,
    eventTime: new Date(base + 3 * 60 * 1000),
    device: "reader@2", // dispositivo DISTINTO
    verificationMode: "FACE",
  });
  const bLogs = await logsOf(sb._id);
  check("segundo tap es duplicate", rb2.duplicate === true);
  check("sigue habiendo 1 solo log", bLogs.length === 1, `(${bLogs.length})`);

  // ---- C) fuera de ventana: entry y exit reales ----
  console.log("[C] fuera de ventana: entry y exit a 6 min");
  const sc = await makeStudent(3);
  await registerAttendanceEvent({
    student: sc,
    eventTime: new Date(base - 10 * 60 * 1000),
    device: "reader@1",
    verificationMode: "RFID",
  });
  const rc = await registerAttendanceEvent({
    student: sc,
    eventTime: new Date(base - 4 * 60 * 1000),
    device: "reader@1",
    verificationMode: "RFID",
  });
  const cLogs = await logsOf(sc._id);
  check("2 logs", cLogs.length === 2, `(${cLogs.length})`);
  check("tipos entry → exit", cLogs.map((l) => l.event_type).join(",") === "entry,exit",
    `(${cLogs.map((l) => l.event_type).join(",")})`);
  check("segundo tap NO es duplicate", rc.duplicate === false);

  // ---- D) clamp anti-futuro ----
  console.log("[D] clamp: event_time +2h en el futuro");
  const sd = await makeStudent(4);
  const future = new Date(base + 2 * 60 * 60 * 1000);
  await registerAttendanceEvent({
    student: sd,
    eventTime: future,
    device: "reader@1",
    verificationMode: "FACE",
  });
  const dLogs = await logsOf(sd._id);
  check("1 log", dLogs.length === 1, `(${dLogs.length})`);
  check(
    "event_time ≈ ahora (no +2h)",
    dLogs.length === 1 &&
      Math.abs(dLogs[0].event_time - Date.now()) < 10 * 1000,
    dLogs.length === 1
      ? `guardó ${dLogs[0].event_time.toISOString()}`
      : ""
  );

  // ---- E) late-arrival: absent de hoy se revierte, no crea exit ----
  console.log("[E] late-arrival: absent de hoy + tap → on_time");
  const se = await makeStudent(5);
  // El absent se coloca a medianoche LOCAL del mismo día local del tap.
  // Los queries internos usan el rango naive [D 00:00Z, D+1 00:00Z); 06:00Z
  // (00:00 local con offset -360) cae SIEMPRE dentro, a cualquier hora en
  // que se corra el smoke (con "base − 1h" fallaba entre 19:00–24:00 local:
  // el event_time cruzaba la medianoche UTC y quedaba fuera del rango).
  const tzOffset = parseInt(process.env.ADMS_TZ_OFFSET_MINUTES || "-360", 10);
  const tapLocal = new Date(base + tzOffset * 60000);
  const naiveDay = Date.UTC(
    tapLocal.getUTCFullYear(),
    tapLocal.getUTCMonth(),
    tapLocal.getUTCDate()
  );
  const absent = await AttendanceLog.create({
    school: se.school,
    student_id: se._id,
    event_time: new Date(naiveDay - tzOffset * 60000), // 00:00 hora local
    event_type: "entry",
    device: "auto@system",
    verificationMode: "MANUAL",
    status: "absent",
  });
  const re = await registerAttendanceEvent({
    student: se,
    eventTime: new Date(base),
    device: "reader@1",
    verificationMode: "RFID",
  });
  const eLogs = await logsOf(se._id);
  check("wasAbsenceOverride true", re.wasAbsenceOverride === true);
  check("1 solo log (el absent reutilizado)", eLogs.length === 1, `(${eLogs.length})`);
  check(
    "log quedó on_time con hora del tap",
    eLogs.length === 1 &&
      eLogs[0].status === "on_time" &&
      Math.abs(eLogs[0].event_time - base) < 5 * 1000,
    eLogs.length === 1
      ? `status=${eLogs[0].status} ev=${eLogs[0].event_time.toISOString()}`
      : ""
  );
  check("mismo _id que el absent", String(re.log._id) === String(absent._id));

  // ---- cleanup ----
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  console.log(
    failures === 0
      ? "\n=== SMOKE OK: todos los checks pasaron ==="
      : `\n=== SMOKE FALLÓ: ${failures} check(s) fallaron ===`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[!] Error:", err);
  process.exit(1);
});
