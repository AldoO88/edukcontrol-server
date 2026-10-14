// Controlador de Plantillas de Grupo
// CRUD de GroupTemplate con aislamiento multi-tenant.

const mongoose = require("mongoose");
const GroupTemplate = require("../models/GroupTemplate.model");
// Scope multi-tenant compartido (soporta ?school= para super_admin).
const { tenantFilter } = require("../utils/school-scope");

// GET /api/group-templates
// Query opcionales: grade, shift, school (solo super_admin — acota a esa escuela)
const getAllGroupTemplates = async (req, res, next) => {
  try {
    const filter = { ...tenantFilter(req) };
    if (req.query.grade) {
      const g = parseInt(req.query.grade, 10);
      if (!Number.isNaN(g)) filter.grade = g;
    }
    if (req.query.shift) {
      filter.shift = req.query.shift;
    }

    const templates = await GroupTemplate.find(filter)
      .sort({ grade: 1, section: 1 })
      .lean();

    res.status(200).json({ items: templates, total: templates.length });
  } catch (error) {
    next(error);
  }
};

// GET /api/group-templates/:templateId
const getGroupTemplateById = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(404).json({ message: "Invalid template id." });
    }

    const template = await GroupTemplate.findOne({
      _id: templateId,
      ...tenantFilter(req),
    }).lean();

    if (!template) {
      return res.status(404).json({ message: "Template not found." });
    }
    res.status(200).json(template);
  } catch (error) {
    next(error);
  }
};

// POST /api/group-templates
const createGroupTemplate = async (req, res, next) => {
  try {
    const { grade, section, shift, type } = req.body;
    if (!grade || !section || !shift) {
      return res
        .status(400)
        .json({ message: "grade, section and shift are required." });
    }

    const school =
      req.payload.role === "super_admin"
        ? req.body.school
        : req.payload.schoolId;

    if (!school) {
      return res
        .status(400)
        .json({ message: "school is required." });
    }

    const template = await GroupTemplate.create({
      school,
      grade: parseInt(grade, 10),
      section: section.toUpperCase().trim(),
      shift,
      type: type || "regular",
    });

    res.status(201).json(template);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Ya existe una plantilla con ese grado y sección en esta escuela.",
      });
    }
    next(error);
  }
};

// PUT /api/group-templates/:templateId
const updateGroupTemplate = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(404).json({ message: "Invalid template id." });
    }

    const update = { ...req.body };
    if (update.grade) update.grade = parseInt(update.grade, 10);
    if (update.section) update.section = update.section.toUpperCase().trim();

    const template = await GroupTemplate.findOneAndUpdate(
      { _id: templateId, ...tenantFilter(req) },
      update,
      { new: true, runValidators: true }
    );

    if (!template) {
      return res.status(404).json({ message: "Template not found." });
    }
    res.status(200).json(template);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Ya existe una plantilla con ese grado y sección en esta escuela.",
      });
    }
    next(error);
  }
};

// DELETE /api/group-templates/:templateId
const deleteGroupTemplate = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(404).json({ message: "Invalid template id." });
    }

    const template = await GroupTemplate.findOneAndDelete({
      _id: templateId,
      ...tenantFilter(req),
    });

    if (!template) {
      return res.status(404).json({ message: "Template not found." });
    }
    res.status(200).json({ message: "Template deleted." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllGroupTemplates,
  getGroupTemplateById,
  createGroupTemplate,
  updateGroupTemplate,
  deleteGroupTemplate,
};
