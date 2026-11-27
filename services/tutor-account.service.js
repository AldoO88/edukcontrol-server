// Garantiza que cada Guardian con teléfono válido tenga un User tutor
// vinculado (`User.role === "tutor"`), para que el papá pueda activar
// su cuenta desde el login móvil via `/auth/request-activation`.
//
// Contexto de negocio:
//   - El alta de un alumno (manual o importando Excel) crea un
//     `Guardian` con `user_id: null`. Antes de este helper, ese tutor
//     recibía 404 al intentar activar su cuenta.
//   - El teléfono es el identificador universal de login; el índice
//     único `{school, phoneNumber}` impide dos Users en la misma
//     escuela con el mismo celular.
//
// Esta función es idempotente y se llama desde:
//   - `POST /api/guardians` (alta manual de alumno)
//   - `POST /api/students/import` (importación Excel)
//   - eventualmente también al editar un tutor.
const User = require("../models/User.model");

// Por qué el opt-in viene forzado a `true` aquí:
//   - El flujo `/auth/request-activation` exige `opted_in === true`
//     (devuelve 451 si no). Si no activamos al crear, el papá nunca
//     podrá sacar su contraseña desde la app.
//   - El usuario eligió explícitamente NO capturar consentimiento
//     en el form de alumno ni en el Excel (decisión de UX, registrada
//     en la conversación del feature). El webhook de STOP de Twilio
//     sigue siendo la vía de baja forzada.
const TUTOR_DEFAULT_OPTED_IN = true;
const TUTOR_DEFAULT_SOURCE = "admin_form";

const ensureTutorUser = async ({ school, name, lastname, phone, email }) => {
  if (!phone || !school || !name) {
    return {
      ok: false,
      reason: "missing_args",
      message: "school, name y phone son requeridos",
    };
  }

  // Normaliza el correo (opcional): minúsculas para que el lookup de
  // Sign in with Apple (`User.find({ email })`, case-sensitive) matchee,
  // y "" → null para no chocar con el índice único parcial.
  const emailNorm =
    email && String(email).trim() ? String(email).trim().toLowerCase() : null;

  // Buscamos por escuela + teléfono. El índice único garantiza que
  // existe a lo sumo un User con esa combinación.
  let user = await User.findOne({ school, phoneNumber: phone });

  if (user) {
    // Caso 1: el User ya existe y ya es tutor → reutilizamos.
    if (user.role === "tutor") {
      // Si la última captura del nombre dejó los apellidos vacíos y
      // ahora los tenemos, sincronizamos para que el dashboard del
      // tutor pueda saludar "Hola, <name> <last_name>". Igual con el
      // correo: solo completamos si estaba VACÍO (misma regla "no
      // pisar datos" que Guardian al reusar por teléfono); un cambio
      // EXPLÍCITO va por PUT /api/guardians/:id.
      const needsNameSync =
        (!user.last_name || !user.last_name.trim()) &&
        lastname &&
        lastname.trim();
      const needsEmailSync = !user.email && emailNorm;
      if (needsNameSync || needsEmailSync) {
        if (needsNameSync) user.last_name = lastname.trim();
        if (needsEmailSync) user.email = emailNorm;
        try {
          await user.save();
        } catch (saveErr) {
          // 11000 = el correo ya pertenece a otra cuenta de la
          // escuela (uniq_school_email). El Guardian queda creado;
          // avisamos al caller.
          if (saveErr && saveErr.code === 11000) {
            return {
              ok: false,
              reason: "email_taken",
              message: "El correo ya está registrado en la escuela",
            };
          }
          throw saveErr;
        }
      }
      return { ok: true, user, reused: true };
    }
    // Caso 2: el celular ya está registrado con otro perfil
    // (teacher/admin/registrar/prefect/etc). Como el modelo tiene
    // índice único `{school, phoneNumber}`, no podemos crear un
    // segundo User. Devolvemos "phone_taken" para que el caller
    // avise al administrador; el Guardian igual se crea.
    return {
      ok: false,
      reason: "phone_taken",
      message: "Teléfono ya registrado",
    };
  }

  // Caso 3: no hay User → crear uno nuevo con el rol "tutor". El
  // pre-save hook de mongoose hashea el password si pasara; aquí va
  // null porque todavía no se activa.
  //
  // `last_name` es requerido en User para roles distintos a
  // super_admin (User.model.js:32-39). Si no nos pasaron apellido
  // (formato "Juan" sin apellido, Excel de una sola palabra) usamos
  // el mismo `name` para que el required no rechace la inserción.
  const lastNameForUser =
    lastname && lastname.trim() ? lastname.trim() : name.trim();

  try {
    user = await User.create({
      name: name.trim(),
      last_name: lastNameForUser,
      role: "tutor",
      school,
      phoneNumber: phone,
      // Correo opcional del Apple ID (Sign in with Apple matchea por
      // aquí). Ausente en el import Excel y en altas sin el dato.
      email: emailNorm,
      // isActive nace TRUE (default del modelo): el tutor está "activo"
      // y pendiente de fijar password vía OTP (sin password = sin activar).
      notification_prefs: {
        whatsapp: {
          opted_in: TUTOR_DEFAULT_OPTED_IN,
          opted_in_at: new Date(),
          source: TUTOR_DEFAULT_SOURCE,
        },
      },
    });
  } catch (createErr) {
    if (createErr && createErr.code === 11000) {
      // Puede ser {school, phoneNumber} (carrera con otra alta) o
      // {school, email} (correo ya registrado en la escuela).
      const dupField = Object.keys(createErr.keyPattern || {})[0] || "";
      return {
        ok: false,
        reason: dupField === "email" ? "email_taken" : "phone_taken",
        message:
          dupField === "email"
            ? "El correo ya está registrado en la escuela"
            : "Teléfono ya registrado",
      };
    }
    throw createErr;
  }

  return { ok: true, user, reused: false };
};

module.exports = {
  ensureTutorUser,
};
