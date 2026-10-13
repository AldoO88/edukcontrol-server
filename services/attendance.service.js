// Servicio de Asistencia
// Lógica compartida por los dos caminos que generan un AttendanceLog:
//   - POST /api/attendance/device-trigger  (lectores propios, body JSON)
//   - POST /iclock/cdata                   (push ADMS de terminales ZKTeco)
// Ambos hacen exactamente lo mismo una vez identificado al alumno: calcular
// entry/exit, crear el log, invalidar el cache de los tutores y disparar la
// notificación push en segundo plano.
const AttendanceLog = require("../models/AttendanceLog.model");
const Guardian = require("../models/Guardian.model");
const Group = require("../models/Group.model");
const SchoolShift = require("../models/SchoolShift.model");
const SchoolCalendar = require("../models/SchoolCalendar.model");
const Student = require("../models/Student.model");
const notificationService = require("./notification.service");
const cache = require("./cache.service");

// Ventana (ms) dentro de la cual dos eventos idénticos del mismo alumno y
// dispositivo se consideran el mismo evento. Las terminales ADMS reenvían el
// lote completo cuando no reciben un 200, y algunos lectores mandan doble
// pulso; sin esta ventana cada reintento duplicaría el log y la notificación.
// (Queda subsumida por la ventana cross-device de abajo, pero se conserva
// como referencia del dedup original ±60 s.)
const DUPLICATE_WINDOW_MS = 60 * 1000;

// Ventana cross-device de duplicados (5 min por defecto, configurable con
// ATTENDANCE_DEDUP_WINDOW_MIN): si el mismo alumno vuelve a pasar la
// credencial o el rostro — en el MISMO o en OTRO dispositivo — dentro de
// esta ventana, el tap se trata como duplicado y NO crea un segundo log.
// Cubre el caso real de una puerta con lector RFID + terminal facial: la
// tarjeta registra el `entry` y la cara vuelve a verificar al alumno
// segundos después; sin esta regla la alternancia automática creaba un
// `exit` falso a los N segundos de haber entrado.
//
// Excepción: si el log reciente es un `absent` marcado por el cron, el tap
// SÍ se procesa — es el late-arrival que debe revertir absent → on_time
// (suprimirlo dejaría al alumno ausente aunque hubiera pasado el lector).
const getCrossDeviceWindowMs = () => {
  const parsed = parseInt(process.env.ATTENDANCE_DEDUP_WINDOW_MIN, 10);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  return minutes * 60 * 1000;
};

// Tolerancia máxima para aceptar un `event_time` "a futuro" mandado por un
// dispositivo. Un reloj desfasado o una zona horaria mal configurada (ej. el
// bug +2h de las terminales Hikvision con offset UTC-8) estampa fechas por
// delante del servidor; una fecha futura jamás es legítima y rompe grace
// period, cron y alternancia. Si event_time supera al reloj del servidor en
// más de esta tolerancia, se clampa al reloj del servidor.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// "HH:mm" → minutos desde medianoche. Helper local para no acoplar al modelo.
const toMinutes = (hhmm) => {
  if (typeof hhmm !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(hhmm))
    return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Convierte una fecha UTC a fecha local (solo año-mes-día) usando ADMS_TZ_OFFSET_MINUTES.
// Define here because determineNextType (declared above) also uses it.
const toLocalDate = (utcDate) => {
  const offset = parseInt(process.env.ADMS_TZ_OFFSET_MINUTES || "0", 10);
  const local = new Date(utcDate.getTime() + offset * 60000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  );
};

// Determina el siguiente tipo de evento (entry/exit) para un estudiante.
// El tipo se alterna a partir del último log: el dispositivo NO decide.
//
// Si el último log es de un DÍA ANTERIOR (en zona horaria de la escuela),
// el siguiente tap SIEMPRE es `entry` — no la alternación del último log.
// Esto evita que un alumno que olvidó registrar su salida consuma su tap
// de entrada del día siguiente como si fuera `exit` (la escuela lo vería
// salir a las 07:32, lo cual es absurdo).
const determineNextType = async (studentId, eventTime = new Date()) => {
  const lastLog = await AttendanceLog.findOne({ student_id: studentId })
    .sort({ event_time: -1 })
    .select("event_type event_time");

  if (!lastLog) return "entry";

  // Comparamos por día local (con ADMS_TZ_OFFSET_MINUTES), no por día UTC.
  const lastLocalDate = toLocalDate(new Date(lastLog.event_time));
  const currentLocalDate = toLocalDate(eventTime);
  if (lastLocalDate.getTime() !== currentLocalDate.getTime()) return "entry";

  return lastLog.event_type === "entry" ? "exit" : "entry";
};

// Busca un log equivalente (mismo alumno, mismo dispositivo, ±1 min) para no
// duplicar en reintentos del dispositivo. Devuelve el log existente o null.
// Nota: el flujo principal (registerAttendanceEvent) ya NO usa esta función —
// la reemplazó la ventana cross-device de 5 min (mismo alumno, cualquier
// dispositivo). Se conserva exportada por compatibilidad con scripts/e2e.
const findRecentDuplicate = async (studentId, device, eventTime) => {
  const from = new Date(eventTime.getTime() - DUPLICATE_WINDOW_MS);
  const to = new Date(eventTime.getTime() + DUPLICATE_WINDOW_MS);

  return AttendanceLog.findOne({
    student_id: studentId,
    device,
    event_time: { $gte: from, $lte: to },
  });
};

// Invalida el cache de dashboard/calificaciones de todos los tutores del
// alumno, para que el próximo GET vea el evento al instante (sin esperar TTL).
// No es crítico: si falla, el cache se autorrecupera al expirar.
const invalidateGuardianCaches = async (student) => {
  try {
    const affectedGuardians = await Guardian.find({ students: student._id })
      .select("user_id")
      .lean();

    for (const g of affectedGuardians) {
      await cache.invalidatePattern(`dashboard:${String(g.user_id)}:*`);
      await cache.invalidatePattern(
        `student-grades:${String(g.user_id)}:${String(student._id)}*`
      );
    }

    if (affectedGuardians.length > 0) {
      console.log(
        `[attendance] Invalidated cache for ${affectedGuardians.length} guardian(s) of student ${student._id}`
      );
    }
  } catch (cacheErr) {
    console.warn(`[attendance] Cache invalidation failed: ${cacheErr.message}`);
  }
};

// Dispara la notificación push fuera del ciclo de respuesta: el dispositivo
// recibe su ACK sin esperar a Firebase.
const dispatchNotificationInBackground = (student, attendanceLog) => {
  process.nextTick(() => {
    (async () => {
      try {
        const result = await notificationService.sendAttendanceNotification(
          student,
          attendanceLog
        );
        if (result && result.dispatched && result.dispatched > 0) {
          await AttendanceLog.updateOne(
            { _id: attendanceLog._id },
            { $set: { notification_sent: true } }
          );
          console.log(
            `[attendance] Push notifications dispatched for log ${attendanceLog._id} (${result.dispatched}/${result.tokens || 0})`
          );
        } else {
          console.log(
            `[attendance] No push notifications dispatched for log ${attendanceLog._id}: ${
              result && result.reason ? result.reason : "unknown"
            }`
          );
        }
      } catch (err) {
        console.error(
          `[attendance] Background notification error for log ${attendanceLog._id}: ${err.message}`
        );
      }
    })();
  });
};

// Dispara notificación de AUSENCIA fuera del ciclo de respuesta.
// SOLO para ausencias reales (cron manual/admin) — usa
// sendAbsenceNotification, que se niega a enviar si status !== "absent".
// Las llegadas (en gracia o fuera de ella) van por
// dispatchNotificationInBackground con el mensaje neutral "ENTRADA".
const dispatchAbsenceNotificationInBackground = (student, attendanceLog) => {
  process.nextTick(() => {
    (async () => {
      try {
        const result = await notificationService.sendAbsenceNotification(
          student,
          attendanceLog
        );
        if (result && result.dispatched && result.dispatched > 0) {
          await AttendanceLog.updateOne(
            { _id: attendanceLog._id },
            { $set: { notification_sent: true } }
          );
          console.log(
            `[attendance] Absence push dispatched for log ${attendanceLog._id} (${result.dispatched}/${result.tokens || 0})`
          );
        } else {
          console.log(
            `[attendance] No absence push for log ${attendanceLog._id}: ${
              result && result.reason ? result.reason : "unknown"
            }`
          );
        }
      } catch (err) {
        console.error(
          `[attendance] Background absence notification error for log ${attendanceLog._id}: ${err.message}`
        );
      }
    })();
  });
};

// Dispara notificación "sin salida" fuera del ciclo de respuesta.
// Lo invoca el cron a las `shift.endTime + gracia` para cada alumno con
// entry pero sin exit registrado en el día. Es paralelo a
// dispatchAbsenceNotificationInBackground pero usa sendMissingExitNotification
// (mensaje "sí estuvo pero no pasó el biométrico de salida").
const dispatchMissingExitNotificationInBackground = (student, attendanceLog) => {
  process.nextTick(() => {
    (async () => {
      try {
        const result =
          await notificationService.sendMissingExitNotification(
            student,
            attendanceLog
          );
        if (result && result.dispatched && result.dispatched > 0) {
          console.log(
            `[attendance] Missing-exit push dispatched for log ${attendanceLog._id} (${result.dispatched}/${result.tokens || 0})`
          );
        } else {
          console.log(
            `[attendance] No missing-exit push for log ${attendanceLog._id}: ${
              result && result.reason ? result.reason : "unknown"
            }`
          );
        }
      } catch (err) {
        console.error(
          `[attendance] Background missing-exit notification error for log ${attendanceLog._id}: ${err.message}`
        );
      }
    })();
  });
};

// "HH:mm" → minutos desde medianoche. Helper local para no acoplar al modelo.
// (toMinutes y toLocalDate están definidos arriba del archivo para que
// determineNextType pueda usarlos — no los redeclares aquí.)

// Calcula el status de una entrada comparando la hora del evento con la
// hora de inicio del turno del grupo del alumno.
// Esta función solo se ejecuta para eventos DENTRO del grace period
// (antes del cutoff), por lo que siempre retorna "on_time".
//   on_time → el alumno pasó el lector antes del cutoff
//   null    → no se pudo resolver (sin grupo, sin turno, etc.)
const computeEntryStatus = async (student, eventTime) => {
  try {
    if (!student.current_group_id) return null;

    const group = await Group.findById(student.current_group_id)
      .select("shift school_year_id school")
      .lean();
    if (!group) return null;

    const shift = await SchoolShift.findOne({
      school: group.school,
      school_year_id: group.school_year_id,
      shift: group.shift,
    })
      .select("startTime")
      .lean();
    if (!shift) return null;

    // Siempre on_time: esta función solo se llama dentro del grace period
    return "on_time";
  } catch (err) {
    console.warn(
      `[attendance] computeEntryStatus failed for student ${student._id}: ${err.message}`
    );
    return null;
  }
};

// Verifica si una fecha es día escolar consultando SchoolCalendar.
// Retorna:
//   { isSchoolDay: true }                                 — sin entrada para ese día
//   { isSchoolDay: true, special_entry_time, special_exit_time,
//     reason: "special_schedule" }                        — día lectivo con horario especial
//   { isSchoolDay: false, reason, name }                  — festivo/vacación/suspensión/no lectivo
const isSchoolDay = async (school, schoolYearId, date) => {
  try {
    // Normalizar a inicio del día UTC
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const entry = await SchoolCalendar.findOne({
      school,
      school_year_id: schoolYearId,
      date: startOfDay,
      is_active: true,
    }).select("type name special_entry_time special_exit_time");

    if (!entry) return { isSchoolDay: true };

    if (entry.type === "special_schedule") {
      // El día ES lectivo: el cron usa las horas especiales para ajustar
      // el cutoff de entrada y el chequeo de salida. Las dos horas son
      // opcionales individualmente; los callers caen al valor del turno si
      // una está ausente.
      return {
        isSchoolDay: true,
        reason: "special_schedule",
        name: entry.name || "Horario especial",
        special_entry_time: entry.special_entry_time || null,
        special_exit_time: entry.special_exit_time || null,
      };
    }

    return {
      isSchoolDay: false,
      reason: entry.type,
      name: entry.name || entry.type,
    };
  } catch (err) {
    console.warn(
      `[attendance] isSchoolDay failed for school ${school}: ${err.message}`
    );
    // En caso de error, asumir que SÍ es día escolar (mejor marcar ausencia
    // que saltársela silenciosamente).
    return { isSchoolDay: true };
  }
};

// Calcula si un evento cayó después del corte de gracia del turno del alumno.
// El cutoff = startTime + gracePeriodMinutes del SchoolShift.
// Si ese día tiene un `special_schedule` en SchoolCalendar con
// `special_entry_time`, se usa esa hora en lugar del `startTime` del turno
// — el día es lectivo con horario modificado (ej: actividad a las 09:00,
// entrada oficial del turno 07:30 → cutoff 09:15 en vez de 08:00).
// Retorna { after: boolean, cutoffMinutes: number, shiftMinutes: number }.
const isAfterGracePeriod = async (student, eventTime) => {
  try {
    if (!student.current_group_id)
      return { after: false, cutoffMinutes: null, shiftMinutes: null };

    const group = await Group.findById(student.current_group_id)
      .select("shift school_year_id school")
      .lean();
    if (!group)
      return { after: false, cutoffMinutes: null, shiftMinutes: null };

    const shift = await SchoolShift.findOne({
      school: group.school,
      school_year_id: group.school_year_id,
      shift: group.shift,
    })
      .select("startTime gracePeriodMinutes")
      .lean();
    if (!shift)
      return { after: false, cutoffMinutes: null, shiftMinutes: null };

    // ¿Ese día tiene horario especial? Si sí, override del startTime.
    const localDay = toLocalDate(eventTime);
    const dayCheck = await isSchoolDay(group.school, group.school_year_id, localDay);
    const effectiveStartTime =
      dayCheck.special_entry_time || shift.startTime;

    const shiftMinutes = toMinutes(effectiveStartTime);
    const gracePeriod = shift.gracePeriodMinutes || 30;
    if (shiftMinutes === null)
      return { after: false, cutoffMinutes: null, shiftMinutes: null };

    const cutoffMinutes = shiftMinutes + gracePeriod;

    // Convertir event_time (UTC) a hora local
    const offset = parseInt(
      process.env.ADMS_TZ_OFFSET_MINUTES || "0",
      10
    );
    const localDate = new Date(eventTime.getTime() + offset * 60000);
    const eventMinutes =
      localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

    return {
      after: eventMinutes > cutoffMinutes,
      cutoffMinutes,
      shiftMinutes,
    };
  } catch (err) {
    console.warn(
      `[attendance] isAfterGracePeriod failed for student ${student._id}: ${err.message}`
    );
    return { after: false, cutoffMinutes: null, shiftMinutes: null };
  }
};

// Convierte una fecha UTC a fecha local (solo año-mes-día) usando ADMS_TZ_OFFSET_MINUTES.
// (toLocalDate está definido arriba — no lo redeclares aquí.)

// Cuando un alumno llega después del corte de gracia y pasa el lector:
// 1. Si ya existe un absent log de hoy → actualiza a "on_time" con la hora real del tap
// 2. Si no existe → crea entry normal con status "on_time"
// El rational: si el alumno pasó por el biometrico, YA ESTÁ presente sin importar la hora.
// Retorna { log, wasAbsenceOverride: boolean, duplicate: boolean }.
const resolveLateArrival = async ({
  student,
  eventTime,
  device,
  verificationMode,
  snapshotUrl = null,
}) => {
  const localDate = toLocalDate(eventTime);
  const endOfDay = new Date(localDate.getTime() + 24 * 60 * 60 * 1000);

  // Buscar si ya hay un absent log para este alumno hoy
  const existingAbsent = await AttendanceLog.findOne({
    student_id: student._id,
    event_type: "entry",
    status: "absent",
    event_time: { $gte: localDate, $lt: endOfDay },
  });

  if (existingAbsent) {
    // Actualizar el absent log a on_time con la hora real del tap
    const updated = await AttendanceLog.findOneAndUpdate(
      { _id: existingAbsent._id },
      {
        $set: {
          status: "on_time",
          event_time: eventTime,
          device,
          verificationMode,
          snapshotUrl,
        },
      },
      { new: true }
    );

    await invalidateGuardianCaches(student);
    dispatchNotificationInBackground(student, updated);

    return { log: updated, wasAbsenceOverride: true, duplicate: false };
  }

  // No hay absent existente → crear entry normal con status "on_time"
  const log = await AttendanceLog.create({
    school: student.school,
    student_id: student._id,
    event_time: eventTime,
    event_type: "entry",
    device,
    verificationMode,
    snapshotUrl,
    status: "on_time",
  });

  await invalidateGuardianCaches(student);
  dispatchNotificationInBackground(student, log);

  return { log, wasAbsenceOverride: false, duplicate: false };
};

// Cola por alumno: serializa el procesamiento de taps del MISMO alumno.
// En una puerta con lector RFID + terminal facial, la tarjeta y el rostro
// pueden llegar al servidor con menos de 1 s de diferencia; sin esta cola
// las dos peticiones concurrentes consultarían los duplicados al mismo
// tiempo, no verían el log recién creado y escribirían DOS documentos
// (race condition). Cada alumno se procesa en cadena (Promise) y las
// colas de distintos alumnos corren en paralelo — no hay bloqueo global.
const studentQueues = new Map();

// Registra un evento de asistencia completo.
// El `school` se desnormaliza desde el estudiante (el caller ya validó que
// exista) para acelerar las queries tenant-scoped.
// Devuelve { log, eventType, duplicate, wasAbsenceOverride }.
// `duplicate: true` significa que se reutilizó un log existente y NO se volvió
// a notificar. `wasAbsenceOverride: true` significa que se actualizó un
// absent→on_time (el alumno pasó el lector después del corte de gracia).
//
// Entrada pública: encola bajo el lock del alumno y delega en
// processAttendanceEvent (el núcleo, siempre corre serializado por alumno).
const registerAttendanceEvent = async (params) => {
  const key = String(params.student._id);
  const previous = studentQueues.get(key) || Promise.resolve();
  const run = previous
    .catch(() => {}) // un error de la tap anterior no debe impedir la siguiente
    .then(() => processAttendanceEvent(params));
  studentQueues.set(key, run);
  try {
    return await run;
  } finally {
    // Solo limpiar si nadie encadenó otra tap encima de esta.
    if (studentQueues.get(key) === run) studentQueues.delete(key);
  }
};

// Núcleo del registro de asistencia (corre SIEMPRE bajo el lock del alumno).
const processAttendanceEvent = async ({
  student,
  eventTime,
  device,
  verificationMode,
  snapshotUrl = null,
}) => {
  // 1) Clamp anti-futuro: si la terminal mandó un timestamp por delante del
  //    reloj del servidor (zona horaria/reloj mal configurado), se usa el
  //    reloj del servidor. Corrige el bug de las terminales Hikvision que
  //    estampaban event_time +2h incluso después de arreglar la config.
  let effectiveEventTime = eventTime;
  const now = new Date();
  if (effectiveEventTime.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    console.warn(
      `[attendance] event_time ${effectiveEventTime.toISOString()} es futuro vs servidor ${now.toISOString()} — clampando al reloj del servidor (student ${student._id}, device ${device})`
    );
    effectiveEventTime = now;
  }

  // 2) Duplicados cross-device: ¿el alumno tocó en ANY dispositivo dentro de
  //    la ventana (por defecto 5 min) alrededor de este evento? Si sí y no es
  //    un absent del cron → duplicado, se reutiliza el log sin notificar.
  const windowMs = getCrossDeviceWindowMs();
  const recent = await AttendanceLog.findOne({
    student_id: student._id,
    event_time: {
      $gte: new Date(effectiveEventTime.getTime() - windowMs),
      $lte: new Date(effectiveEventTime.getTime() + windowMs),
    },
  }).sort({ event_time: -1 });

  if (recent) {
    const isCronAbsence =
      recent.status === "absent" && recent.event_type === "entry";
    if (!isCronAbsence) {
      console.log(
        `[attendance] duplicate cross-device for student ${student._id}: reusing ${recent._id} (${recent.event_type} @ ${recent.event_time.toISOString()}, window ±${Math.round(windowMs / 60000)} min, device ${device})`
      );
      return {
        log: recent,
        eventType: recent.event_type,
        duplicate: true,
        wasAbsenceOverride: false,
      };
    }
    // El log reciente es un absent del cron → NO suprimir: caer al flujo
    // normal para que determineNextType + isAfterGracePeriod +
    // resolveLateArrival reviertan absent → on_time con la hora real del tap.
  }

  // 3) Late-arrival: si el alumno ya tiene un `absent` de HOY, este tap lo
  //    revierte absent → on_time con la hora real del tap. Se consulta ANTES
  //    de determineNextType porque un absent ES un `entry` faltante: la
  //    alternancia diría "el siguiente tap es exit" y el alumno tardío
  //    habría registrado una SALIDA a los minutos de llegar, dejándolo
  //    ausente todo el día. resolveLateArrival es incondicional aquí — si
  //    existe el absent de hoy, el alumno acaba de pasar el lector y ya está
  //    presente (documentado en AGENTS.md, sección late-arrival override).
  const localDay = toLocalDate(effectiveEventTime);
  const endOfDay = new Date(localDay.getTime() + 24 * 60 * 60 * 1000);
  const existingAbsent = await AttendanceLog.findOne({
    student_id: student._id,
    event_type: "entry",
    status: "absent",
    event_time: { $gte: localDay, $lt: endOfDay },
  }).select("_id");
  if (existingAbsent) {
    console.log(
      `[attendance] late arrival for student ${student._id}: flipping absent ${existingAbsent._id} → on_time at ${effectiveEventTime.toISOString()} (device ${device})`
    );
    const result = await resolveLateArrival({
      student,
      eventTime: effectiveEventTime,
      device,
      verificationMode,
      snapshotUrl,
    });
    return {
      log: result.log,
      eventType: "entry",
      duplicate: result.duplicate,
      wasAbsenceOverride: result.wasAbsenceOverride,
    };
  }

  const eventType = await determineNextType(student._id, effectiveEventTime);

  // Para entry events: si el alumno llegó después del corte de gracia,
  // resolver arrival (puede actualizar un absent→on_time o crear on_time normal)
  if (eventType === "entry") {
    const { after } = await isAfterGracePeriod(student, effectiveEventTime);
    if (after) {
      const result = await resolveLateArrival({
        student,
        eventTime: effectiveEventTime,
        device,
        verificationMode,
        snapshotUrl,
      });
      return {
        log: result.log,
        eventType: "entry",
        duplicate: result.duplicate,
        wasAbsenceOverride: result.wasAbsenceOverride,
      };
    }
  }

  // Flujo normal: computeEntryStatus para entry, null para exit
  let status = null;
  if (eventType === "entry") {
    status = await computeEntryStatus(student, effectiveEventTime);
  }

  const log = await AttendanceLog.create({
    school: student.school,
    student_id: student._id,
    event_time: effectiveEventTime,
    event_type: eventType,
    device,
    verificationMode,
    snapshotUrl,
    status,
  });

  // Si este tap es un EXIT, limpiar el flag exit_missing del entry del mismo
  // día — el alumno acaba de registrar su salida. Sin exit log no podría
  // saberse; con él, el par entry+exit describe el día completo.
  if (eventType === "exit") {
    const localDay = toLocalDate(effectiveEventTime);
    const endOfDay = new Date(localDay.getTime() + 24 * 60 * 60 * 1000);
    await AttendanceLog.updateOne(
      {
        student_id: student._id,
        event_type: "entry",
        exit_missing: true,
        event_time: { $gte: localDay, $lt: endOfDay },
      },
      { $set: { exit_missing: false, exit_missing_at: null } }
    );
  }

  await invalidateGuardianCaches(student);
  dispatchNotificationInBackground(student, log);

  return { log, eventType, duplicate: false, wasAbsenceOverride: false };
};

// Registra una ausencia manual (sin marcación del dispositivo).
// Crea un log con event_type "entry", status "absent", y verificationMode "MANUAL".
const registerAbsence = async ({ student, eventTime, device = "manual@system" }) => {
  const log = await AttendanceLog.create({
    school: student.school,
    student_id: student._id,
    event_time: eventTime,
    event_type: "entry",
    device,
    verificationMode: "MANUAL",
    status: "absent",
  });

  await invalidateGuardianCaches(student);
  return log;
};

// Marca ausencias automáticas para alumnos sin entry en la fecha dada.
// Para cada turno activo de la escuela, busca alumnos activos que no tengan
// un AttendanceLog entry en esa fecha y les crea un log con status "absent".
// Si el día tiene `special_schedule` con `special_entry_time`, el cutoff de
// entrada (hora del log absent) se calcula con esa hora en vez del
// `shift.startTime` del turno. Notifica push a cada tutor individualmente.
// Retorna { marked, skipped, date, shiftsProcessed }.
const markAbsencesForSchool = async (schoolId, schoolYearId, targetDate) => {
  const date = targetDate || new Date();
  const localDate = toLocalDate(date);
  const endOfDay = new Date(localDate.getTime() + 24 * 60 * 60 * 1000);

  // 1. Verificar si es día escolar (y si tiene horario especial).
  const dayCheck = await isSchoolDay(schoolId, schoolYearId, localDate);
  if (!dayCheck.isSchoolDay) {
    console.log(
      `[attendance][absences] Skipping ${localDate.toISOString().slice(0, 10)} — not a school day (${dayCheck.reason})`
    );
    return {
      marked: 0,
      skipped: 0,
      date: localDate.toISOString().slice(0, 10),
      reason: dayCheck.reason,
      shiftsProcessed: [],
    };
  }

  // 2. Buscar todos los turnos activos
  const shifts = await SchoolShift.find({
    school: schoolId,
    school_year_id: schoolYearId,
    isActive: true,
  })
    .select("shift startTime gracePeriodMinutes name")
    .lean();

  const results = {
    marked: 0,
    skipped: 0,
    date: localDate.toISOString().slice(0, 10),
    shiftsProcessed: [],
  };

  // Override del cutoff para todo el día si hay special_entry_time.
  // Recae a shift.startTime si no hay override. Aplica a TODOS los turnos
  // (la escuela tiene uno o varios turnos, pero un "día especial" es a
  // nivel escuela — se documenta así).
  const effectiveEntryOverride = dayCheck.special_entry_time || null;
  if (effectiveEntryOverride) {
    console.log(
      `[attendance][absences] Day ${results.date} uses special_entry_time=${effectiveEntryOverride}`
    );
  }

  for (const shift of shifts) {
    // 3. Buscar grupos activos de este turno (excluir taller)
    const groups = await Group.find({
      school: schoolId,
      school_year_id: schoolYearId,
      shift: shift.shift,
      isActive: true,
      type: "regular",
    })
      .select("_id")
      .lean();

    if (groups.length === 0) continue;

    const groupIds = groups.map((g) => g._id);

    // 4. Buscar alumnos activos en estos grupos
    const students = await Student.find({
      current_group_id: { $in: groupIds },
      status: "active",
    })
      .select("_id school current_group_id")
      .lean();

    let shiftMarked = 0;
    let shiftSkipped = 0;

    // Cutoff efectivo para este turno: override del día si existe, sino el
    // startTime del turno.
    const effectiveStartTime = effectiveEntryOverride || shift.startTime;

    for (const student of students) {
      // 5. Verificar si ya tiene un entry log hoy
      const existingEntry = await AttendanceLog.findOne({
        student_id: student._id,
        event_type: "entry",
        event_time: { $gte: localDate, $lt: endOfDay },
      }).select("_id");

      if (existingEntry) {
        shiftSkipped++;
        continue;
      }

      // 6. Crear log de ausencia con timestamp = cutoff efectivo.
      const absentTime = new Date(localDate);
      const cutoffMinutes =
        toMinutes(effectiveStartTime) + (shift.gracePeriodMinutes || 30);
      absentTime.setUTCHours(
        Math.floor(cutoffMinutes / 60),
        cutoffMinutes % 60,
        0,
        0
      );

      const log = await AttendanceLog.create({
        school: student.school,
        student_id: student._id,
        event_time: absentTime,
        event_type: "entry",
        device: "auto@system",
        verificationMode: "MANUAL",
        status: "absent",
      });

      // 7. Notificar push al tutor
      dispatchAbsenceNotificationInBackground(student, log);

      shiftMarked++;
    }

    results.marked += shiftMarked;
    results.skipped += shiftSkipped;
    results.shiftsProcessed.push({
      name: shift.name,
      shift: shift.shift,
      startTime: effectiveStartTime,
      gracePeriodMinutes: shift.gracePeriodMinutes || 30,
      students: students.length,
      marked: shiftMarked,
      skipped: shiftSkipped,
    });

    console.log(
      `[attendance][absences] Shift ${shift.name}: ${shiftMarked} absent, ${shiftSkipped} already had entry (${students.length} total students)`
    );
  }

  console.log(
    `[attendance][absences] Total for ${results.date}: ${results.marked} marked, ${results.skipped} skipped`
  );

  return results;
};

// Chequeo de salida: para cada turno activo, marca `exit_missing: true` en el
// entry log de los alumnos que SÍ entraron pero NO salieron (sin exit log del
// día). Manda push al tutor informando "sin salida". Se llama desde el cron
// a `shift.endTime + gracia` (o `special_exit_time + gracia`).
// El flag se limpia automáticamente cuando el alumno registra exit (incluso
// tarde), en registerAttendanceEvent.
//
// Retorna { flagged, skipped, date, shiftsProcessed }.
const runExitCheckForSchool = async (schoolId, schoolYearId, targetDate) => {
  const date = targetDate || new Date();
  const localDate = toLocalDate(date);
  const endOfDay = new Date(localDate.getTime() + 24 * 60 * 60 * 1000);

  // 1. Verificar si es día escolar (los días no lectivos no necesitan chequeo).
  const dayCheck = await isSchoolDay(schoolId, schoolYearId, localDate);
  if (!dayCheck.isSchoolDay) {
    return {
      flagged: 0,
      skipped: 0,
      date: localDate.toISOString().slice(0, 10),
      reason: dayCheck.reason,
      shiftsProcessed: [],
    };
  }

  // 2. Buscar turnos activos
  const shifts = await SchoolShift.find({
    school: schoolId,
    school_year_id: schoolYearId,
    isActive: true,
  })
    .select("shift startTime endTime gracePeriodMinutes name")
    .lean();

  const results = {
    flagged: 0,
    skipped: 0,
    date: localDate.toISOString().slice(0, 10),
    shiftsProcessed: [],
  };

  // Override de salida si el día tiene special_exit_time.
  const effectiveExitOverride = dayCheck.special_exit_time || null;
  if (effectiveExitOverride) {
    console.log(
      `[attendance][exit-check] Day ${results.date} uses special_exit_time=${effectiveExitOverride}`
    );
  }

  for (const shift of shifts) {
    const effectiveExitTime = effectiveExitOverride || shift.endTime;

    // 3. Buscar grupos del turno
    const groups = await Group.find({
      school: schoolId,
      school_year_id: schoolYearId,
      shift: shift.shift,
      isActive: true,
      type: "regular",
    })
      .select("_id")
      .lean();

    if (groups.length === 0) continue;

    const groupIds = groups.map((g) => g._id);

    // 4. Alumnos activos en estos grupos
    const students = await Student.find({
      current_group_id: { $in: groupIds },
      status: "active",
    })
      .select("_id school current_group_id")
      .lean();

    let shiftFlagged = 0;
    let shiftSkipped = 0;

    for (const student of students) {
      // 5. ¿Tiene entry hoy?
      const entryLog = await AttendanceLog.findOne({
        student_id: student._id,
        event_type: "entry",
        event_time: { $gte: localDate, $lt: endOfDay },
      }).select("_id status notification_sent");

      if (!entryLog) {
        // Sin entry: el alumno no estuvo, ya se marcó ausente o no aplica.
        shiftSkipped++;
        continue;
      }

      // Ya marcado como ausente: el absent log NO debería contar como
      // "estuvo en la escuela". Saltamos.
      if (entryLog.status === "absent") {
        shiftSkipped++;
        continue;
      }

      // 6. ¿Tiene exit hoy?
      const exitLog = await AttendanceLog.findOne({
        student_id: student._id,
        event_type: "exit",
        event_time: { $gte: localDate, $lt: endOfDay },
      }).select("_id");

      if (exitLog) {
        shiftSkipped++;
        continue;
      }

      // 7. Marcar exit_missing en el entry log y notificar al tutor.
      const updated = await AttendanceLog.findOneAndUpdate(
        { _id: entryLog._id },
        { $set: { exit_missing: true, exit_missing_at: new Date() } },
        { new: true }
      );

      if (updated) {
        dispatchMissingExitNotificationInBackground(student, updated);
        shiftFlagged++;
      }
    }

    results.flagged += shiftFlagged;
    results.skipped += shiftSkipped;
    results.shiftsProcessed.push({
      name: shift.name,
      shift: shift.shift,
      endTime: effectiveExitTime,
      gracePeriodMinutes: shift.gracePeriodMinutes || 30,
      students: students.length,
      flagged: shiftFlagged,
      skipped: shiftSkipped,
    });

    console.log(
      `[attendance][exit-check] Shift ${shift.name}: ${shiftFlagged} flagged, ${shiftSkipped} skipped (${students.length} total students)`
    );
  }

  console.log(
    `[attendance][exit-check] Total for ${results.date}: ${results.flagged} flagged, ${results.skipped} skipped`
  );

  return results;
};

module.exports = {
  determineNextType,
  findRecentDuplicate,
  invalidateGuardianCaches,
  dispatchNotificationInBackground,
  dispatchAbsenceNotificationInBackground,
  dispatchMissingExitNotificationInBackground,
  registerAttendanceEvent,
  registerAbsence,
  computeEntryStatus,
  isSchoolDay,
  isAfterGracePeriod,
  resolveLateArrival,
  markAbsencesForSchool,
  runExitCheckForSchool,
  toMinutes,
  toLocalDate,
};
