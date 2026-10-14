// Scope de escuela (multi-tenant) para los endpoints de LISTADO.
//
// Versión centralizada del `tenantFilter` que cada controller duplica.
// Además del filtro estándar, soporta el query param opcional `?school=<oid>`
// para que el panel web (que navega como super_admin, sin `schoolId` en el JWT)
// pueda pedir "solo la escuela seleccionada": /schools/[id]/subjects,
// /schools/[id]/shifts, .../guardians, etc.
//
// Reglas de seguridad (ver AGENTS.md → Multi-tenant architecture):
//  - Rol normal (admin, registrar, teacher, ...): el tenant sale SIEMPRE del
//    JWT (`req.payload.schoolId`). El param `?school=` se IGNORA por completo,
//    así que nadie puede desviarse a otra escuela (regla 2: no se lee el
//    tenant del query).
//  - super_admin: puede cruzar tenants. Sin `?school=` devuelve `{}` (todo,
//    igual que antes — los dashboards globales no cambian de comportamiento);
//    con `?school=<oid válido>` acota a esa escuela; con un valor no válido
//    lanza un error 400 (mejor fallar en frío que responder la lista global
//    de todas las escuelas por un typo en la URL).
//
// Uso en el controller (reemplaza el `tenantFilter` local):
//
//   const { tenantFilter } = require("../utils/school-scope");
//
//   const getAllX = async (req, res, next) => {
//     try {
//       const filter = { ...tenantFilter(req) };
//       ...
//     } catch (error) {
//       next(error);  // el status 400 del throw viaja en err.status
//     }
//   };
const mongoose = require("mongoose");

// Devuelve el filtro `{ school }` (o `{}` si aplica) para la request.
// Lanza `Error` con `status: 400` si `?school=` no es un ObjectId válido.
const tenantFilter = (req) => {
  const role = req.payload && req.payload.role;

  // Roles normales: tenant fijo por JWT. Jamás se lee el query.
  if (role !== "super_admin") {
    return { school: req.payload.schoolId };
  }

  // super_admin sin scope → sin filtro (comportamiento histórico).
  const raw = req.query && req.query.school;
  if (!raw) {
    return {};
  }

  if (!mongoose.Types.ObjectId.isValid(String(raw))) {
    const error = new Error("Invalid school.");
    error.status = 400;
    throw error;
  }

  return { school: String(raw) };
};

module.exports = { tenantFilter };
