// scripts/seed-local-test-users.js
// ---------------------------------------------------------------------
// Seed mínimo para la BD LOCAL vacía: crea una escuela de prueba, su
// ciclo 2025-2026 activo, y 5 usuarios (maestro, prefecto, directivo,
// trabajador social y tutor) para poder probar login/roles sin tocar
// producción.
//
// Idempotente: si la escuela/ciclo/usuarios ya existen se reutilizan
// (solo se completan campos vacíos), nunca se duplican.
//
// USO:
//   node scripts/seed-local-test-users.js
//
// Usa MONGO_URI del .env (por defecto mongodb://127.0.0.1:27017/eduk_control).
// ---------------------------------------------------------------------

require("dotenv").config();
const mongoose = require("mongoose");

const School = require("../models/School.model");
const SchoolYear = require("../models/SchoolYear.model");
const User = require("../models/User.model");
const Guardian = require("../models/Guardian.model");

const SCHOOL_DATA = {
  name: "Escuela Secundaria Técnica No. 47",
  cct: "13DST0049E",
  isActive: true,
};

const SCHOOL_YEAR_DATA = {
  name: "2025-2026",
  startDate: new Date("2025-08-18"),
  endDate: new Date("2026-07-10"),
  isActive: true,
};

// Staff (email es el lookup por `{school, email}`).
// Phones únicos: 7711234001 (docente, igual que credentials.md),
// 7711234019 (prefecto, credentials.md), 7711234020/4021 (nuevos).
const STAFF_USERS = [
  {
    name: "Juan Francisco",
    last_name: "Aguilar Luna",
    email: "juan.aguilar@sec47.edu.mx",
    phoneNumber: "7711234001",
    password: "Sec47_2025!",
    role: "teacher",
    contractedHours: 6,
    sex: "male",
  },
  {
    name: "Marin",
    last_name: "Castillo Chavarria",
    email: "marin.castillo@sec47.edu.mx",
    phoneNumber: "7711234019",
    password: "Sec47_2025!",
    role: "prefect",
    sex: "female",
  },
  {
    name: "Francisco Javier",
    last_name: "Ramírez Solís",
    email: "francisco.ramirez@sec47.edu.mx",
    phoneNumber: "7711234020",
    password: "Sec47_2025!",
    role: "principal",
    sex: "male",
  },
  {
    name: "Laura Gabriela",
    last_name: "Torres Aguilar",
    email: "laura.torres@sec47.edu.mx",
    phoneNumber: "7711234021",
    password: "Sec47_2025!",
    role: "social_worker",
    sex: "female",
  },
];

// Tutor de credentials.md. Se crea con password directa (sin OTP) para
// poder entrar al login de inmediato. El Guardian asociado queda sin
// hijos (BD local vacía).
const TUTOR_USER = {
  name: "Roberto",
  last_name: "García López",
  email: "roberto.garcia@test.com",
  phoneNumber: "7711111111",
  password: "Test1234!",
  role: "tutor",
  sex: "male",
};

const TUTOR_GUARDIAN = {
  name: "Roberto",
  lastname: "García López",
  relationship: "Padre",
  phone: "7711111111",
  sex: "male",
};

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("[!] MONGO_URI no está definido en .env");
    process.exit(1);
  }

  console.log("Conectando a MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Conectado.\n");

  // 1) ESCUELA
  console.log("🏫 Escuela...");
  let school = await School.findOne({ cct: SCHOOL_DATA.cct });
  if (!school) {
    school = await School.create(SCHOOL_DATA);
    console.log(`   ✅ Creada: ${school.name} (${school.cct})`);
  } else {
    console.log(`   ⏭️  Ya existe: ${school.name} (${school.cct})`);
  }

  // 2) CICLO ESCOLAR + activación
  console.log("\n📅 Ciclo escolar...");
  let year = await SchoolYear.findOne({ school: school._id, name: SCHOOL_YEAR_DATA.name });
  if (!year) {
    year = await SchoolYear.create({ school: school._id, ...SCHOOL_YEAR_DATA });
    console.log(`   ✅ Creado: ${year.name}`);
  } else {
    console.log(`   ⏭️  Ya existe: ${year.name}`);
  }

  // Activación (mismo efecto que POST /api/school-years/:id/activate)
  if (!year.isActive) {
    await SchoolYear.updateMany(
      { school: school._id, _id: { $ne: year._id } },
      { $set: { isActive: false } }
    );
    year.isActive = true;
    await year.save();
    console.log(`   ✅ Activado: ${year.name}`);
  }
  if (String(school.current_school_year_id || "") !== String(year._id)) {
    school.current_school_year_id = year._id;
    await school.save();
    console.log("   ✅ School.current_school_year_id sincronizado");
  }

  // 3) STAFF (maestro, prefecto, directivo, trabajador social)
  console.log("\n👥 Staff...");
  for (const data of STAFF_USERS) {
    const existing = await User.findOne({ school: school._id, email: data.email });
    if (existing) {
      // Solo completamos campos vacíos; nunca pisamos passwords hasheados.
      let dirty = false;
      if (!existing.password) {
        existing.password = data.password;
        existing.markModified("password");
        dirty = true;
      }
      if (existing.role !== data.role) {
        existing.role = data.role;
        dirty = true;
      }
      if (existing.isActive !== true) {
        existing.isActive = true;
        dirty = true;
      }
      if (dirty) await existing.save();
      console.log(`   ⏭️  Ya existe: ${data.name} ${data.last_name} (${data.role})`);
      continue;
    }

    await User.create({
      school: school._id,
      name: data.name,
      last_name: data.last_name,
      email: data.email,
      phoneNumber: data.phoneNumber,
      password: data.password,
      role: data.role,
      isActive: true,
      sex: data.sex || null,
      ...(data.contractedHours !== undefined
        ? { contractedHours: data.contractedHours, appointmentType: "BASE" }
        : {}),
    });
    console.log(`   ✅ Creado: ${data.name} ${data.last_name} (${data.role})`);
  }

  // 4) TUTOR (User + Guardian sin hijos)
  console.log("\n👨‍👩‍👦 Tutor...");
  let tutorUser = await User.findOne({ school: school._id, phoneNumber: TUTOR_USER.phoneNumber });
  if (!tutorUser) {
    tutorUser = await User.create({
      school: school._id,
      name: TUTOR_USER.name,
      last_name: TUTOR_USER.last_name,
      email: TUTOR_USER.email,
      phoneNumber: TUTOR_USER.phoneNumber,
      password: TUTOR_USER.password,
      role: "tutor",
      isActive: true,
      sex: TUTOR_USER.sex,
      notification_prefs: {
        whatsapp: {
          opted_in: true,
          opted_in_at: new Date(),
          source: "admin_form",
        },
      },
    });
    console.log(`   ✅ User tutor creado: ${TUTOR_USER.name} ${TUTOR_USER.last_name}`);
  } else {
    if (!tutorUser.password) {
      tutorUser.password = TUTOR_USER.password;
      tutorUser.markModified("password");
      await tutorUser.save();
    }
    console.log(`   ⏭️  User tutor ya existe: ${TUTOR_USER.name} ${TUTOR_USER.last_name}`);
  }

  let guardian = await Guardian.findOne({ school: school._id, phone: TUTOR_GUARDIAN.phone });
  if (!guardian) {
    guardian = await Guardian.create({
      school: school._id,
      user_id: tutorUser._id,
      name: TUTOR_GUARDIAN.name,
      lastname: TUTOR_GUARDIAN.lastname,
      relationship: TUTOR_GUARDIAN.relationship,
      phone: TUTOR_GUARDIAN.phone,
      sex: TUTOR_GUARDIAN.sex,
      students: [],
      isActive: true,
      notification_prefs: {
        whatsapp: {
          opted_in: true,
          opted_in_at: new Date(),
          source: "admin_form",
        },
      },
    });
    console.log(`   ✅ Guardian creado (sin hijos)`);
  } else {
    if (String(guardian.user_id || "") !== String(tutorUser._id)) {
      guardian.user_id = tutorUser._id;
      await guardian.save();
    }
    console.log(`   ⏭️  Guardian ya existe`);
  }

  // 5) RESUMEN
  console.log("\n=== RESUMEN ===");
  console.log(`Escuela: ${school.name} (cct ${school.cct}) _id=${school._id}`);
  console.log(`Ciclo:   ${year.name} (activo=${year.isActive}) _id=${year._id}`);
  const users = await User.find({ school: school._id }).sort({ role: 1 });
  for (const u of users) {
    console.log(
      `  - ${u.role.padEnd(14)} ${u.phoneNumber} ${u.email || ""} ${u.name} ${u.last_name || ""}`
    );
  }
  console.log("\nLogins (teléfono + password):");
  console.log("  staff:  7711234001 (maestro) / 7711234019 (prefecto) / 7711234020 (directivo) / 7711234021 (trabajo social)");
  console.log("  staff password: Sec47_2025!");
  console.log("  tutor:  7711111111  password: Test1234!");

  await mongoose.disconnect();
  console.log("\nDesconectado.");
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
