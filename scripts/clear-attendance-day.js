// scripts/clear-attendance-day.js
//
// BORRADO TOTAL de AttendanceLog de UN día local (America/Mexico_City,
// offset configurable vía ADMS_TZ_OFFSET_MINUTES, default -360 = CDMX).
// Sirve para "reiniciar" un día de asistencia sucio (pruebas, dobles
// registros, cron caído) y arrancar el siguiente día limpio.
//
// Qué hace:
//   1. Cuenta los logs del día por escuela / event_type / status.
//   2. Vuelca una copia COMPLETA de todos los documentos a un JSON de
//      backup (scripts/_backups/) antes de tocar nada.
//   3. Borra con deleteMany el rango [medianoche local, medianoche + 24h).
//   4. Verifica que quedaron 0 logs en el rango.
//
// NO toca: Notification (historial de pushes ya entregados a teléfonos),
// SchoolShift.absenceMarkedAt / exitCheckedAt (gates por fecha-vs-hoy que
// no bloquean días siguientes), ni ningún otro modelo.
//
// Uso:
//   DRY_RUN=1 MONGO_URI="mongodb+srv://..." node scripts/clear-attendance-day.js 2026-10-12   # preview (default)
//   DRY_RUN=0 MONGO_URI="mongodb+srv://..." node scripts/clear-attendance-day.js 2026-10-12   # aplica
//
// Sin argumento de fecha usa el día ACTUAL en hora local (por eso un día
// ya cerrado se pasa explícito para no borrar por accidente "hoy vivo").
//
// Idempotente: si el rango ya quedó vacío, backup = 0 docs y deleteMany = 0.
// Repetible durante un deploy sin efectos secundarios.

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const DRY_RUN = !["0", "false", "no"].includes(
  String(process.env.DRY_RUN || "1").toLowerCase()
);

const TZ_OFFSET_MIN = parseInt(
  process.env.ADMS_TZ_OFFSET_MINUTES || "-360",
  10
);

// Fecha local "YYYY-MM-DD" (default: hoy en zona horaria local).
function localTodayISO(offsetMin) {
  const nowUtc = Date.now();
  const local = new Date(nowUtc + offsetMin * 60000);
  return local.toISOString().slice(0, 10);
}

// Día local → rango UTC [start, end): la medianoche local `dateStrT00:00`
// equivale a `dateStrT00:00 - offsetMin` en UTC
// (offset -360 → medianoche CDMX = 06:00 UTC).
function localDayRangeUTC(dateStr, offsetMin) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Fecha inválida: "${dateStr}" (esperado YYYY-MM-DD)`);
  }
  const localMidnight = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(localMidnight)) {
    throw new Error(`Fecha inválida: "${dateStr}"`);
  }
  const start = new Date(localMidnight - offsetMin * 60000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("[!] MONGO_URI no está definida (pásala como env var)");
    process.exit(1);
  }

  const dateArg = process.argv[2] || localTodayISO(TZ_OFFSET_MIN);
  const { start, end } = localDayRangeUTC(dateArg, TZ_OFFSET_MIN);

  await mongoose.connect(process.env.MONGO_URI, { dbName: "eduk-control" });
  const col = mongoose.connection.db.collection("attendancelogs");

  console.log(
    `=== clear-attendance-day (DRY_RUN=${DRY_RUN}) ===`
  );
  console.log(`fecha día local : ${dateArg} (offset ${TZ_OFFSET_MIN} min)`);
  console.log(
    `rango UTC       : [${start.toISOString()}, ${end.toISOString()})\n`
  );

  const filter = { event_time: { $gte: start, $lt: end } };
  const total = await col.countDocuments(filter);

  if (total === 0) {
    console.log("0 logs en el rango — nada que hacer (idempotente).");
    await mongoose.disconnect();
    return;
  }

  // ------------------------------------------------------------------
  // 1) Conteos por escuela / tipo / estado (preview)
  // ------------------------------------------------------------------
  const bySchool = await col
    .aggregate([
      { $match: filter },
      {
        $group: {
          _id: { school: "$school", event_type: "$event_type", status: "$status" },
          n: { $sum: 1 },
        },
      },
      { $sort: { "_id.school": 1, "_id.event_type": 1, "_id.status": 1 } },
    ])
    .toArray();

  const bySchoolTotals = {};
  for (const row of bySchool) {
    const s = String(row._id.school);
    bySchoolTotals[s] = (bySchoolTotals[s] || 0) + row.n;
    console.log(
      `  ${s}  ${row._id.event_type}/${row._id.status || "-"}  →  ${row.n}`
    );
  }
  const exitMissingCount = await col.countDocuments({
    ...filter,
    exit_missing: true,
  });
  console.log(`\ntotal logs      : ${total}`);
  console.log(`  por escuela    : ${JSON.stringify(bySchoolTotals)}`);
  console.log(`  exit_missing   : ${exitMissingCount}`);

  if (DRY_RUN) {
    console.log(
      "\n[DRY] No se escribió backup ni se borró nada. " +
        "Repite con DRY_RUN=0 para aplicar."
    );
    await mongoose.disconnect();
    return;
  }

  // ------------------------------------------------------------------
  // 2) Backup JSON completo ANTES de borrar
  // ------------------------------------------------------------------
  const backupDir = path.join(__dirname, "_backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(
    backupDir,
    `attendance-clear-${dateArg}-${Date.now()}.json`
  );
  const docs = await col.find(filter).toArray();
  fs.writeFileSync(
    backupFile,
    JSON.stringify(
      {
        meta: {
          script: "clear-attendance-day",
          date_local: dateArg,
          tz_offset_min: TZ_OFFSET_MIN,
          range_utc: { start: start.toISOString(), end: end.toISOString() },
          total: docs.length,
          by_school_totals: bySchoolTotals,
          exit_missing: exitMissingCount,
          created_at: new Date().toISOString(),
        },
        logs: docs,
      },
      null,
      2
    )
  );
  console.log(`\nbackup escrito  : ${backupFile} (${docs.length} docs)`);

  // ------------------------------------------------------------------
  // 3) Borrado
  // ------------------------------------------------------------------
  const res = await col.deleteMany(filter);
  console.log(`deleteMany       : deletedCount=${res.deletedCount}`);

  // ------------------------------------------------------------------
  // 4) Verificación
  // ------------------------------------------------------------------
  const after = await col.countDocuments(filter);
  if (after !== 0) {
    console.error(`[!] VERIFICACIÓN FALLÓ: quedan ${after} logs en el rango`);
    process.exitCode = 1;
  } else {
    console.log(`verificación OK  : 0 logs en el rango`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[!] clear-attendance-day falló:", err);
  process.exit(1);
});
