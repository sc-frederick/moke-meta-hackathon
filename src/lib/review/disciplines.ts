import { Schema } from "effect";

/** Discipline routing preserves the four distinct fire responsibilities from Moke. */
export const ReviewDiscipline = Schema.Literals([
  "general",
  "civil",
  "building_design",
  "life_safety",
  "structural",
  "mechanical",
  "electrical",
  "plumbing",
  "fire_alarm",
  "fire_sprinkler",
  "fire_protection",
]);

/** Human-readable scope names shared by setup and the execution summary. */
export const reviewDisciplines = [
  { id: "general", label: "General" },
  { id: "civil", label: "Civil" },
  { id: "building_design", label: "Building design" },
  { id: "life_safety", label: "Life safety" },
  { id: "structural", label: "Structural" },
  { id: "mechanical", label: "Mechanical" },
  { id: "electrical", label: "Electrical" },
  { id: "plumbing", label: "Plumbing" },
  { id: "fire_alarm", label: "Fire alarm" },
  { id: "fire_sprinkler", label: "Fire sprinkler" },
  { id: "fire_protection", label: "Fire protection" },
] as const;

/** Auto chooses a discipline from the request and selected drawing scope before admission. */
export const ReviewDisciplineSelection = Schema.Union([Schema.Literal("auto"), ReviewDiscipline]);
