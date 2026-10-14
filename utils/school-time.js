// utils/school-time.js
// ---------------------------------------------------------------------
// Formateo de horas/fechas INDEPENDIENTE del timezone del servidor.
//
// Problema que resuelve (bug 2026-10-14): en producción (Render, contenedor
// UTC) cualquier `toLocaleTimeString`/`toLocaleDateString`/`toLocaleString`
// sin `timeZone` explícito imprime la hora UTC. Ej.: un tap real a las
// 07:23 de la mañana (guardado como `13:23Z`) se mostraba como "01:23 PM"
// en los pushes de ENTRADA/SALIDA (+6h). En dev local (máquina en México)
// "funcionaba" porque el TZ del proceso sí era el de la escuela, por eso
// el bug solo se veía en prod.
//
// REGLA DEL PROYECTO: en este backend NUNCA se formatea una fecha con
// `toLocale*` "pelado". Siempre pasar por helpers de este módulo.
//
// Hay DOS convenciones de almacenamiento en este código (revisado el
// 2026-10-14, ver AGENTS.md → "Timezone correctness"):
//
//   1. "Instante UTC real" — fecha/hora real con offset correcto:
//        - `AttendanceLog.event_time` de taps de dispositivo (la terminal
//          manda ISO con offset `-06:00` y se guarda como UTC exacto).
//        - `AttendanceLog.event_time` de ausencias MANUALES (default
//          `new Date()` del servidor o ISO con offset del cliente).
//        → Para mostrar: `formatSchoolTime` / `formatSchoolDate` (aplican
//          el offset de la escuela y leen el resultado como UTC).
//
//   2. "Hora pared forzada a UTC" (wall-clock) — el valor guardado ya ES
//      la hora local de la escuela, interpretada como si fuera UTC:
//        - `AttendanceLog.event_time` de ausencias del CRON
//          (`markAbsencesForSchool` hace `setUTCHours(cutoff)` sobre la
//          medianoche local → 07:30 guardado como `07:30Z`, no `13:30Z`).
//        → Para mostrar: `formatWallClockTime` / `formatWallClockDateTime`
//          (NO aplican offset; leen los componentes getUTC* como hora
//          pared). Aplicarles offset les RESTARÍA 6h y rompería lo que
//          hoy se muestra bien en prod.
//      NOTA (2026-10-14): `Citation.scheduledDate` ANTES estaba en esta
//      convención; se migró a instante UTC real (backfill + shim en
//      citations.controller#parseScheduledDate) — ver AGENTS.md.
//
// Nota sobre DST: México abolió el horario de verano en 2022, así que el
// offset fijo de `ADMS_TZ_OFFSET_MINUTES` es estable. Si un día se reintroduce
// DST, hay que migrar a `Intl.DateTimeFormat({ timeZone: CRON_TZ })`.
// ---------------------------------------------------------------------

// Offset (en minutos) entre la hora pared de la escuela y UTC.
// Se lee SIEMPRE en cada llamada (no al cargar el módulo) para que scripts
// y pruebas puedan cambiar el env sin reiniciar el proceso.
// Default -360 (México central, UTC-6) — misma convención que usan los
// scripts/ del repo (`smoke-*`, `clear-attendance-day`, etc.).
const getSchoolOffsetMinutes = () => {
  const raw = process.env.ADMS_TZ_OFFSET_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return -360;
  }
  const parsed = parseInt(String(raw).trim(), 10);
  return Number.isNaN(parsed) ? -360 : parsed;
};

// Corre un instante UTC real al "reloj de pared" de la escuela.
// El resultado DEBE leerse con getters `getUTC*` o formatearse con
// `timeZone: "UTC"` — usar `getHours()`/`getDate()` mezclaría el TZ del
// servidor y volvería a introducir el bug original.
const toSchoolDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + getSchoolOffsetMinutes() * 60000);
};

// Formatea la HORA de un instante UTC real en la hora de la escuela.
//   formatSchoolTime("2026-10-14T13:23:00Z", "en-US", { hour: "2-digit", minute: "2-digit" })
//   → "07:23 AM" (con ADMS_TZ_OFFSET_MINUTES=-360), sin importar el TZ
//     del servidor.
// `locale` y `opts` se pasan tal cual a `toLocaleTimeString`.
const formatSchoolTime = (value, locale, opts) =>
  toSchoolDate(value).toLocaleTimeString(locale, {
    ...opts,
    timeZone: "UTC", // se impone SIEMPRE: el corrimiento ya dejó la hora escolar en los getUTC*
  });

// Igual que `formatSchoolTime` pero para la fecha completa (día/mes/weekday).
//   formatSchoolDate(new Date(), "es-MX", { weekday: "long", day: "numeric", month: "long" })
const formatSchoolDate = (value, locale, opts) =>
  toSchoolDate(value).toLocaleDateString(locale, {
    ...opts,
    timeZone: "UTC",
  });

// Igual que `formatSchoolTime` pero con fecha y hora en un solo string
// (p. ej. cuerpo del push de citatorio: "mié, 15 oct, 10:00 a. m.").
//   formatSchoolDateTime("2026-10-15T16:00:00Z", "es-MX",
//     { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
//   → "mié, 15 oct, 10:00 a. m."  (con ADMS_TZ_OFFSET_MINUTES=-360)
const formatSchoolDateTime = (value, locale, opts) =>
  toSchoolDate(value).toLocaleString(locale, {
    ...opts,
    timeZone: "UTC",
  });

// Formatea la HORA de un valor guardado como "hora pared forzada a UTC"
// (convención 2: solo ausencias del cron — el scheduledDate de citatorios
// se migró a instante real en 2026-10-14 y usa formatSchool*).
// NO aplica offset: los componentes getUTC* del valor YA son la hora local.
// Siempre con `timeZone: "UTC"` para que el resultado sea idéntico en dev
// (máquina en México) y en prod (contenedor UTC).
//   formatWallClockTime("2026-10-14T07:30:00Z", "en-US", { hour: "2-digit", minute: "2-digit" })
//   → "07:30 AM"
const formatWallClockTime = (value, locale, opts) =>
  new Date(value).toLocaleTimeString(locale, {
    ...opts,
    timeZone: "UTC",
  });

// Igual que `formatWallClockTime` pero con fecha y hora en un solo string
// (cuerpos de pushes de citatorios, historial día-a-día del tutor).
//   formatWallClockDateTime("2026-10-15T10:00:00Z", "es-MX",
//     { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
//   → "mié, 15 oct, 10:00 a. m."
const formatWallClockDateTime = (value, locale, opts) =>
  new Date(value).toLocaleString(locale, {
    ...opts,
    timeZone: "UTC",
  });

module.exports = {
  getSchoolOffsetMinutes,
  toSchoolDate,
  formatSchoolTime,
  formatSchoolDate,
  formatSchoolDateTime,
  formatWallClockTime,
  formatWallClockDateTime,
};
