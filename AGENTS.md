# AGENTS.md — eduk-control-backend

Express + MongoDB backend for **EdukControl**, a multi-tenant SaaS for school attendance with biometric (RFID / facial) device triggers and Expo Push notifications to guardians and staff.

## Commands

- `npm run dev` — nodemon on `app.js` (default port 5000, override with `PORT`).
- `npm start` — `node server.js` for production.
- `npm run lint` — **no-op placeholder** (`echo "No linter configured yet"`). Do not treat its exit status as meaningful. No ESLint/Prettier is installed; there is no formatter configured.
- `node scripts/migrate-to-multitenant.js` — one-shot migration to assign existing data to a default school and sync unique compound indexes. **Make a DB backup first**.
- `node scripts/migrate-guardians-to-collection.js` — extracts embedded `Student.guardians` subdocs into the new `Guardian` collection. **Idempotent** (no-op if already migrated).
- `node scripts/migrate-logo-to-logoUrl.js` — renames the School `logo` field to `logoUrl`. **Idempotent** (no-op if already migrated).
- `DRY_RUN=1 node scripts/cleanup-orphan-cloudinary-assets.js` — logs what would be deleted without touching Cloudinary. Drop `DRY_RUN=1` to actually delete. Cleans up orphan assets and old versions in `edukcontrol/schools/<school_id>/`. Run periodically (cron).
- `node scripts/retry-pending-uploads.js` — processes the queue of uploads that failed all inline retries and were persisted to disk. Run periodically (cron every 5-15 min) or after a Cloudinary outage.
- `node scripts/cleanup-old-s3-uploads.js` — deletes S3 objects in `pending-uploads/` older than `S3_CLEANUP_MAX_AGE_DAYS` (default 30). Requires `PENDING_UPLOADS_BACKEND=s3`. Complements the S3 lifecycle policy.
- `node scripts/migrate-cloudinary-folder-structure.js` — one-shot: moves legacy assets from `edukcontrol/schools/logos/` and `edukcontrol/students/` to the new per-school structure. Idempotent. Add `DRY_RUN=1` to simulate.
- `node scripts/migrate-grade-periods.js` — one-shot: `Grade.period` (Number) → `Grade.gradingPeriod` (ref `GradingPeriod`) + `period_order`. Crea los `GradingPeriod` que falten a partir de los valores que existan en los datos y dropea el índice `uniq_enrollment_subject_period`. Idempotente. `DRY_RUN=1` para simular. **Backup antes.** Las fechas de los períodos creados son un placeholder repartido en tramos iguales sobre el `SchoolYear` — la escuela debe corregirlas.
- `node scripts/migrate-subjects-to-refs.js` — one-shot: `Grade.subject` y `TeacherSubject.subject` (String) → `subject_id` (ref `Subject`). Empata contra el catálogo ignorando mayúsculas/acentos/espacios y crea las materias faltantes con un `code` derivado (`MAT-001`). Tiene un **pre-flight que aborta sin escribir** si dos grafías de la misma materia colisionarían contra los índices únicos nuevos. Idempotente. `DRY_RUN=1` para simular. **Correr DESPUÉS de `migrate-grade-periods.js`** (el pre-flight agrupa por `gradingPeriod`).
- `node scripts/migrate-workshop-groups.js` — one-shot: convierte los talleres de Tecnología en grupos transversales `Group.type: "taller"`. Borra los 48 `TeacherSubject`/`ClassSchedule` de Tecnología que cada grupo de origen tenía (los 4 maestros en el mismo bloque) y crea 12 grupos taller (4 talleres × 3 grados) con su propio maestro y horario. Marca los grupos de origen como `type: "regular"` y asigna `Student.workshop_group_id` a cada alumno (distribución uniforme). **Idempotente** (aborta si ya hay grupos taller).
- `node scripts/load-schedules.js` — reconstruye TODO el horario del ciclo (los 18 maestros) desde el array `SCHEDULES` transcrito del PDF de la escuela. Modo `DRY_RUN` (default): valida resoluciones (bloques, grupos, materias, maestros) y detecta conflictos de maestro (doble-book) y de grupo (dos materias en el mismo bloque) sin escribir. Para escribir: `DRY_RUN=0 node scripts/load-schedules.js`. **Borra y recrea todos los `TeacherSubject` y `ClassSchedule` del ciclo** — no es idempotente por maestro, el array es la fuente de verdad completa. Entradas `[day, "M1-M3"|"M2", subjectCode, target]` donde `target` es `1A`..`3D` o `TALLER:<grado>` (resuelto contra la sección del maestro en `TALLER_SECTION`). Los bloques del shift se mapean por nombre (`Módulo N` → `M{N}`). Verificación post-carga: cada grupo de origen debe quedar con exactamente 8 huecos (los bloques de taller transversal), y los grupos `taller` con sus 2 bloques por día LUN/MAR/MIE/JUE.
- `node scripts/backfill-mark-absences.js` — marks absences for a given date (or today). Uses the same logic as the cronjob. `DRY_RUN=1` to simulate. **Backup before running in production.**
- `DRY_RUN=1 node scripts/cleanup-orphan-students.js` — `DELETE /api/students/:studentId` no tiene cascada, así que tras un borrado masivo quedan Enrollments con `student_id` inexistente y entradas muertas en `Guardian.students[]`. Este script borra los Enrollments huérfanos y `$pull` los ids muertos de los tutores (deja vivos intactos). `SCHOOL_ID=<oid>` opcional para limitar el alcance. `DRY_RUN=0` aplica. Útil correr **antes** de re-importar un Excel de alumnos con el mismo CURP.
- `DRY_RUN=1 node scripts/delete-students-for-reimport.js` — Borrado **escopado por grupo** (label `grado+sección`, p.ej. `GROUP_LABEL=2D`) del ciclo activo: dumpea backup JSON de los alumnos/enrollments a `_backup-reimport-<GROUP>-<ts>/`, luego borra los Enrollments del grupo, los Students y hace `$pull` de las refs muertas en `Guardian.students[]`. **NO borra tutores ni cuentas de tutor** — el re-import los reusa por `{school, phone}`. Pensado para el flujo "import dejó basura (p.ej. sin columna `grupo`) → re-import del Excel corregido". `SCHOOL_ID=<oid>` y `GROUP_LABEL=<X>` requeridos. `DRY_RUN=0` aplica.
- There is **no test framework, no test script, and no test directory**. Don't suggest `npm test`. Hay scripts de e2e manuales en `scripts/` (ver `e2e-hikvision-event.js` para el patrón).

## Entry points & layout

- `server.js` — process entrypoint. Starts the HTTP listener, handles `SIGTERM`/`SIGINT`/`uncaughtException` shutdown. Delegates the app build to `app.js`.
- `app.js` — builds the Express app: loads env, connects Mongo (`db/index.js`), mounts global middleware (`config/index.js`), mounts routers, attaches error handler (`error-handling/index.js`).
- `routes/` ↔ `controllers/` are 1:1 (`auth`, `schools`, `students`, `groups`, `enrollments`, `attendance`, `adms`).
- `middleware/` — `jwt.middleware.js` (verifies `Authorization: Bearer`), `authorize.middleware.js` (`authorize(...roles)`), `device.middleware.js` (`verifyDeviceApiKey` compares the device API key with `crypto.timingSafeEqual`; `verifyAdmsDevice` allowlists ZKTeco terminals by serial number and resolves their tenant), `tenant-context.middleware.js` (`attachSchoolContext`, `attachActiveSchoolYear`, `requireGuardianOf` — para los endpoints del Guardian Dashboard que necesitan school/schoolYear/relación tutor-student inyectados en `req`).
- `services/notification.service.js` — Expo Push API wrapper (POST `https://exp.host/--/api/v2/push/send`); safe to call when no tokens are registered (no-op). Handles stale token invalidation on `DeviceNotRegistered`.
- `services/attendance.service.js` — `registerAttendanceEvent` centraliza lo que comparten `POST /api/attendance/device-trigger` y el push ADMS de `/iclock/cdata`: supresión de duplicados (±60 s por alumno+dispositivo), alternancia entry/exit, creación del `AttendanceLog`, invalidación del cache de los tutores y disparo de la notificación push en `process.nextTick`.
- `models/` — `User`, `School`, `SchoolYear`, `Student`, `AttendanceLog`, `Enrollment`, `Group`, `Grade`, `Subject`, `TeacherSubject`, `Guardian`, `AssetVersion`, `ConductLog`, `ConductConfig`, `Announcement`, `Citation`, `GradingPeriod`, `SchoolShift`, `ClassSchedule`, `SchoolCalendar`.
- `db/index.js` — Mongoose connection (exits the process on failure).
- `error-handling/index.js` — 404 catch-all + central error handler (translates Mongoose `ValidationError`, `CastError`, `11000` duplicate-key to HTTP responses).
- `services/dashboard-cache.service.js` — invalidación compartida de las keys de cache del dashboard (`dashboard:*`, `student-grades:*`, `student-kpis:*`) para todos los tutores de un `studentId`. Se llama desde `grades.controller.js` y `conduct-logs.controller.js`.
- `services/conduct.service.js` — resuelve la `ConductConfig` de una escuela con fallback a defaults (`weights={minor:5, moderate:10, severe:20}, merit_points=5, baseline=100, floor=0`). Ofrece `getImpactForEvent` (magnitud con signo) y `clampScore`.
- `services/student-kpi.service.js` — cálculos puros de los KPIs del Guardian Dashboard. `getConductKpi` aplica la fórmula `score = clamp(baseline + signedTotal, floor, baseline)` donde `signedTotal = merits - demerits`.
- `scripts/migrate-to-multitenant.js` — one-shot migration for the multi-tenant rollout.

## Multi-tenant architecture (MUST FOLLOW)

Every collection that holds school-scoped data **must** include the field below — current models already do, future models must too:

```js
school: {
  type: Schema.Types.ObjectId,
  ref: "School",
  required: [true, "School reference is required."],
  index: true,
}
```

Rules:

1. **Every query is tenant-scoped.** The standard pattern in every controller is:
   ```js
   const filter = req.payload.role === "super_admin"
     ? {}
     : { school: req.payload.schoolId };
   ```
2. **JWT payload carries `schoolId`** (signed at login/signup in `controllers/auth.controller.js`). Never read the tenant from request body or query — only from `req.payload.schoolId`.
3. **`super_admin` is the only cross-tenant role.** It has `school: null` in the DB (the `required` is a function that returns `false` for `super_admin`). It bypasses the tenant filter in every controller.
4. **All `findById` are forbidden.** Use `findOne({ _id, ...tenantFilter })` so a wrong tenant returns 404, not a leak.
5. **Compound unique indexes are scoped per school.** A student's `controlNumber` is unique within their school, not globally. Don't undo the compound indexes; see the data model table below.
6. **`/api/attendance/device-trigger` is the only endpoint without JWT.** It identifies the tenant by denormalizing `student.school` after looking the student up. The student MUST have a `school` set or the request is rejected with 500.

## API surface

All under `/api` (no `/v1` prefix). Auth endpoints are under `/auth` (no `/api` prefix).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/signup` | none | Creates a `User`. `school` is required unless `role: "super_admin"`. |
| POST | `/auth/login` | none | Returns `{ user, authToken }`. `user` includes `role` and `school`. |
| GET | `/auth/verify` | JWT | Returns the decoded JWT payload (including `schoolId`). |
| GET/POST/PUT/DELETE | `/api/schools/*` | JWT + `super_admin` | Tenant management. Delete is blocked (409) if the school has users or students. |
| POST | `/api/schools/with-logo` | JWT + `super_admin` | `multipart/form-data`: crea la escuela y sube el logo en un solo request. Campos: `name`, `cct`, `isActive?` + `logo` (file, JPEG/PNG/WebP/SVG ≤5MB). Si el upload del logo falla, la escuela QUEDA CREADA sin logo (el front puede reintentar el logo por separado). |
| GET/POST/PUT/DELETE | `/api/school-years/*` | JWT + staff (read) / admin,registrar,super_admin (write) | Catálogo de ciclos escolares, tenant-scoped. |
| POST | `/api/school-years/:schoolYearId/activate` | JWT + admin/registrar/super_admin | Marca el ciclo como vigente: desactiva los demás de la escuela y sincroniza `School.current_school_year_id`. |
| POST | `/api/schools/:schoolId/logo` | JWT + `super_admin` | `multipart/form-data` field `logo` (JPEG/PNG/WebP/SVG, ≤5MB). Streams to Cloudinary with `crop: fit` 400x400 WebP/AVIF auto. |
| DELETE | `/api/schools/:schoolId/logo` | JWT + `super_admin` | Borra el asset de Cloudinary y limpia `logoUrl` en la DB. |
| GET | `/api/schools/:schoolId/logo/versions` | JWT + `super_admin` | Lista el historial de versiones del logo (AssetVersion). |
| POST | `/api/schools/:schoolId/logo/rollback` | JWT + `super_admin` | Body: `{ version_id }`. Marca una versión anterior como actual. |
| GET | `/api/students/:studentId/photo/versions` | JWT + staff | Lista el historial de versiones de la foto. |
| POST | `/api/students/:studentId/photo/rollback` | JWT + staff | Body: `{ version_id }`. Marca una versión anterior como actual. |
| POST | `/api/webhooks/cloudinary` | none | Endpoint de notificación para uploads asíncronos de Cloudinary. |
| GET | `/api/uploads/events` | JWT (query, header, or cookie) | SSE stream que notifica al cliente cuando un retry de upload termina. |
| POST | `/api/uploads/retry` | JWT + admin/registrar/super_admin | Reintenta manualmente un upload pendiente para una entidad. |
| POST | `/auth/logout` | none | Limpia la cookie HttpOnly de auth. |
| POST | `/api/students/register` | JWT + `admin`/`registrar` | `rfid_card` is uppercased on save; `controlNumber` is auto-generated (10 chars: YY + SHIFT + CCT4 + CONSEC). Unique per school. |
| GET | `/api/students` | JWT + any staff role | Paginated (`page`, `limit` max 100), filter by `status`, `group`, free-text `search`. |
| GET | `/api/students/export` | JWT + any staff role | Descarga `.xlsx` del padrón: `Numero de Control`, `Nombre Completo`, `Genero`, `RFID`, `Grado`, `Grupo` (formato `1A`, igual que la columna `grupo` del import). Sin paginación; mismos filtros opcionales que `GET /api/students` (`status`, `group`, `search`, `school_year_id`). Registrada ANTES de `/:studentId`. |
| GET | `/api/students/export/photos` | JWT + any staff role | ZIP en streaming (`archiver`) con las fotos de los alumnos en JPEG. Por default nombradas `<controlNumber>.jpg` (ZIP `fotos-alumnos-<fecha>.zip`); con **`?format=ivms`** van nombradas `<ID8>.jpg` (ZIP `fotos-ivms-<fecha>.zip`) para importar caras en iVMS-4200: `ID8` = `YY(2)+SHIFT(1)+CCT2(2)+CONSEC(3)` = 8 dígitos (`CCT2` = el CCT4 del controlNumber sin ceros iniciales, ej. CCT `0049` → `2610049001` → `26149001`; si eso no da 2 dígitos se usan los últimos 2 del CCT4) y la foto se re-escala vía URL a `w_640,h_640,c_fill,f_jpg,q_auto` (mínimo ~640×480 de iVMS; el asset es 300×300, hace upscale). ControlNumbers que no sean de 10 dígitos se omiten en modo ivms (log warning). Fotos WebP de Cloudinary → JPEG vía transformación URL `f_jpg` (mismo truco que `credential-pdf.service.js#toPngUrl`), fetch con pool de 6 + sniff magic bytes `FF D8`. Omite alumnos sin `photoUrl` y sin `controlNumber`; descargas fallidas se omiten (log warning). 404 si no hay ninguna foto. Mismos filtros que `/export`. Registrada ANTES de `/:studentId`. |
| GET | `/api/students/:studentId` | JWT + any staff role | |
| PUT | `/api/students/:studentId` | JWT + `admin`/`registrar` | `school` cannot be changed by non-`super_admin`. |
| DELETE | `/api/students/:studentId` | JWT + `admin`/`registrar` | |
| POST | `/api/students/:studentId/photo` | JWT + `admin`/`registrar`/`super_admin` | `multipart/form-data` field `photo` (JPEG/PNG/WebP, ≤5MB). El cliente **debe** recortar la imagen manualmente con un encuadre cuadrado (modal en el expediente) antes de subirla; el backend solo la re-escala a 300x300 WebP con `crop: "fill"` en Cloudinary. |
| GET | `/api/groups` | JWT + any staff role | |
| POST | `/api/groups` | JWT + `admin`/`registrar` | |
| GET/PUT/DELETE | `/api/groups/:groupId` | JWT + role-scoped | |
| GET | `/api/groups/:groupId/students` | JWT + staff | Estudiantes históricos de un grupo (todos los ciclos). |
| GET/POST | `/api/enrollments` | JWT + role-scoped | |
| GET/PUT/DELETE | `/api/enrollments/:enrollmentId` | JWT + role-scoped | |
| POST | `/api/attendance/device-trigger` | **device API key** | Called by hardware. See below. |
| GET/POST | `/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd` | **ZKTeco serial allowlist** | ADMS push from hybrid RFID + face terminals. Outside `/api` (path fixed in firmware). Plain-text responses only. See below. |
| POST | `/hikvision/event/:token` | **event token in path** | HTTP Listening push from Hikvision DS-K1T3xx access terminals. Outside `/api`. Plain-text responses only. See below. |
| GET | `/api/attendance/logs` | JWT + any staff role | Paginated (`limit` max 200), filter by `student_id`, `event_type`, `from`, `to`. |
| POST | `/api/conduct-logs` | JWT + staff (admin, principal, registrar, teacher, prefect, social_worker) | Crea un evento de conducta (`eventType: "demerit" \| "merit"`). `points_impact` se copia de la `ConductConfig` vigente de la escuela. Invalida el cache del dashboard de los tutores del alumno. |
| GET | `/api/conduct-logs` | JWT + staff | Lista paginada, filtra por `student_id`, `school_year_id`, `eventType`, `severity`, `status`, `from`, `to`. |
| GET | `/api/conduct-logs/:logId` | JWT + staff | Detalle. |
| PUT | `/api/conduct-logs/:logId/cancel` | JWT + admin / principal / registrar | Soft-cancel: cambia `status` a `cancelled` (no borra). Body opcional: `{ reason }`. Invalida cache. |
| DELETE | `/api/conduct-logs/:logId` | JWT + `super_admin` | Borrado físico. NO usar en el flujo normal — preferir cancel. |
| GET | `/api/guardians/me/students/:studentId/conduct-logs` | JWT + tutor dueño | Vista del tutor. Por default NO muestra cancelados (`?include_cancelled=true` para incluirlos). Filtra por `school_year_id`, `eventType`. |
| GET | `/api/guardians/me/students/:studentId/conduct-summary` | JWT + tutor dueño | Resumen de conducta para el Guardian Dashboard (cuando el padre selecciona un hijo). Devuelve `{ success, data: { currentScore, maxScore, recentLogs } }`. `currentScore` es el acumulado histórico (merits − demerits, clamp a [0, baseline]). Requiere los middlewares `attachSchoolContext`, `attachActiveSchoolYear` y `requireGuardianOf` (auto-inyectados en la ruta). |
| GET | `/api/conduct-config` | JWT + staff | Devuelve la config efectiva de la escuela (mezcla con defaults si nunca se creó). |
| PUT | `/api/conduct-config` | JWT + admin / registrar / super_admin | Upsert. Body: `{ weights?: { minor?, moderate?, severe? }, merit_points?, baseline?, floor?, school? }` (school solo para super_admin). |
| POST | `/api/attendance/mark-absences` | JWT + admin/registrar/super_admin | Marcación manual de ausencias (fallback del cronjob). Body: `{ date?: "2026-08-19" }`. Retorna `{ marked, skipped, date }`. |
| PUT | `/api/attendance/logs/:logId/justify` | JWT + admin/registrar | Justifica una ausencia. Body: `{ justified: true, justified_reason: "Enfermedad" }`. Solo para logs con `status: "absent"`. |
| GET/POST/PUT/DELETE | `/api/school-calendar/*` | JWT + staff (read) / admin,registrar,super_admin (write) | CRUD de calendario escolar (días festivos, vacaciones, suspensiones). El cronjob de ausencias consulta este modelo para saltarse días no lectivos. |

Health: `GET /health` (unauthenticated). Root: `GET /` returns service banner.

## Two distinct auth systems

1. **User JWT** — `Authorization: Bearer <token>`. Token payload: `{ _id, email, name, role, schoolId }`. Verified in `middleware/jwt.middleware.js#isAuthenticated`; role gate via `middleware/authorize.middleware.js#authorize(...roles)`.
2. **Device API key** — consumed by `POST /api/attendance/device-trigger`. Header `X-Device-Api-Key` (or `X-Api-Key`, or `body.api_key`) must match `DEVICE_TRIGGER_API_KEY` via `crypto.timingSafeEqual`. Rate-limited separately at 300 req/min.
3. **ZKTeco serial allowlist** — consumed by `/iclock/*`. The firmware can't send custom headers, so the `SN` query param is checked against `ADMS_ALLOWED_SERIALS`. Rate-limited at 600 req/min (terminals poll for commands every few seconds).
4. **Hikvision event token** — consumed by `/hikvision/event/:token`. The token is generated with `openssl rand -hex 32`, configured on the device in the form `System Configuration → HTTP(S) → HTTP Listening` (campo `URL = /hikvision/event/<token>`) and on the server in `HIKVISION_EVENT_TOKEN`. Validated with `crypto.timingSafeEqual`. Rate-limited at 300 req/min. The token travels in the URL path (not in headers and not as a query param) because the Hikvision firmware only sends a fixed POST to the configured URL.

`app.set('trust proxy', 1)` is set in `config/index.js` so rate limiting works correctly behind a reverse proxy — keep it.

## `device-trigger` quirks (controllers/attendance.controller.js)

- Body shape: `{ identifier, device_type, device_id, event_time?, snapshot_url? }`. `identifier` is matched against `Student.rfid_card` OR `Student.biometricId` OR `Student.controlNumber`, only for `status: 'active'`. `rfid_card`/`controlNumber` match uppercased; `biometricId` matches the raw trimmed string (the terminal's User ID is case/zero-padding sensitive).
- `event_type` (`entry`/`exit`) is **auto-determined** by the last `AttendanceLog` for that student — alternates. The body does not accept `event_type`.
- `event_time` is optional (defaults to `now`) and must be ISO 8601 if provided.
- `device` is stored as `${device_type || 'unknown'}@${device_id}`.
- `verificationMode` is derived from `device_type`: `face`/`facial`/`camera`/`zkteco` → `FACE`, anything else → `RFID`.
- `school` is denormalized from `student.school` into the log so tenant queries don't need a join.
- Push notification dispatch runs in **`process.nextTick`** after the response is sent; the log is created first, then `notification_sent` is flipped to `true` only on successful delivery. Expect `notification_sent` to lag behind API success.
- Duplicate suppression: a log for the same `(student, device)` within **±60 s** reuses the existing document, responds `200` (not `201`) with `duplicate: true`, and does **not** re-notify. Lives in `services/attendance.service.js`.

## Auto-absence system (cronjob + grace period)

The system automatically marks students as absent if they don't tap the biometric reader by the entry cutoff. After the exit cutoff it flags students who entered but never scanned out ("sin salida"). Both passes share a single cron schedule and run for each active shift of each active school.

**Schedule:** `*/5 7-16 * * 1-5` (every 5 minutes, Mon–Fri, 07:00–16:59, in `CRON_TZ`). Wider than the entry-only window because the exit check can fire as late as `shift.endTime + gracePeriodMinutes` (up to 14:30 + 120 min = 16:30).

**Pass 1 — Ausencias (entrada).**
1. Per shift: skip if `absenceMarkedAt` is today (idempotency).
2. Skip if the entry cutoff (`shift.startTime + gracePeriodMinutes`, or `special_entry_time + gracia` on a special day) has not been reached in `CRON_TZ`.
3. Call `markAbsencesForSchool(school, year)`. For each active student with NO entry log for today, create a `status: "absent"` log at the cutoff time and push a "AUSENCIA" notification.
4. Set `absenceMarkedAt = now` (even when nothing was marked — the gate is "did we attempt today", not "did we mark anything").

**Pass 2 — Chequeo de salidas.**
1. Per shift: skip if `exitCheckedAt` is today.
2. Skip if the exit cutoff (`shift.endTime + gracePeriodMinutes`, or `special_exit_time + gracia`) has not been reached in `CRON_TZ`.
3. Call `runExitCheckForSchool(school, year)`. For each active student with an entry log of today (status NOT absent) and NO exit log of today, set `exit_missing: true` + `exit_missing_at: now` on the entry log and push a "SIN SALIDA" notification.
4. Set `exitCheckedAt = now`.

Both `absenceMarkedAt` and `exitCheckedAt` are reset on server startup if their value is from yesterday (`resetStaleMarkers` in `config/cron.js`).

**Timezone correctness.** The cutoff comparisons use `Intl.DateTimeFormat({ timeZone: CRON_TZ })` (see `getCurrentMinutesInCronTz` in `config/cron.js`) — NOT `new Date().getHours()`, which on Render (UTC container) would mix UTC hours with Mexico-local `startTime` strings and could mark absences/deshoras. **Set `CRON_TZ=America/Mexico_City` in production.**

**Late-arrival override.** When a student taps AFTER the entry cutoff, `registerAttendanceEvent` calls `isAfterGracePeriod`; if true, it routes to `resolveLateArrival`, which flips an existing `absent` log to `on_time` with the real tap time. (`status: "late"` is in the schema enum but never written today — all late taps become `on_time` after the flip.)

**Exit-clear override.** When an `exit` log is created, `registerAttendanceEvent` clears `exit_missing` and `exit_missing_at` on the entry log of the same local day. The "SALIDA: ..." push still fires (normal attendance notification).

**Day-boundary alternation.** `determineNextType(studentId, eventTime)` compares the last log's local date to the event's local date — if they differ, the next tap is forced to `entry`. This prevents a student who forgot to scan out yesterday from having today's morning arrival logged as `exit` (which would also throw off the absent-vs-entry alternate-flow decision).

**AttendanceLog fields added for exit tracking:**
- `exit_missing: Boolean default false` — set by the cron at the exit cutoff, cleared by an exit tap.
- `exit_missing_at: Date default null` — when it was flagged.

**Key functions in `services/attendance.service.js`:**
- `isSchoolDay(school, schoolYearId, date)` — checks `SchoolCalendar`. Returns `{ isSchoolDay, reason, special_entry_time?, special_exit_time? }`. `special_schedule` entries are LECTIVE days with override times.
- `isAfterGracePeriod(student, eventTime)` — cutoff from `special_entry_time ?? shift.startTime` + grace.
- `resolveLateArrival({...})` — flips absent → on_time.
- `markAbsencesForSchool(schoolId, schoolYearId, targetDate?)` — main entry cron function.
- `runExitCheckForSchool(schoolId, schoolYearId, targetDate?)` — main exit cron function.

**Cron configuration (.env):**
- `CRON_ABSENCE_ENABLED` — default `true`. Set `false` to disable BOTH the entry and exit passes.
- `CRON_TZ` — **required in production** (e.g. `America/Mexico_City`); used for the schedule AND for cutoff comparisons. See "Timezone correctness" above.
- `ADMS_TZ_OFFSET_MINUTES` — offset in minutes between school wall-clock and UTC (e.g. `-360` for UTC−6). Used to compute local-date for daily bucketing. Set this whenever the backend does not run in the school's timezone.

**Manual triggers:**
- `POST /api/attendance/mark-absences` (JWT + admin/registrar) — entry pass only. Body: `{ date?: "YYYY-MM-DD" }`.
- `node scripts/backfill-mark-absences.js` — entry pass for a historical date (manual; does not auto-run).

**`SchoolCalendar.type` enum:** `holiday | vacation | suspension | non_lectivo | special_schedule`. The first four are non-school days (cron skips). `special_schedule` is a school day with `special_entry_time` and/or `special_exit_time` overrides.

## Hybrid auth: ADMS push from ZKTeco terminals (`/iclock/*`)

Terminals that do both RFID and face recognition speak the ZKTeco Push SDK, not our JSON API. `controllers/adms.controller.js` + `routes/adms.routes.js` implement it. Mounted at **`/iclock` in `app.js`, outside `/api`** — the path is hard-coded in the device firmware (only host and port are configurable). Do not move it.

| Method | Path | Purpose |
|---|---|---|
| GET | `/iclock/cdata?SN=..&options=all` | Handshake. Returns the plain-text config block; the device won't push until it gets this. |
| POST | `/iclock/cdata?SN=..&table=ATTLOG` | The actual punch push. `table` values other than `ATTLOG` are acked and discarded. |
| GET | `/iclock/getrequest?SN=..` | Command polling. Returns `OK` (no command queue yet — this is the hook for remote face enrollment). |
| POST | `/iclock/devicecmd?SN=..` | Command ACK. Returns `OK`. |

Protocol rules that are easy to break:

- **Always respond `200` with `Content-Type: text/plain`.** A 4xx/5xx (or a JSON body) makes the terminal re-send the whole batch in a loop until its buffer fills. Unmatched records are logged to console and acked anyway; even the outer `catch` returns `200 OK: 0`. The rate-limit handler and the auth middleware also reply in plain text.
- **ATTLOG body format**: `\n`-separated lines, `\t`-separated columns — `PIN, DateTime, Status, Verify, WorkCode, Reserved1, Reserved2`. It arrives as `text/plain` (sometimes with no `Content-Type`), so the route adds `express.text({ type: () => true })`; `express.json()` has already run globally, so JSON integrator payloads still parse to objects and the text parser skips them (`req._body`).
- **`Card` is not in ATTLOG.** When a student taps a card the terminal resolves it to that user's internal PIN and reports the PIN with `Verify=4`. So `verificationMode` comes from the `Verify` code first (`15,20–23` → `FACE`; `2,4` → `RFID`), and only falls back to "is a `Card` field present" for JSON payloads.
- **Timestamps have no timezone.** The device sends local wall-clock time. Set `ADMS_TZ_OFFSET_MINUTES` (e.g. `-360` for UTC−6) or the server will interpret it in its own zone — which is UTC in most containers.
- **Auth is an SN allowlist, not a key.** The firmware cannot send custom headers, so `verifyDeviceApiKey` is unusable here. `verifyAdmsDevice` checks the `SN` query param against `ADMS_ALLOWED_SERIALS`. The SN travels in cleartext — serve `/iclock` over HTTPS and IP-restrict it to the school network.
- **Cross-tenant ambiguity.** `biometricId` is unique *per school*, and the push carries no tenant context, so the same PIN can exist in two schools. The lookup uses `.limit(2)`: two matches → the record is dropped with an `ambiguous` warning rather than credited to the wrong student. Set `ADMS_DEVICE_SCHOOL_MAP` (`{"<SN>":"<schoolId>"}`) to scope each terminal to one school and remove the ambiguity entirely.
- A JSON/urlencoded body is also accepted (for integrators that put middleware in front of the device): `{ Card, PIN | User_ID, DateTime, Verify?, snapshotUrl? }`, a bare array, or `{ records: [...] }` / `{ data: [...] }`.

## Hikvision ISAPI HTTP Listening push (`/hikvision/event/:token`)

Terminales Hikvision (DS-K1T3xx — actualmente en producción las DS-K1T323EBWX-E1) usan ISAPI con un modo **HTTP Listening** que las hace POSTear eventos a un servidor HTTP externo. La configuración se hace desde la web UI de la terminal en **System Configuration → HTTP(S) → HTTP Listening** (o vía `PUT /ISAPI/Event/notification/httpHosts/1` desde un script con auth Digest). El backend expone `POST /hikvision/event/<HIKVISION_EVENT_TOKEN>` en `controllers/hikvision.controller.js` + `routes/hikvision.routes.js`, montado en `app.js` fuera de `/api` (igual que `/iclock`).

### Configuración del dispositivo

Llenar el form **HTTP Listening** con estos valores:

| Campo | Valor |
|---|---|
| Event Alarm IP/Domain Name | `<tu-servicio>.onrender.com` (sin `https://`) |
| URL | `/hikvision/event/<HIKVISION_EVENT_TOKEN>` |
| Port | `80` |
| Protocol | `HTTP` primero (evita certs); probar `HTTPS/443` después |

Mismo valor de `<HIKVISION_EVENT_TOKEN>` va en el `.env`/Render del backend. Generar con `openssl rand -hex 32`.

### Protocolo esperado

La terminal empuja un `EventNotificationAlert` XML (o JSON si `parameterFormatType=JSON`) por cada evento de autenticación. Ejemplo de body:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <ipAddress>192.168.100.42</ipAddress>
  <macAddress>aa:bb:cc:dd:ee:ff</macAddress>
  <channelID>1</channelID>
  <dateTime>2026-09-29T13:31:55+00:00</dateTime>
  <activePostCount>1</activePostCount>
  <eventType>AccessControllerEvent</eventType>
  <eventState>active</eventState>
  <AccessControllerEvent>
    <majorEventType>5</majorEventType>     <!-- 5 = Access Event -->
    <subEventType>75</subEventType>         <!-- 75 = Face Auth Success -->
    <employeeNoString>2610912001</employeeNoString>
    <cardNo>...optional...</cardNo>
    <doorNo>1</doorNo>
  </AccessControllerEvent>
</EventNotificationAlert>
```

`majorEventType=5` (Access Event) es el único que genera un `AttendanceLog`. Otros major (alarmas, tamper, etc.) llegan pero el backend los registra y acka sin crear log. `subEventType` mapea a `verificationMode`: `75/76` → `FACE`; `1..5` → `RFID`; cualquier otro con `cardNo` → `RFID`, sin `cardNo` → `FACE` (fallback).

### Reglas que son fáciles de romper

- **Siempre responder `200` con `text/plain`.** Un 4xx/5xx (o un body JSON) hace que la terminal reenvíe el evento en loop hasta llenar su buffer. Lo mismo que ADMS. Token inválido → `401 text/plain`; cualquier otra condición (evento sin identificador, alumno no matcheado, duplicado, JSON malformado) → `200 OK: 0` o `200 OK: 1`.
- **El parser loguea el body crudo (info level)**. Las primeras capturas reales con una terminal en sitio son la mejor forma de validar que el árbol XML/JSON coincide con la estructura esperada — revisar la consola del server después del primer punch de prueba.
- **Auth = token en path.** El firmware Hikvision NO permite cabeceras personalizadas. El token vive en el path (`/hikvision/event/<token>`), validado con `crypto.timingSafeEqual` contra `HIKVISION_EVENT_TOKEN`. Es un secreto: la URL completa NO debe quedar en logs de proxy (path token, no query).
- **Reuso total del flujo de asistencia.** Después de parsear, el controller matchea al alumno con el mismo `$or: [{biometricId}, {rfid_card}, {controlNumber}]` que `device-trigger` y llama a `attendanceService.registerAttendanceEvent`. Eso significa dedup ±60s, alternancia entry/exit, cálculo de late/absent y push notifications funcionan igual que en los demás endpoints.
- **Cross-tenant ambiguity.** El `$or` con tres campos puede dar más de un match si dos alumnos comparten identificador en distintas escuelas. Mismo patrón que ADMS: `Student.find().limit(2)` y drop con `ambiguous` warning si hay más de uno. Con la convención `biometricId == controlNumber`, una escuela no puede tener dos alumnos con el mismo `biometricId` salvo colisión con un manual override.
- **`device` se guarda como `hikvision@<MAC o IP>`.** La MAC es más estable que la IP (la IP puede cambiar por DHCP). `controllers/hikvision.controller.js` prefiere MAC; fallback a IP si la MAC no viene en el payload.
- **Timestamps con offset ISO.** La terminal envía `dateTime` con offset de zona (ej. `2026-09-29T13:31:55-06:00`). El controller parsea con `new Date()` que respeta el offset y queda un `Date` UTC correcto — `attendanceService.isAfterGracePeriod` usa `ADMS_TZ_OFFSET_MINUTES` para convertir de vuelta a local, así que la terminal y el server DEBEN coincidir en zona horaria (idealmente UTC-6 = `ADMS_TZ_OFFSET_MINUTES=-360`).

### Configurar la terminal vía API (alternativa al form UI)

`scripts/hikvision-configure-push.sh` automatiza el `PUT /ISAPI/Event/notification/httpHosts/1` con auth Digest. Útil para instalaciones futuras; corre desde la LAN de la escuela.

### Verificación manual

```bash
# 1. Generar token
TOKEN=$(openssl rand -hex 32)
echo "Pegar en .env del backend: HIKVISION_EVENT_TOKEN=$TOKEN"
echo "Pegar en el form HTTP Listening de la terminal: URL=/hikvision/event/$TOKEN"

# 2. Disparar un rostro de prueba y verificar:
curl -s -o /dev/null -w "%{http_code}\n" https://<api>/hikvision/event/0000000000000000000000000000000000000000000000000000000000000000
#   → 401 (token incorrecto)

# 3. (con el token correcto, después del deploy) pegar una cara y revisar
#   el log del servidor — debería aparecer "[hikvision] entry/exit log created ...".
```

E2E completo: `node scripts/e2e-hikvision-event.js` (cubre 401, body vacío, body malformado, face XML, dedup, card XML, JSON, sin identificador, verificación de `biometricId == controlNumber`).

## Convención `biometricId` = `controlNumber`

Las terminales (ZKTeco ADMS con PIN numérico, Hikvision ISAPI con `employeeNo`) matchean al alumno contra un identificador que **configura el admin al enrollerlo** en la terminal. La convención adoptada es usar `controlNumber` directamente:

- Es 100% numérico (10 dígitos: `YY(2) + SHIFT(1) + CCT4(4) + CONSEC(3)`), aceptado por cualquier firmware que espere un User ID / PIN numérico.
- Es único por escuela (índice compuesto `{ school, controlNumber }`, secuencia atómica en el pre-save de Student).
- Es auto-generado — no requiere asignación manual, cero typos.
- Ya está incluido en los lookups `$or` de los tres endpoints de asistencia (`/api/attendance/device-trigger`, `/iclock/cdata`, `/hikvision/event/:token`), así que los punches resuelven sin necesidad de tocar `biometricId`.
- Es legible: cuando aparece en el payload crudo (`employeeNoString=2610912001`), es inmediatamente identificable.

Implementación: el pre-save hook en `models/Student.model.js` autocompleta `this.biometricId = this.controlNumber` si no se especificó en el body. Los alumnos existentes se migraron con `scripts/migrate-biometric-id-from-control-number.js` (idempotente: solo llena `biometricId: null` por default; `--force` sobrescribe manuales).

Un override manual sigue siendo posible (`PUT /api/students/:studentId` con `biometricId` explícito) — útil para casos de excepción. El índice único `{ school, biometricId }` previene duplicados accidentales.

## Required environment (.env)

`MONGO_URI`, `SECRET_KEY` (≥32 chars, used for JWT), `FIREBASE_SERVICE_ACCOUNT_PATH`, `DEVICE_TRIGGER_API_KEY`, `PORT` (default 5000), `NODE_ENV` (default `development`), `ORIGIN` (default `http://localhost:5173`).

## Special schedule days (`SchoolCalendar.type === "special_schedule"`)

Días lectivos con horario modificado (ej: día de actividad, jornada cultural, salida temprana). **No** es día festivo — los alumnos asisten, solo que a horario distinto al oficial del turno.

**API:** `POST/PUT /api/school-calendar` acepta, además de los campos existentes:
- `special_entry_time` (`"HH:mm"`, opcional) — entrada oficial del día. Si está presente, el cron usa este valor (en lugar de `shift.startTime`) como inicio para calcular el cutoff de entrada.
- `special_exit_time` (`"HH:mm"`, opcional) — salida oficial del día. Si está presente, el cron usa este valor (en lugar de `shift.endTime`) como inicio para calcular el corte del chequeo de salidas.

**Validaciones del backend (`controllers/school-calendar.controller.js#validateSpecialScheduleBounds`):**
- `type === "special_schedule"` requiere al menos uno de los dos horarios.
- `special_entry_time >= min(shift.startTime)` de los turnos activos del ciclo — los alumnos no se citan antes de la hora oficial.
- `special_exit_time <= max(shift.endTime)` — los alumnos no se quedan después de la hora oficial.
- Si no hay turnos activos en el ciclo, los bounds no se aplican (la validación se reduce al formato `HH:mm`).

**Efectos en el cron / taps reales (resumidos):**
- Corte de entrada (ausencias) = `special_entry_time ?? shift.startTime` + `gracePeriodMinutes` del turno (`services/attendance.service.js#markAbsencesForSchool`).
- Corte de salida (chequeo de salidas) = `special_exit_time ?? shift.endTime` + `gracePeriodMinutes` (`services/attendance.service.js#runExitCheckForSchool`).
- Clasificación `on_time` / `late` en taps reales = `isAfterGracePeriod` consulta `SchoolCalendar` para el día del evento y usa el override.

**Configuración:** un solo registro de calendario por (escuela, ciclo, fecha). Si ese día además es festivo/vacación, gana el festivo (no usar `special_schedule` para "no lectivo").

## Chequeo de salidas (cron de ausencias, pase 2)

El mismo cron que marca ausencias corre después un pase para detectar alumnos que **sí entraron pero no salieron**. El papá recibe un push "SIN SALIDA: ..." si su hijo está en esa situación. La alerta se limpia automáticamente cuando el alumno registra su salida (incluso tarde).

**Cuándo corre:** a `shift.endTime + gracePeriodMinutes` (o `special_exit_time + gracia` en días con horario especial). El cron schedule (`*/5 7-16 * * 1-5`) es lo suficientemente ancho para cualquier gracia ≤ 120 min.

**Gate de idempotencia:** `SchoolShift.exitCheckedAt` se resetea al iniciar el server (igual que `absenceMarkedAt`) — un turno solo se chequea una vez por día.

**Modelo:** `AttendanceLog.exit_missing: Boolean` + `exit_missing_at: Date`. Se limpian en `registerAttendanceEvent` cuando se crea un `exit` log del mismo día (consulta por día local con `ADMS_TZ_OFFSET_MINUTES`).

**Push al tutor:** `notification.service.js#sendMissingExitNotification` con título `SIN SALIDA: {nombre}` y cuerpo `{nombre} registró entrada a las HH:mm pero no registró salida. Si se encuentra en la escuela, favor de avisar a la oficina.`. Canal `eduk_attendance_channel`. Data `kind: "missing_exit"`.

**Consulta API (sin UI en web por ahora):** `GET /api/attendance/logs?exit_missing=true` filtra solo los entry logs marcados. Combinable con `from`/`to` para acotar el día. Cuando se implemente la pantalla de asistencia, este endpoint ya tiene los datos.

**NO crear** el push de "sin salida" para alumnos con `status: "absent"` — su entry log es un absent auto-marcado, no significa que estuvo en la escuela. El cron ya lo excluye en `runExitCheckForSchool`.


`ADMS_ALLOWED_SERIALS` — comma-separated allowlist of ZKTeco terminal serial numbers permitted to push to `/iclock/*`. **Required in production**: if unset, any SN is accepted (a warning is logged per request).

`HIKVISION_EVENT_TOKEN` — opaque token (≥ 32 chars, generate with `openssl rand -hex 32`) that travels in the URL path of the Hikvision HTTP Listening push. Configured on the device in the form `System Configuration → HTTP(S) → HTTP Listening` (campo `URL = /hikvision/event/<token>`) and on the server in this env. **Required in production**: if unset, `/hikvision/event/:token` rejects all requests with 503. See the "Hikvision ISAPI HTTP Listening push" section below.

`ADMS_TZ_OFFSET_MINUTES` — offset in minutes between the terminals' local wall-clock time and UTC (e.g. `-360` for UTC−6). Set it whenever the backend does not run in the school's timezone, or every punch will be stored hours off.

`ADMS_DEVICE_SCHOOL_MAP` (opcional) — JSON map `{"<SN>": "<schoolId>"}` binding each terminal to a school. Scopes the student lookup to one tenant and prevents ambiguous PIN matches across schools. Invalid JSON is logged and ignored.

`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — required for the student photo upload endpoint (`POST /api/students/:studentId/photo`). Without them, the upload will fail with a Cloudinary auth error.

`CLOUDINARY_WEBHOOK_SECRET` — required in production to validate `X-Cld-Signature` on incoming webhooks (`POST /api/webhooks/cloudinary`). If unset, the webhook endpoint rejects all requests. Configure the same value in Cloudinary Console → Webhooks.

`PENDING_UPLOADS_DIR` (default `/tmp/eduk-pending-uploads`) — directorio donde se persisten los buffers que fallaron al subirse a Cloudinary, para que el job `scripts/retry-pending-uploads.js` los reprocese.

`CRON_ABSENCE_ENABLED` — default `true`. Set `false` to disable the auto-absence cronjob.
`CRON_ABSENCE_SCHEDULE` — cron expression for the absence marking job (default `0 8 * * 1-5` = L-V 08:00).
`CRON_TZ` — timezone for the cron schedule (e.g. `America/Mexico_City`).

`CLOUDINARY_NOTIFICATION_URL` (opcional) — URL base pública de tu backend (e.g. `https://api.tu-dominio.com`). Si está configurada, los uploads usan `eager_async: true` + `notification_url` para que Cloudinary procese las transformaciones async y notifique por webhook cuando termine. Si está vacía, el comportamiento es síncrono (default en desarrollo).

`PENDING_UPLOADS_BACKEND` (opcional) — `disk` (default) o `s3`. Si es `s3`, los buffers de uploads fallidos se persisten en S3 en vez de disco. Requiere también: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_PENDING_UPLOADS_BUCKET`.

`EXPO_PUSH_API_URL` (opcional) — URL del servicio de Expo Push. Default: `https://exp.host/--/api/v2/push/send`. Solo cambiar si usás un endpoint custom (tests, on-prem).

## Data model constraints

- `User.role` ∈ `super_admin | admin | principal | registrar | teacher | prefect | social_worker`.
- `User.school` is required for every role except `super_admin` (uses a `required: function()` so the validator sees the role at validation time).
- `School.cct` is unique globally; `School.isActive` defaults to `true`. `School.current_school_year_id` is a denormalized ref to the school's active `SchoolYear` (kept in sync exclusively via `POST /api/school-years/:schoolYearId/activate`).
- `PUT /api/schools/:schoolId` only accepts `name` and `isActive` (whitelist). The logo is NOT updated via this endpoint — use `POST /api/schools/:schoolId/logo` (upload/replace) or `DELETE /api/schools/:schoolId/logo` (remove). `logoUrl` is intentionally excluded from the whitelist to prevent a string-from-body update that bypasses Cloudinary.
- `SchoolYear` (`school`, `name` matching `^\d{4}-\d{4}$`, `startDate`, `endDate`, `isActive`) is the source of truth for school cycles. `Group`, `Enrollment`, `Grade` (denormalized from `Enrollment`), and `TeacherSubject` all reference it via `school_year_id` (ObjectId ref) instead of a raw string. Unique per school: `{ school, name }`.
- `Student.status` ∈ `active | withdrawn_temp | withdrawn_permanent`.
- `AttendanceLog.event_type` ∈ `entry | exit`. `AttendanceLog.verificationMode` ∈ `FACE | RFID | MANUAL` (default `RFID` — historic logs all predate facial recognition). `AttendanceLog.snapshotUrl` is the camera capture of the check-in event, not the student's reference photo (that one is `Student.photoUrl`). `AttendanceLog.status` ∈ `on_time | late | absent | null` (only set for entry events; `null` for exit events and legacy records).
- `Student.biometricId` is the User ID / PIN the student is enrolled under in the ZKTeco terminal. Stored as `String` (leading zeros are significant: `"0042" ≠ "42"`). `Student.isFaceEnrolled` marks that the face template was actually loaded onto the device, as distinct from merely having a `biometricId` assigned.
- `Group.grade` ∈ `{1, 2, 3}`. `Group.type` ∈ `regular | taller` (default `regular`). Los grupos `taller` son secciones transversales de Tecnología que mezclan alumnos de varios grupos de origen del mismo grado (el grupo de origen se dispersa en el bloque de taller; cada alumno pertenece a UN solo taller vía `Student.workshop_group_id`).
- `Student.workshop_group_id` (ref `Group`) apunta al grupo taller del alumno. Se elige UNA sola vez al ingresar a primer grado y se conserva en ciclos siguientes: al promover, `students.controller.js#promoteStudent` lo re-apunta al grupo taller del mismo nombre de sección en el nuevo grado/ciclo. `enrollments.controller.js` NO lo toca.
- `Enrollment.cycle_status` ∈ `enrolled | withdrawn | graduated | transferred`.
- Unique compound indexes (per school):
  - `User`: `{ school, email }` unique, partial on `school: ObjectId`; plus `{ email }` unique, partial on `school: null` for super_admins.
  - `Student`: `{ school, controlNumber }` unique, partial on `controlNumber: string`; `{ school, rfid_card }` unique, partial on `rfid_card: string`.
  - `Group`: `{ school, grade, section, school_year_id }` unique.
  - `Enrollment`: `{ school, student_id, school_year_id }` unique.
  - `SchoolYear`: `{ school, name }` unique.
  - `ConductConfig`: `{ school }` unique (un único doc por escuela).
  - `GradingPeriod`: `{ school, school_year_id, order }` unique; `{ school, school_year_id, name }` unique.
  - `SchoolShift`: `{ school, school_year_id, name }` unique — el nombre sí se repite ENTRE ciclos, que es lo que permite clonar la campana sin tocar los horarios del año anterior.
  - `ClassSchedule`: `{ school_year_id, group_id, subject_id, teacher_id }` unique (la co-docencia son dos documentos, y el índice lo permite).
  - `Grade`: `{ enrollment_id, subject_id, gradingPeriod }` unique — **sustituye** a `uniq_enrollment_subject_period`.
  - `TeacherSubject`: `{ teacher_id, subject_id, group_id, school_year_id }` unique — **sustituye** a `uniq_teacher_subject_group_year`.
  - `Subject`: `{ school, code }` unique; `{ school, name }` **no** unique (los datos migrados pueden traer nombres repetidos; deduplicar el catálogo es tarea manual).
  - `SchoolCalendar`: `{ school, school_year_id, date }` unique.
  - Mongoose crea los índices nuevos pero **nunca borra los viejos**: los dropean las migraciones. Un índice único sobre un campo eliminado sigue exigiendo unicidad sobre `null` y bloquea la segunda inserción de cada documento.
- Mongoose `__v` is globally disabled (`versionKey: false`).

## Períodos de evaluación y horarios (GradingPeriod / SchoolShift / ClassSchedule)

Tres modelos configurables por escuela. **Todavía no tienen controllers ni rutas** — sólo los esquemas y la migración.

- **`GradingPeriod`** — catálogo de períodos por `(school, school_year_id)`. Sustituye al enum fijo de trimestres: una escuela puede usar bimestres y otra trimestres. `order: 0` significa *calificación final del ciclo* (conserva la semántica del viejo `period: 0`); `1..N` son los ordinarios en orden cronológico. `GradingPeriod.findByDate(school, yearId, date)` resuelve el período vigente e ignora el `order: 0`. `isClosed` es una bandera de negocio para bloquear captura — **el schema no la aplica**, tiene que hacerlo el controller.
- **`SchoolShift`** — la campana de la escuela, **por ciclo** (`school_year_id` es obligatorio): `startTime`/`endTime` del turno, `moduleDurationMinutes` nominal y un array de subdocumentos `timeBlocks` (`name`, `startTime`, `endTime`, `isBreak`, `order`). Las horas se guardan como String `"HH:mm"` y no como `Date` a propósito: un módulo es una hora de reloj recurrente, no un instante, y así no se arrastra zona horaria ni horario de verano. El `pre("validate")` **reordena `timeBlocks` cronológicamente y recalcula `order`** (el orden en que llega el array es irrelevante), y rechaza solapamientos, bloques invertidos y bloques fuera de la ventana del turno. Métodos: `resolveBlocks(ids)` y `areContiguous(ids)`.
- **`ClassSchedule`** — pivote del horario: `school_year_id` + `group_id` + `subject_id` + `teacher_id` + `school_shift_id`, con un array `scheduleSlots` de `{ dayOfWeek, timeBlockRefs[], classroom }`. **Un módulo doble o triple es simplemente varios `timeBlockRefs` contiguos en el mismo slot** — no hay documentos duplicados ni campo de duración. `dayOfWeek` usa la convención de `Date.prototype.getDay()` (0 = domingo … 6 = sábado) para poder filtrar con `new Date().getDay()` sin tabla de conversión.

Cosas que el schema **no** puede validar y tienen que vivir en el controller:

- **Arranque de ciclo:** para el año nuevo se **clona** el `SchoolShift` del anterior. Al clonar se generan `_id` de bloque nuevos, así que los `ClassSchedule` viejos siguen resolviendo contra la campana que estaba vigente cuando se armaron. Nunca reutilices el turno del ciclo pasado editándolo en sitio.
- **`timeBlockRefs` apunta a subdocumentos de otra colección.** Por eso `ClassSchedule` guarda también `school_shift_id`: sin él esos ObjectIds no se pueden resolver, y Mongoose no puede poblar subdocumentos cross-collection. Al editar `SchoolShift.timeBlocks` **nunca** reconstruyas el array desde cero (regenera todos los `_id` e invalida todos los horarios): modifica los subdocs por `_id` y haz push sólo de los nuevos. Antes de quitar un bloque, `ClassSchedule.exists({ "scheduleSlots.timeBlockRefs": blockId })` → 409 si está en uso.
- **Empalmes.** Un índice único no sirve: los slots viven en un array y el choque cruza documentos. Consulta previa al guardado con `$elemMatch` sobre `{ dayOfWeek, timeBlockRefs: { $in: [...] } }` filtrando por `$or: [{ group_id }, { teacher_id }]` (ver el comentario al pie de `ClassSchedule.model.js`).
- **Recesos y contigüidad.** Rechazar `timeBlockRefs` con `isBreak: true` y exigir `shift.areContiguous(refs)` para los módulos dobles.
- Los hooks son `pre("validate")`, así que corren en `save()` y en `doc.validate()` pero **no** en `validateSync()`.

## Guardian Dashboard — KPIs del tutor

`GET /api/guardians/me/dashboard` devuelve, por cada estudiante del tutor, un objeto `kpis` con 3 indicadores del ciclo escolar activo de la escuela (`School.current_school_year_id`):

- **`kpis.attendance`** — `% de Asistencia`:
  - `percentage`: `(días con entry del alumno / días lectivos del ciclo hasta hoy) * 100`, redondeado a 2 decimales. `null` si no hay días lectivos.
  - `attended_days`, `total_school_days`: números crudos para mostrar "9/10" en el front.
  - `source`: `"derived_from_attendance_logs"` por ahora. Cuando se cree un modelo `SchoolDay` (calendario explícito) se prefiere ese lookup.
- **`kpis.cumulative_gpa`** — `Promedio Acumulado` (regla de los 3 trimestres):
  - `null` si ningún trimestre tiene calificaciones.
  - Si solo T1 evaluado (9.0) → `9.0`.
  - Si T1 (9.0) y T2 (8.0) → `8.5` (media de los trimestres evaluados).
  - Se consideran los `period ∈ {1,2,3}` de `Grade`. `period=0` (calificación final) NO entra.
- **`kpis.conduct`** — `Score de Conducta` (ledger-style: merits + demerits):
  - `score = clamp(baseline + signedTotal, floor, baseline)`, donde `signedTotal = sum(merits) - sum(demerits)`.
  - El clamp garantiza que el score nunca baja del `floor` ni sube del `baseline` (los méritos solo recuperan puntos perdidos, no superan el techo).
  - `points_impact` se congela al crear el evento (no se recalcula contra cambios futuros en `ConductConfig`).
  - Defaults si la escuela nunca creó su `ConductConfig`: `baseline=100`, `floor=0`, `weights={minor:5, moderate:10, severe:20}`, `merit_points=5`.
  - El payload incluye además: `signed_total`, `total_events`, `demerits_count`, `merits_count` (para que la UI muestre "X demerits, Y merits").

Cualquier cambio en `Grade` o `ConductLog` invalida el cache del dashboard (TTL 5 min) de TODOS los tutores del estudiante afectado vía `services/dashboard-cache.service.js`.

## Guardians — identidad por teléfono y reuso entre hermanos

La identidad del tutor es su **teléfono** dentro de la escuela: el índice único `{school, phone}` (`Guardian.model.js:105`) garantiza que existe a lo sumo un `Guardian` por `{school, phone}`. Esto permite que un mismo padre/madre quede vinculado a varios alumnos (hermanos) sin duplicar registros.

**Endpoints principales (admin/registrar/super_admin):**

| Método | Path | Notas |
|---|---|---|
| GET | `/api/guardians?phone=10dígitos` | Lookup exacto por teléfono, usa el índice `{school, phone}`. Recomendado para auto-detección al teclear el teléfono en el form de alta de alumno. Soporta también `?search=` (regex sobre nombre/phone) y `?student_id=` para filtrar. Paginado (`page`, `limit` máx 100). Acepta `status=active\|inactive\|all`, `no_students=1`, `group_id=<oid>` y `taller_id=<oid>` (filtros de la pantalla Padres — si vienen ambos se intersectan; `school_year_id` opcional, default = `current_school_year_id` del School del tenant). |
| POST | `/api/guardians` | Crea un tutor. **Si ya existe uno con el mismo `{school, phone}`, lo REUSA** y solo le suma el `students` (mirror en ambos lados) y sincroniza el `User` tutor con `ensureTutorUser`. |
| POST | `/api/guardians/:guardianId/students` | **Vincula alumnos a un tutor ya existente por ID** (sin necesidad de mandar nombre/teléfono). Body: `{ student_ids: ["…"] }` o `{ student_id: "…" }`. **Aditivo**: `$addToSet` en `Guardian.students` y `Student.guardians` — los hermanos se conservan. Safety: si el guardian no tiene `user_id` aún, llama `ensureTutorUser` (idempotente). Nunca toca `name`/`lastname`/`relationship`/`notification_prefs`. Usado por la modal "Buscar tutor existente" del form de alta de alumno. |
| DELETE | `/api/guardians/:guardianId/students/:studentId` | **Desvincula UN estudiante puntual** del tutor (cambio de tutor a mitad de ciclo: ya no es la mamá ahora es el papá). `$pull` en ambos lados; idempotente (si no estaba vinculado devuelve 200 con `wasLinked:false`). Solo admin/registrar/super_admin. |
| PUT | `/api/guardians/:guardianId` | Edita un tutor existente. Acepta `isActive` (boolean) — solo admin/registrar/super_admin pueden cambiarlo. Al pasar a `false` desvincula TODOS los hijos automáticamente y desactiva el `User` tutor si queda sin guardians activos. Al pasar a `true` reactiva el `User` si existía y estaba bajado. |
| GET | `/api/guardians/stats?school_year_id=<oid>` | Métricas de la pantalla Padres en 1 request: `{ total, ativos, dados_de_baja, sin_alumnos, con_cuenta_activa, con_hijos_en_ciclo, alumnos_sin_tutor }`. `school_year_id` opcional resuelve el ciclo de `con_hijos_en_ciclo` (lo manda el front; **requerido en la práctica para super_admin**, cuyo JWT trae `schoolId: null` — sin param ese corte queda en 0). El `school` del `distinct` de enrollments se deriva vía `schoolForYear()` (JWT o SchoolYear). |

**Regla de no-pisar-datos:** En el reuso por teléfono (tanto en `POST /api/guardians` como en `POST /api/students/import`) **solo completamos campos vacíos** (`name`/`lastname`/`relationship`). Un typo en el alta de un hermano no debe corromper al padre ya registrado — el teléfono es la identidad, sus datos personales son los del primer registro válido. `user_id` y `notification_prefs` nunca se tocan al reusar.

**Import Excel:** El endpoint `POST /api/students/import` (`controllers/students.controller.js`) vincula tutores por teléfono. Si la fila del Excel trae **teléfono sin nombre**, pero el tutor ya existe en la DB, se vincula aunque falte el nombre (no se exige `name` cuando hay reuse). Si no existe y no hay nombre, se reporta `warning` por fila. Cada fila de éxito lleva `guardian_reused: true` + `guardian: "<nombre>"` cuando se reusó un tutor, para que el admin vea en el resumen qué filas se vincularon a un tutor existente.

**Alumnos creados sin tutor:** Cuando la fila queda sin tutor **y** no se emitió un `warning` específico de tutor (teléfono sin nombre / error de creación / `phone_taken`), el `okRow` lleva `guardian_missing: true`, `student_name: "<nombre completo>"` y `guardian_missing_reason: "missing_phone" | "no_data"`. El front filtra esos `okRow` para mostrar la lista "Alumnos sin tutor" del resumen con el motivo (`missing_phone` → "tenía nombre pero faltaba celular", `no_data` → "sin datos de tutor"). El alumno se conserva — es un OK, no un error. La identidad del tutor es el teléfono; no podemos crear uno sin él (`Guardian.phone` es `required` + `match: /^\d{10}$/`).

## Conventions

- CommonJS (`require`). Spanish comments in source files (doc-internal); English in user-facing strings (error messages, response bodies, Expo Push payloads — the frontend localizes).
- Errors flow to `error-handling/index.js`; controllers just `next(error)`. Don't `try/catch`+`res.status` inside async handlers unless transforming the error.
- `tenantFilter(req)` is the standard helper at the top of every controller that touches school-scoped data. Use it.
- `morgan` is `dev`/`combined` only — disabled when `NODE_ENV === 'test'`.
- Body limit is 1 MB for both JSON and urlencoded.
- All timestamps use `timestamps: true`; do not add manual `createdAt`/`updatedAt`.

## Account state (`isActive`)

`User.isActive` representa el **estado de la cuenta**: `true` (alta activa) o `false` (baja explícita). Toda nueva cuenta nace activa (`default: true` en el modelo), incluyendo tutores.

**"Pendiente de activar" ya NO se define por este flag**, sino por la **ausencia de `password`**: una cuenta con `isActive=true` y sin password aún no hizo OTP, y puede hacerlo. La baja (`isActive=false`) es una acción admin consciente desde la pantalla de Personal (o equivalente).

**Dónde se valida `isActive === false`:**

| Endpoint | Comportamiento |
| --- | --- |
| `POST /auth/login` | `403` "Your account is disabled. Contact your school." (chequeado **después** del password match para no filtrar estado). |
| `POST /auth/refresh` | `403` + revoca TODA la family de refresh del user. |
| `POST /auth/request-activation` | `403` "Account is disabled…" (no se gasta OTP en bajas). |
| `POST /auth/verify-otp` | `403` (mismo motivo). |
| `POST /auth/activate-account` | `403` (mismo motivo). |
| `POST /auth/forgot-password/request` | `403` (no quemar OTPs en bajas). |

Los tres endpoints de activación siguen bloqueando con `400 "Account is already active…"` cuando `user.password` ya existe (criterio de "ya activado" — sigue siendo la frase que el mobile mapea a `already_active`).

**Backfill histórico.** Antes de este cambio todos los `User.isActive` nacían `false` (excepto `super_admin`), por lo que cualquier admin creado vía `users/page.tsx` con password quedó con `isActive=false`. Con el nuevo guard de login, eso se traduce en bloqueo de admins. **Rerun antes del deploy del guard:**

```sh
DRY_RUN=1 MONGO_URI=… node scripts/backfill-user-active.js   # preview
DRY_RUN=0 MONGO_URI=… node scripts/backfill-user-active.js   # aplica
```

El script flipea todos los `isActive=false` a `true`. Idempotente. Después del backfill, `isActive=false` solo aparece cuando un operador lo setea explícitamente.

**`Guardian.isActive`** funciona igual: `default: true` en el modelo, baja explícita via `PUT /api/guardians/:id { isActive: false }` (solo admin/registrar/super_admin). Al desactivar el backend **desvincula automáticamente a todos los hijos** (ambos lados) y, si el tutor queda sin ningún guardian activo, baja `User.isActive` a false (login → 403). Antes de desplegar el guard de lectura o cualquier uso real:

```sh
DRY_RUN=1 MONGO_URI=… node scripts/backfill-guardian-active.js   # preview
DRY_RUN=0 MONGO_URI=… node scripts/backfill-guardian-active.js   # aplica
```

Flipa a `true` los guardians con `isActive: false` O sin el campo (los 422 preexistentes). Idempotente.

## WhatsApp OTP (Twilio Business API)

**Proveedor:** Twilio. **Canal único:** WhatsApp (sin fallback SMS).
**Tipo de template:** Authentication (OTP).

### Variables de entorno requeridas

Ver `.env.example` para el detalle. Las claves son:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` (en sandbox: `+14155238886`)
- `TWILIO_OTP_TEMPLATE_ID` (Content SID `HXxxxxx`, post-aprobación de Meta)
- `TWILIO_STATUS_CALLBACK_URL` (URL pública del webhook)

### Opt-in (obligatorio para cumplir Meta policy)

Todo usuario que reciba OTPs vía WhatsApp debe tener `notification_prefs.whatsapp.opted_in === true`. El opt-in se captura en:

- `POST /auth/signup` — body `whatsapp_opt_in: true` (source = `signup`)
- `POST /api/guardians` — body `whatsapp_opt_in: true` (source = `admin_form`)
- `PUT /auth/me/notification-preferences` — body `{ whatsapp_opted_in: true }` (source = `self_profile`)
- `PUT /api/guardians/:guardianId` — body `whatsapp_opt_in: true` (source = `admin_form`)

Los endpoints OTP (`/auth/request-activation`, `/auth/forgot-password/request`) retornan **`451 Unavailable For Legal Reasons`** con `{ consent_required: true }` si `opted_in === false`.

### Webhook de status

Twilio POSTea a `TWILIO_STATUS_CALLBACK_URL` con estados:
`queued | sent | delivered | read | failed | undelivered`. Si Twilio
reporta `failed`/`undelivered` con código `63007` (recipient not opted-in)
o `63038` (session not found), el handler sincroniza `opted_in = false`
en `User` y `Guardian` para evitar que se acumulen reintentos en vano.

Path real: **`POST /auth/webhooks/twilio/whatsapp-status`** (GET misma URL =
health check). El POST **valida `X-Twilio-Signature`** con
`twilio.validateRequest(TWILIO_AUTH_TOKEN, …, TWILIO_STATUS_CALLBACK_URL, req.body)`
en `routes/auth-webhooks.routes.js#verifyTwilioSignature` — firma inválida →
`403`. Si faltan `TWILIO_AUTH_TOKEN` o `TWILIO_STATUS_CALLBACK_URL` se omite
la validación con un warning (no hay callbacks legítimos sin esas vars).

### Códigos de error Twilio manejados

| Código | Significado | Mapeo HTTP |
|--------|-------------|------------|
| `21211` | Invalid 'To' phone number | `400` |
| `63007` / `63038` | Recipient not opted in / session not found | `451` |
| `63016` / `63033` | Template not approved / paused | `503` |
| `21655` | Content SID no existe en la cuenta (revisar `TWILIO_OTP_TEMPLATE_ID`: SID `HX...` de la misma cuenta, sin espacios) | `503` |

### Archivos clave

- `services/whatsapp.service.js` — wrapper de Twilio + custom errors
- `controllers/webhooks.controller.js` — handler del status callback
- `routes/auth-webhooks.routes.js` — montado en `/auth/webhooks`
- `services/sms.service.js` — DEPRECATED, solo loggea a consola
- `models/User.model.js` y `models/Guardian.model.js` — campo `notification_prefs.whatsapp`

### `OTP_ECHO` — bypass temporal para probar flujos sin Meta aprobada

Mientras la Authentication template de Meta no está aprobada, Twilio devuelve `63016` y los endpoints OTP retornan `503`. Para validar los flujos de activación (`/auth/request-activation`) y recuperación de contraseña (`/auth/forgot-password/request`) end-to-end sin esperar la aprobación, existe un modo de bypass controlado por env:

- **Var:** `OTP_ECHO` (unset / `0` / `false` = off por default; `1` / `true` / `console` / `yes` / `on` = on).
- **Efecto:** `services/whatsapp.service.js#sendOtpViaWhatsApp` loguea el código en consola como `[otp-echo] purpose=… to=… code=123456` y devuelve `{ success: true, messageSid: "echo", status: "echo", echoed: true }` — **sin contactar Twilio**, no requiere credenciales ni template.
- **Persistencia del OTP:** el código sigue hasheándose y guardándose en `User.otpCode` con TTL de 10 min, así `verify-otp` y `activate-account` / `forgot-password/reset` funcionan idéntico que con WhatsApp real.
- **Warning de arranque:** `app.js` imprime un banner bien visible al boot si la flag está activa (imposible olvidarla en Render Logs).
- **Cómo probar:** setear `OTP_ECHO=console` en Render, deploy, pedir OTP desde la app, abrir Render Logs y buscar la línea `[otp-echo]` con el código.
- **⚠️ Apagar siempre** que la template de Meta esté aprobada y las 5 vars `TWILIO_*` estén en Render. Con la flag activa los códigos no salen del servidor: el usuario queda atrapado sin poder activar / recuperar.

### Costos estimados

- ~$0.04 USD por OTP vía Authentication template.
- 1000 usuarios × 2 OTPs/año = ~$80 USD/año.

### Cuándo reconsiderar

- Si excedemos 500K mensajes/mes → migrar a 360dialog (más barato).
- Si necesitamos SMS fallback → agregar Twilio SMS side-by-side.
- Si Meta cambia política de Authentication templates → revisar documentación oficial.

## Known dead weight

- `xss-clean` is listed in `package.json` dependencies but is **not** wired into `app.js`. Sanitization is currently provided by `express-mongo-sanitize` + `hpp` only. Removing `xss-clean` is safe; do not assume it is active.

## Mobile app integration (Expo Push)

The mobile app uses **Expo Push API** for push notifications (`expo-notifications` SDK). On iOS this still works inside Expo Go; on Android, push remotes require a development build (`eas build --profile development`).

### Token registration

The mobile must register the Expo push token after login:

1. **Tutor (rol `tutor`):** POST a `/api/guardians/me/fcm-token` con body `{ fcm_token: "ExponentPushToken[…]", device_id? }`. El backend escribe el token en **todos los Guardian records** vinculados al user_id (un tutor puede ser guardián de varios hijos).
2. **Staff (cualquier otro rol):** POST a `/auth/fcm-token` con body `{ fcm_token: "ExponentPushToken[…]" }`. El backend escribe el token en `User.fcm_token`.

> ⚠️ El campo en la DB sigue llamándose `fcm_token` por compatibilidad histórica, pero el valor es ahora un **Expo Push Token** (`ExponentPushToken[…]`), no un token FCM raw.

### Token rotation

Expo puede rotar el push token en cualquier momento (restore from backup, reinstalación, etc.). La app DEBE suscribirse a `Notifications.addPushTokenListener` y re-llamar al endpoint de registro cada vez que reciba un token nuevo.

### Tap → deep linking

El backend incluye `data.kind` en cada push (`attendance`, `absence`, `citation`, `citation_rescheduled`, `citation_cancelled`, `citation_confirmed`, `citation_reschedule_request`, `announcement`). El cliente debe usar `Notifications.addNotificationResponseReceivedListener` para parsear `data.kind` + `data.citation_id` / `data.student_id` / etc. y navegar a la pantalla correspondiente. Ver `src/utils/notificationData.js` en el mobile.

### Auto-invalidation

El backend marca `fcm_token = null` cuando Expo responde con `DeviceNotRegistered` (token expirado o app desinstalada). El siguiente login de la app re-registra el token.

## Things you should NOT do

- Do not add a `lint` script that just `echo`s — wire a real linter (e.g. ESLint flat config) or leave it alone and update this file.
- Do not add `xss-clean` middleware back without testing — it has known compatibility issues with modern Express 4.
- Do not move the `process.nextTick` notification dispatch inline; the device must get a fast 201 even if Expo Push is slow.
- Do not change `app.set('trust proxy', 1)` without also revising the rate limiter; removing it breaks the per-IP accounting behind a proxy.
- Do not commit `config/firebase-service-account.json` (ya no se usa pero sigue gitignored — keep it that way) or any populated `.env` file (both are gitignored).
- Do not remove the `school` field from any model. Do not weaken the `required: function()` on `User.school`.
- Do not reintroduce a raw `school_year: String` field on `Group`, `Enrollment`, `Grade`, or `TeacherSubject` — always reference `SchoolYear` via `school_year_id`.
- Do not write a query without `tenantFilter(req)` in any controller that handles school-scoped data. This is a security requirement, not a performance one.
- Do not add a new resource/model (e.g. `Notice`, `Report`, `Grade`) without adding the `school: { ref: 'School', required: true, index: true }` field.
- Do not mark `super_admin` users as belonging to a specific school when creating them; leave `school: null` so the cross-tenant filter bypass works.
