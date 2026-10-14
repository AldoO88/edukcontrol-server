// Punto de entrada del servidor.
// Levanta el listener HTTP, registra los manejadores de señales
// (SIGTERM, SIGINT, uncaughtException) y gestiona el cierre limpio.

// ---------------------------------------------------------------------
// Zona horaria del proceso — ANTES de cualquier require.
// Prácticamente todo el código está escrito asumiendo que el servidor corre
// en la zona de la escuela (es como funciona en dev local): `setHours(0,0,0,0)`
// para rangos "día de asistencia", `new Date().getDay()` para weekday de
// horarios, `new Date(y,m,d)`, fallbacks de parseo de fechas del dispositivo,
// y el `timeZone` por defecto del cron si falta CRON_TZ. En Render el
// contenedor es UTC: los dashboards contaban el día desde las 18:00 h local,
// `isToday` cambiaba de día tras las 18:00, etc.
//
// Fijar TZ aquí hace que producción se comporte EXACTAMENTE igual que dev.
// Un TZ explícito definido en el entorno se respeta (no se pisa).
//
// Ojo: `utils/school-time.js` es INMUNE a este valor (formatea con offset
// explícito + `timeZone: "UTC"`) — es defensa en profundidad: los strings
// que viajan en pushes/campanita salen bien aunque alguien cambie el TZ.
// ---------------------------------------------------------------------
if (!process.env.TZ) {
  process.env.TZ = "America/Mexico_City";
  // Log visible en Render: confirma en consola que prod corre en hora escolar.
  console.log(`[tz] TZ no definido en el entorno → fijando ${process.env.TZ}`);
}

const app = require("./app"); // Instancia de Express ya configurada
const { startAbsenceCron, stopAbsenceCron } = require("./config/cron");
const { startCitationNoShowCron, stopCitationNoShowCron } = require("./config/cron-citations");

const PORT = process.env.PORT || 5005;

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  startAbsenceCron();
  startCitationNoShowCron();
});

// Cierre limpio: dejar de aceptar conexiones, cerrar pool de Mongo, salir.
const shutdown = (signal) => {
  console.log(`\n${signal} received. Closing server gracefully...`);
  stopAbsenceCron();
  stopCitationNoShowCron();
  server.close(async () => {
    try {
      const mongoose = require("mongoose");
      await mongoose.connection.close();
      console.log("MongoDB connection closed.");
      process.exit(0);
    } catch (err) {
      console.error(`Error during shutdown: ${err.message}`);
      process.exit(1);
    }
  });
  // Timeout duro de respaldo: si el cierre limpio tarda demasiado, forzar
  setTimeout(() => {
    console.error("Forcing shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Capturar excepciones síncronas no manejadas
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  shutdown("uncaughtException");
});

// Capturar rechazos de promesas no manejados (solo se loggean, no se cierra)
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
