// scripts/backfill-group-isactive.js
// ---------------------------------------------------------------------
// Backfill idempotente: pone isActive=true a TODOS los Group que no tengan
// el campo.
//
// Contexto: el cron de asistencia (markAbsencesForSchool y
// runExitCheckForSchool en services/attendance.service.js) filtra
// `Group.find({ ..., isActive: true })`, pero el schema Group.model.js
// NUNCA definió `isActive` — los docs existentes no tienen el campo, el
// filtro no matcheaba NINGÚN grupo y ambos pases del cron corrían en
// vacío (marked=0) en TODAS las escuelas desde siempre. Con el campo
// agregado al schema (default: true) los grupos nuevos nacen activos; este
// script activa los 14 preexistentes.
//
// Los grupos nunca tuvieron UI ni endpoint para desactivarlos, así que
// true es el único valor correcto para los docs existentes.
//
// Flags:
//   DRY_RUN=1   Cuenta lo que haría y no escribe nada (default: ON).
//               Para aplicar: DRY_RUN=0 node scripts/backfill-group-isactive.js
//
// Uso:
//   DRY_RUN=1 MONGO_URI=... node scripts/backfill-group-isactive.js
//   DRY_RUN=0 MONGO_URI=... node scripts/backfill-group-isactive.js

require("dotenv").config();

const mongoose = require("mongoose");
const Group = require("../models/Group.model");

const DRY_RUN = process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false";

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("ERROR: MONGO_URI no está definido en el entorno.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  try {
    const total = await Group.countDocuments({});
    const missing = await Group.countDocuments({ isActive: { $exists: false } });
    const nullish = await Group.countDocuments({ isActive: null });

    console.log("=== Backfill Group.isActive=true ===");
    console.log(`DRY_RUN: ${DRY_RUN}`);
    console.log(`Total groups: ${total}`);
    console.log(`Groups sin isActive: ${missing}`);
    console.log(`Groups con isActive=null: ${nullish}`);

    if (missing === 0 && nullish === 0) {
      console.log("Nada que flipear. Saliendo.");
      return;
    }

    if (DRY_RUN) {
      console.log("");
      console.log("DRY_RUN → no se escribió nada. Repetir con DRY_RUN=0 para aplicar.");
      return;
    }

    const r1 = await Group.updateMany(
      { isActive: { $exists: false } },
      { $set: { isActive: true } }
    );
    const r2 = await Group.updateMany(
      { isActive: null },
      { $set: { isActive: true } }
    );
    console.log(
      `OK: ${r1.modifiedCount} ($exists:false) + ${r2.modifiedCount} (null) → isActive=true`
    );

    const after = await Group.countDocuments({ isActive: true });
    console.log(`Verificación: ${after}/${total} groups con isActive=true`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
