// Controlador de Asistencia
// Maneja los eventos de dispositivos (RFID/cámaras) y la consulta de historial.
// Las queries se filtran por la escuela del usuario autenticado.
// El endpoint /device-trigger usa la API key del dispositivo (no JWT),
// por lo que ahí se identifica la escuela a partir del estudiante.
const mongoose = require("mongoose");
const Student = require("../models/Student.model");
const AttendanceLog = require("../models/AttendanceLog.model");
const SchoolYear = require("../models/SchoolYear.model");
const attendanceService = require("../services/attendance.service");
const notificationService = require("../services/notification.service");
// tenantFilter centralizado (utils/school-scope.js): devuelve
// { school: ObjectId } (casteado — el aggregation pipeline NO castea
// strings, bug prod 2026-10-16) y soporta ?school=<oid> para que el
// super_admin de la web acote a una escuela. Reemplaza al local que
// ignoraba el param (super_admin consultaba TODAS las escuelas).
const { tenantFilter } = require("../utils/school-scope");

// Mapea el device_type que manda el lector al verificationMode del log.
// Los lectores faciales propios se identifican con "face"/"facial"/"camera";
// cualquier otro valor (o ninguno) se trata como lectura de tarjeta.
const FACE_DEVICE_TYPES = new Set(["face", "facial", "camera", "zkteco"]);
const resolveVerificationMode = (deviceType) =>
  FACE_DEVICE_TYPES.has(String(deviceType || "").toLowerCase())
    ? "FACE"
    : "RFID";

// POST /api/attendance/device-trigger
// Auth: API key del dispositivo (no JWT). No hay req.payload, pero el school
// se puede obtener del estudiante (ya validado que pertenezca a una escuela activa).
const deviceTriggerController = async (req, res, next) => {
  try {
    const {
      identifier,
      device_type,
      device_id,
      event_time,
      snapshot_url,
      status: manualStatus,
      student_id: manualStudentId,
    } = req.body;

    // === Modo ausencia manual ===
    // Si se envía status: "absent", se crea un log de ausencia sin buscar
    // el student por identifier (se usa student_id del body directamente).
    if (manualStatus === "absent") {
      if (!manualStudentId || !mongoose.Types.ObjectId.isValid(manualStudentId)) {
        return res
          .status(400)
          .json({ message: "student_id is required when status is 'absent'." });
      }
      const student = await Student.findOne({
        _id: manualStudentId,
        status: "active",
      }).select("_id school controlNumber first_name last_name");
      if (!student) {
        return res
          .status(404)
          .json({ message: `No active student with id '${manualStudentId}'.` });
      }
      if (!student.school) {
        return res
          .status(500)
          .json({ message: "Student has no school assigned. Contact support." });
      }

      const eventTimeDate = event_time ? new Date(event_time) : new Date();
      if (event_time && Number.isNaN(eventTimeDate.getTime())) {
        return res
          .status(400)
          .json({ message: "event_time is not a valid ISO 8601 date." });
      }

      const log = await attendanceService.registerAbsence({
        student,
        eventTime: eventTimeDate,
      });

      return res.status(201).json({
        log,
        student: {
          _id: student._id,
          controlNumber: student.controlNumber,
          first_name: student.first_name,
          last_name: student.last_name,
        },
        event_type: "entry",
        status: "absent",
        duplicate: false,
      });
    }

    // === Modo normal (dispositivo RFID/facial) ===
    const identifierUpper = String(identifier).toUpperCase().trim();
    // El biometricId se compara SIN uppercase: es el User ID literal de la
    // terminal facial (puede llevar ceros a la izquierda y no se normaliza).
    const identifierRaw = String(identifier).trim();

    const student = await Student.findOne({
      $or: [
        { rfid_card: identifierUpper },
        { biometricId: identifierRaw },
        { controlNumber: identifierUpper },
      ],
      status: "active",
    });

    if (!student) {
      return res
        .status(404)
        .json({ message: `No active student found for identifier '${identifier}'.` });
    }

    // El student DEBE tener school (validación a nivel de modelo).
    // Si por algún motivo no lo tiene, rechazar para no crear logs huérfanos.
    if (!student.school) {
      return res
        .status(500)
        .json({ message: "Student has no school assigned. Contact support." });
    }

    const eventTimeDate = event_time ? new Date(event_time) : new Date();
    if (event_time && Number.isNaN(eventTimeDate.getTime())) {
      return res
        .status(400)
        .json({ message: "event_time is not a valid ISO 8601 date." });
    }

    const deviceLabel = `${device_type || "unknown"}@${device_id}`;

    // La creación del log, la invalidación de cache y la notificación en
    // segundo plano viven en el servicio (compartido con el push ADMS).
    const { log, eventType, duplicate } =
      await attendanceService.registerAttendanceEvent({
        student,
        eventTime: eventTimeDate,
        device: deviceLabel,
        verificationMode: resolveVerificationMode(device_type),
        snapshotUrl: snapshot_url || null,
      });

    res.status(duplicate ? 200 : 201).json({
      log,
      student: {
        _id: student._id,
        controlNumber: student.controlNumber,
        first_name: student.first_name,
        last_name: student.last_name,
      },
      event_type: eventType,
      duplicate,
      notification_queued: !duplicate,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/attendance/logs
// Consulta del historial. Auth: JWT. Filtra por la escuela del usuario (super_admin ve todas).
// Soporta filtro por group_id (primero busca student_ids del grupo).
const getAttendanceLogsController = async (req, res, next) => {
  try {
    const { student_id, group_id, from, to, event_type, status, exit_missing, page = 1, limit = 50 } =
      req.query;

    const filter = { ...tenantFilter(req) };

    // Si se pide filter por grupo, buscar los student_ids de ese grupo primero
    if (group_id) {
      if (!mongoose.Types.ObjectId.isValid(group_id)) {
        return res.status(400).json({ message: "Invalid group_id." });
      }
      const groupStudents = await Student.find({
        current_group_id: group_id,
        ...tenantFilter(req),
      }).select("_id");
      const studentIds = groupStudents.map((s) => s._id);
      if (studentIds.length === 0) {
        return res.status(200).json({ items: [], total: 0, page: 1, limit: limitNum, pages: 1 });
      }
      filter.student_id = { $in: studentIds };
    }

    if (student_id) {
      if (!mongoose.Types.ObjectId.isValid(student_id)) {
        return res.status(400).json({ message: "Invalid student_id." });
      }
      filter.student_id = student_id;
    }

    if (event_type && ["entry", "exit"].includes(event_type)) {
      filter.event_type = event_type;
    }

    if (status && ["on_time", "late", "absent"].includes(status)) {
      filter.status = status;
    }

    // exit_missing=true → solo entry logs de alumnos que NO registraron salida
    // (marcados por el cron a shift.endTime + gracia). Combinable con from/to
    // para acotar al día o semana en cuestión.
    if (exit_missing === "true") {
      filter.exit_missing = true;
      filter.event_type = "entry";
    }

    if (from || to) {
      filter.event_time = {};
      if (from) {
        const fromDate = new Date(from);
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({ message: "from is not a valid date." });
        }
        filter.event_time.$gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({ message: "to is not a valid date." });
        }
        filter.event_time.$lte = toDate;
      }
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      AttendanceLog.find(filter)
        .populate("student_id", "controlNumber first_name last_name current_group_id")
        .sort({ event_time: -1 })
        .skip(skip)
        .limit(limitNum),
      AttendanceLog.countDocuments(filter),
    ]);

    res.status(200).json({
      items,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum) || 1,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/attendance/manual-override
// Override manual de asistencia por personal de la escuela.
// Auth: JWT + admin/registrar/prefect/super_admin.
// Crea un AttendanceLog con verificationMode: "MANUAL" si no existe uno
// para ese estudiante en esa fecha, o actualiza el status si ya existe.
const manualOverrideController = async (req, res, next) => {
  try {
    const { student_id, date, status, notes } = req.body;

    // Validar student_id
    if (!student_id || !mongoose.Types.ObjectId.isValid(student_id)) {
      return res.status(400).json({ message: "student_id is required and must be valid." });
    }

    // Validar date
    if (!date) {
      return res.status(400).json({ message: "date is required (YYYY-MM-DD)." });
    }
    const targetDate = new Date(date);
    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ message: "date is not a valid date." });
    }

    // Validar status
    if (!status || status !== "present") {
      return res.status(400).json({ message: "status must be 'present'." });
    }

    // Buscar el estudiante (debe pertenecer a la misma escuela)
    const student = await Student.findOne({
      _id: student_id,
      status: "active",
      ...tenantFilter(req),
    }).select("_id school controlNumber first_name last_name");
    if (!student) {
      return res.status(404).json({ message: `No active student with id '${student_id}' in your school.` });
    }

    // Calcular inicio y fin del día en UTC
    const dayStart = new Date(targetDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setUTCHours(23, 59, 59, 999);

    // Buscar si ya existe un log de entrada para este estudiante en esta fecha
    const existingLog = await AttendanceLog.findOne({
      school: student.school,
      student_id: student._id,
      event_type: "entry",
      event_time: { $gte: dayStart, $lte: dayEnd },
    });

    if (existingLog) {
      // Actualizar el status existente
      existingLog.status = "on_time";
      existingLog.verificationMode = "MANUAL";
      if (notes) {
        existingLog.justified = true;
        existingLog.justified_reason = notes;
        existingLog.justified_at = new Date();
      }
      await existingLog.save();

      // Notificar al tutor que el alumno ingresó
      try {
        const populatedLog = await AttendanceLog.findById(existingLog._id).lean();
        notificationService.sendAttendanceNotification(student, populatedLog);
      } catch (notifErr) {
        console.error("Error sending manual override notification:", notifErr.message);
      }

      return res.status(200).json({
        success: true,
        action: "updated",
        log: existingLog,
        student: {
          _id: student._id,
          controlNumber: student.controlNumber,
          first_name: student.first_name,
          last_name: student.last_name,
        },
      });
    }

    // Crear nuevo log de entrada manual
    const newLog = await AttendanceLog.create({
      school: student.school,
      student_id: student._id,
      event_time: targetDate,
      event_type: "entry",
      device: "manual@prefect",
      verificationMode: "MANUAL",
      status: "on_time",
      justified: !!notes,
      justified_reason: notes || null,
      justified_at: notes ? new Date() : null,
    });

    // Notificar al tutor que el alumno ingresó
    try {
      const populatedLog = await AttendanceLog.findById(newLog._id).lean();
      notificationService.sendAttendanceNotification(student, populatedLog);
    } catch (notifErr) {
      console.error("Error sending manual override notification:", notifErr.message);
    }

    return res.status(201).json({
      success: true,
      action: "created",
      log: newLog,
      student: {
        _id: student._id,
        controlNumber: student.controlNumber,
        first_name: student.first_name,
        last_name: student.last_name,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/attendance/daily-history
// ---------------------------------------------------------------------
// Historial de asistencia AGREGADO por día calendario (UTC) para el
// monitoreo del panel web (super_admin / admin de escuela). Un renglón
// por día con alumnos ÚNICOS por status (mismo criterio que
// utils/school-day-attendance.js — un alumno edge con 2 docs cuenta 1
// vez por status, no se sobre-cuenta).
//
// Convención de día (utils/school-time.js): se agrupa por la fecha
// UTC de event_time. Ese día calendario cubre las DOS convenciones de
// almacenamiento del backend: taps reales (instante UTC, 07:00-14:30
// CST → 13:00-20:30Z) y ausencias del cron (wall-clock forzado a UTC,
// cutoff 07:30 → 07:30Z del mismo día).
//
// Query params:
//   school=<oid>        OBLIGATORIO para super_admin (tenantFilter lo
//                       exige vía ?school=, igual que el resto de
//                       endpoints tenant-scoped). El admin de escuela
//                       sale del JWT.
//   from, to            Rango calendario YYYY-MM-DD (UTC). Default:
//                       últimos 30 días (to = hoy). Máx 366 días.
//   school_year_id      Opcional: si viene y falta `from`, el rango
//                       arranca en el startDate del ciclo (hasta hoy).
//
// Respuesta: { from, to, totalStudents, days: [{ date, on_time, late,
//              absent, present, total }] } — present = on_time + late;
// total = present + absent. Orden date desc. totalStudents = matrícula
// activa (MISMA query que los dashboards móviles: school + status
// active) — la web calcula el % como present/totalStudents para que el
// número responda "¿cuántos de los matriculados vinieron?".
const getDailyHistoryController = async (req, res, next) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant.school) {
      return res.status(400).json({
        message: "school query param is required (super_admin must scope with ?school=).",
      });
    }

    const { from, to, school_year_id } = req.query;

    // 'to' default = hoy; 'from' default = hoy − 29 días, ampliable al
    // inicio del ciclo si se pasa school_year_id sin from.
    const today = new Date();
    const toStr = to || today.toISOString().slice(0, 10);
    let fromStr = from;
    if (!fromStr && school_year_id && mongoose.Types.ObjectId.isValid(String(school_year_id))) {
      const year = await SchoolYear.findById(String(school_year_id)).select("startDate").lean();
      if (year?.startDate) {
        fromStr = new Date(year.startDate).toISOString().slice(0, 10);
      }
    }
    if (!fromStr) {
      fromStr = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }

    // Rango UTC [from 00:00Z, to+1d 00:00Z) — el to es inclusivo en
    // día calendario, hence +1 día exclusivo.
    const fromUtc = new Date(`${fromStr}T00:00:00.000Z`);
    const toUtcExclusive = new Date(`${toStr}T00:00:00.000Z`);
    toUtcExclusive.setUTCDate(toUtcExclusive.getUTCDate() + 1);
    if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtcExclusive.getTime())) {
      return res.status(400).json({ message: "from/to must be YYYY-MM-DD." });
    }
    if (toUtcExclusive <= fromUtc) {
      return res.status(400).json({ message: "from must be <= to." });
    }
    if (toUtcExclusive - fromUtc > 367 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ message: "Range too large (max 366 days)." });
    }

    const [days, totalStudents] = await Promise.all([
      AttendanceLog.aggregate([
      {
        $match: {
          school: tenant.school,
          event_type: "entry",
          status: { $in: ["on_time", "late", "absent"] },
          event_time: { $gte: fromUtc, $lt: toUtcExclusive },
        },
      },
      // Alumnos únicos por (día, status): primero colapsa (día, status,
      // alumno) y luego cuenta, así un doc doble edge no sobre-cuenta.
      { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$event_time" } }, status: "$status", student: "$student_id" } } },
      { $group: { _id: { date: "$_id.date", status: "$_id.status" }, n: { $sum: 1 } } },
      {
        $group: {
          _id: "$_id.date",
          on_time: { $sum: { $cond: [{ $eq: ["$_id.status", "on_time"] }, "$n", 0] } },
          late: { $sum: { $cond: [{ $eq: ["$_id.status", "late"] }, "$n", 0] } },
          absent: { $sum: { $cond: [{ $eq: ["$_id.status", "absent"] }, "$n", 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          on_time: 1,
          late: 1,
          absent: 1,
          present: { $add: ["$on_time", "$late"] },
          total: { $add: ["$on_time", "$late", "$absent"] },
        },
      },
      { $sort: { date: -1 } },
      ]),
      // Matrícula activa — MISMA query que los dashboards móviles
      // (prefect/director/social-worker: school + status active) para
      // que el % de la web concuerde con el "Alumnos" de la app.
      Student.countDocuments({ ...tenant, status: "active" }),
    ]);

    res.status(200).json({ from: fromStr, to: toStr, totalStudents, days });
  } catch (error) {
    next(error);
  }
};

// GET /api/attendance/day-detail
// ---------------------------------------------------------------------
// Detalle de asistencia de UN día — un renglón por alumno activo. Lo
// consume la pantalla de monitoreo web al hacer click en un renglón del
// historial diario: trae foto (photoUrl Cloudinary), nombre, # control,
// grupo, hora de entrada, hora de salida y estatus por alumno.
//
// Query params:
//   school=<oid>   OBLIGATORIO para super_admin (tenantFilter lo exige
//                  vía ?school=, igual que daily-history).
//   date=YYYY-MM-DD  Día calendario UTC (misma convención documentada
//                  en utils/school-time.js: taps reales 13:00-20:30Z y
//                  ausencias del cron 07:30Z caen en el mismo día).
//
// Lógica (merge en JS — máximo ~500 alumnos, trivial):
//   1. Logs del día (entry + exit) ordenados por event_time: el primer
//      entry por alumno gana (el tap real; los absent del cron TAMBIÉN
//      son event_type entry, con hora wall-clock del cutoff) y el
//      primer exit idem.
//   2. Alumnos activos de la escuela (MISMA matrícula que
//      daily-history y los dashboards: school + status active) con el
//      grupo poblado.
//   3. Merge: estatus desde el log de entrada (on_time → present,
//      late → late, absent → absent + flag justified). Sin log de
//      entrada → "no_record": NO se miente con "falta" en días donde
//      el cron no corrió (fin de semana, paro, etc.).
//
// Respuesta: { date, summary: { present, late, absent, no_record },
//              students: [{ student, group, entry_time, exit_time,
//                           status, justified }] }.
// Orden: faltas primero, luego grupo y apellido — en monitoreo lo
// interesante está arriba.
const getDayDetailController = async (req, res, next) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant.school) {
      return res.status(400).json({
        message: "school query param is required (super_admin must scope with ?school=).",
      });
    }

    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ message: "date is required and must be YYYY-MM-DD." });
    }

    // Rango UTC del día: [00:00Z, +1d 00:00Z).
    const dayUtc = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(dayUtc.getTime())) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD." });
    }
    const nextDayUtc = new Date(dayUtc);
    nextDayUtc.setUTCDate(nextDayUtc.getUTCDate() + 1);

    const [logs, students] = await Promise.all([
      // Logs del día: entry (tap real o marcación del cron) + exit.
      // sort event_time asc → el primero de cada tipo por alumno gana.
      AttendanceLog.find({
        school: tenant.school,
        event_type: { $in: ["entry", "exit"] },
        event_time: { $gte: dayUtc, $lt: nextDayUtc },
      })
        .sort({ event_time: 1 })
        .lean(),
      // Matrícula activa — MISMA query que daily-history / dashboards
      // móviles para que los números concuerden en todas las pantallas.
      Student.find({ ...tenant, status: "active" })
        .select("controlNumber first_name last_name photoUrl current_group_id")
        .populate("current_group_id", "grade section type")
        .lean(),
    ]);

    // Mapas por alumno: primer entry y primer exit del día.
    const entryByStudent = new Map();
    const exitByStudent = new Map();
    for (const log of logs) {
      const sid = String(log.student_id);
      if (log.event_type === "entry") {
        if (!entryByStudent.has(sid)) entryByStudent.set(sid, log);
      } else if (!exitByStudent.has(sid)) {
        exitByStudent.set(sid, log);
      }
    }

    // Merge: un renglón por alumno activo.
    const studentsRows = students.map((s) => {
      const entry = entryByStudent.get(String(s._id)) || null;
      const exit = exitByStudent.get(String(s._id)) || null;

      let status = "no_record";
      let justified = false;
      if (entry) {
        if (entry.status === "on_time") status = "present";
        else if (entry.status === "late") status = "late";
        else if (entry.status === "absent") {
          status = "absent";
          justified = Boolean(entry.justified);
        }
      }

      const g = s.current_group_id; // poblado (grade, section, type) o null
      return {
        student: {
          id: String(s._id),
          controlNumber: s.controlNumber || null,
          first_name: s.first_name,
          last_name: s.last_name,
          photoUrl: s.photoUrl || null,
        },
        group: g ? { id: String(g._id), label: `${g.grade}° ${g.section}`, type: g.type } : null,
        // entry_time solo si hubo TAP (un absent del cron no es hora
        // de entrada — su event_time es el cutoff wall-clock).
        entry_time: entry && entry.status !== "absent" ? entry.event_time : null,
        exit_time: exit ? exit.event_time : null,
        status,
        justified,
      };
    });

    // Orden: faltas primero, luego grupo (grado/sección) y apellido.
    const STATUS_ORDER = { absent: 0, late: 1, present: 2, no_record: 3 };
    studentsRows.sort((a, b) => {
      const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (byStatus !== 0) return byStatus;
      const ag = a.group ? a.group.label : "zz";
      const bg = b.group ? b.group.label : "zz";
      if (ag !== bg) return ag < bg ? -1 : 1; // "1° A" < "3° C" (grados 1-3)
      const al = `${a.student.last_name} ${a.student.first_name}`.toLowerCase();
      const bl = `${b.student.last_name} ${b.student.first_name}`.toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : 0;
    });

    const summary = { present: 0, late: 0, absent: 0, no_record: 0 };
    for (const r of studentsRows) summary[r.status] += 1;

    res.status(200).json({ date, summary, students: studentsRows });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  deviceTriggerController,
  getAttendanceLogsController,
  getDailyHistoryController,
  getDayDetailController,
  manualOverrideController,
};
