// scripts/clone-tenant-local.js
// ---------------------------------------------------------------------
// Clona UN tenant (una escuela) de MongoDB Atlas (producción) hacia la
// Mongo LOCAL, para probar con datos reales sin tocar prod.
//
// Diseño anti-desastres:
//   1. NUNCA escribe en Atlas — solo lee (source) y escribe en local
//      (target = MONGO_URI). Dry-run por defecto.
//   2. SCRUB DE PUSH TOKENS: copia `guardians` y `users` con
//      proyección `fcm_token: 0`. Si no, cada tap/ausencia/citatorio
//      probado en local NOTIFICARÍA A LAS FAMILIAS REALES (los Expo
//      Push Tokens del clon siguen siendo válidos).
//   3. REFRESH TOKENS NO SE COPIAN (se vacía la colección en local):
//      un refresh token de prod serviría para arrancar sesiones de
//      usuarios reales contra el backend local.
//   4. Borra en local SOLO los docs del tenant clonado
//      (`deleteMany({ school: schoolId })`) → re-clonar es idempotente
//      y NO toca las seeds locales de OTRAS escuelas (útil para
//      probar multi-tenant).
//   6. Si el target ya tiene una escuela con el MISMO cct pero _id
//      distinto (stub local o clon viejo), se REEMPLAZA por completo
//      (borra esa escuela y sus docs) — el índice único `cct_1`
//      chocaría y convivirían 2 escuelas fantasma con el mismo CCT.
//   7. Preserva los `_id` originales → la integridad referencial
//      exacta (student_id, group_id, etc.) queda idéntica a prod.
//
// Colecciones con tratamiento especial:
//   - `schools`        → solo el doc de la escuela clonada.
//   - `refreshtokens`  → NO se copia; target queda vacío.
//   - `assetversions`  → no tiene campo `school`; se filtra por
//     entity_id (docs de la escuela + docs de sus alumnos).
//   - cualquier colección SIN campo `school` → SKIP con aviso (revisar
//     a mano si aparece alguna nueva).
//
// Después de clonar: arrancar el backend local UNA vez para que
// mongoose cree los índices sobre las colecciones recién pobladas
// (autoIndex en el arranque).
//
// Uso (requiere MONGO_URI_ATLAS en .env — NUNCA commitear ese valor):
//   DRY_RUN=1 SCHOOL_NAME='Secundaria No. 47' node scripts/clone-tenant-local.js
//   SCHOOL_ID='64f0...' node scripts/clone-tenant-local.js            # aplica
//   SCHOOL_NAME='...' node scripts/clone-tenant-local.js              # aplica
//
// IMPORTANTE: el clon contiene datos personales de menores (nombres,
// biometría, teléfonos). Tratar la máquina local como confidencial y
// BORRAR el clon al terminar las pruebas.

require("dotenv").config();

const mongoose = require("mongoose");

const CHUNK = 1000; // tamaño de lote para insertMany

async function main() {
  const isDryRun = process.env.DRY_RUN === "1";

  const srcUri = process.env.MONGO_URI_ATLAS;
  const tgtUri = process.env.MONGO_URI;
  if (!srcUri) {
    console.error(
      "[clone] Falta MONGO_URI_ATLAS en .env (URI de Atlas, solo local, no commitear)."
    );
    process.exitCode = 1;
    return;
  }
  if (!tgtUri) {
    console.error("[clone] Falta MONGO_URI (target local) en .env.");
    process.exitCode = 1;
    return;
  }

  console.log("[clone] Conectando a Atlas (source, SOLO LECTURA)...");
  const srcConn = await mongoose.createConnection(srcUri).asPromise();
  const srcDb = srcConn.db;
  console.log(`[clone]   source = ${srcDb.name} @ ${srcConn.host}`);

  console.log("[clone] Conectando a Mongo local (target)...");

  const tgtConn = await mongoose.createConnection(tgtUri).asPromise();
  const tgtDb = tgtConn.db;
  console.log(`[clone]   target = ${tgtDb.name} @ ${tgtConn.host}`);

  try {
    // -------------------------------------------------------------
    // 1) Resolver la escuela destino (por id o por nombre).
    // -------------------------------------------------------------
    const { schoolId, schoolDoc } = await resolveSchool(srcDb);
    console.log(
      `[clone] Escuela: ${schoolDoc.name} (_id=${schoolId}) — dry-run=${isDryRun}`
    );

    // -------------------------------------------------------------
    // Listar TODAS las colecciones del source (se usa para el plano
    // de reemplazo del stub local y para el loop de copia).
    // -------------------------------------------------------------
    const collNames = (await srcDb.listCollections().toArray())
      .map((c) => c.name)
      .sort();

    // -------------------------------------------------------------
    // 1.5) ¿Existe en el TARGET una escuela con el MISMO CCT pero otro
    //      _id (stub local / clon viejo)? Se reemplaza por completo:
    //      el índice único `cct_1` chocaría y convivirían 2 escuelas
    //      "fantasma" con el mismo CCT.
    // -------------------------------------------------------------
    await handleLocalConflict(tgtDb, schoolDoc, collNames, isDryRun);

    // -------------------------------------------------------------
    // 2) Student ids del tenant (necesario para filtrar assetversions
    //    antes de llegar a esa colección).
    // -------------------------------------------------------------
    const studentIds = (
      await srcDb
        .collection("students")
        .find({ school: schoolId }, { projection: { _id: 1 } })
        .toArray()
    ).map((d) => d._id);
    console.log(`[clone] Alumnos del tenant: ${studentIds.length}`);

    // -------------------------------------------------------------
    // 3) Loop de copia por colección.
    // -------------------------------------------------------------
    let totalCopied = 0;
    const report = [];

    for (const name of collNames) {
      const plan = await planCollection(srcDb, name, schoolId, studentIds);
      if (!plan) {
        report.push(`  SKIP     ${name} (sin campo school — revisar a mano)`);
        continue;
      }
      const srcCount = await srcDb.collection(name).countDocuments(plan.filter);
      if (srcCount === 0 && plan.action !== "empty-target") {
        report.push(`  (vacío)  ${name}`);
        continue;
      }
      if (isDryRun) {
        // Filtro legible: los $or/$in grandes se resumen.
        const filterDesc = plan.filter.$or
          ? "<entity_id = escuela o sus alumnos>"
          : JSON.stringify(plan.filter);
        report.push(
          `  DRY ${String(srcCount).padStart(6)}  ${name}  filtro=${filterDesc}${
            plan.scrubTokens ? "  [scrub fcm_token]" : ""
          }${plan.action === "drop-target" ? "  [target vaciado, no se copia]" : ""}`
        );
        continue;
      }

      // -----------------------------------------------------------
      // APPLY: primero limpiar el target (solo el tenant), luego copiar.
      // -----------------------------------------------------------
      if (name === "refreshtokens") {
        // Vaciar por completo: sesiones de prod no deben servir aquí.
        const del = await tgtDb.collection(name).deleteMany({});
        report.push(`  target vaciado (${del.deletedCount} docs): ${name}`);
        continue;
      }
      if (name === "schools") {
        await tgtDb.collection(name).deleteMany({ _id: schoolId });
      } else {
        await tgtDb.collection(name).deleteMany(plan.filter);
      }

      const projection = plan.scrubTokens ? { fcm_token: 0 } : {};
      let copied = 0;
      const cursor = srcDb.collection(name).find(plan.filter, { projection });
      let batch = [];
      for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= CHUNK) {
          await tgtDb.collection(name).insertMany(batch, { ordered: false });
          copied += batch.length;
          batch = [];
        }
      }
      if (batch.length) {
        await tgtDb.collection(name).insertMany(batch, { ordered: false });
        copied += batch.length;
      }
      totalCopied += copied;
      report.push(
        `  OK       ${name}: ${copied} docs${
          plan.scrubTokens ? " (fcm_token excluido)" : ""
        }`
      );
    }

    console.log("[clone] Reporte por colección:");
    for (const line of report) console.log(line);
    console.log(
      isDryRun
        ? `[clone] DRY_RUN: no se escribió nada. Aplica con: SCHOOL_ID='${schoolId}' node scripts/clone-tenant-local.js`
        : `[clone] DONE. Total copiado: ${totalCopied} docs.`
    );
    if (!isDryRun) {
      console.log(
        "[clone] Siguiente paso: arranca el backend local una vez (npm start) para que mongoose cree los índices."
      );
    }
  } catch (error) {
    console.error("[clone] FAILED:", error);
    process.exitCode = 1;
  } finally {
    await srcConn.close();
    await tgtConn.close();
    console.log("[clone] Disconnected");
  }
}

// resolveSchool: por SCHOOL_ID directo, o por nombre (subcadena,
// case-insensitive). Aborta si el nombre no matchea exactamente 1.
async function resolveSchool(srcDb) {
  const schools = srcDb.collection("schools");
  if (process.env.SCHOOL_ID) {
    const doc = await schools.findOne({ _id: new mongoose.Types.ObjectId(process.env.SCHOOL_ID) });
    if (!doc) {
      throw new Error(`SCHOOL_ID no existe: ${process.env.SCHOOL_ID}`);
    }
    return { schoolId: doc._id, schoolDoc: doc };
  }
  const name = process.env.SCHOOL_NAME;
  if (!name) {
    throw new Error("Define SCHOOL_ID o SCHOOL_NAME.");
  }
  const regex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const matches = await schools.find({ name: regex }).toArray();
  if (matches.length === 0) {
    const all = await schools.find({}, { projection: { name: 1 } }).toArray();
    console.error(
      "[clone] Ninguna escuela matchea. Disponibles:",
      all.map((s) => `${s._id} — ${s.name}`).join("\n  ")
    );
    throw new Error(`Sin match para: ${name}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `El nombre matchea ${matches.length} escuelas, usa SCHOOL_ID: ` +
        matches.map((s) => `${s._id} — ${s.name}`).join(" | ")
    );
  }
  return { schoolId: matches[0]._id, schoolDoc: matches[0] };
}

// handleLocalConflict: si el TARGET ya tiene una escuela con el MISMO
// cct pero _id distinto (stub local o clon viejo), la borra por
// completo (escuela + todos sus docs tenant) para que conviva UNA sola
// escuela con ese CCT tras el clone.
async function handleLocalConflict(tgtDb, schoolDoc, collNames, isDryRun) {
  const conflicts = await tgtDb
    .collection("schools")
    .find({ cct: schoolDoc.cct, _id: { $ne: schoolDoc._id } })
    .toArray();
  if (conflicts.length === 0) return;

  for (const local of conflicts) {
    const label = `STUB LOCAL (${local.name}, _id=${local._id})`;
    if (isDryRun) {
      console.log(
        `[clone] ${label} → SE REEMPLAZARÁ (mismo cct ${schoolDoc.cct}).`
      );
      continue;
    }
    // Borrar TODOS los docs del tenant local en cada colección.
    for (const name of collNames) {
      if (name === "schools") continue;
      await tgtDb.collection(name).deleteMany({ school: local._id });
    }
    // Assetversions y el doc de la escuela stub.
    await tgtDb
      .collection("assetversions")
      .deleteMany({ entity_type: "school", entity_id: local._id });
    await tgtDb.collection("schools").deleteOne({ _id: local._id });
    console.log(`[clone] ${label} eliminado del target.`);
  }
}

// planCollection: decide QUÉ filtro aplicar a cada colección.
// Devuelve { filter, scrubTokens } o null si hay que saltarla.
async function planCollection(srcDb, name, schoolId, studentIds) {
  // Treatment especial: solo el doc de la escuela.
  if (name === "schools") {
    return { filter: { _id: schoolId }, scrubTokens: false };
  }
  // Sesiones: no copiar (el target solo se vacía).
  if (refreshtokens(name)) {
    return { filter: {}, scrubTokens: false, action: "drop-target" };
  }
  // assetversions: sin campo school → por entity_id.
  if (name === "assetversions") {
    return {
      filter: {
        $or: [
          { entity_type: "school", entity_id: schoolId },
          { entity_type: "student", entity_id: { $in: studentIds } },
        ],
      },
      scrubTokens: false,
    };
  }
  // Genérico: ¿la colección usa el campo `school`?
  const hasSchool = await srcDb
    .collection(name)
    .findOne({ school: { $exists: true } }, { projection: { _id: 0 } });
  if (!hasSchool) {
    // Sin ningún doc con `school`: si la colección está VACÍA es solo
    // una feature sin usar (se usa el filtro igual, copia 0 docs y ya);
    // solo SKIP si tiene docs reales sin el campo (revisión manual).
    const total = await srcDb.collection(name).countDocuments({});
    if (total > 0) return null;
    return { filter: { school: schoolId }, scrubTokens: false };
  }
  // Scrub de tokens solo donde viven (Guardian / User).
  const scrubTokens = name === "guardians" || name === "users";
  return { filter: { school: schoolId }, scrubTokens };
}

// refreshtokens: el nombre real de la colección según la pluralización
// de mongoose ("RefreshToken" → "refreshtokens"); se compara en
// minúsculas por si acaso.
const refreshtokens = (name) => name.toLowerCase() === "refreshtokens";

main();
