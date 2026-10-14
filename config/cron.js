// Configuración del cronjob de auto-ausencias (Nivel 3 — dinámico por turno)
// Cada 5 minutos verifica si ya se cumplió el cutoff de CADA turno
// (startTime + gracePeriodMinutes) y marca ausencias solo una vez por turno al día.
//
// Después del marcado de ausencias, también ejecuta el chequeo de SALIDAS:
// si ya se cumplió el cutoff de salida (shift.endTime + gracia, o
// special_exit_time + gracia en días con horario especial) y todavía no se
// ejecutó hoy para ese turno (`exitCheckedAt`), marca `exit_missing: true`
// en el entry log de cada alumno que SÍ entró pero NO salió, y manda push
// al tutor.
//
// Usa los campos `absenceMarkedAt` y `exitCheckedAt` en SchoolShift para no
// repetir: si alguno es de hoy, se salta. El server los resetea al iniciar.
//
// Cron schedule: "*/5 7-16 * * 1-5" → cada 5 min, L-V, 07:00-16:59
// Cubre:
//   - entrada matutina (cutoff típico ~07:35-08:15)
//   - corte de salida vespertino con gracia hasta 120 min: 14:30+120 = 16:30
//   - cualquier override special_schedule que mueva el cutoff de salida.
//
// Configuración:
//   - CRON_ABSENCE_ENABLED en .env (default: true)
//   - CRON_TZ en .env (RECOMENDADO: America/Mexico_City) — el cron usa esta
//     zona tanto para el schedule como para los cálculos de cutoff. Sin
//     CRON_TZ, el container (UTC) puede marcar faltas/deshoras.
const cron = require("node-cron");
const mongoose = require("mongoose");
const School = require("../models/School.model");
const SchoolShift = require("../models/SchoolShift.model");
const attendanceService = require("../services/attendance.service");

let scheduledTask = null;

// "HH:mm" → minutos desde medianoche
const toMinutes = (hhmm) => {
  if (typeof hhmm !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(hhmm))
    return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Resetea absenceMarkedAt y exitCheckedAt de AYER en todos los SchoolShifts
// activos. Se ejecuta una vez al iniciar el server para que el cron pueda
// marcar hoy.
const resetStaleMarkers = async () => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setUTCHours(23, 59, 59, 999);

    const absResult = await SchoolShift.updateMany(
      { absenceMarkedAt: { $lte: yesterday } },
      { $set: { absenceMarkedAt: null } }
    );
    if (absResult.modifiedCount > 0) {
      console.log(
        `[cron][absences] Reset ${absResult.modifiedCount} stale absenceMarkedAt marker(s).`
      );
    }

    const exitResult = await SchoolShift.updateMany(
      { exitCheckedAt: { $lte: yesterday } },
      { $set: { exitCheckedAt: null } }
    );
    if (exitResult.modifiedCount > 0) {
      console.log(
        `[cron][exit-check] Reset ${exitResult.modifiedCount} stale exitCheckedAt marker(s).`
      );
    }
  } catch (err) {
    console.error(`[cron][absences] Error resetting stale markers: ${err.message}`);
  }
};

// Devuelve los minutos desde medianoche ACTUALES en la zona horaria del
// cron (`CRON_TZ` si está definida, si no la del proceso — UTC en Render).
// Esto es lo que se compara contra `startTime + gracia` para decidir si ya
// se cumplió el cutoff. Sin este fix, en Render (UTC) `getHours()` daría
// hora UTC mientras que `startTime` está en hora local de la escuela — el
// cron podría marcar ausencias/deshoras.
const getCurrentMinutesInCronTz = () => {
  const now = new Date();
  const tz = process.env.CRON_TZ;
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
      }).formatToParts(now);
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
      const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
      return hour * 60 + minute;
    } catch (err) {
      console.warn(
        `[cron] Invalid CRON_TZ="${tz}", falling back to process local time: ${err.message}`
      );
    }
  }
  return now.getHours() * 60 + now.getMinutes();
};

// Verifica si la hora actual ya supera el cutoff de un turno específico.
// cutoff = startTime + gracePeriodMinutes (en minutos desde medianoche).
// Compara contra la hora actual en `CRON_TZ` (no hora UTC del servidor).
const hasCutoffBeenReached = (startTime, gracePeriodMinutes) => {
  const shiftMinutes = toMinutes(startTime);
  if (shiftMinutes === null) return false;

  const cutoffMinutes = shiftMinutes + (gracePeriodMinutes || 30);
  return getCurrentMinutesInCronTz() >= cutoffMinutes;
};

// Ejecuta el marcado de ausencias Y el chequeo de salidas para TODAS las
// escuelas activas. Para cada escuela, consulta sus SchoolShifts activos
// y aplica ambos pases con sus gates independientes:
//   - entry: ausenciaMarkedAt === hoy, cutoff = startTime + gracia
//   - exit:  exitCheckedAt === hoy,    cutoff = endTime + gracia
// Los dos pases tienen gates separados y se ejecutan en orden (entry primero,
// luego exit). Si un turno solo necesita uno de los dos, los gates
// individuales controlan.
const runAbsenceMarking = async () => {
  const startTime = Date.now();
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  console.log(`[cron] Starting attendance run for ${todayStr}...`);

  try {
    const schools = await School.find({ isActive: true })
      .select("name cct current_school_year_id")
      .lean();

    if (schools.length === 0) {
      console.log("[cron] No active schools found. Skipping.");
      return;
    }

    let totalMarked = 0;
    let totalSkipped = 0;
    let totalExitFlagged = 0;
    let totalExitSkipped = 0;

    for (const school of schools) {
      if (!school.current_school_year_id) {
        console.log(
          `[cron] School ${school.name || school._id}: no active school year, skipping.`
        );
        continue;
      }

      try {
        // Buscar turnos activos de esta escuela (incluye startTime, endTime,
        // gracePeriodMinutes, absenceMarkedAt, exitCheckedAt).
        const shifts = await SchoolShift.find({
          school: school._id,
          school_year_id: school.current_school_year_id,
          isActive: true,
        })
          .select(
            "shift startTime endTime gracePeriodMinutes name absenceMarkedAt exitCheckedAt"
          )
          .lean();

        for (const shift of shifts) {
          // ========== PASE 1: marcado de AUSENCIAS ==========
          const absenceAlreadyMarked =
            shift.absenceMarkedAt &&
            new Date(shift.absenceMarkedAt).toISOString().slice(0, 10) === todayStr;

          if (absenceAlreadyMarked) {
            console.log(
              `[cron][absences] ${school.name || school._id} / ${shift.name}: already marked today, skipping.`
            );
          } else if (
            !hasCutoffBeenReached(shift.startTime, shift.gracePeriodMinutes)
          ) {
            console.log(
              `[cron][absences] ${school.name || school._id} / ${shift.name}: entry cutoff not reached yet (${shift.startTime} + ${shift.gracePeriodMinutes || 30}min), skipping.`
            );
          } else {
            console.log(
              `[cron][absences] ${school.name || school._id} / ${shift.name}: marking absences...`
            );
            const result = await attendanceService.markAbsencesForSchool(
              school._id,
              school.current_school_year_id,
              undefined,
              shift._id
            );
            totalMarked += result.marked;
            totalSkipped += result.skipped;

            // Marcamos absenceMarkedAt aún si `marked=0` (no había alumnos
            // sin entry ese día), para no iterar la lógica cada 5 minutos.
            await SchoolShift.updateOne(
              { _id: shift._id },
              { $set: { absenceMarkedAt: new Date() } }
            );

            console.log(
              `[cron][absences] ${school.name || school._id} / ${shift.name}: ${result.marked} marked, ${result.skipped} skipped.`
            );
          }

          // ========== PASE 2: chequeo de SALIDAS ==========
          const exitAlreadyChecked =
            shift.exitCheckedAt &&
            new Date(shift.exitCheckedAt).toISOString().slice(0, 10) === todayStr;

          if (exitAlreadyChecked) {
            // Silencioso: el chequeo es idempotente y solo queremos logs la
            // primera vez.
          } else if (
            !hasCutoffBeenReached(shift.endTime, shift.gracePeriodMinutes)
          ) {
            // Todavía no llega la hora del chequeo; no logueamos para no
            // spammear cada 5 minutos.
          } else {
            console.log(
              `[cron][exit-check] ${school.name || school._id} / ${shift.name}: checking for missing exits...`
            );
            const result = await attendanceService.runExitCheckForSchool(
              school._id,
              school.current_school_year_id,
              undefined,
              shift._id
            );
            totalExitFlagged += result.flagged;
            totalExitSkipped += result.skipped;

            await SchoolShift.updateOne(
              { _id: shift._id },
              { $set: { exitCheckedAt: new Date() } }
            );

            console.log(
              `[cron][exit-check] ${school.name || school._id} / ${shift.name}: ${result.flagged} flagged, ${result.skipped} skipped.`
            );
          }
        }
      } catch (err) {
        console.error(
          `[cron] Error processing school ${school.name || school._id}: ${err.message}`
        );
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[cron] Run completed in ${elapsed}s. Absences: ${totalMarked} marked / ${totalSkipped} skipped. Exit checks: ${totalExitFlagged} flagged / ${totalExitSkipped} skipped. Schools: ${schools.length}.`
    );
  } catch (err) {
    console.error(`[cron] Fatal error: ${err.message}`);
  }
};

// Inicia el cronjob si está habilitado.
const startAbsenceCron = async () => {
  const enabled = process.env.CRON_ABSENCE_ENABLED !== "false"; // default: true

  if (!enabled) {
    console.log("[cron][absences] Disabled (CRON_ABSENCE_ENABLED=false).");
    return;
  }

  // Resetear markers stale al iniciar
  if (mongoose.connection.readyState === 1) {
    await resetStaleMarkers();
  } else {
    mongoose.connection.once("connected", async () => {
      console.log("[cron][absences] MongoDB connected. Resetting stale markers.");
      await resetStaleMarkers();
    });
  }

  // Cron: cada 5 minutos, L-V, 07:00-16:59
  // Cubre: cortes de entrada matutinos (~07:30+gracia) y el corte de salida
  // vespertino hasta ~14:30 + 120 min de gracia = 16:30. Si una escuela
  // tiene un turno vespertino más largo o quiere gracia > 120, ampliar el
  // rango o ajustar `gracePeriodMinutes.max`.
  const schedule = "*/5 7-16 * * 1-5";

  if (!cron.validate(schedule)) {
    console.error(
      `[cron][absences] Invalid cron schedule "${schedule}". Skipping.`
    );
    return;
  }

  // No arrancar si Mongo no está conectado
  if (mongoose.connection.readyState !== 1) {
    console.warn(
      "[cron][absences] MongoDB not connected. Deferring cron start..."
    );
    mongoose.connection.once("connected", () => {
      console.log("[cron][absences] MongoDB connected. Starting cron now.");
      _startTask(schedule);
    });
    return;
  }

  _startTask(schedule);
};

const _startTask = (schedule) => {
  scheduledTask = cron.schedule(schedule, runAbsenceMarking, {
    timezone: process.env.CRON_TZ || undefined,
  });
  console.log(
    `[cron][absences] Scheduled: "${schedule}" (tz: ${process.env.CRON_TZ || "server default"})`
  );
};

// Detiene el cronjob (útil para graceful shutdown).
const stopAbsenceCron = () => {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[cron][absences] Stopped.");
  }
};

module.exports = {
  startAbsenceCron,
  stopAbsenceCron,
  runAbsenceMarking,
};
