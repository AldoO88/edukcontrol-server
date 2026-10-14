// Controlador de Materias (Subject)
// CRUD del catálogo de materias de la escuela. Multi-tenant estricto.
const mongoose = require("mongoose");
const Subject = require("../models/Subject.model");
// Scope multi-tenant compartido (soporta ?school= para super_admin).
const { tenantFilter } = require("../utils/school-scope");

// GET /api/subjects
// Lista las materias de la escuela. Filtros: ?isActive=true, ?school=<oid>
const getAllSubjects = async (req, res, next) => {
  try {
    const filter = { ...tenantFilter(req) };
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === "true";
    }
    const subjects = await Subject.find(filter).sort({ name: 1 });
    res.status(200).json({ items: subjects, total: subjects.length });
  } catch (error) {
    next(error);
  }
};

// GET /api/subjects/:subjectId
const getSubjectById = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(subjectId)) {
      return res.status(404).json({ message: "Subject not found." });
    }
    const subject = await Subject.findOne({
      _id: subjectId,
      ...tenantFilter(req),
    });
    if (!subject) {
      return res.status(404).json({ message: "Subject not found." });
    }
    res.status(200).json(subject);
  } catch (error) {
    next(error);
  }
};

// POST /api/subjects
// Crea una materia. Auth: admin/registrar.
const createSubject = async (req, res, next) => {
  try {
    const {
      code, name, grade, description,
      educationalLevel, classificationType, macroCategory,
      credits, isTutoria, color, icon, workshops,
    } = req.body;

    if (!code || !name) {
      return res.status(400).json({ message: "code and name are required." });
    }

    const school = req.payload.schoolId || req.body.school;
    if (!school) {
      return res.status(400).json({ message: "school is required (super_admin)." });
    }

    const subject = await Subject.create({
      school,
      code: code.toUpperCase().trim(),
      name: name.trim(),
      grade: grade || null,
      description: description || null,
      educationalLevel: educationalLevel || "BASIC",
      classificationType: classificationType || "DISCIPLINE",
      macroCategory: macroCategory || null,
      credits: credits || 0,
      isTutoria: isTutoria || false,
      color: color || null,
      icon: icon || null,
      workshops: classificationType === "WORKSHOP" && workshops ? workshops : [],
    });
    res.status(201).json(subject);
  } catch (error) {
    next(error);
  }
};

// PUT /api/subjects/:subjectId
const updateSubject = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(subjectId)) {
      return res.status(404).json({ message: "Subject not found." });
    }
    const updated = await Subject.findOneAndUpdate(
      { _id: subjectId, ...tenantFilter(req) },
      req.body,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Subject not found." });
    }
    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/subjects/:subjectId
const deleteSubject = async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(subjectId)) {
      return res.status(404).json({ message: "Subject not found." });
    }
    const deleted = await Subject.findOneAndDelete({
      _id: subjectId,
      ...tenantFilter(req),
    });
    if (!deleted) {
      return res.status(404).json({ message: "Subject not found." });
    }
    res.status(200).json({ message: "Subject deleted successfully." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllSubjects,
  getSubjectById,
  createSubject,
  updateSubject,
  deleteSubject,
};
