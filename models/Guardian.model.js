// Modelo de Guardian (Tutor)
// Entidad de primera clase: un tutor/guardián con identidad propia.
// Se vincula opcionalmente a un User (cuando activa su cuenta) y a uno o
// varios Students (los hijos/estudiantes a su cargo).
//
// Regla multi-tenant: cada guardian pertenece a UNA escuela.
const { Schema, model } = require("mongoose");

const guardianSchema = new Schema(
  {
    // Referencia a la escuela (tenant)
    school: {
      type: Schema.Types.ObjectId,
      ref: "School",
      required: [true, "School reference is required."],
      index: true,
    },
    // Referencia opcional al User (cuando el tutor activa su cuenta).
    // Mientras no active, este campo es null.
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    // Nombres del tutor (sin apellidos). Mapea 1:1 con `User.name`
    // para que la creación del User con el helper `ensureTutorUser`
    // pueda pasar ambos sin ambigüedad.
    name: {
      type: String,
      required: [true, "Guardian name is required."],
      trim: true,
    },
    // Apellidos del tutor. Mapea 1:1 con `User.last_name`. Por
    // compatibilidad histórica queda `default: ""` (los Guardians
    // preexistentes guardaban el nombre completo en `name`).
    lastname: {
      type: String,
      trim: true,
      default: "",
    },
    sex: {
      type: String,
      enum: {
        values: ["male", "female"],
        message: 'sex must be one of: "male", "female".',
      },
      default: null,
    },
    // Relación o parentesco: "madre", "padre", "tutor legal", etc.
    relationship: {
      type: String,
      required: [true, "Relationship is required."],
      trim: true,
    },
    // Número de celular a 10 dígitos (formato MX)
    phone: {
      type: String,
      required: [true, "Guardian phone is required."],
      trim: true,
      match: [/^\d{10}$/, "Phone must be 10 digits."],
    },
    // Correo opcional del tutor. Existe para poder dar de alta el
    // correo del Apple ID y que "Sign in with Apple" matchee la cuenta
    // (POST /auth/apple busca por `User.email`; este campo es el espejo
    // en la ficha del Guardian, igual que name/lastname → User.name/
    // last_name). La unicidad por escuela la impone el índice de
    // User.email (uniq_school_email), no un índice propio: la
    // identidad del tutor sigue siendo el teléfono. Se guarda en
    // minúsculas para que el lookup case-insensitive de Apple matchee.
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: null,
      // "" (form editado y campo vaciado) → null: sin el setter, el
      // `match` de abajo rechazaría el string vacío en un PUT.
      set: (v) => (v && String(v).trim() ? String(v).trim().toLowerCase() : null),
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please provide a valid email address.",
      ],
    },
    // Token FCM (Firebase Cloud Messaging) del dispositivo del tutor
    fcm_token: {
      type: String,
      default: null,
      trim: true,
    },
    // Identificador legible del dispositivo (último que registró el token).
    // Útil para debug y para invalidar tokens antiguos en logout.
    last_device_id: {
      type: String,
      default: null,
      trim: true,
    },
    // Estudiantes a cargo (N:M con Student vía este array)
    students: {
      type: [Schema.Types.ObjectId],
      ref: "Student",
      default: [],
    },
    // Estado del registro de tutor. `true` = activo (vigente, recibe
    // notificaciones, aparece en listas de operación). `false` = dado
    // de baja: el registro SE CONSERVA como historial (auditoría,
    // contactos previos) pero NO debe volver a aparecer como tutor
    // activo en ningún flujo.
    //
    // Al pasar a `false` el backend desvinculará automáticamente a
    // todos los estudiantes (el push y los populate dejaron de
    // necesitarlos) y, si el `user_id` del tutor no queda asociado a
    // ningún otro guardian activo, también bajará `User.isActive` a
    // `false` para que el tutor no pueda entrar al dashboard.
    //
    // Precedente: `User.isActive` (commit `feat(auth): isActive
    // semántica`). Para los 422 guardians existentes sin el campo, un
    // backfill (`scripts/backfill-guardian-active.js`) los marca como
    // activos y las queries que importan usan `{$ne: false}` por
    // seguridad. Solo se escribe explícitamente desde el controller.
    isActive: {
      type: Boolean,
      default: true,
    },
    // Preferencias de notificación por canal. Misma estructura que en
    // User. Para tutores el opt-in se captura normalmente al crearse
    // el Guardian vía admin (la escuela informa al padre al darle
    // de alta que va a recibir códigos por WhatsApp).
    notification_prefs: {
      whatsapp: {
        opted_in: { type: Boolean, default: false },
        opted_in_at: { type: Date, default: null },
        source: {
          type: String,
          enum: ["admin_form", "self_profile", "imported_seed", "signup", "unknown"],
          default: null,
        },
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// phone único dentro de la escuela
guardianSchema.index(
  { school: 1, phone: 1 },
  { unique: true, name: "uniq_school_phone" }
);
// Búsquedas por user_id (los tutores activados)
guardianSchema.index({ user_id: 1 });
// Búsquedas por estudiante (listar tutores de un alumno)
guardianSchema.index({ students: 1 });

const Guardian = model("Guardian", guardianSchema);

module.exports = Guardian;
