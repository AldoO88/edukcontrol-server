// User Model
// Defines the schema for system users:
//   - Staff (super_admin, admin, principal, registrar, teacher, prefect, social_worker):
//     login with email + password. Their school is set upon creation.
//   - Tutor (parent/guardian): pre-registers with phoneNumber and is activated
//     via SMS (OTP). Once activated, logs in with phoneNumber + password.
// Multi-tenant rule: each user belongs to ONE school, except super_admin.
const { Schema, model } = require("mongoose"); // Mongoose constructors
const bcrypt = require("bcryptjs"); // Password and OTP hashing

const userSchema = new Schema(
  {
    // School (tenant) reference — required except for super_admin
    school: {
      type: Schema.Types.ObjectId,
      ref: "School",
      required: function () {
        return this.role !== "super_admin";
      },
      index: true,
      default: null,
    },
    // Display name of the user (first name or given name)
    name: {
      type: String,
      required: [true, "Name is required."],
      trim: true,
    },
    // User's last name. Required except for super_admin (initial system
    // bootstrap). Used by the tutor dashboard to build the greeting
    // "Hello, <name> <last_name>".
    last_name: {
      type: String,
      required: function () {
        return this.role !== "super_admin";
      },
      default: null,
      trim: true,
    },
    sex: {
      type: String,
      enum: {
        values: ["male", "female"],
        message: 'sex must be one of: "male", "female".',
      },
      default: null,
    },
    // User's email (optional). Login is by phoneNumber, but email
    // can be used for notifications, recovery, or other future flows.
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        "Please provide a valid email address.",
      ],
    },
    // Sign in with Apple (Guideline 4.8 App Store): `sub` estable de
    // Apple = identificador único de este usuario+app. Se guarda en el
    // PRIMER login con Apple cuando el correo del Apple ID coincide
    // con una cuenta ya provisionada por la escuela; los logins
    // siguientes buscan primero por este campo (más confiable que el
    // correo, que Apple solo lo entrega la primera vez). Sparse
    // (partialFilterExpression en los índices): solo existe en cuentas
    // que ligaron su Apple ID. select:false: no viaja en los queries
    // normales (es un identificador de autenticación; el match de
    // `User.findOne({ apple_sub })` sigue funcionando, select sólo
    // afecta la proyección del documento devuelto).
    apple_sub: {
      type: String,
      trim: true,
      select: false,
    },
    // 10-digit cell phone number (MX format, no country code).
    // Universal login identifier and OTP contact method.
    // Required for ALL roles.
    phoneNumber: {
      type: String,
      required: [true, "Phone number is required."],
      match: [/^\d{10}$/, "Phone number must be 10 digits."],
      trim: true,
    },
    // Password hashed with bcrypt. For tutor it's null until account is activated.
    password: {
      type: String,
      required: false,
      minlength: [8, "Password must be at least 8 characters long."],
      select: false,
    },
    // Authorization role
    role: {
      type: String,
      required: [true, "Role is required."],
      enum: {
        values: [
          "super_admin",    // Cross-tenant
          "admin",          // School administrator
          "principal",      // School principal
          "registrar",      // School registrar
          "teacher",        // Teacher
          "prefect",        // Prefect
          "social_worker",  // Social worker
          "tutor",          // Parent/guardian (separate account, phone login)
        ],
        message:
          "Role must be one of: super_admin, admin, principal, registrar, teacher, prefect, social_worker, tutor.",
      },
    },
    // Estado de la cuenta. Default TRUE ("activo") para todos los roles:
    // el alta nace activa y lo único que falta es el primer login (vía
    // OTP si el usuario fue creado sin password). isActive=false es una
    // BAJA explícita puesta por el admin: bloquea login (403), refresh,
    // forgot-password y la activación OTP. El "pendiente de activar" ya
    // NO se define por isActive sino por la ausencia de password.
    isActive: {
      type: Boolean,
      default: true,
    },
    // Temporary OTP (hashed with bcrypt). Only present during activation flow.
    // Never returned in default queries.
    otpCode: {
      type: String,
      select: false,
      default: null,
    },
    // OTP expiration date. Typically now + 10 min.
    otpExpiresAt: {
      type: Date,
      select: false,
      default: null,
    },
    // Weekly contracted hours of the teacher (HSM - Horas Semana Mes).
    // Represents the hours assigned in the teacher's contract.
    // Applicable only for "teacher" role users.
    contractedHours: {
      type: Number,
      default: 0,
      min: [0, "Contracted hours cannot be negative."],
      max: [50, "Contracted hours cannot exceed 50."],
    },
    // Teacher appointment type.
    // "BASE" = Permanent position (plaza base)
    // "INTERINATO" = Temporary substitution (interim)
    // "HONORARIOS" = Contract-based (honorarios)
    // "OTHER" = Other appointment type
    appointmentType: {
      type: String,
      enum: {
        values: ["BASE", "INTERINATO", "HONORARIOS", "OTHER"],
        message: "appointmentType must be BASE, INTERINATO, HONORARIOS, or OTHER.",
      },
      default: "BASE",
    },
    // Teacher's academic preparation — structured records.
    // Each entry holds the degree type, career name, institution, and status.
    academicPreparation: [
      {
        type: {
          type: String,
          enum: ["Licenciatura", "Especialidad", "Maestría", "Doctorado", "Posdoctorado"],
          required: [true, "Degree type is required."],
        },
        careerName: {
          type: String,
          required: [true, "Career name is required."],
          trim: true,
        },
        institution: {
          type: String,
          required: [true, "Institution is required."],
          trim: true,
        },
        status: {
          type: String,
          enum: ["pasante", "titulado"],
          required: [true, "Status is required."],
        },
      },
    ],
    // Firebase Cloud Messaging token for push notifications.
    // Used by staff mobile app to receive notifications (e.g., when a
    // guardian confirms or requests reschedule of a citation).
    fcm_token: {
      type: String,
      default: null,
    },
    // Preferencias de notificación por canal. Cada subdoc lleva su propio
    // opt-in timestamp + source para auditoría (Meta exige evidencia de
    // consentimiento antes de mandar WhatsApp Business-initiated).
    notification_prefs: {
      // Estado del opt-in para mensajes WhatsApp Business (OTP,
      // recuperación de contraseña, futuros avisos opcionales).
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

// Unique email per school (staff). Tutors (email null) and super_admins (school null) are excluded.
userSchema.index(
  { school: 1, email: 1 },
  {
    unique: true,
    name: "uniq_school_email",
    partialFilterExpression: {
      school: { $type: "objectId" },
      email: { $exists: true, $type: "string" },
    },
  }
);
// Unique email for super_admins (school null)
userSchema.index(
  { email: 1 },
  {
    unique: true,
    name: "uniq_super_admin_email",
    partialFilterExpression: { school: null },
  }
);
// Unique phoneNumber per school (only tutors have phoneNumber)
userSchema.index(
  { school: 1, phoneNumber: 1 },
  {
    unique: true,
    name: "uniq_school_phone",
    partialFilterExpression: { phoneNumber: { $type: "string" } },
  }
);
// Unique apple_sub (Sign in with Apple): una cuenta Apple NO puede
// ligarse a 2 usuarios distintos. Mismo estilo partialFilterExpression
// que los índices de arriba: solo aplica a docs que traen el campo
// (las cuentas sin ligar no compiten por la unicidad).
userSchema.index(
  { apple_sub: 1 },
  {
    unique: true,
    name: "uniq_apple_sub",
    partialFilterExpression: { apple_sub: { $type: "string" } },
  }
);
userSchema.index({ role: 1, isActive: 1 });

// Pre-save hook: hashes password or OTP if modified.
// If password is null/empty (tutor not activated), skips hashing.
userSchema.pre("save", async function hashSecrets(next) {
  try {
    if (this.isModified("password") && this.password) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }
    if (this.isModified("otpCode") && this.otpCode) {
      const salt = await bcrypt.genSalt(10);
      this.otpCode = await bcrypt.hash(this.otpCode, salt);
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

// Compares a plain text password against the hash.
// Returns false if the user has no password (tutor not activated).
userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

// Compares a plain text OTP against the stored hash.
userSchema.methods.compareOtp = function compareOtp(candidate) {
  if (!this.otpCode) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.otpCode);
};

const User = model("User", userSchema);

module.exports = User;
