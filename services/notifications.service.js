// =====================================================================
// notifications.service.js
// =====================================================================
// Capa de servicio para la campanita in-app.
//
// Responsabilidades:
//   1) Persistir cada push enviada en la colección Notification.
//   2) Listar notificaciones de un usuario (filtradas por tenant).
//   3) Marcar como leída (una o todas).
//   4) Contar no leídas (para el badge de la campanita).
//
// Esta capa es DELIBERADAMENTE separada de services/notification.service.js
// (que maneja el envío de push vía Expo). La razón:
//   - notification.service.js es sobre OUTPUT (mandar push al celular).
//   - notifications.service.js es sobre STATE (historial in-app).
// Separarlas evita que un cambio en cómo mandamos push rompa la
// campanita, o viceversa.
// =====================================================================
const Notification = require("../models/Notification.model");

// ---------------------------------------------------------------------
// Ventana de la campanita (mejor práctica UX, 2026-10-17)
// ---------------------------------------------------------------------
// Badge (unread-count) y lista solo consideran notificaciones de los
// últimos VENTANA_DIAS días. Por qué: un badge que acumula no leídas
// de SIEMPRE se vuelve ruido y el usuario deja de mirarlo (el "efecto
// lloriqueo del lobo"); lo más viejo no leído expira visualmente
// solo. Nada se borra con esto — el borrado FÍSICO es el TTL de 90
// días sobre createdAt que define Notification.model.js (auditoría
// + minimización de PII de menores).
const VENTANA_DIAS = 30;

// Filtro de ventana reutilizable (lista + unread-count).
const ventanaReciente = () => ({
  sent_at: { $gte: new Date(Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000) },
});

// ---------------------------------------------------------------------
// persistNotification(payload)
// ---------------------------------------------------------------------
// Guarda una notificación en MongoDB. Se llama DESPUÉS de que
// sendToTokens() haya intentado el envío (para no persistir pushes
// que Expo rechazó antes de mandarlos).
//
// `payload` es el objeto normalizado que le pasamos al service de
// push:
//   {
//     recipient_user_id, recipient_role, school,
//     kind, title, body, data, channel_id,
//     expo_status, expo_ticket_id
//   }
//
// Devuelve el documento creado (incluyendo su _id).
// ---------------------------------------------------------------------
const persistNotification = async ({
  recipient_user_id,
  recipient_role,
  school,
  kind,
  title,
  body,
  data = {},
  channel_id = null,
  expo_status = "pending",
  expo_ticket_id = null,
}) => {
  // Validamos los campos mínimos. Si falta algo, throw para que el
  // caller sepa que NO se persistió (importante para la consistencia
  // entre "se mandó push" y "se persistió in-app").
  if (!recipient_user_id) {
    throw new Error("persistNotification requiere recipient_user_id");
  }
  if (!school) {
    throw new Error("persistNotification requiere school");
  }
  if (!kind) {
    throw new Error("persistNotification requiere kind");
  }
  if (!title || !body) {
    throw new Error("persistNotification requiere title y body");
  }

  return Notification.create({
    user_id: recipient_user_id,
    role: recipient_role,
    school,
    kind,
    title,
    body,
    data,
    channel_id,
    expo_status,
    expo_ticket_id,
    sent_at: new Date(),
  });
};

// ---------------------------------------------------------------------
// getMyNotifications(userId, schoolId, options)
// ---------------------------------------------------------------------
// Lista las notificaciones del usuario autenticado.
// Opciones: { unreadOnly: boolean, limit: number }
// Devuelve array de notificaciones ordenadas por sent_at desc.
// ---------------------------------------------------------------------
const getMyNotifications = async (userId, schoolId, { unreadOnly = false, limit = 50 } = {}) => {
  const filter = {
    user_id: userId,
    school: schoolId,
    // Ventana de 30 días (ver VENTANA_DIAS): lo más viejo no se
    // lista aunque siga existiendo en BD hasta el TTL de 90 días.
    ...ventanaReciente(),
  };
  if (unreadOnly) {
    filter.read_at = null;
  }
  return Notification.find(filter)
    .sort({ sent_at: -1 })
    .limit(Math.min(limit, 100))
    .lean();
};

// ---------------------------------------------------------------------
// getUnreadCount(userId, schoolId)
// ---------------------------------------------------------------------
// Cuenta notificaciones no leídas. Más eficiente que getMyNotifications
// porque solo cuenta, no trae los documentos completos.
// ---------------------------------------------------------------------
const getUnreadCount = async (userId, schoolId) => {
  return Notification.countDocuments({
    user_id: userId,
    school: schoolId,
    read_at: null,
    // Misma ventana de 30 días que la lista (VENTANA_DIAS): el badge
    // no cuenta no leídas más viejas que la ventana — sin esto el
    // badge se quedaba pegado con acumulación de meses.
    ...ventanaReciente(),
  });
};

// ---------------------------------------------------------------------
// markAsRead(notificationId, userId, schoolId)
// ---------------------------------------------------------------------
// Marca UNA notificación como leída.
// Verifica que la notificación pertenezca al userId + school (tenant
// scoping) para evitar que un usuario marque como leída la notificación
// de otro.
// Devuelve el documento actualizado o null si no existe.
// ---------------------------------------------------------------------
const markAsRead = async (notificationId, userId, schoolId) => {
  return Notification.findOneAndUpdate(
    {
      _id: notificationId,
      user_id: userId,
      school: schoolId,
    },
    { $set: { read_at: new Date() } },
    { new: true },
  );
};

// ---------------------------------------------------------------------
// markAllAsRead(userId, schoolId)
// ---------------------------------------------------------------------
// Marca TODAS las notificaciones no leídas del usuario como leídas.
// Devuelve el número de documentos modificados.
// ---------------------------------------------------------------------
const markAllAsRead = async (userId, schoolId) => {
  const result = await Notification.updateMany(
    {
      user_id: userId,
      school: schoolId,
      read_at: null,
    },
    { $set: { read_at: new Date() } },
  );
  return result.modifiedCount || 0;
};

module.exports = {
  persistNotification,
  getMyNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
};
