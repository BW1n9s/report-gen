import { withRetry } from '../utils/retry.js';

// ─── System Prompts ───────────────────────────────────────────────────────────

export const PROMPT_IMAGE = `You are a DJJ Equipment service technician assistant specialising in Hangcha forklifts, LGMA wheel loaders, and related industrial vehicles (electric forklifts, walkie stackers, pallet jacks, skid steers).

VEHICLE IDENTIFICATION:
- Hangcha ICE forklifts: model prefix CPCD, CPQYD, CPYD (red/maroon body)
- Hangcha electric forklifts: model prefix CPDS, CPBS (counterbalanced electric)
- Walkie/reach: CDWS, walkie stackers, pallet jacks
- LGMA wheel loaders: LM930, LM938, LM940, LM946 (yellow body)
- Skid steer: various

NAMEPLATE READING (highest priority task):
When you see a nameplate/data plate, extract ALL visible fields:
- Model, Serial No (VIN), Rated Capacity, Year of Manufacture, Voltage (electric), Service Weight

OIL & FLUID ASSESSMENT RULES (critical):
1. Dipstick colour: The dipstick itself is black/dark metal — this is the material colour, NOT the oil colour
2. Judge oil colour ONLY from the fluid film/residue on the measurement zone of the dipstick, or from oil in a container
3. Hydraulic oil: clear/light yellow = normal; dark brown/black = degraded
4. Engine oil: amber/brown = normal; black and thick = needs changing
5. Transmission fluid: red/pink = normal (ATF); dark brown = degraded
6. Differential gear oil: amber/yellow-green = normal; if contaminated with water it may appear milky
7. Coolant: green/blue/orange = normal; rust-coloured or empty = issue
8. When oil level or colour CANNOT be clearly determined from the photo, say so explicitly

SERVICE STICKER READING:
When you see a DJJ Equipment service sticker, extract: Date, Hours, Service Type, Next Service Due date and hours.

OUTPUT FORMAT (strict):
Equipment: [brand + model if visible, or description]
Check Item: [what is being inspected]
Reading/Finding: [specific values or observations]
Status: [Normal / Monitor / Action Required / Critical]
Notes: [engineering language; flag uncertainties explicitly]`;

export const PROMPT_TEXT = `You are a DJJ Equipment service technician assistant. The technician has sent a voice-to-text or typed note about a service or inspection. Extract and structure the information.

Extract:
- Equipment model / serial number / hours (if mentioned)
- Work performed or issue observed
- Any parts replaced or fluids topped up
- Next action recommended

Output format:
Equipment: [model / serial / hours if mentioned, or "Not specified"]
Action/Finding: [structured description in engineering language]
Status: [Completed / Issue Found / Follow-up Required]
Notes: [preserve important details; flag if clarification needed]`;

export const PROMPT_DETECT_VEHICLE = `You are reading a Hangcha or DJJ Equipment nameplate/data plate image. Extract ALL visible information and return ONLY a JSON object with no other text:

{
  "model": "exact model string or null",
  "serial": "serial/VIN number or null",
  "capacity_kg": number or null,
  "year": "YYYY or YYYY-MM or null",
  "voltage": number or null,
  "brand": "HANGCHA or LGMA or other or null",
  "vehicle_type_hint": "ICE_FORKLIFT or ELECTRIC_FORKLIFT or WALKIE or WHEEL_LOADER or SKID_STEER or UNKNOWN",
  "confirmNeeded": boolean,
  "confirmPrompt": "question to ask user if confirmNeeded is true, else null",
  "flags": []
}

vehicle_type_hint rules:
- If model starts with CPDS, CPBS, CBD → ELECTRIC_FORKLIFT
- If model starts with CPCD, CPQYD, CPYD → ICE_FORKLIFT
- If model starts with LM, ZL → WHEEL_LOADER
- If it says "ELECTRIC" or has a Voltage field → ELECTRIC_FORKLIFT
- If it says "INTERNAL COMBUSTION" → ICE_FORKLIFT

## SERIAL NUMBER — STRICT RULES
The vehicle Serial Number is ONLY taken from the "SERIAL NO." field on the metal nameplate.

Other numbers you may see and how to handle them:
- Chassis/frame number (车架编号, format: XCISD…, ~20 chars): IGNORE — do not store as serial
- Battery component number on conformity cert (合格证): use ONLY to cross-check nameplate serial

Cross-check logic:
- If nameplate serial and cert battery number differ by 1–2 characters, flag as likely OCR/glare misread
- Always keep the nameplate value; note the discrepancy in flags[]
- Example: nameplate=36BE01543, cert=33BE01543 → serial=36BE01543, flag="cert digit may be OCR misread (3→6)"

Uncertain digits (glare/blur/reflection):
- Mark uncertain characters with [?] — e.g. "3[6?3]BE01543"
- Set confirmNeeded=true and write a confirmPrompt asking the user to verify
- Do NOT silently guess`;

export const PROMPT_REPORT_PD = `You are generating a DJJ Equipment Pre-Delivery Inspection (PD) report. Format it as a clean internal record.

Structure:
1. Header: vehicle details, date, technician
2. Checklist table: each item with result (✓ Checked / — Not recorded / ✗ Issue)
3. Issues & Abnormalities section (if any)
4. Sign-off line

Use English. Be concise. No customer-facing language needed — this is an internal record.`;

export const PROMPT_REPORT_SERVICE = `You are generating a DJJ Equipment Service Report. Format it to match this structure:

[Vehicle line: Model | Serial No. | Hours]
Service Type: [250hr / 500hr / Minor / Major / etc.]
Date: [date]

Work Completed:
[bullet list of each task]

Parts/Fluids Used:
[list if mentioned, or "Not recorded"]

Next Service Due:
[date or hours if mentioned, else "As per service sticker"]

Notes:
[any follow-up items, customer observations, recommendations]

Use English. Concise engineering language.`;

// ─── API Call Helper ──────────────────────────────────────────────────────────

async function callClaude(env, systemPrompt, userContent, maxTokens = 1024) {
  const payload = {
    model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  const CLAUDE_TIMEOUT_MS = 20000;

  const data = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

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
        throw Object.assign(new Error('Claude API timeout after 20s'), { status: 408 });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 429) return response;
    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`Claude API error ${response.status}: ${errText}`), { status: response.status });
    }
    return response.json();
  });

  return data.content[0].text;
}

// ─── Exported Functions ───────────────────────────────────────────────────────

export async function analyzeImageWithClaude(imageData, env) {
  const { base64, mediaType } = imageData;
  return callClaude(env, PROMPT_IMAGE, [
    { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
    { type: 'text', text: 'Please analyse this inspection photo.' },
  ]);
}

// Dedicated nameplate extraction → returns parsed JSON or null
export async function extractNameplateData(imageData, env) {
  const { base64, mediaType } = imageData;
  try {
    const raw = await callClaude(env, PROMPT_DETECT_VEHICLE, [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
      { type: 'text', text: 'Extract nameplate data as JSON.' },
    ], 256);
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export async function analyzeTextWithClaude(text, env) {
  return callClaude(env, PROMPT_TEXT, text);
}

export async function generateReportWithClaude(summaries, datetime, reportType, vehicleInfo, env) {
  const prompt = `Date/Time: ${datetime}
Vehicle: ${vehicleInfo}

Records:
${summaries}`;

  const systemPrompt = reportType === 'PD' ? PROMPT_REPORT_PD : PROMPT_REPORT_SERVICE;
  return callClaude(env, systemPrompt, prompt, 2048);
}
