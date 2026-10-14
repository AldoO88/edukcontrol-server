// Controlador de Plantillas de Turno (ShiftTemplate)
// CRUD de plantillas a nivel escuela (sin ciclo escolar).
const mongoose = require("mongoose");
const ShiftTemplate = require("../models/ShiftTemplate.model");
// Scope multi-tenant compartido (soporta ?school= para super_admin).
const { tenantFilter } = require("../utils/school-scope");

// GET /api/shift-templates
// Query opcional: school (solo super_admin) — acota a esa escuela.
const getAllTemplates = async (req, res, next) => {
  try {
    const filter = { ...tenantFilter(req) };
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === "true";
    }
    const templates = await ShiftTemplate.find(filter).sort({ shift: 1, name: 1 });
    res.status(200).json({ items: templates, total: templates.length });
  } catch (error) {
    next(error);
  }
};

// GET /api/shift-templates/:templateId
const getTemplateById = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(404).json({ message: "Template not found." });
    }
    const template = await ShiftTemplate.findOne({
      _id: templateId,
      ...tenantFilter(req),
    });
    if (!template) {
      return res.status(404).json({ message: "Template not found." });
    }
    res.status(200).json(template);
  } catch (error) {
    next(error);
  }
};

// POST /api/shift-templates
const createTemplate = async (req, res, next) => {
  try {
    const {
      name, shift, startTime, endTime,
      moduleDurationMinutes, timeBlocks, gracePeriodMinutes,
    } = req.body;

    if (!name || !startTime || !endTime) {
      return res.status(400).json({ message: "name, startTime, and endTime are required." });
    }

    const school = req.payload.schoolId || req.body.school;
    if (!school) {
      return res.status(400).json({ message: "school is required (super_admin)." });
    }

    const template = await ShiftTemplate.create({
      school,
      name: name.trim(),
      shift: shift || "matutino",
      startTime: startTime.trim(),
      endTime: endTime.trim(),
      moduleDurationMinutes: moduleDurationMinutes || 50,
      timeBlocks: timeBlocks || [],
      gracePeriodMinutes: gracePeriodMinutes ?? 30,
    });
    res.status(201).json(template);
  } catch (error) {
    next(error);
  }
};

// PUT /api/shift-templates/:templateId
const updateTemplate = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(404).json({ message: "Template not found." });
    }
    const updated = await ShiftTemplate.findOneAndUpdate(
      { _id: templateId, ...tenantFilter(req) },
      req.body,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Template not found." });
    }
    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/shift-templates/:templateId
const deleteTemplate = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(404).json({ message: "Template not found." });
    }
    const deleted = await ShiftTemplate.findOneAndDelete({
      _id: templateId,
      ...tenantFilter(req),
    });
    if (!deleted) {
      return res.status(404).json({ message: "Template not found." });
    }
    res.status(200).json({ message: "Template deleted." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
