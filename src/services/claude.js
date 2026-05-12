import { withRetry } from '../utils/retry.js';

// ─── System Prompts ───────────────────────────────────────────────────────────

export const PROMPT_IMAGE = `You are a forklift/loader inspection assistant. Analyse the photo and return ONLY a valid JSON object, no other text.

Output schema:
{
  "check_id": "<section id from list below>",
  "reading": "<objective observation only, max 12 words, no judgement>",
  "nameplate": null,
  "picking_list": null
}

Section IDs — pick the single best match:
  nameplate              — data plate, serial number plate, rating plate
  picking_list           — delivery picking list, packing slip, invoice or order document showing customer name, VIN/Engine No., model, invoice number
  handwritten_pdi        — handwritten or printed PDI / inspection checklist form with multiple rows of check items and marks (ticks, crosses, NA)
  attachment_accessories — keys, manuals, charger, forks, attachments
  visual_structure       — body panels, paint, frame, overhead guard, decals, wiring
  fluid_levels           — any fluid level, coolant, fuel, hydraulic oil, fluid leaks
  engine_mechanical      — engine start/idle, belts, air filter, exhaust, mounts
  electrical_system      — battery, lights, horn, dashboard, Curtis controller
  hydraulic_system       — pump, hoses, cylinders, lift/tilt/sideshift/valve
  mast_fork_chain        — mast rails, chains, fork arms, carriage (forklifts)
  loader_arm_axle        — loader arm, axles, bucket pins (loaders)
  steering_brake_dynamic — drive test, brakes, steering, noise/vibration
  tyre_wheel             — tyre, pressure, wear, wheel nuts, rim
  safety_functions       — seat switch, interlock, reverse alarm, beacon, mirrors
  maintenance_work       — completed work: oil change, filter, grease, lube
  final_result           — overall test complete, ready-for-delivery
  general                — cannot match any section above

Nameplate schema (when check_id="nameplate"):
{
  "check_id": "nameplate",
  "reading": "nameplate visible",
  "nameplate": {
    "model": "string or null",
    "serial": "string or null — ONLY from SERIAL NO. field",
    "capacity_kg": number or null,
    "year": "YYYY or null",
    "voltage": number or null,
    "vehicle_type": "FORKLIFT_ICE|FORKLIFT_ELECTRIC|FORKLIFT_WALKIE|WHEEL_LOADER|UNKNOWN",
    "confirm_needed": false,
    "confirm_prompt": null
  },
  "picking_list": null
}

Picking list schema (when check_id="picking_list"):
{
  "check_id": "picking_list",
  "reading": "picking list detected",
  "nameplate": null,
  "picking_list": {
    "customer": "company/customer name or null",
    "invoice_number": "invoice or order number exactly as printed (e.g. INV-26113B) or null",
    "vin": "VIN or Engine No. for the MAIN MACHINE only — extract character-for-character as printed, or null",
    "model": "model code for the main machine only — the SHORT code only (e.g. CPD35-XAJ4-I, LM938), NOT the full product description, or null",
    "invoice_date": "date string as printed or null",
    "contact": "contact person name or null",
    "djj_code": "DJJ product code for the main machine or null",
    "attachments": [
      {
        "djj_code": "DJJ code for this line item or null",
        "name": "attachment/accessory name and model as printed (e.g. GP Bucket LM938, Pallet Fork LM938, Charger)"
      }
    ]
  }
}

Attachments rules:
- attachments = every line item that is NOT the main machine and NOT a shipping/freight fee
- Examples of attachments: GP Bucket, Pallet Fork, Side Shifter, Fork Positioner, Work Light, Charger, Spare Parts
- If no attachments exist, return "attachments": []
- Do NOT include the main machine or shipping/freight lines in attachments

Rules:
- reading = objective observation only, never use ok/good/normal/bad/damaged
- uncertain digits in serial: "3[6?]BE01543", confirm_needed=true
- If ELECTRIC context: note engine/transmission items as not applicable in reading
- For picking_list: extract VIN/Engine No. character-for-character as it appears in the document`;

export const PROMPT_CORRECTION = `User is correcting or annotating an inspection photo.
Extract the correction into JSON only, no other text.
{
  "action": "ng | correction",
  "reading": "corrected observation, max 15 words, objective",
  "note": "additional context if any, max 15 words, or null"
}
action "ng" = user says item is defective/abnormal/damaged/needs attention
action "correction" = user is clarifying what the item actually is or adding detail`;

export const PROMPT_TEXT = `Extract inspection note into JSON only, no other text.
{
  "check_id": "nameplate|attachment_accessories|visual_structure|fluid_levels|engine_mechanical|electrical_system|hydraulic_system|mast_fork_chain|loader_arm_axle|steering_brake_dynamic|tyre_wheel|safety_functions|maintenance_work|final_result|general",
  "status": "ok|low|leak|dirty|missing|noted|n/a",
  "reading": "objective fact only, max 12 words"
}`;

// ─── API Call Helper ──────────────────────────────────────────────────────────

async function callClaude(payload, env, timeoutMs = 25000) {
  const data = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(
          new Error(`Claude API timeout after ${timeoutMs / 1000}s`),
          { status: 408 },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 429) return response;
    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(
        new Error(`Claude API error ${response.status}: ${errText}`),
        { status: response.status },
      );
    }
    return response.json();
  });

  return data.content[0].text;
}

// ─── Exported Functions ───────────────────────────────────────────────────────

export async function analyzeImageWithClaude(imageData, env, timeoutMs = 25000, vehicleContext = null) {
  const { base64, mediaType } = imageData;

  let contextNote = '';
  if (vehicleContext) {
    contextNote = `\n\nVehicle context: ${vehicleContext}`;
  }

  const payload = {
    model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 500,
    system: PROMPT_IMAGE + contextNote,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
      { type: 'text', text: 'Analyse.' },
    ]}],
  };

  const raw = await callClaude(payload, env, timeoutMs);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { check_id: 'general', status: 'unreadable', reading: 'parse error', nameplate: null, picking_list: null };
  }
}

export async function analyzeCorrection(userText, originalReading, env) {
  const payload = {
    model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 120,
    system: PROMPT_CORRECTION,
    messages: [{
      role: 'user',
      content: `Original reading: "${originalReading}"\nUser correction: "${userText}"`,
    }],
  };
  const raw = await callClaude(payload, env, 10000);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { action: 'correction', reading: userText.slice(0, 80), note: null };
  }
}

export async function analyzeTextWithClaude(text, env, timeoutMs = 15000) {
  const payload = {
    model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 150,
    system: PROMPT_TEXT,
    messages: [{ role: 'user', content: text }],
  };

  const raw = await callClaude(payload, env, timeoutMs);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { check_id: 'general', status: 'noted', reading: text.slice(0, 80), raw: text };
  }
}

// ─── Handwritten PDI Extraction ───────────────────────────────────────────────

/**
 * itemCatalog: [{ id, label, section }] — full list from both PDI templates
 * Returns: { is_pdi_form: bool, items: [{ item_id, status: "ok|ng|na", reading }] }
 */
export async function analyzeHandwrittenPdiItems(imageData, itemCatalog, env) {
  const catalogText = itemCatalog
    .map(i => `  ${i.id}: ${i.label}`)
    .join('\n');

  const system = `You are a PDI inspection form reader. The photo shows a HANDWRITTEN or PRINTED Pre-Delivery Inspection (PDI) checklist.

Your task: identify every check item in the form that has been MARKED, and return its status.

Mark interpretation:
- ✓ √ tick checkmark = "ok"
- ✗ × X cross = "ng"
- \\ or NA or N/A or / (forward slash used as N/A) = "na"
- blank / empty / dash = do NOT include (skip unchecked items)

Return ONLY valid JSON, no other text:
{
  "is_pdi_form": true,
  "items": [
    { "item_id": "<id from catalog below>", "status": "ok|ng|na", "reading": "<handwritten note beside the mark, max 10 words, or null>" }
  ]
}

If this is NOT a PDI/inspection checklist form: { "is_pdi_form": false, "items": [] }

Rules:
- Only include items you can CLEARLY see as marked — never guess
- Match each row to the catalog by its English or Chinese label text visible in the form
- If a row label does not match any catalog entry, omit it
- "reading" = any handwritten annotation next to the mark (e.g. "replace", "low", "2500 hrs"), or null

Item catalog (item_id: English label / 中文标签):
${catalogText}`;

  const payload = {
    model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: imageData.mediaType || 'image/jpeg', data: imageData.base64 } },
      { type: 'text', text: 'Extract all marked items from this PDI form.' },
    ]}],
  };

  const raw = await callClaude(payload, env, 45000);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { is_pdi_form: false, items: [] };
  }
}
