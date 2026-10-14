// scripts/backfill-citation-scheduled-date.js
// ---------------------------------------------------------------------
// Migración de la convención de `Citation.scheduledDate` (2026-10-14):
//
//   ANTES: hora pared escolar "forzada a UTC" (la app vieja construía con
//          `new Date(Date.UTC(y, m, d, hh, mm))`) → cita de 10:00 guardada
//          como `10:00Z` en vez de `16:00Z`. Con esa convención el cron de
//          no-show y el badge "VENCIDO" del front evaluaban contra el
//          reloj REAL y marcaban vencidos/no_show 6h antes de la cita.
//   AHORA: instante UTC REAL (cita 10:00 hora escolar → `16:00Z`).
//
// El script suma el offset de la escuela a cada doc LEGACY:
//   real = pared − offset   (ADMS_TZ_OFFSET_MINUTES=-360 → +6h)
//
// Idempotencia: solo toca docs con `updatedAt < BEFORE_ISO`. El
// `updateOne` de mongoose bumpa `updatedAt` (timestamps: true), así que
// una segunda corrida con el MISMO BEFORE_ISO los salta — sin doble
// suma. BEFORE_ISO debe ser fijo (el momento del deploy), no "ahora".
// Los citatorios creados por la app NUEVA o por builds viejas vía el
// shim de citations.controller ya nacen como instante real y tienen
// `updatedAt` posterior → también se saltan.
//
// Uso (BEFORE_ISO es OBLIGATORIO para aplicar):
//   DRY_RUN=1 BEFORE_ISO='2026-10-14T18:00:00-06:00' node scripts/backfill-citation-scheduled-date.js
//   BEFORE_ISO='2026-10-14T18:00:00-06:00' node scripts/backfill-citation-scheduled-date.js
//
// IMPORTANTE: hacer backup antes (Mongo Atlas → Snapshots / mongodump).

require("dotenv").config();

const mongoose = require("mongoose");
const Citation = require("../models/Citation.model");
const {
  getSchoolOffsetMinutes,
} = require("../utils/school-time");

async function main() {
  const isDryRun = process.env.DRY_RUN === "1";

  // BEFORE_ISO: corte de idempotencia. Momento del deploy de esta
  // migración (cualquier ISO con offset, ej. '2026-10-14T18:00:00-06:00').
  const beforeRaw = process.env.BEFORE_ISO;
  if (!beforeRaw) {
    console.error(
      "[backfill] Falta BEFORE_ISO. Define el momento del deploy, p. ej.:\n" +
        "  BEFORE_ISO='2026-10-14T18:00:00-06:00' node scripts/backfill-citation-scheduled-date.js\n" +
        "(Usa SIEMPRE el mismo valor en corridas futuras: es la garantía de idempotencia.)"
    );
    process.exitCode = 1;
    return;
  }
  const beforeDate = new Date(beforeRaw);
  if (Number.isNaN(beforeDate.getTime())) {
    console.error(`[backfill] BEFORE_ISO no es una fecha válida: ${beforeRaw}`);
    process.exitCode = 1;
    return;
  }

  // real = pared − offset*60000 (offset negativo para UTC-6 → suma 6h).
  const offsetMs = getSchoolOffsetMinutes() * 60000;

  console.log("[backfill-citation-scheduled-date] Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);

  try {
    const filter = {
      updatedAt: { $lt: beforeDate },
      scheduledDate: { $exists: true },
    };

    const total = await Citation.countDocuments(filter);
    if (total === 0) {
      console.log(
        "[backfill-citation-scheduled-date] No legacy citations to migrate. Nothing to do."
      );
      return;
    }

    console.log(
      `[backfill-citation-scheduled-date] ${total} citation(s) with updatedAt < ${beforeDate.toISOString()} (offset escuela: ${getSchoolOffsetMinutes()} min).`
    );

    if (isDryRun) {
      // Loguea hasta 8 ejemplos con el cambio que SE APLICARÍA.
      const sample = await Citation.find(filter)
        .select("_id scheduledDate status")
        .limit(8)
        .lean();
      for (const c of sample) {
        const oldDate = new Date(c.scheduledDate);
        const newDate = new Date(oldDate.getTime() - offsetMs);
        console.log(
          `  DRY ${c._id} [${c.status}] ${oldDate.toISOString()} → ${newDate.toISOString()}`
        );
      }
      console.log(
        `[backfill-citation-scheduled-date] DRY_RUN: migraría ${total} doc(s). Sin cambios en la DB.`
      );
      return;
    }

    // Aplicar doc por doc (no updateMany: necesitamos bump de updatedAt
    // por doc + log old→new para auditoría).
    let migrated = 0;
    let failed = 0;
    const cursor = Citation.find(filter).select("_id scheduledDate").cursor();

    for await (const doc of cursor) {
      try {
        const oldDate = new Date(doc.scheduledDate);
        const newDate = new Date(oldDate.getTime() - offsetMs);
        await Citation.updateOne(
          { _id: doc._id },
          { $set: { scheduledDate: newDate } }
        );
        console.log(
          `  ${doc._id} ${oldDate.toISOString()} → ${newDate.toISOString()}`
        );
        migrated++;
      } catch (err) {
        console.error(`  ${doc._id} FAILED: ${err.message}`);
        failed++;
      }
    }

    console.log("[backfill-citation-scheduled-date] DONE.");
    console.log(`  migrated: ${migrated}`);
    console.log(`  failed:   ${failed}`);
    console.log(
      "  Verificación rápida: mongosh → db.citations.findOne({ scheduledDate: { $gte: ISODate('<BEFORE_ISO>') } }) ya no debe requerir corrección."
    );
  } catch (error) {
    console.error("[backfill-citation-scheduled-date] FAILED:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("[backfill-citation-scheduled-date] Disconnected");
  }
}

main();
