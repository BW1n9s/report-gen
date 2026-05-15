import { template as forkliftPdiTemplate } from './pd_forklift.js';
import { template as loaderPdiTemplate } from './pd_loader.js';

// Deduplicated union of all sub-items from both PDI templates (forklift + loader).
// Used by both analyzeImage.js (handwritten recognition) and lark.js (doc filling).
export const HANDWRITTEN_ITEM_CATALOG = (() => {
  const seen = new Set();
  const catalog = [];
  for (const tmpl of [forkliftPdiTemplate, loaderPdiTemplate]) {
    for (const section of tmpl.sections) {
      if (!Array.isArray(section.items)) continue;
      for (const item of section.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          catalog.push({ id: item.id, label: item.label, section: section.id });
        }
      }
    }
  }
  return catalog;
})();

// Map: sub-item ID → parent section ID (e.g. 'fl_engine_oil' → 'fluid_levels')
export const ITEM_SECTION_MAP = Object.fromEntries(
  HANDWRITTEN_ITEM_CATALOG.map(i => [i.id, i.section]),
);
