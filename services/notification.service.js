// Servicio de Notificaciones Push — Expo Push API
// ---------------------------------------------------------------------
// Encapsula el envío de notificaciones push a dispositivos iOS y Android
// usando el servicio de Expo (https://exp.host/--/api/v2/push/send).
//
// Ventajas vs. Firebase Cloud Messaging directo:
//   - No requiere @react-native-firebase/* ni google-services.json.
//   - Compatible con Expo Go en iOS (todavía).
//   - Expo traduce los Expo Push Tokens a FCM (Android) / APNs (iOS)
//     internamente — el backend no necesita saber cuál SDK usa el móvil.
//
// Modelo de datos:
//   - Guardian.fcm_token / User.fcm_token siguen llamándose así en la DB
//     pero ahora almacenan Expo Push Tokens ("ExponentPushToken[…]").
//   - Cuando Expo responde "DeviceNotRegistered", marcamos el token como
//     null en la DB (la app móvil deberá re-registrar en el próximo login).
//
// Es seguro llamar a las funciones de este módulo aunque no haya tokens
// registrados: las funciones simplemente devolverán un resultado vacío y
// se imprimirá una advertencia en consola.
// =====================================================================

const Guardian = require("../models/Guardian.model"); // Modelo de tutores
const Student = require("../models/Student.model"); // Modelo de estudiantes
const User = require("../models/User.model"); // Modelo de usuarios (para notificaciones a staff)
const notificationsService = require("./notifications.service"); // Persistencia in-app (campanita)

// URL del servicio de Expo Push. Puede sobreescribirse en .env para
// tests o entornos on-prem. El default es el público de Expo.
const EXPO_PUSH_URL =
  process.env.EXPO_PUSH_API_URL || "https://exp.host/--/api/v2/push/send";

// Channels de Android (Expo los pasa como `channelId` en el payload).
// El móvil debe crear canales con los mismos IDs en
// notificationService.createAndroidChannel() para que el sistema
// operativo respete los settings (sonido, vibración, importance, etc.).
const CHANNELS = {
  attendance: "eduk_attendance_channel",
  citation: "eduk_citations_channel",
  announcement: "eduk_announcements_channel",
  conduct: "eduk_conduct_channel",
};

// =====================================================================
// sendToTokens(tokens, payload)
// =====================================================================
// Envía un push a una lista de Expo Push Tokens.
// `payload` debe tener: { title, body, channelId, data }.
// Devuelve { successCount, failureCount, responses, tickets }.
// =====================================================================
const sendToTokens = async (tokens, payload) => {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, responses: [], tickets: [] };
  }

  // Expo Push acepta un array de hasta 100 mensajes por request.
  // Construimos un mensaje por token.
  const messages = tokens.map((token) => ({
    to: token,
    sound: "default",
    title: payload.title,
    body: payload.body,
    // `channelId` se respeta en Android (Android 8+). El cliente debe
    // haber creado el canal con este mismo ID.
    channelId: payload.channelId || CHANNELS.attendance,
    // data debe ser string-keyed string-valued (Expo lo requiere).
    data: payload.data
      ? Object.fromEntries(
          Object.entries(payload.data).map(([k, v]) => [k, String(v)])
        )
      : {},
    // Prioridad alta para delivery inmediato. En iOS esto activa el
    // delivery silencioso + visible (content-available: 1).
    priority: "high",
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[expo-push] HTTP ${response.status} from Expo Push API: ${errorText}`
      );
      return {
        successCount: 0,
        failureCount: tokens.length,
        responses: [],
        tickets: [],
        httpError: response.status,
      };
    }

    const result = await response.json();
    // Expo Push responde con { data: [{ status, id?, message?, details? }, ...] }
    const tickets = Array.isArray(result?.data) ? result.data : [];

    let successCount = 0;
    let failureCount = 0;
    tickets.forEach((ticket) => {
      if (ticket.status === "ok") successCount++;
      else failureCount++;
    });

    return { successCount, failureCount, responses: tickets, tickets };
  } catch (error) {
    console.error(`[expo-push] Error sending push: ${error.message}`);
    return {
      successCount: 0,
      failureCount: tokens.length,
      responses: [],
      tickets: [],
      networkError: error.message,
    };
  }
};

// =====================================================================
// dispatchToGuardians(guardians, payload, logTag)
// =====================================================================
// Helper compartido: arma el mapa token → guardian, despacha el push,
// limpia tokens stale (DeviceNotRegistered) y persiste cada push
// enviada en la colección Notification (para la campanita in-app).
// Lo usan las funciones de notificación a tutores.
// =====================================================================
const dispatchToGuardians = async (guardians, payload, logTag) => {
  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }
  const tokenToGuardian = new Map();
  // Map user_id → guardian para persistir notificaciones in-app.
  // Solo guardamos el primer guardian por user_id (un tutor puede
  // ser guardian de varios alumnos y recibiría la misma push N veces,
  // pero en la campanita solo aparece UNA entrada por user_id).
  const userIdToGuardian = new Map();
  for (const g of guardians) {
    if (typeof g.fcm_token === "string" && g.fcm_token.trim().length > 0) {
      tokenToGuardian.set(g.fcm_token, g._id);
    }
    // Solo guardamos para persistencia si el guardian tiene user_id
    // (tutor activado). Guardians sin user_id son tutores pre-registrados
    // que aún no activaron su cuenta — no pueden ver la campanita.
    if (g.user_id) {
      const uidStr = String(g.user_id);
      if (!userIdToGuardian.has(uidStr)) {
        userIdToGuardian.set(uidStr, g);
      }
    }
  }
  const tokens = [...tokenToGuardian.keys()];
  // NOTA: aunque no haya tokens (guardian sin app abierta todavía), la
  // campanita in-app SÍ debe poblarse para que cuando el tutor abra
  // la app la próxima vez, vea la notificación. Por eso persistimos
  // ANTES de (y aunque) enviar los pushes.

  // Persistir cada push en la campanita in-app (solo para guardians
  // ACTIVADOS con user_id). Best-effort: si la persistencia falla,
  // loggeamos pero no fallamos el envío.
  const persistedUserIds = new Set();
  for (const [userIdStr, guardian] of userIdToGuardian.entries()) {
    if (persistedUserIds.has(userIdStr)) continue;
    persistedUserIds.add(userIdStr);
    try {
      await notificationsService.persistNotification({
        recipient_user_id: guardian.user_id,
        recipient_role: "tutor",
        school: guardian.school,
        kind: payload.data?.kind || "announcement",
        title: payload.title,
        body: payload.body,
        data: payload.data || {},
        channel_id: payload.channelId,
      });
    } catch (persistErr) {
      console.warn(
        `[${logTag}] Failed to persist notification for user ${userIdStr}: ${persistErr.message}`
      );
    }
  }

  // Si no hay tokens, retornamos temprano DESPUÉS de persistir
  // (porque la campanita ya quedó poblada).
  if (tokens.length === 0) {
    return { dispatched: 0, reason: "no_tokens", persisted: persistedUserIds.size };
  }

  const result = await sendToTokens(tokens, payload);

  // Invalidar tokens stale: Expo responde "DeviceNotRegistered" cuando
  // el usuario desinstaló la app o el token expiró. Marcamos como null
  // para que el siguiente login re-registre el token nuevo.
  const invalidTokenGuardianIds = [];
  if (result.tickets && Array.isArray(result.tickets)) {
    result.tickets.forEach((ticket, idx) => {
      if (ticket.status === "ok") return;
      const errorCode = ticket.details?.error;
      if (errorCode !== "DeviceNotRegistered") return;
      const failedToken = tokens[idx];
      const guardianId = tokenToGuardian.get(failedToken);
      if (guardianId) invalidTokenGuardianIds.push(guardianId);
    });
  }

  let invalidated = 0;
  if (invalidTokenGuardianIds.length > 0) {
    const upd = await Guardian.updateMany(
      { _id: { $in: invalidTokenGuardianIds } },
      { $set: { fcm_token: null } }
    );
    invalidated = upd.modifiedCount;
    console.log(
      `[${logTag}] Invalidated ${invalidated} stale expo push token(s) (will require mobile app to re-register)`
    );
  }

  return {
    dispatched: result.successCount,
    failed: result.failureCount,
    tokens: tokens.length,
    invalidated,
    persisted: persistedUserIds.size,
  };
};

// =====================================================================
// Notificaciones para TUTORES (attendance, citation, announcement)
// =====================================================================

// Notifica a los tutores de un estudiante sobre un evento de asistencia
// recién creado (RFID tap).
const sendAttendanceNotification = async (student, attendanceLog) => {
  const guardians = await Guardian.find({
    students: student._id,
    school: student.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const schoolTag = student.school
    ? student.school.cct || String(student.school._id || student.school)
    : "no-school";

  const fullName = `${student.first_name} ${student.last_name}`.trim();
  const eventTypeLabel =
    attendanceLog.event_type === "entry" ? "ENTRADA" : "SALIDA";
  const time = new Date(attendanceLog.event_time).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const payload = {
    title: `${eventTypeLabel}: ${fullName}`,
    body: `${fullName} registró ${eventTypeLabel.toLowerCase()} a las ${time}.`,
    channelId: CHANNELS.attendance,
    data: {
      kind: "attendance",
      event_type: attendanceLog.event_type,
      student_id: String(student._id),
      controlNumber: student.controlNumber,
      event_time: String(attendanceLog.event_time),
      log_id: String(attendanceLog._id),
    },
  };

  console.log(
    `[attendance][school=${schoolTag}] Dispatching ${eventTypeLabel} for ${fullName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "attendance");
};

// Notifica a los tutores de un estudiante sobre una ausencia marcada
// automáticamente por el cronjob o manualmente por el admin.
const sendAbsenceNotification = async (student, attendanceLog) => {
  // SOLO ausencias reales. Jamás se notifica "RETARDO": llegar tarde
  // puede deberse a un inconveniente y no es motivo de alerta (acuerdo
  // con el cliente). Las llegadas usan sendAttendanceNotification y el
  // mensaje neutral "ENTRADA: ... registró entrada a las HH:MM".
  if (attendanceLog.status !== "absent") {
    return { dispatched: 0, reason: "not_absent" };
  }

  const guardians = await Guardian.find({
    students: student._id,
    school: student.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const fullName = `${student.first_name} ${student.last_name}`.trim();
  const time = new Date(attendanceLog.event_time).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const payload = {
    title: `AUSENCIA: ${fullName}`,
    body: `${fullName} fue marcado ausente a las ${time}.`,
    channelId: CHANNELS.attendance,
    data: {
      kind: "absence",
      event_type: attendanceLog.event_type,
      status: attendanceLog.status,
      student_id: String(student._id),
      controlNumber: student.controlNumber,
      event_time: String(attendanceLog.event_time),
      log_id: String(attendanceLog._id),
    },
  };

  const schoolTag = student.school
    ? student.school.cct || String(student.school._id || student.school)
    : "no-school";

  console.log(
    `[attendance][school=${schoolTag}] Dispatching AUSENCIA for ${fullName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "attendance");
};

// Notifica a los tutores de un estudiante que registró ENTRADA pero NO
// registró SALIDA en el día (el cronjob lo detecta a `shift.endTime +
// gracePeriodMinutes`). El alumno SÍ estuvo en la escuela — el push sirve
// para que el papá/tutor confirme la salida de su hijo o pida apoyo al
// personal si la omisión fue accidental. `entryLog` debe tener al menos
// `event_time`, `_id` y `student_id`.
const sendMissingExitNotification = async (student, entryLog) => {
  const guardians = await Guardian.find({
    students: entryLog.student_id,
    school: student.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const fullName = `${student.first_name || ""} ${student.last_name || ""}`.trim() ||
    "Alumno";

  const entryTime = new Date(entryLog.event_time).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const payload = {
    title: `SIN SALIDA: ${fullName}`,
    body: `${fullName} registró entrada a las ${entryTime} pero no registró salida. Si se encuentra en la escuela, favor de avisar a la oficina.`,
    channelId: CHANNELS.attendance,
    data: {
      kind: "missing_exit",
      event_type: "entry",
      student_id: String(entryLog.student_id),
      controlNumber: student.controlNumber || null,
      event_time: String(entryLog.event_time),
      log_id: String(entryLog._id),
    },
  };

  const schoolTag = student.school
    ? student.school.cct || String(student.school._id || student.school)
    : "no-school";

  console.log(
    `[attendance][school=${schoolTag}] Dispatching SIN SALIDA for ${fullName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "attendance");
};

// Notifica a los tutores de un estudiante sobre un citatorio recién creado.
// `citation` debe traer el `student` populado.
const sendCitationNotification = async (citation) => {
  const studentId = citation.student?._id || citation.student;
  const studentName = citation.student
    ? `${citation.student.first_name || ""} ${citation.student.last_name || ""}`.trim()
    : "Alumno";

  const guardians = await Guardian.find({
    students: studentId,
    school: citation.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const dateStr = new Date(citation.scheduledDate).toLocaleString("es-MX", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const typeLabel =
    citation.type === "academic"
      ? "Académico"
      : citation.type === "behavioral"
      ? "Conducta"
      : "Administrativo";

  const payload = {
    title: `Citatorio: ${studentName}`,
    body: `${typeLabel} - ${dateStr}. ${citation.reason}${
      citation.location ? ` · Lugar: ${citation.location}` : ""
    }`,
    channelId: CHANNELS.citation,
    data: {
      kind: "citation",
      citation_id: String(citation._id),
      student_id: String(studentId),
      scheduledDate: String(citation.scheduledDate),
      type: citation.type,
      status: citation.status,
    },
  };

  console.log(
    `[citations] Dispatching citatorio for ${studentName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "citations");
};

// Notifica reagendación de citatorio.
const sendCitationRescheduledNotification = async (citation) => {
  const studentId = citation.student?._id || citation.student;
  const studentName = citation.student
    ? `${citation.student.first_name || ""} ${citation.student.last_name || ""}`.trim()
    : "Alumno";

  const guardians = await Guardian.find({
    students: studentId,
    school: citation.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const dateStr = new Date(citation.scheduledDate).toLocaleString("es-MX", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const payload = {
    title: `Citatorio reagendado: ${studentName}`,
    body: `Nueva fecha: ${dateStr}. Lugar: ${citation.location || "No especificado"}`,
    channelId: CHANNELS.citation,
    data: {
      kind: "citation_rescheduled",
      citation_id: String(citation._id),
      student_id: String(studentId),
      scheduledDate: String(citation.scheduledDate),
      type: citation.type,
      status: citation.status,
    },
  };

  console.log(
    `[citations] Dispatching reschedule notification for ${studentName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "citations");
};

// Notifica cancelación de citatorio.
const sendCitationCancelledNotification = async (citation) => {
  const studentId = citation.student?._id || citation.student;
  const studentName = citation.student
    ? `${citation.student.first_name || ""} ${citation.student.last_name || ""}`.trim()
    : "Alumno";

  const guardians = await Guardian.find({
    students: studentId,
    school: citation.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const dateStr = new Date(citation.scheduledDate).toLocaleString("es-MX", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const payload = {
    title: `Citatorio cancelado: ${studentName}`,
    body: `La cita del ${dateStr} ha sido cancelada.`,
    channelId: CHANNELS.citation,
    data: {
      kind: "citation_cancelled",
      citation_id: String(citation._id),
      student_id: String(studentId),
      scheduledDate: String(citation.scheduledDate),
      type: citation.type,
      status: citation.status,
    },
  };

  console.log(
    `[citations] Dispatching cancel notification for ${studentName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "citations");
};

// Notifica a los tutores afectados por un aviso recién creado.
// targetType: "general" | "group" | "student".
const sendAnnouncementNotification = async (announcement) => {
  // 1) Resolver los studentIds destinatarios.
  let studentIds = [];
  const targetGroupsIds = (announcement.targetGroups || []).map((g) =>
    typeof g === "object" ? String(g._id || g) : String(g)
  );
  const targetStudentsIds = (announcement.targetStudents || []).map((s) =>
    typeof s === "object" ? String(s._id || s) : String(s)
  );

  if (announcement.targetType === "general") {
    const students = await Student.find({
      school: announcement.school,
      status: "active",
    })
      .select("_id")
      .lean();
    studentIds = students.map((s) => s._id);
  } else if (announcement.targetType === "group") {
    if (targetGroupsIds.length === 0) {
      return { dispatched: 0, reason: "no_groups" };
    }
    const students = await Student.find({
      school: announcement.school,
      current_group_id: { $in: targetGroupsIds },
      status: "active",
    })
      .select("_id")
      .lean();
    studentIds = students.map((s) => s._id);
  } else if (announcement.targetType === "student") {
    studentIds = targetStudentsIds;
  }

  if (studentIds.length === 0) {
    return { dispatched: 0, reason: "no_students" };
  }

  // 2) Tutores de esos estudiantes.
  const guardians = await Guardian.find({
    school: announcement.school,
    students: { $in: studentIds },
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  // 3) Truncar el mensaje (Android limita a ~240 chars).
  const truncated =
    announcement.message && announcement.message.length > 180
      ? `${announcement.message.slice(0, 177)}...`
      : announcement.message || "";

  const priorityPrefix =
    announcement.priority === "urgent" ? "🚨 Urgente: " : "";
  const title = `${priorityPrefix}${announcement.title}`;

  const payload = {
    title,
    body: truncated,
    channelId: CHANNELS.announcement,
    data: {
      kind: "announcement",
      announcement_id: String(announcement._id),
      targetType: announcement.targetType,
      priority: announcement.priority,
    },
  };

  console.log(
    `[announcements] Dispatching "${announcement.title}" (${announcement.targetType}) to ${guardians.length} guardian(s) of ${studentIds.length} student(s)`
  );
  return dispatchToGuardians(guardians, payload, "announcements");
};

// =====================================================================
// Notificaciones al STAFF (cuando un tutor actúa sobre un citatorio)
// =====================================================================

// Envía un push a un solo staff user por su fcm_token (que ahora es
// un Expo Push Token). También persiste en la campanita in-app.
//
// IMPORTANTE: la persistencia en campanita ocurre SIEMPRE que el user
// exista (tenga o no token de push). Esto permite que el staff vea la
// notificación cuando abra la app, aunque no haya abierto la app
// cuando el tutor pidió la reagendación.
const sendToStaffUser = async (user, payload) => {
  if (!user) {
    return { dispatched: 0, reason: "no_user" };
  }

  // Persistir en campanita in-app (best-effort, incluso si no hay token).
  try {
    await notificationsService.persistNotification({
      recipient_user_id: user._id,
      recipient_role: user.role,
      school: user.school,
      kind: payload.data?.kind || "announcement",
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      channel_id: payload.channelId,
    });
  } catch (persistErr) {
    console.warn(
      `[notifications] Failed to persist notification for staff ${user._id}: ${persistErr.message}`
    );
  }

  // Si no hay token, retornamos temprano (campanita ya quedó poblada).
  if (!user.fcm_token) {
    return { dispatched: 0, reason: "no_fcm_token", persisted: true };
  }

  const result = await sendToTokens([user.fcm_token], payload);

  // Invalidar si el token está stale.
  if (result.tickets && result.tickets[0]?.details?.error === "DeviceNotRegistered") {
    await User.updateOne(
      { _id: user._id },
      { $set: { fcm_token: null } }
    );
    console.log(
      `[notifications] Invalidated stale expo push token for staff ${user._id}`
    );
  }

  return {
    dispatched: result.successCount,
    failed: result.failureCount,
    persisted: true,
  };
};

// Notifica al staff creator que un tutor confirmó un citatorio.
const sendCitationConfirmedNotification = async (citation, guardianName) => {
  const studentName = citation.student
    ? `${citation.student.first_name || ""} ${citation.student.last_name || ""}`.trim()
    : "Alumno";

  const creator = await User.findById(citation.creator)
    .select("fcm_token name last_name school role")
    .lean();

  if (!creator) {
    return { dispatched: 0, reason: "creator_not_found" };
  }

  const dateStr = new Date(citation.scheduledDate).toLocaleString("es-MX", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const payload = {
    title: `Citatorio confirmado: ${studentName}`,
    body: `${guardianName} confirmó asistencia para ${dateStr}.`,
    channelId: CHANNELS.citation,
    data: {
      kind: "citation_confirmed",
      citation_id: String(citation._id),
      student_id: String(citation.student?._id || citation.student),
      scheduledDate: String(citation.scheduledDate),
      status: "confirmed",
    },
  };

  console.log(
    `[citations] Dispatching confirmed notification for citation ${citation._id} to staff ${creator._id}`
  );
  return sendToStaffUser(creator, payload);
};

// Notifica al staff creator que un tutor solicita reagendar un citatorio.
const sendCitationRescheduleRequestNotification = async (
  citation,
  guardianName,
  reason
) => {
  const studentName = citation.student
    ? `${citation.student.first_name || ""} ${citation.student.last_name || ""}`.trim()
    : "Alumno";

  const creator = await User.findById(citation.creator)
    .select("fcm_token name last_name school role")
    .lean();

  if (!creator) {
    return { dispatched: 0, reason: "creator_not_found" };
  }

  const payload = {
    title: `Solicitud de reagendación`,
    body: `${guardianName} solicita reagendar cita de ${studentName}. Razón: ${reason}`,
    channelId: CHANNELS.citation,
    data: {
      kind: "citation_reschedule_request",
      citation_id: String(citation._id),
      student_id: String(citation.student?._id || citation.student),
      scheduledDate: String(citation.scheduledDate),
      reason: reason,
    },
  };

  console.log(
    `[citations] Dispatching reschedule request notification for citation ${citation._id} to staff ${creator._id}`
  );
  return sendToStaffUser(creator, payload);
};

// =====================================================================
// Notificaciones de CONDUCTA (a los tutores del alumno)
// =====================================================================

// Helper: arma el nombre completo del staff que creó el reporte.
// Si el creator no tiene nombre, devuelve "Staff".
const buildCreatorName = (creator) => {
  if (!creator) return "Staff";
  const first = creator.name || "";
  const last = creator.last_name || "";
  const full = `${first} ${last}`.trim();
  return full || "Staff";
};

// Notifica a los tutores de un estudiante que se creó un reporte de
// conducta (demerit o merit).
//
// `conductLog` debe traer el student populado ({ first_name, last_name }).
// `creator` debe traer { name, last_name }.
const sendConductNotification = async (conductLog, creator) => {
  const studentId = conductLog.student_id?._id || conductLog.student_id;
  const studentName = conductLog.student_id
    ? `${conductLog.student_id.first_name || ""} ${conductLog.student_id.last_name || ""}`.trim()
    : "Alumno";

  const guardians = await Guardian.find({
    students: studentId,
    school: conductLog.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const creatorName = buildCreatorName(creator);

  // Truncar la descripción a 180 chars (límite push Android).
  const description =
    conductLog.description && conductLog.description.length > 180
      ? `${conductLog.description.slice(0, 177)}...`
      : conductLog.description || "";

  const payload = {
    title: `Reporte de conducta: ${studentName}`,
    body: `${creatorName} reportó: ${description}`,
    channelId: CHANNELS.conduct,
    data: {
      kind: "conduct_report",
      conduct_log_id: String(conductLog._id),
      student_id: String(studentId),
      severity: conductLog.severity || null,
      eventType: conductLog.eventType,
    },
  };

  console.log(
    `[conduct] Dispatching report notification for ${studentName} by ${creatorName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "conduct");
};

// Notifica a los tutores de un estudiante que un reporte de conducta
// fue cancelado (soft-cancel por admin o creator).
const sendConductCancelledNotification = async (conductLog, creator) => {
  const studentId = conductLog.student_id?._id || conductLog.student_id;
  const studentName = conductLog.student_id
    ? `${conductLog.student_id.first_name || ""} ${conductLog.student_id.last_name || ""}`.trim()
    : "Alumno";

  const guardians = await Guardian.find({
    students: studentId,
    school: conductLog.school,
  })
    .select("fcm_token phone name user_id school")
    .lean();

  if (!guardians || guardians.length === 0) {
    return { dispatched: 0, reason: "no_guardians" };
  }

  const creatorName = buildCreatorName(creator);

  const payload = {
    title: `Reporte cancelado: ${studentName}`,
    body: `${creatorName} canceló un reporte de conducta.`,
    channelId: CHANNELS.conduct,
    data: {
      kind: "conduct_cancelled",
      conduct_log_id: String(conductLog._id),
      student_id: String(studentId),
    },
  };

  console.log(
    `[conduct] Dispatching cancellation notification for ${studentName} by ${creatorName} to ${guardians.length} guardian(s)`
  );
  return dispatchToGuardians(guardians, payload, "conduct");
};

module.exports = {
  // Note: initializeFirebase e isFirebaseReady se mantienen en module.exports
  // como no-ops para no romper imports legacy. En realidad ya no se usan.
  initializeFirebase: () => null,
  isFirebaseReady: () => false,

  // API principal
  sendToTokens,
  sendAttendanceNotification,
  sendAbsenceNotification,
  sendMissingExitNotification,
  sendCitationNotification,
  sendCitationRescheduledNotification,
  sendCitationCancelledNotification,
  sendCitationConfirmedNotification,
  sendCitationRescheduleRequestNotification,
  sendAnnouncementNotification,
  sendConductNotification,
  sendConductCancelledNotification,

  // Constantes exportadas (por si los controllers o tests las necesitan)
  CHANNELS,
  EXPO_PUSH_URL,
};
