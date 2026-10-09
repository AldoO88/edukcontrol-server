// scripts/migrate-biometric-id-to-ivms.js
// ---------------------------------------------------------------------
// Migración de convención: `Student.biometricId` pasa de ser igual al
// controlNumber (10 dígitos) a ser el ID8 / Employee ID de iVMS-4200
// (8 dígitos: YY(2)+SHIFT(1)+CCT2(2)+CONSEC(3), ver utils/ivms-id.js).
//
// Contexto: la terminal Hikvision DS-K1T3xx matchea los eventos contra el
// Employee ID que el admin dio de alta en iVMS-4200, y ese ID viene del
// import de fotos `?format=ivms` (<ID8>.jpg). iVMS limita el Employee ID
// a 8 dígitos, así que el controlNumber de 10 dígitos NUNCA va a llegar
// en el payload del evento — por eso el biometricId tiene que ser el ID8.
//
// Qué hace (por alumno):
//   - biometricId == controlNumber  → se actualiza a ID8   (convención auto)
//   - biometricId null              → se rellena con ID8
//   - biometricId ya == ID8         → skip (idempotente)
//   - biometricId manual (≠ cn e ≠ id8) → skip (con --force se sobrescribe)
//   - controlNumber ≠ 10 dígitos    → skip (no hay ID8 derivable; el
//                                     export ivms los omite igual)
//
// Seguridad:
//   - Pre-check de colisiones {school, id8} ANTES de escribir: si dos
//     alumnos de la misma escuela darían el mismo ID8 (o chocarían con un
//     biometricId manual existente), aborta sin escribir.
//   - Idempotente: re-correrlo no vuelve a modificar nada.
//
// Flags:
//   --dry-run   Reporta lo que haría y no escribe nada.
//   --yes       Salta la confirmación interactiva (para correr non-tty).
//   --force     Incluye también los overrides manuales de biometricId.
//
// Uso:
//   node scripts/migrate-biometric-id-to-ivms.js --dry-run
//   node scripts/migrate-biometric-id-to-ivms.js --yes
//   node scripts/migrate-biometric-id-to-ivms.js --force --yes

require("dotenv").config();

const mongoose = require("mongoose");
const Student = require("../models/Student.model");
const { buildIvmsId } = require("../utils/ivms-id");

const parseArgs = () => {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k && k.startsWith("--")) {
      out[k.slice(2)] = true;
    }
  }
  return out;
};

const safeMongoHost = (uri) => {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.username ? "***@" : ""}${u.hostname}${u.pathname}`;
  } catch {
    return "(uri no parseable)";
  }
};

const sampleRow = (s, id8) =>
  `    ${String(s.first_name || "")} ${String(s.last_name || "")} — cn=${s.controlNumber} → id8=${id8} (bio actual: ${s.biometricId ?? "null"})`;

async function main() {
  const args = parseArgs();
  const dryRun = !!args["dry-run"];
  const force = !!args["force"];
  const yes = !!args["yes"];

  console.log(`[migrate-to-ivms] dry-run=${dryRun} force=${force} yes=${yes}`);
  console.log(`[migrate-to-ivms] MONGO_URI host: ${safeMongoHost(process.env.MONGO_URI)}`);

  if (!process.env.MONGO_URI) {
    console.error("[!] MONGO_URI no está definido. Cargá .env o exportá la variable.");
    process.exit(1);
  }

  // Smoke test de la función compartida — vectores conocidos.
  const vectors = [
    ["2610049001", "26149001"],
    ["2611234001", "26134001"],
    ["2610123001", "26123001"],
  ];
  for (const [cn, want] of vectors) {
    const got = buildIvmsId(cn);
    if (got !== want) {
      console.error(`[FAIL] buildIvmsId(${cn}) = ${got}, esperado ${want}`);
      process.exit(1);
    }
  }
  if (buildIvmsId("abc") !== null) {
    console.error("[FAIL] buildIvmsId no devuelve null para controlNumber inválido");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const students = await Student.find({})
      .select("school first_name last_name controlNumber biometricId status")
      .lean();

    const buckets = {
      update: [], // { _id, id8, row }
      already_ok: [],
      skip_manual: [],
      skip_no_id8: [],
    };

    for (const s of students) {
      const id8 = buildIvmsId(s.controlNumber);
      const bio = s.biometricId ?? null;
      const row = sampleRow(s, id8);

      if (bio !== null && bio === s.controlNumber) {
        // Convención auto anterior: biometricId == controlNumber.
        if (id8) buckets.update.push({ _id: s._id, id8, row });
        else buckets.skip_no_id8.push(row);
      } else if (bio === null) {
        if (id8) buckets.update.push({ _id: s._id, id8, row });
        else buckets.skip_no_id8.push(row);
      } else if (id8 && bio === id8) {
        buckets.already_ok.push(s._id);
      } else if (force && id8) {
        buckets.update.push({ _id: s._id, id8, row, forced: true });
      } else {
        buckets.skip_manual.push(row);
      }
    }

    // --- Pre-check de colisiones del valor FINAL {school, biometricId} ---
    // (el índice único parcial {school, biometricId} rechazaría la escritura)
    const updateById = new Map(buckets.update.map((u) => [String(u._id), u.id8]));
    const finalBySchool = new Map(); // school -> Map(value -> [rows])
    for (const s of students) {
      const finalVal = updateById.has(String(s._id))
        ? updateById.get(String(s._id))
        : s.biometricId ?? null;
      if (finalVal == null) continue;
      const key = String(s.school);
      if (!finalBySchool.has(key)) finalBySchool.set(key, new Map());
      const m = finalBySchool.get(key);
      if (!m.has(finalVal)) m.set(finalVal, []);
      m.get(finalVal).push(
        `${s.first_name || ""} ${s.last_name || ""} (_id=${s._id}, cn=${s.controlNumber})`
      );
    }
    const collisions = [];
    for (const [school, m] of finalBySchool) {
      for (const [value, rows] of m) {
        if (rows.length > 1) collisions.push(`  school=${school} id8=${value}:\n    ${rows.join("\n    ")}`);
      }
    }

    console.log(`\n[migrate-to-ivms] Snapshot (${students.length} students):`);
    console.log(`  a migrar (cn → id8):   ${buckets.update.length}${force ? ` (incluye ${buckets.update.filter((u) => u.forced).length} manuales --force)` : ""}`);
    console.log(`  ya correctos (id8):    ${buckets.already_ok.length}`);
    console.log(`  overrides manuales:    ${buckets.skip_manual.length}${force ? "" : " (sin tocar; usar --force para migrarlos)"}`);
    console.log(`  sin id8 derivable:     ${buckets.skip_no_id8.length} (controlNumber ≠ 10 dígitos)`);

    if (buckets.update.length) {
      console.log("\n  Muestras:");
      for (const u of buckets.update.slice(0, 10)) console.log(u.row);
      if (buckets.update.length > 10) console.log(`    … y ${buckets.update.length - 10} más`);
    }

    if (collisions.length) {
      console.error("\n[FAIL] Colisiones de ID8 dentro de la misma escuela — NO se escribe nada:");
      console.error(collisions.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log("\n[ok] Sin colisiones de {school, biometricId}.");

    if (dryRun) {
      console.log("[dry-run] OK. Re-ejecutá sin --dry-run para aplicar.");
      return;
    }
    if (!buckets.update.length) {
      console.log("[ok] Nada para aplicar.");
      return;
    }

    if (!yes) {
      console.log(`\nEsta migración va a escribir biometricId = ID8 en ${buckets.update.length} alumnos.`);
      console.log("Los overrides manuales NO se tocan (salvo --force). Para abortar: Ctrl-C.");
      console.log("\n¿Continuar? (escribí `yes` para confirmar)");
      process.stdin.setEncoding("utf8");
      const answer = await new Promise((resolve) => {
        process.stdin.once("data", (d) => resolve(String(d).trim()));
        process.stdin.once("error", () => resolve(""));
      });
      if (answer !== "yes") {
        console.log("[abort] cancelado por el usuario");
        return;
      }
    }

    const ops = buckets.update.map((u) => ({
      updateOne: {
        filter: { _id: u._id },
        update: { $set: { biometricId: u.id8 } },
      },
    }));
    const result = await Student.collection.bulkWrite(ops, { ordered: false });
    console.log(`\n[ok] bulkWrite: matched=${result.matchedCount} modified=${result.modifiedCount}`);
    if (result.result?.writeErrors?.length) {
      console.error("[!] writeErrors:", result.result.writeErrors);
    }

    // Verificación final.
    const stillOld = await Student.countDocuments({
      controlNumber: { $type: "string" },
      biometricId: { $type: "string" },
      $expr: { $eq: ["$biometricId", "$controlNumber"] },
    });
    const nowId8 = await Student.countDocuments({
      biometricId: { $type: "string", $regex: /^\d{8}$/ },
    });
    console.log(`[verify] biometricId == controlNumber restantes: ${stillOld} (esperado: overrides manuales + sin id8 = ${buckets.skip_manual.length + buckets.skip_no_id8.length})`);
    console.log(`[verify] biometricId de 8 dígitos: ${nowId8} (esperado: ${buckets.already_ok.length + buckets.update.length})`);
  } catch (err) {
    console.error("[FAIL]", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("[migrate-to-ivms] Disconnected");
  }
}

main();
