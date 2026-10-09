// utils/ivms-id.js
// ID8 / Employee ID de iVMS-4200.
//
// iVMS-4200 limita el Employee ID a 8 dígitos numéricos (1..99999999, sin
// cero inicial), así que el número de control (10 dígitos) no sirve como
// identificador en la terminal Hikvision. El ID8 se deriva del
// controlNumber descartando 2 ceros del CCT:
//
//   ID8 = YY(2) + SHIFT(1) + CCT2(2) + CONSEC(3)
//
//   controlNumber = YY(2) + SHIFT(1) + CCT4(4) + CONSEC(3)
//   CCT2 = CCT4 sin ceros a la izquierda (si eso no da exactamente 2
//          dígitos, se usan los últimos 2 del CCT4).
//
// Ejemplos:
//   2610049001 -> 26149001   (CCT4 "0049" -> "49")
//   2611234001 -> 26134001   (CCT4 "1234" -> fallback "34")
//   2610123001 -> 26123001   (CCT4 "0123" -> fallback "23")
//   "abc"      -> null       (controlNumber no es de 10 dígitos)
//
// Fuente única: la usan el export de fotos (?format=ivms), la migración
// scripts/migrate-biometric-id-to-ivms.js y el e2e de Hikvision. Si la
// cambias acá, cambiá también Student.biometricId en la DB (migración).
const buildIvmsId = (controlNumber) => {
  if (!/^\d{10}$/.test(controlNumber)) return null;
  const cct4 = controlNumber.slice(3, 7);
  const stripped = cct4.replace(/^0+/, "");
  const cct2 = stripped.length === 2 ? stripped : cct4.slice(-2);
  return `${controlNumber.slice(0, 3)}${cct2}${controlNumber.slice(7)}`;
};

module.exports = { buildIvmsId };
