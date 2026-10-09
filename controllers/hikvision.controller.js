// Controlador de eventos push de terminales Hikvision (ISAPI HTTP Listening).
//
// Una vez configurado el form "HTTP Listening" en la UI de la terminal
// (System Configuration → HTTP(S) → HTTP Listening), el dispositivo hace
// POST a <BACKEND_URL>/hikvision/event/<HIKVISION_EVENT_TOKEN> con un cuerpo
// XML o JSON del tipo:
//
//   <EventNotificationAlert version="1.0" xmlns="...">
//     <ipAddress>192.168.100.42</ipAddress>
//     <portNo>80</portNo>
//     <protocolType>HTTP</protocolType>
//     <macAddress>...</macAddress>
//     <channelID>1</channelID>
//     <dateTime>2026-09-29T13:31:55+08:00</dateTime>
//     <activePostCount>1</activePostCount>
//     <eventType>AccessControllerEvent</eventType>
//     <eventState>active</eventState>
//     <eventDescription>Access Controller Event</eventDescription>
//     <AccessControllerEvent>
//       <majorEventType>5</majorEventType>      <!-- 5 = Access Event -->
//       <subEventType>75</subEventType>          <!-- 75 = Face Auth Success -->
//       <name>Face Authentication</name>
//       <employeeNoString>2610912001</employeeNoString>
//       <cardNo>...</cardNo>                     <!-- opcional -->
//       <doorNo>1</doorNo>
//       <entryExitLatency>...</entryExitLatency>
//     </AccessControllerEvent>
//   </EventNotificationAlert>
//
// El controller:
//   1. Valida el :token contra HIKVISION_EVENT_TOKEN (401 text/plain si no).
//   2. Parsea el body (XML con fast-xml-parser; JSON como objeto directo).
//   3. Loguea el body crudo (info) mientras se valida con la primera captura real.
//   4. Extrae: dateTime, employeeNo (string), cardNo, major/minor codes.
//   5. Mapea a verificationMode (FACE/RFID) por los códigos o por presencia de cardNo.
//   6. Resuelve el alumno con la misma lógica $or que device-trigger:
//        biometricId | rfid_card | controlNumber   (status="active")
//   7. Reusa attendanceService.registerAttendanceEvent para crear el log,
//      alternar entry/exit, deduplicar, invalidar cache y notificar.
//   8. **Siempre HTTP 200** con texto plano (regla dorada ADMS). Un 5xx hace
//      que el firmware reenvíe en loop.
const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");

const Student = require("../models/Student.model");
const attendanceService = require("../services/attendance.service");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// ── Códigos de evento ISAPI / Hikvision Access Controller ────────────────
// majorEventType = 5 → Access Controller Event.
// subEventType: 75 = Face Authentication Success (DS-K1T323).
// Otras series pueden usar códigos ligeramente distintos. Si llega un código
// desconocido y hay cardNo presente → RFID; si no → FACE (asume rostro).
const FACE_VERIFY_CODES = new Set([75, 76]); // Face Auth success/fail treated as face device
const CARD_VERIFY_CODES = new Set([1, 2, 3, 4, 5]); // card swipe variants

// ── Auth: timingSafeEqual del :token ─────────────────────────────────────
const verifyEventToken = (req, res, next) => {
  const expected = process.env.HIKVISION_EVENT_TOKEN;

  if (!expected) {
    // El servidor no está configurado para aceptar push Hikvision.
    console.error(
      "[hikvision] HIKVISION_EVENT_TOKEN is not configured — rejecting all push requests."
    );
    return res
      .type("text/plain")
      .status(503)
      .send("HIKVISION_EVENT_TOKEN not configured on server.");
  }

  const provided = String(req.params.token || "").trim();
  if (!provided) {
    return res.type("text/plain").status(401).send("Missing event token");
  }

  let equal = false;
  try {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length === b.length) {
      equal = crypto.timingSafeEqual(a, b);
    }
  } catch {
    equal = false;
  }

  if (!equal) {
    console.warn(
      `[hikvision] Rejected push with invalid event token (len=${provided.length})`
    );
    return res.type("text/plain").status(401).send("Invalid event token");
  }

  return next();
};

// ── Parseo del body crudo ────────────────────────────────────────────────
// Acepta: (a) XML string, (b) JSON string, (c) multipart/form-data con
// campo AccessControllerEvent (formato real de DS-K1T3xx con
// parameterFormatType=JSON), (d) objeto ya parseado por express.json().
// Devuelve un objeto normalizado o null si no se pudo parsear.
const parseBody = (raw) => {
  if (raw === null || raw === undefined || raw === "") return null;

  // Ya es objeto (express.json() lo parseó antes que nuestro text-parser)
  if (typeof raw === "object") return raw;

  const text = String(raw).trim();
  if (text === "") return null;

  // multipart/form-data: el firmware DS-K1T3xx envía --<boundary> + headers
  // + cuerpo JSON del campo AccessControllerEvent.
  if (text.startsWith("--")) {
    return parseMultipartBody(text);
  }

  // JSON puro
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.warn(`[hikvision] JSON parse failed: ${e.message}`);
      return null;
    }
  }

  // XML (caso normal del firmware Hikvision)
  if (text.startsWith("<")) {
    try {
      const parsed = xmlParser.parse(text);
      return parsed;
    } catch (e) {
      console.warn(`[hikvision] XML parse failed: ${e.message}`);
      return null;
    }
  }

  // Form-urlencoded: intentar como key=value (defensivo, raro)
  if (text.includes("=")) {
    const out = {};
    for (const part of text.split("&")) {
      const [k, v] = part.split("=");
      if (k) out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
    }
    return out;
  }

  return null;
};

// Parsea un body multipart/form-data crudo (sin librería). Extrae el primer
// campo cuyo body sea JSON (application/json o empiece con "{"). El boundary
// se toma de la primera línea "--<boundary>".
const parseMultipartBody = (text) => {
  // Primera línea: --boundary (posible \r\n o \n)
  const firstLineEnd = text.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const boundary = firstLine.replace(/^--/, "").trim();
  if (!boundary) {
    console.warn("[hikvision] multipart without boundary");
    return null;
  }

  // Separar partes por --boundary (tolerante a \r\n y \n)
  const parts = text.split(`--${boundary}`);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") continue;

    // headers hasta la primera línea vacía
    const sep = trimmed.search(/\r?\n\r?\n/);
    if (sep === -1) continue;
    const headers = trimmed.slice(0, sep);
    const body = trimmed.slice(sep).trim();

    if (!body || !body.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(body);
      // Loguea el nombre del campo si viene (útil para depurar)
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fieldName = nameMatch ? nameMatch[1] : "unknown";
      console.log(
        `[hikvision] multipart field "${fieldName}" parsed (${body.length} bytes)`
      );
      return parsed;
    } catch (e) {
      console.warn(`[hikvision] multipart JSON parse failed: ${e.message}`);
    }
  }

  console.warn(
    `[hikvision] multipart: no JSON field found (boundary=${boundary}, parts=${parts.length})`
  );
  return null;
};

// Extrae de forma defensiva los campos del árbol parseado.
// Maneja dos variantes de anidamiento:
//   - Con namespace XML: parsed["EventNotificationAlert"]["AccessControllerEvent"]
//   - Sin namespace:      parsed["EventNotificationEvent"]["AccessControllerEvent"]
//     (algunos firmwares viejos usan EventNotificationEvent en singular)
const extractEvent = (parsed) => {
  if (!parsed || typeof parsed !== "object") return null;

  const root =
    parsed.EventNotificationAlert || parsed.EventNotificationEvent || parsed;
  if (!root || typeof root !== "object") return null;

  const inner =
    root.AccessControllerEvent ||
    root.EventNotificationAlert ||
    root.EventNotificationEvent ||
    null;

  // Algunos firmwares envuelven el evento dentro de EventInfo.
  const innerEvent = inner?.EventInfo?.AccessControllerEvent || inner;

  const dateTime =
    root.dateTime ||
    root.eventTime ||
    innerEvent?.dateTime ||
    innerEvent?.time ||
    innerEvent?.localTime ||
    null;

  const major = parseInt(
    innerEvent?.majorEventType ||
      innerEvent?.major ||
      root.majorEventType ||
      root.major ||
      "0",
    10
  );

  const minor = parseInt(
    innerEvent?.subEventType ||
      innerEvent?.minor ||
      root.subEventType ||
      root.minor ||
      "0",
    10
  );

  const employeeNo =
    innerEvent?.employeeNoString ||
    innerEvent?.employeeNo ||
    root.employeeNoString ||
    root.employeeNo ||
    null;

  const cardNo =
    innerEvent?.cardNo ||
    innerEvent?.card ||
    root.cardNo ||
    root.card ||
    null;

  const deviceIp =
    root.ipAddress || root.deviceIP || root.deviceIp || null;
  const mac = root.macAddress || root.MACAddress || null;

  if (!employeeNo && !cardNo) {
    return {
      dateTime: dateTime ? new Date(dateTime) : null,
      employeeNo: null,
      cardNo: null,
      major: Number.isFinite(major) ? major : null,
      minor: Number.isFinite(minor) ? minor : null,
      deviceIp,
      mac,
    };
  }

  return {
    dateTime: dateTime ? new Date(dateTime) : null,
    employeeNo: employeeNo ? String(employeeNo).trim() : null,
    cardNo: cardNo ? String(cardNo).trim() : null,
    major: Number.isFinite(major) ? major : null,
    minor: Number.isFinite(minor) ? minor : null,
    deviceIp,
    mac,
  };
};

const resolveVerificationMode = ({ minor, cardNo }) => {
  // Prioriza el código ISAPI si lo reconocemos
  if (Number.isFinite(minor)) {
    if (FACE_VERIFY_CODES.has(minor)) return "FACE";
    if (CARD_VERIFY_CODES.has(minor)) return "RFID";
  }
  // Fallback: si hay cardNo presente → RFID; si no → FACE
  return cardNo ? "RFID" : "FACE";
};

// Busca al alumno activo con la misma lógica $or que device-trigger.
// Devuelve { student, ambiguous } — ambiguous=true si hay >1 match (drop).
const findStudentForHikvisionEvent = async (record) => {
  const orClauses = [];
  if (record.employeeNo) {
    orClauses.push({ biometricId: record.employeeNo });
    orClauses.push({ controlNumber: record.employeeNo });
  }
  if (record.cardNo) {
    orClauses.push({ rfid_card: String(record.cardNo).toUpperCase() });
  }

  if (orClauses.length === 0) return { student: null, ambiguous: false };

  const matches = await Student.find({
    $or: orClauses,
    status: "active",
  })
    .limit(2)
    .select("_id school controlNumber first_name last_name current_group_id");

  if (matches.length === 0) return { student: null, ambiguous: false };
  if (matches.length > 1) return { student: null, ambiguous: true };
  return { student: matches[0], ambiguous: false };
};

// POST /hikvision/event/:token
const handleHikvisionEvent = [
  verifyEventToken,
  async (req, res) => {
    const raw = req.body;
    const providedTokenLen = String(req.params.token || "").length;

    // Log del body crudo. Para multipart solo logueamos los primeros bytes
    // (el JSON ya se loguea al parsear la parte) — volcar el blob completo
    // es ruido (30s x N terminales).
    const contentType = req.headers["content-type"] || "<none>";
    const isMultipart = contentType.includes("multipart/");
    if (isMultipart) {
      console.log(
        `[hikvision] event push multipart (token_len=${providedTokenLen}): ${typeof raw === "string" ? raw.slice(0, 200) : "<object>"}…`
      );
    } else {
      console.log(
        `[hikvision] event push (token_len=${providedTokenLen}, content-type=${contentType}):`,
        typeof raw === "string"
          ? raw.slice(0, 2000)
          : JSON.stringify(raw).slice(0, 2000)
      );
    }

    let parsed;
    try {
      parsed = parseBody(raw);
    } catch (e) {
      console.warn(`[hikvision] unexpected parse error: ${e.message}`);
      parsed = null;
    }

    if (!parsed) {
      // Body vacío o no parseable — ACKK igual (200) para evitar loop.
      console.warn("[hikvision] empty/unparseable body, acking 200");
      return res.type("text/plain").status(200).send("OK: 0");
    }

    const record = extractEvent(parsed);
    if (!record) {
      console.warn("[hikvision] could not extract event fields, acking 200");
      return res.type("text/plain").status(200).send("OK: 0");
    }

    if (!record.employeeNo && !record.cardNo) {
      // No hay forma de identificar al alumno (puede ser un evento no-asistencia,
      // p.ej. una alarma). Logueamos y ackk: el firmware no reintentará.
      console.log(
        `[hikvision] event without employeeNo/cardNo (major=${record.major}, minor=${record.minor}), acking 200`
      );
      return res.type("text/plain").status(200).send("OK: 0");
    }

    let student;
    let ambiguous = false;
    try {
      ({ student, ambiguous } = await findStudentForHikvisionEvent(record));
    } catch (e) {
      console.error(`[hikvision] student lookup failed: ${e.message}`);
      return res.type("text/plain").status(200).send("OK: 0");
    }

    if (ambiguous) {
      console.warn(
        `[hikvision] ambiguous match (employeeNo=${record.employeeNo}, cardNo=${record.cardNo}), acking 200`
      );
      return res.type("text/plain").status(200).send("OK: 0");
    }

    if (!student) {
      console.log(
        `[hikvision] no active student for employeeNo=${record.employeeNo}, cardNo=${record.cardNo}, acking 200`
      );
      return res.type("text/plain").status(200).send("OK: 0");
    }

    if (!student.school) {
      console.error(
        `[hikvision] student ${student._id} has no school assigned — refusing to log`
      );
      return res.type("text/plain").status(200).send("OK: 0");
    }

    const eventTime =
      record.dateTime && !Number.isNaN(record.dateTime.getTime())
        ? record.dateTime
        : new Date();

    // Etiqueta de dispositivo: preferimos la MAC (estable) sobre la IP (puede
    // cambiar). El formato "hikvision@<identificador>" sigue el patrón de
    // zkteco@<SN> en controllers/adms.controller.js.
    const deviceLabel = `hikvision@${record.mac || record.deviceIp || "unknown"}`;

    const verificationMode = resolveVerificationMode(record);

    try {
      const { log, eventType, duplicate } =
        await attendanceService.registerAttendanceEvent({
          student,
          eventTime,
          device: deviceLabel,
          verificationMode,
          snapshotUrl: null,
        });

      if (!duplicate) {
        console.log(
          `[hikvision] ${eventType} log created for student ${student.controlNumber} (${student._id}) at ${eventTime.toISOString()} via ${deviceLabel} [mode=${verificationMode}]`
        );
      } else {
        console.log(
          `[hikvision] duplicate ${eventType} log for student ${student.controlNumber} within ±60s — reusing existing log`
        );
      }

      return res.type("text/plain").status(200).send("OK: 1");
    } catch (err) {
      console.error(
        `[hikvision] registerAttendanceEvent failed for student ${student._id}: ${err.message}`
      );
      // Igual ACKK 200: registrar el error ya es suficiente; un 5xx haría
      // loop en el dispositivo.
      return res.type("text/plain").status(200).send("OK: 0");
    }
  },
];

module.exports = {
  handleHikvisionEvent,
};
