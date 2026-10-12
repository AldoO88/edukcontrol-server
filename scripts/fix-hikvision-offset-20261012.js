// scripts/fix-hikvision-offset-20261012.js
//
// Corrección puntual de datos para los AttendanceLog escritos el 2026-10-12
// por las terminales Hikvision de la Escuela Secundaria Técnica No. 47,
// cuya zona horaria estaba mal configurada (offset equivocado a UTC-8 en vez
// de UTC-6 CDMX): TODOS los logs del día quedaron con `event_time` =
// hora real + 2 horas (createdAt del servidor = referencia de tiempo real).
//
// Además, en la puerta conviven lector RFID (`...:ed`) y terminal facial
// (`...:9f`): la tarjeta registraba el `entry` y el rostro, segundos
// después, creaba un `exit` falso por la alternancia automática. Este
// script borra esos `exit` ocurridos a menos de 5 minutos del log anterior
// del mismo alumno (misma regla que el nuevo dedup cross-device del
// servicio de asistencia).
//
// Uso:
//   DRY_RUN=1 MONGO_URI="mongodb+srv://..." node scripts/fix-hikvision-offset-20261012.js   # preview (default)
//   DRY_RUN=0 MONGO_URI="mongodb+srv://..." node scripts/fix-hikvision-offset-20261012.js   # aplica
//
// Idempotente: un log ya corregido deja de caer en el filtro de delta
// [110,130] min, y un `exit` ya borrado no aparece en la cadena del alumno.
// Repetible: si llegan logs rotos mientras corre el deploy, vuelve a
// ejecutarse sin efectos secundarios.

const mongoose = require("mongoose");

// Día a corregir (logs creados desde el inicio del día en UTC).
const DAY_START = new Date("2026-10-12T00:00:00Z");

// Desfase exacto detectado: el offset de la terminal estampaba +2h
// (UTC-8 vs UTC-6) — se resta 2 horas exactas al event_time.
const OFFSET_MS = 2 * 60 * 60 * 1000;

// Rango de detección de logs rotos: event_time - createdAt entre 110 y 130
// minutos (2h exactos menos la latencia de red de unos segundos). Un delta
// fuera de ese rango no es el bug de zona horaria y NO se toca.
const DELTA_MIN_MS = 110 * 60 * 1000;
const DELTA_MAX_MS = 130 * 60 * 1000;

// Misma ventana que services/attendance.service.js (ATTENDANCE_DEDUP_WINDOW_MIN):
// un `exit` a menos de 5 min del log anterior del mismo alumno es un
// falso exit por doble verificación en la misma puerta.
const FALSE_EXIT_WINDOW_MS = 5 * 60 * 1000;

const DRY_RUN =
  !["0", "false", "no"].includes(String(process.env.DRY_RUN || "1").toLowerCase());

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("[!] MONGO_URI no está definida (pásala como env var)");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { dbName: "eduk-control" });
  const col = mongoose.connection.db.collection("attendancelogs");

  console.log(`=== fix-hikvision-offset-20261012 (DRY_RUN=${DRY_RUN}) ===\n`);

  // ------------------------------------------------------------------
  // 1) event_time +2h → restar 2 horas
  // ------------------------------------------------------------------
  const todays = await col
    .find({ createdAt: { $gte: DAY_START } })
    .project({ student_id: 1, event_time: 1, createdAt: 1, event_type: 1, device: 1, status: 1 })
    .toArray();

  const toFixTime = todays.filter((l) => {
    const delta = l.event_time - l.createdAt;
    return delta >= DELTA_MIN_MS && delta <= DELTA_MAX_MS;
  });

  console.log(`[1] Logs con event_time +2h: ${toFixTime.length} de ${todays.length} creados hoy`);
  for (const l of toFixTime.slice(0, 5)) {
    console.log(
      `    ${l.event_time.toISOString()} → ${new Date(l.event_time - OFFSET_MS).toISOString()} | ${l.event_type} | ${l.device}`
    );
  }
  if (toFixTime.length > 5) console.log(`    … y ${toFixTime.length - 5} más`);

  // ------------------------------------------------------------------
  // 2) Borrar `exit` falsos: exit a <5 min del log anterior (por
  //    createdAt = tiempo real) del mismo alumno, sin importar el dispositivo.
  //    Se evalúa en orden cronológico real; los borrados NO se convierten en
  //    "log anterior" para las siguientes comparaciones (un exit duplicado
  //    posterior sigue midiendo contra el entry que lo originó).
  // ------------------------------------------------------------------
  const byStudent = new Map();
  for (const l of todays) {
    const key = String(l.student_id);
    if (!byStudent.has(key)) byStudent.set(key, []);
    byStudent.get(key).push(l);
  }

  const falseExits = [];
  for (const logs of byStudent.values()) {
    logs.sort((a, b) => a.createdAt - b.createdAt);
    let lastKept = null;
    for (const l of logs) {
      if (lastKept && l.event_type === "exit") {
        const gap = l.createdAt - lastKept.createdAt;
        if (gap < FALSE_EXIT_WINDOW_MS) {
          falseExits.push({
            _id: l._id,
            gapMin: (gap / 60000).toFixed(1),
            after: lastKept.event_type,
            createdAt: l.createdAt,
            device: l.device,
          });
          continue; // se borra; no se actualúa lastKept
        }
      }
      lastKept = l;
    }
  }

  console.log(`\n[2] Exit falsos (<5 min tras el log anterior del alumno): ${falseExits.length}`);
  for (const l of falseExits) {
    console.log(
      `    ${l.createdAt.toISOString()} gap=${l.gapMin}min tras ${l.after} | ${l.device} | id=${l._id}`
    );
  }

  // ------------------------------------------------------------------
  // 3) Aplicar (o solo reportar en DRY_RUN)
  // ------------------------------------------------------------------
  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 → no se escribió nada. Repetir con DRY_RUN=0 para aplicar.");
    await mongoose.disconnect();
    return;
  }

  if (toFixTime.length > 0) {
    const ops = toFixTime.map((l) => ({
      updateOne: {
        filter: { _id: l._id },
        update: { $set: { event_time: new Date(l.event_time.getTime() - OFFSET_MS) } },
      },
    }));
    const res1 = await col.bulkWrite(ops, { ordered: false });
    console.log(`\n[1] ${res1.modifiedCount} event_time corregidos (-2h)`);
  }

  if (falseExits.length > 0) {
    const ops = falseExits.map((l) => ({
      deleteOne: { filter: { _id: l._id } },
    }));
    const res2 = await col.bulkWrite(ops, { ordered: false });
    console.log(`[2] ${res2.deletedCount} exit falsos borrados`);
  }

  // ------------------------------------------------------------------
  // 4) Verificación posterior
  // ------------------------------------------------------------------
  const after = await col
    .find({ createdAt: { $gte: DAY_START } })
    .project({ event_time: 1, createdAt: 1, event_type: 1 })
    .toArray();

  const hist = {};
  for (const l of after) {
    const delta = Math.round((l.event_time - l.createdAt) / 60000);
    hist[delta] = (hist[delta] || 0) + 1;
  }
  console.log(`\n[verify] ${after.length} logs hoy, delta(event_time-createdAt) en minutos:`);
  for (const k of Object.keys(hist).sort((a, b) => a - b)) {
    console.log(`    ${k} min: ${hist[k]}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[!] Error:", err.message);
  process.exit(1);
});
