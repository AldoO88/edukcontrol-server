// =====================================================================
// Notification Model
// =====================================================================
// Modelo para persistir cada notificación push enviada por el backend.
//
// Antes de este modelo, las push se enviaban "fire-and-forget" — el
// backend las mandaba a Expo y se olvidaba. No había forma de que el
// mobile consultara un historial de notificaciones, ni de que la
// campanita in-app mostrara cuántas no leídas tiene el usuario.
//
// Este modelo persiste cada push en MongoDB. Sirve como:
//   1) Fuente de verdad para la campanita (badge + lista).
//   2) Auditoría (debugging: "por qué este tutor no recibió push X").
//   3) Posibles repushes (ej: dispositivo nuevo, reinstall) — el
//      mobile puede pedir "todas mis notificaciones no leídas" y
//      mostrarlas aunque el push original se haya perdido.
//
// MULTI-TENANT: cada notificación tiene `school` (ObjectId ref).
// Queries siempre filtran por school para evitar leaks cross-tenant.
// =====================================================================
const { Schema, model } = require("mongoose");

const notificationSchema = new Schema(
  {
    // School (tenant) — referencia para multi-tenant scoping.
    school: {
      type: Schema.Types.ObjectId,
      ref: "School",
      required: [true, "School reference is required."],
      index: true,
    },

    // ---------------------------------------------------------
    // Destinatario: usamos `user_id` siempre. Para tutores, este
    // es el User._id (NO el Guardian._id). El mobile consulta
    // por su propio user_id en /api/me/notifications.
    //
    // Decisión: usamos User._id en vez de Guardian._id porque:
    //   - El JWT del mobile ya tiene user._id.
    //   - Staff también recibe notificaciones y no tiene Guardian.
    //   - Es un solo punto de lookup, no dos rutas paralelas.
    // ---------------------------------------------------------
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "user_id is required."],
      index: true,
    },

    // Rol del destinatario al momento del envío. Útil para analytics
    // y para que el frontend pueda mostrar iconos distintos por rol.
    role: {
      type: String,
      enum: [
        "tutor",
        "teacher",
        "admin",
        "principal",
        "prefect",
        "social_worker",
        "registrar",
        "super_admin",
      ],
      required: true,
    },

    // ---------------------------------------------------------
    // Contenido (lo que se muestra al usuario).
    // ---------------------------------------------------------
    kind: {
      type: String,
      enum: [
        "attendance",                // RFID/face tap
        "absence",                   // ausencia (NO retardo — ver notification.service.js)
        "missing_exit",              // entró pero no salió (chequeo del cron)
        "citation",                  // citatorio nuevo
        "citation_rescheduled",      // reagendado
        "citation_cancelled",        // cancelado
        "citation_confirmed",        // tutor confirmó (→ staff)
        "citation_reschedule_request", // tutor pide reagendar (→ staff)
        "announcement",              // aviso general/grupo/alumno
        "conduct_report",            // reporte de conducta nuevo
        "conduct_cancelled",         // reporte de conducta cancelado
      ],
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    // ---------------------------------------------------------
    // Deep link data (mismo `data` que se manda a Expo Push).
    // Ej: { kind: 'citation', citation_id: '...', student_id: '...' }
    // ---------------------------------------------------------
    data: {
      type: Schema.Types.Mixed, // objeto libre
      default: {},
    },

    // ---------------------------------------------------------
    // Metadata del delivery.
    // ---------------------------------------------------------
    channel_id: {
      type: String,
      default: null,
    },

    // Status del push en Expo: 'ok' (entregado a Expo), 'error',
    // 'DeviceNotRegistered', etc. Para debugging.
    expo_status: {
      type: String,
      default: "pending",
    },

    // Expo ticket ID (si status fue 'ok'). Para correlación con
    // logs de Expo.
    expo_ticket_id: {
      type: String,
      default: null,
    },

    // ---------------------------------------------------------
    // Estado de lectura (para la campanita in-app).
    // ---------------------------------------------------------
    // null = no leída. Date = leída en esa fecha.
    read_at: {
      type: Date,
      default: null,
      index: true,
    },

    // Timestamp de cuándo se creó/envió la push. Usamos sent_at
    // en vez de createdAt para semántica más clara en queries.
    sent_at: {
      type: Date,
      default: () => new Date(),
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ============================================================
// Índices compuestos para queries comunes de la campanita
// ============================================================

// 1) Lista de notificaciones del usuario, ordenadas por fecha desc.
//    Usado por: GET /api/me/notifications
notificationSchema.index({ user_id: 1, sent_at: -1 });

// 2) Contador de no leídas.
//    Usado por: GET /api/me/notifications/unread-count
notificationSchema.index({ user_id: 1, read_at: 1, sent_at: -1 });

// 3) Por school + kind (analytics, debugging).
notificationSchema.index({ school: 1, kind: 1, sent_at: -1 });

// ============================================================
// TTL de retención (borrado automático por MongoDB)
// ============================================================
// Las notificaciones EXPIRAN a los 90 días (2026-10-17): cada doc
// guarda datos de menores (nombre + evento de asistencia/citatorio)
// y no debe retenerse PII indefinidamente (minimización de datos).
// 90 días cubren el propósito de auditoría/debug del modelo ("¿por
// qué no llegó la push a X?") — nadie investiga incidentes de hace
// más. MongoDB borra los docs solo (~cada 60s), sin cron propio.
//
// La ventana de UX de la campanita (badge/lista = últimos 30 días)
// vive en services/notifications.service.js (VENTANA_DIAS): la
// ventana es solo VISUAL, este TTL es el borrado FÍSICO.
//
// OJO: el TTL va sobre `createdAt` y NO sobre `sent_at` aunque las
// queries usen sent_at — ya existe un índice llano {sent_at:1}
// (index: true en el campo) y MongoDB no permite dos índices con el
// mismo key pattern (migrarlo exigiría dropearlo a mano en Atlas).
// createdAt ≡ sent_at en la práctica: ambos se setean al ingresar.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: "notifications_ttl_90d" }
);

const Notification = model("Notification", notificationSchema);

module.exports = Notification;
