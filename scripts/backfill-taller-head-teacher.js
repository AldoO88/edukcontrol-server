// scripts/backfill-taller-head-teacher.js
// ---------------------------------------------------------------------
// Backfill idempotente: setea `Group.head_teacher_id` en los grupos
// `type: "taller"` que no lo tengan, copiando el maestro de su
// TeacherSubject de materia WORKSHOP (ej. Tecnología).
//
// Contexto: el dropdown de materias de Horarios (schedules page) solo
// muestra Tecnología si cada grupo taller del grado tiene (a)
// `head_teacher_id` y (b) un TeacherSubject (ese mismo maestro + la
// materia WORKSHOP). La UI NO tiene form para setear `head_teacher_id`
// (gap), así que una escuela que armó todo por la web queda bloqueada:
// los TS existen pero el gate nunca deja pasar Tecnología.
//
// Fuente de verdad: el TeacherSubject de la materia WORKSHOP que ya
// existe contra cada grupo taller (el admin ya asignó al maestro correcto
// desde "Asignar Materias"). Si un grupo taller tiene exactamente UN
// teacher en sus TS de WORKSHOP, ese es su head_teacher. Si tiene 0 o
// más de 1, se omite con warning (decisión manual).
//
// Idempotente: solo toca grupos con `head_teacher_id` null/ausente.
//
// Flags:
//   DRY_RUN=1        Cuenta lo que haría y no escribe nada (default: ON).
//                    Para aplicar: DRY_RUN=0 node scripts/backfill-taller-head-teacher.js
//   SCHOOL_ID=<oid>  Limita a una escuela (opcional; default: todas las activas).
//
// Uso:
//   DRY_RUN=1 MONGO_URI=... node scripts/backfill-taller-head-teacher.js
//   DRY_RUN=0 MONGO_URI=... node scripts/backfill-taller-head-teacher.js
//   DRY_RUN=0 SCHOOL_ID=6abc5b2de5ede2c2d76ae24a MONGO_URI=... node scripts/backfill-taller-head-teacher.js

require("dotenv").config();

const mongoose = require("mongoose");
const School = require("../models/School.model");
const SchoolYear = require("../models/SchoolYear.model");
const Group = require("../models/Group.model");
const TeacherSubject = require("../models/TeacherSubject.model");
const Subject = require("../models/Subject.model");
const User = require("../models/User.model");

const DRY_RUN = process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false";
const SCHOOL_ID = process.env.SCHOOL_ID || null;

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("ERROR: MONGO_URI no está definido en el entorno.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  try {
    console.log("=== Backfill Group.head_teacher_id (grupos taller) ===");
    console.log(`DRY_RUN: ${DRY_RUN}`);
    if (SCHOOL_ID) console.log(`SCHOOL_ID: ${SCHOOL_ID} (limitado)`);

    const schoolFilter = SCHOOL_ID
      ? { _id: new mongoose.Types.ObjectId(SCHOOL_ID), isActive: true }
      : { isActive: true };
    const schools = await School.find(schoolFilter).select("_id name").lean();
    if (schools.length === 0) {
      console.log("No hay escuelas activas. Saliendo.");
      return;
    }

    let totalSet = 0;
    let totalSkipNoTs = 0;
    let totalSkipMulti = 0;

    for (const school of schools) {
      // Ciclo activo de la escuela (si no hay, usamos todos los ciclos activos por escuela)
      const years = await SchoolYear.find({
        school: school._id,
        isActive: true,
      })
        .select("_id name")
        .lean();

      for (const year of years) {
        // Grupos taller SIN head_teacher_id en este ciclo
        const tallerGroups = await Group.find({
          school: school._id,
          school_year_id: year._id,
          type: "taller",
          $or: [{ head_teacher_id: null }, { head_teacher_id: { $exists: false } }],
        })
          .select("_id grade section head_teacher_id")
          .lean();

        if (tallerGroups.length === 0) continue;

        // MATERIAS WORKSHOP de la escuela (una sola query, resolvemos después)
        const workshopSubjectIds = await Subject.find({
          school: school._id,
          classificationType: "WORKSHOP",
        })
          .select("_id")
          .lean()
          .then((ss) => ss.map((s) => s._id));

        if (workshopSubjectIds.length === 0) {
          console.log(
            `[${school.name} / ${year.name}] Sin materias WORKSHOP — no puedo derivar head_teacher. Omitiendo ${tallerGroups.length} grupos taller.`
          );
          continue;
        }

        for (const taller of tallerGroups) {
          // TeacherSubjects de este grupo taller cuya materia sea WORKSHOP
          const tsList = await TeacherSubject.find({
            school: school._id,
            school_year_id: year._id,
            group_id: taller._id,
            subject_id: { $in: workshopSubjectIds },
          })
            .select("teacher_id subject_id")
            .lean();

          const teacherIds = [...new Set(tsList.map((t) => String(t.teacher_id)))];

          if (teacherIds.length === 0) {
            totalSkipNoTs += 1;
            console.log(
              `[${school.name} / ${year.name}] ${taller.grade}°${taller.section}: SIN TeacherSubject WORKSHOP — omitido (asigna la materia en "Asignar Materias" primero).`
            );
            continue;
          }
          if (teacherIds.length > 1) {
            totalSkipMulti += 1;
            console.warn(
              `[${school.name} / ${year.name}] ${taller.grade}°${taller.section}: ${teacherIds.length} maestros WORKSHOP distintos — decidir manualmente. Omitido.`
            );
            continue;
          }

          // Exactamente UN maestro WORKSHOP → es el head_teacher
          const teacherOid = new mongoose.Types.ObjectId(teacherIds[0]);
          const teacher = await User.findById(teacherOid)
            .select("name last_name")
            .lean();
          const teacherName = teacher
            ? `${teacher.name} ${teacher.last_name || ""}`.trim()
            : teacherIds[0];

          if (DRY_RUN) {
            console.log(
              `[DRY_RUN] ${school.name} / ${year.name} / ${taller.grade}°${taller.section}: → head_teacher_id = ${teacherName}`
            );
          } else {
            await Group.updateOne(
              { _id: taller._id },
              { $set: { head_teacher_id: teacherOid } }
            );
            console.log(
              `OK ${school.name} / ${year.name} / ${taller.grade}°${taller.section}: head_teacher_id = ${teacherName}`
            );
          }
          totalSet += 1;
        }
      }
    }

    console.log("");
    console.log("=== Resumen ===");
    console.log(
      `${DRY_RUN ? "[DRY_RUN] Setearía" : "Seteados"}: ${totalSet} | Sin TS (omitidos): ${totalSkipNoTs} | Multi-maestro (omitidos): ${totalSkipMulti}`
    );
    if (DRY_RUN && totalSet > 0) {
      console.log(
        "DRY_RUN → no se escribió nada. Repetir con DRY_RUN=0 para aplicar."
      );
    }
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
