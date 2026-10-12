// Modelo de Grupo/Grado
// Representa una sección/clase de un grado específico en un ciclo escolar.
// Cada grupo pertenece a UNA escuela (tenant).
const { Schema, model } = require("mongoose");

const groupSchema = new Schema(
  {
    // Referencia a la escuela (tenant) — obligatoria para aislamiento multi-tenant
    school: {
      type: Schema.Types.ObjectId,
      ref: "School",
      required: [true, "School reference is required."],
      index: true,
    },
    grade: {
      type: Number,
      required: [true, "Grade is required."],
      enum: {
        values: [1, 2, 3],
        message: "Grade must be 1, 2 or 3.",
      },
    },
    section: {
      type: String,
      required: [true, "Section is required."],
      trim: true,
      uppercase: true,
    },
    // Tipo de grupo: "regular" (grupo de origen, secciones A-D) o "taller"
    // (grupo transversal de Tecnología que mezcla alumnos de varios grupos
    // de origen del mismo grado). Los talleres se eligen una sola vez al
    // entrar a primer grado y se conservan en los ciclos siguientes.
    type: {
      type: String,
      enum: {
        values: ["regular", "taller"],
        message: "type must be: regular or taller",
      },
      default: "regular",
    },
    school_year_id: {
      type: Schema.Types.ObjectId,
      ref: "SchoolYear",
      required: [true, "School year reference is required."],
      index: true,
    },
    // Turno en el que se imparte el grupo: matutino, vespertino o nocturno.
    // Usado por el dashboard del tutor para mostrar "2°B - Turno Matutino".
    shift: {
      type: String,
      required: [true, "Shift is required."],
      enum: {
        values: ["matutino", "vespertino"],
        message: "shift must be: matutino or vespertino ",
      },
      default: "matutino",
    },
    // Referencia al docente titular del grupo (opcional; null si no hay asignado)
    head_teacher_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Grupo vigente. Lo usan los dos pases del cron de asistencia
    // (markAbsencesForSchool / runExitCheckForSchool) para filtrar grupos
    // activos — sin este campo el filtro `{ isActive: true }` no matcheaba
    // NINGÚN grupo y el cron nunca marcaba ausencias. Backfill para los
    // docs preexistentes: scripts/backfill-group-isactive.js.
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Único DENTRO de la escuela: mismo grado+sección+ciclo puede existir en otra escuela
groupSchema.index(
  { school: 1, grade: 1, section: 1, school_year_id: 1 },
  { unique: true, name: "uniq_school_grade_section_year" }
);
groupSchema.index({ head_teacher_id: 1 });

const Group = model("Group", groupSchema);

module.exports = Group;
