// scripts/backfill-expediente-status.js
// ---------------------------------------------------------------------
// Backfill idempotente del estado del EXPEDIENTE (sección web del
// trabajador social): pone `expediente_status: "in_progress"` a los
// alumnos que YA tienen datos capturados en `health_inclusion` (o
// medical_notes), para que el listado web no muestre "pendiente" a
// expedientes que en realidad ya se llenaron desde la app móvil.
//
// Quién se marca:
//   - expediente_status ausente o "pending" (nunca degrada "completed").
//   - Y con datos reales en health_inclusion: algún campo escalar con
//     valor, algún arreglo con elementos (medicamentos, contactos,
//     alertas, visitas, miembros de familia) o medical_notes.
//
// Flags:
//   DRY_RUN=1   Cuenta lo que haría y no escribe nada (default: ON).
//               Para aplicar: DRY_RUN=0 node scripts/backfill-expediente-status.js
//
// Uso (siempre contra la BD correcta — prod: MONGO_URI_ATLAS):
//   DRY_RUN=1 MONGO_URI=... node scripts/backfill-expediente-status.js
//   DRY_RUN=0 MONGO_URI=... node scripts/backfill-expediente-status.js

require("dotenv").config();

const mongoose = require("mongoose");
const Student = require("../models/Student.model");

const DRY_RUN = process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false";

// Campos escalares de health_inclusion que cuentan como "con datos".
// "ninguna" en disability_type es el valor por defecto de algunos
// flujos → NO cuenta como dato.
const SCALAR_FIELDS = [
  "learning_style",
  "style_hint",
  "diagnosis",
  "disability_severity",
  "allergies",
  "health_insurance",
  "vaccination_authorization",
  "protection_civil_authorization",
  "last_evaluation_date",
  "notes",
];

// Arreglos de health_inclusion con al menos un elemento.
const ARRAY_FIELDS = [
  "medical_conditions",
  "medications",
  "alerts",
  "emergency_contacts",
  "home_visits",
];

// Ojo con los booleanos: vaccination_authorization y
// protection_civil_authorization son `default: false` en el schema, así
// que `false` NO es dato capturado (marcaba el 100% de los alumnos).
// Solo cuenta un `true` explícito.
const hasValue = (v) =>
  v !== undefined &&
  v !== null &&
  v !== "" &&
  v !== false &&
  !(Array.isArray(v) && v.length === 0);

const hasExpedienteData = (student) => {
  if (student.medical_notes) return true;
  const h = student.health_inclusion;
  if (!h) return false;

  for (const f of SCALAR_FIELDS) {
    if (hasValue(h[f])) return true;
  }
  // disability_type con dato real (excluye "ninguna")
  if (h.disability_type && h.disability_type !== "ninguna") return true;

  for (const f of ARRAY_FIELDS) {
    if (Array.isArray(h[f]) && h[f].length > 0) return true;
  }

  // family_socioeconomic: cuenta si hay miembros o cualquier campo con valor
  const fam = h.family_socioeconomic;
  if (fam && typeof fam === "object") {
    if (Array.isArray(fam.family_members) && fam.family_members.length > 0) {
      return true;
    }
    const { family_members: _ignored, ...rest } = fam;
    if (Object.values(rest).some(hasValue)) return true;
  }

  return false;
};

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("ERROR: MONGO_URI no está definido en el entorno.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  try {
    console.log("=== Backfill Student.expediente_status ===");
    console.log(`DRY_RUN: ${DRY_RUN}`);

    // Solo alumnos que todavía no tienen estado (pending por default en
    // docs viejos sin el campo) y con datos reales capturados.
    const candidates = await Student.find({
      $or: [
        { expediente_status: { $exists: false } },
        { expediente_status: "pending" },
      ],
    })
      .select(
        "first_name last_name controlNumber medical_notes health_inclusion expediente_status"
      )
      .lean();

    const toMark = candidates.filter(hasExpedienteData);

    console.log(`Alumnos revisados: ${candidates.length}`);
    console.log(`Con datos de expediente → in_progress: ${toMark.length}`);
    if (toMark.length > 0) {
      console.log("Ejemplos:");
      for (const s of toMark.slice(0, 5)) {
        console.log(
          `  - ${s.last_name || ""} ${s.first_name || ""} (${s.controlNumber})`
        );
      }
    }

    if (toMark.length === 0) {
      console.log("Nada que marcar. Saliendo.");
      return;
    }

    if (DRY_RUN) {
      console.log("");
      console.log(
        "DRY_RUN → no se escribió nada. Repetir con DRY_RUN=0 para aplicar."
      );
      return;
    }

    const ids = toMark.map((s) => s._id);
    const result = await Student.updateMany(
      { _id: { $in: ids } },
      { $set: { expediente_status: "in_progress" } }
    );
    console.log(`OK → ${result.modifiedCount} alumnos marcados como in_progress.`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
