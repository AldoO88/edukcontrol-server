// scripts/e2e-hikvision-event.js
// ---------------------------------------------------------------------
// E2E manual del endpoint /hikvision/event/:token (push HTTP Listening
// de terminales Hikvision).
//
// Este repo NO tiene framework de tests (AGENTS.md). En lugar de Jest, este
// script es un runner de Node que:
//   1. Se conecta a Mongo para buscar un Student activo (con controlNumber
//      y/o rfid_card) y dejar la DB en estado conocido (limpia sus logs de
//      asistencia de las últimas 24h para que los counters arranquen en 0).
//   2. Hace POST al endpoint /hikvision/event/<token> con payloads XML y
//      JSON sintéticos (rostro, tarjeta, evento malformado, sin match, etc.).
//   3. Verifica el status code, el body, y la presencia/ausencia del
//      AttendanceLog correspondiente.
//
// Uso:
//   # contra el server local (npm run dev):
//   API_URL=http://localhost:5050 \
//   HIKVISION_EVENT_TOKEN="$(grep HIKVISION_EVENT_TOKEN .env | cut -d= -f2)" \
//     node scripts/e2e-hikvision-event.js
//
//   # contra el server deployado:
//   API_URL=https://adukcontrol-server.onrender.com \
//   HIKVISION_EVENT_TOKEN="<el valor configurado en Render>" \
//     node scripts/e2e-hikvision-event.js
//
// Variables de entorno:
//   API_URL                Base del backend (sin slash final).
//   HIKVISION_EVENT_TOKEN  Token configurado en el backend (en Render o .env).
//   MONGO_URI              Para conectarse y armar el fixture.
//   SCHOOL_ID              (Opcional) Default 6a790cb141b48704e7d2d72e.
//   DRY_RUN=1              Solo muestra qué haría sin borrar logs ni postear.

require("dotenv").config();

const mongoose = require("mongoose");

const Student = require("../models/Student.model");
const AttendanceLog = require("../models/AttendanceLog.model");
const { buildIvmsId } = require("../utils/ivms-id");

const API_URL = (process.env.API_URL || "http://localhost:5050").replace(/\/$/, "");
const TOKEN = process.env.HIKVISION_EVENT_TOKEN;
const SCHOOL_ID = process.env.SCHOOL_ID || "6a790cb141b48704e7d2d72e";
const DRY_RUN = process.env.DRY_RUN === "1";

if (!TOKEN) {
  console.error("[!] HIKVISION_EVENT_TOKEN es requerido (env).");
  process.exit(1);
}

const safeMongoHost = (uri) => {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.username ? "***@" : ""}${u.hostname}${u.pathname}`;
  } catch {
    return "(uri no parseable)";
  }
};

// ── Result helpers ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

const ok = (name, info = "") => {
  passed += 1;
  results.push({ status: "OK", name, info });
  console.log(`  ✔ ${name}${info ? "  " + info : ""}`);
};

const bad = (name, info = "") => {
  failed += 1;
  results.push({ status: "FAIL", name, info });
  console.log(`  ✘ ${name}${info ? "  " + info : ""}`);
};

// ── HTTP helper (Node 18+ tiene fetch global) ───────────────────────────
const post = async (path, { body, contentType = "application/xml", token } = {}) => {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...(token ? { "X-Test-Token": token } : {}),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text, contentType: res.headers.get("content-type") || "" };
};

// ── XML payload builders ─────────────────────────────────────────────────
const xmlEvent = ({
  employeeNo,
  cardNo = "",
  ipAddress = "192.168.100.42",
  mac = "aa:bb:cc:dd:ee:ff",
  channelID = "1",
  dateTime = "2026-09-29T13:31:55+00:00",
  activePostCount = "1",
  eventType = "AccessControllerEvent",
  eventState = "active",
  eventDescription = "Access Controller Event",
  major = "5",
  minor = "75",
  doorNo = "1",
  name = "Face Authentication",
} = {}) => {
  const cardField = cardNo
    ? `<cardNo>${cardNo}</cardNo>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <ipAddress>${ipAddress}</ipAddress>
  <portNo>80</portNo>
  <protocolType>HTTP</protocolType>
  <macAddress>${mac}</macAddress>
  <channelID>${channelID}</channelID>
  <dateTime>${dateTime}</dateTime>
  <activePostCount>${activePostCount}</activePostCount>
  <eventType>${eventType}</eventType>
  <eventState>${eventState}</eventState>
  <eventDescription>${eventDescription}</eventDescription>
  <AccessControllerEvent>
    <majorEventType>${major}</majorEventType>
    <subEventType>${minor}</subEventType>
    <name>${name}</name>
    <employeeNoString>${employeeNo}</employeeNoString>
    ${cardField}
    <doorNo>${doorNo}</doorNo>
  </AccessControllerEvent>
</EventNotificationAlert>`;
};

const jsonEvent = ({ employeeNo, cardNo = "", minor = 75, dateTime = new Date().toISOString() }) =>
  JSON.stringify({
    EventNotificationAlert: {
      ipAddress: "192.168.100.42",
      portNo: 80,
      protocolType: "HTTP",
      macAddress: "aa:bb:cc:dd:ee:ff",
      channelID: "1",
      dateTime,
      activePostCount: 1,
      eventType: "AccessControllerEvent",
      eventState: "active",
      eventDescription: "Access Controller Event",
      AccessControllerEvent: {
        majorEventType: 5,
        subEventType: minor,
        name: "Face Authentication",
        employeeNoString: String(employeeNo),
        cardNo,
        doorNo: 1,
      },
    },
  });

// ── Tests ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[e2e-hikvision] API_URL: ${API_URL}`);
  console.log(`[e2e-hikvision] TOKEN len: ${TOKEN.length}`);
  if (process.env.MONGO_URI) {
    console.log(`[e2e-hikvision] MONGO_URI: ${safeMongoHost(process.env.MONGO_URI)}`);
  }
  console.log(`[e2e-hikvision] DRY_RUN: ${DRY_RUN}\n`);

  // 0) Sanity: backend responde a /health
  console.log("[0] Sanity check");
  try {
    const health = await fetch(`${API_URL}/health`);
    if (health.status === 200) {
      ok("backend /health", "(uptime OK)");
    } else {
      bad("backend /health", `status=${health.status}`);
      process.exit(1);
    }
  } catch (e) {
    bad("backend reachable", e.message);
    console.error(`[!] No se pudo conectar a ${API_URL}. ¿El server está corriendo?`);
    process.exit(1);
  }

  // ── 1) Auth: token inválido → 401 text/plain ────────────────────────
  console.log("\n[1] Auth");
  const r1 = await post("/hikvision/event/wrong-token", {
    body: xmlEvent({ employeeNo: "0" }),
  });
  if (r1.status === 401 && r1.contentType.includes("text/plain")) {
    ok("invalid token → 401 text/plain");
  } else {
    bad("invalid token", `status=${r1.status} ct=${r1.contentType} body=${r1.body.slice(0, 80)}`);
  }

  // ── 2) Body vacío → 200 OK:0 (sin crash, ack para no loop) ───────────
  console.log("\n[2] Body vacío");
  const r2 = await post(`/hikvision/event/${TOKEN}`, { body: "" });
  if (r2.status === 200 && /OK/.test(r2.body)) {
    ok("empty body → 200", `body="${r2.body.trim()}"`);
  } else {
    bad("empty body", `status=${r2.status} body=${r2.body.slice(0, 120)}`);
  }

  // ── 3) Body no-parseable → 200 OK:0 (ack defensivo) ─────────────────
  console.log("\n[3] Body no-parseable");
  const r3 = await post(`/hikvision/event/${TOKEN}`, { body: "<<<not really xml>>>" });
  if (r3.status === 200 && /OK/.test(r3.body)) {
    ok("non-parseable body → 200");
  } else {
    bad("non-parseable body", `status=${r3.status} body=${r3.body.slice(0, 120)}`);
  }

  // Para los siguientes tests necesitamos un Student con controlNumber
  // Y/O rfid_card. Conectamos a Mongo.
  if (!process.env.MONGO_URI) {
    console.error("\n[!] Para los tests [4..N] hace falta MONGO_URI en env.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const student = await Student.findOne({
    school: SCHOOL_ID,
    status: "active",
    controlNumber: { $type: "string" },
  }).select("_id school controlNumber first_name last_name current_group_id rfid_card biometricId");

  if (!student) {
    console.error("\n[!] No se encontró un Student activo con controlNumber. Corré scripts/seed-students.js primero.");
    process.exit(1);
  }

  console.log(
    `\n[i] Fixture student: ${student.controlNumber} (${student.first_name} ${student.last_name}) _id=${student._id}`
  );
  console.log(`[i] biometricId actual: ${student.biometricId} (convención nueva: ID8 = ${buildIvmsId(student.controlNumber) ?? "n/a"})`);

  if (DRY_RUN) {
    console.log("[dry-run] saltando tests que mutan DB y haciendo solo los primeros 3 + sanity.");
    await mongoose.disconnect();
    console.log(`\n[e2e-hikvision] DRY_RUN terminado: ${passed} OK, ${failed} FAIL`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // Limpiar logs del fixture en las últimas 24h para empezar en cero.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cleanup = await AttendanceLog.deleteMany({
    student_id: student._id,
    event_time: { $gte: yesterday },
  });
  console.log(`[i] Limpiados ${cleanup.deletedCount} AttendanceLog(s) del fixture de las últimas 24h.`);

  // ── 4) XML con employeeNo conocido (rostro) → 200 OK:1, log FACE ─────
  console.log("\n[4] XML face auth (employeeNo)");
  const faceDateTime = new Date().toISOString();
  const r4 = await post(`/hikvision/event/${TOKEN}`, {
    body: xmlEvent({ employeeNo: student.controlNumber, minor: 75, dateTime: faceDateTime }),
  });
  if (r4.status === 200 && r4.body.trim() === "OK: 1") {
    ok("face XML → 200 OK: 1", `body="${r4.body.trim()}"`);
  } else {
    bad("face XML", `status=${r4.status} body=${r4.body.slice(0, 200)}`);
  }

  // Verificar que se creó el log con verificationMode=FACE.
  const logFace = await AttendanceLog.findOne({
    student_id: student._id,
    event_time: { $gte: yesterday },
  }).sort({ event_time: -1 });
  if (logFace && logFace.verificationMode === "FACE" && /^hikvision@/.test(logFace.device)) {
    ok("log FACE con device hikvision@*", `device=${logFace.device} mode=${logFace.verificationMode} type=${logFace.event_type}`);
  } else {
    bad(
      "log FACE",
      logFace
        ? `device=${logFace.device} mode=${logFace.verificationMode}`
        : "no log created"
    );
  }

  // ── 5) Mismo evento en <60s → 200 OK:1, duplicate (mismo log) ────────
  console.log("\n[5] Duplicado ±60s");
  const r5 = await post(`/hikvision/event/${TOKEN}`, {
    body: xmlEvent({ employeeNo: student.controlNumber, minor: 75, dateTime: faceDateTime }),
  });
  if (r5.status === 200 && r5.body.trim() === "OK: 1") {
    ok("duplicate XML → 200 OK: 1");
  } else {
    bad("duplicate", `status=${r5.status} body=${r5.body.slice(0, 200)}`);
  }
  const logsAfterDup = await AttendanceLog.countDocuments({
    student_id: student._id,
    event_time: { $gte: yesterday },
  });
  if (logsAfterDup === 1) {
    ok("count sigue en 1 (dedup OK)", `count=${logsAfterDup}`);
  } else {
    bad("count después de duplicado", `count=${logsAfterDup}`);
  }

  // ── 6) Esperar >60s no es viable; en su lugar, forzar un evento con ───
  //    timestamp >60s en el futuro, que cuenta igual para el dedup window.
  //    Luego pasar un event_time 5 min en el FUTURO con otro employeeNo
  //    o con otro major/minor (RFID code 1) → debe crear log RFID.
  console.log("\n[6] RFID card swipe (cardNo conocido)");
  if (!student.rfid_card) {
    console.log("[skip] student no tiene rfid_card — saltando test 6.");
  } else {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const r6 = await post(`/hikvision/event/${TOKEN}`, {
      body: xmlEvent({
        employeeNo: student.controlNumber,
        cardNo: student.rfid_card,
        minor: 1, // card swipe code
        dateTime: future,
      }),
    });
    if (r6.status === 200 && r6.body.trim() === "OK: 1") {
      ok("card XML → 200 OK: 1", `body="${r6.body.trim()}"`);
    } else {
      bad("card XML", `status=${r6.status} body=${r6.body.slice(0, 200)}`);
    }
    const logCard = await AttendanceLog.findOne({
      student_id: student._id,
      event_time: { $gte: yesterday },
    })
      .sort({ event_time: -1 })
      .select("verificationMode device event_type");
    if (logCard && logCard.verificationMode === "RFID") {
      ok("log RFID", `device=${logCard.device} type=${logCard.event_type}`);
    } else {
      bad("log RFID", logCard ? `mode=${logCard.verificationMode}` : "no log");
    }
  }

  // ── 7) employeeNo desconocido → 200 OK:0, sin log ────────────────────
  console.log("\n[7] employeeNo desconocido");
  const future2 = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const r7 = await post(`/hikvision/event/${TOKEN}`, {
    body: xmlEvent({ employeeNo: "9999999999", minor: 75, dateTime: future2 }),
  });
  if (r7.status === 200 && r7.body.trim() === "OK: 0") {
    ok("unknown employeeNo → 200 OK: 0");
  } else {
    bad("unknown employeeNo", `status=${r7.status} body=${r7.body.slice(0, 200)}`);
  }

  // ── 8) JSON con employeeNo → 200 OK:1 ────────────────────────────────
  console.log("\n[8] JSON face auth");
  const future3 = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const r8 = await post(`/hikvision/event/${TOKEN}`, {
    body: jsonEvent({ employeeNo: student.controlNumber, minor: 75, dateTime: future3 }),
    contentType: "application/json",
  });
  if (r8.status === 200 && r8.body.trim() === "OK: 1") {
    ok("JSON face → 200 OK: 1");
  } else {
    bad("JSON face", `status=${r8.status} body=${r8.body.slice(0, 200)}`);
  }

  // ── 9) Evento sin employeeNo ni cardNo → 200 OK:0 (no es asistencia) ─
  console.log("\n[9] Evento sin identificador (alarma)");
  const r9 = await post(`/hikvision/event/${TOKEN}`, {
    body: xmlEvent({ employeeNo: "", minor: 75, dateTime: future3 }),
  });
  if (r9.status === 200 && r9.body.trim() === "OK: 0") {
    ok("evento sin identificador → 200 OK: 0");
  } else {
    bad("evento sin identificador", `status=${r9.status} body=${r9.body.slice(0, 200)}`);
  }

  // ── 10) Convención biometricId = ID8 (Employee ID de iVMS-4200) ──────
  // Transicional: los alumnos migrados con scripts/migrate-biometric-id-to-ivms.js
  // llevan el ID8 (8 dígitos); los creados después del migrate pero con el
  // pre-save viejo todavía nacen con controlNumber (10 dígitos) y matchean
  // por la clause `controlNumber` del $or. Ambos son válidos mientras no
  // cambie el pre-save.
  console.log("\n[10] Convención biometricId (ID8 o controlNumber)");
  const fresh = await Student.findOne({ _id: student._id }).select("biometricId controlNumber");
  const expectedId8 = fresh ? buildIvmsId(fresh.controlNumber) : null;
  if (fresh && fresh.biometricId === expectedId8 && expectedId8 !== null) {
    ok("biometricId == ID8 (convención iVMS)", `biometricId=${fresh.biometricId}`);
  } else if (fresh && fresh.biometricId === fresh.controlNumber) {
    ok("biometricId == controlNumber (pre-save viejo, matchea por $or)", `biometricId=${fresh.biometricId}`);
  } else {
    bad("convención biometricId", `bio=${fresh?.biometricId} cn=${fresh?.controlNumber} id8=${expectedId8}`);
  }

  // ── 11) Evento con employeeNo = ID8 → OK:1 (match por biometricId) ───
  // Solo aplica si el fixture ya fue migrado (biometricId == ID8): con el
  // pre-save viejo un alumno nuevo no matchearía un evento ID8, que es
  // exactamente lo que la migración corrige.
  console.log("\n[11] Evento con employeeNo = ID8");
  if (fresh && expectedId8 && fresh.biometricId === expectedId8) {
    const futureId8 = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const r11 = await post(`/hikvision/event/${TOKEN}`, {
      body: xmlEvent({ employeeNo: expectedId8, minor: 75, dateTime: futureId8 }),
    });
    if (r11.status === 200 && r11.body.trim() === "OK: 1") {
      ok("evento ID8 → 200 OK: 1", `employeeNo=${expectedId8}`);
    } else {
      bad("evento ID8", `status=${r11.status} body=${r11.body.slice(0, 200)}`);
    }
  } else {
    console.log("  - saltado: el fixture no tiene biometricId = ID8 (corré scripts/migrate-biometric-id-to-ivms.js)");
  }

  // ── Resumen ───────────────────────────────────────────────────────────
  await mongoose.disconnect();

  console.log(`\n[e2e-hikvision] Resultado: ${passed} OK, ${failed} FAIL.`);
  if (failed > 0) {
    console.log("\nDetalle de fallas:");
    for (const r of results.filter((x) => x.status === "FAIL")) {
      console.log(`  - ${r.name}: ${r.info}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[FAIL]", err);
  try {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
