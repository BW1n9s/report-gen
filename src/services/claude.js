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

SERIAL NUMBER — STRICT RULES:
The vehicle Serial Number is ONLY taken from the "SERIAL NO." field on the metal nameplate.
- Chassis/frame number (~20 chars starting with XCI): IGNORE
- Mark uncertain digits with [?], e.g. "3[6?3]BE01543"

OUTPUT FORMAT (strict) — you MUST always output both sections:

ANALYSIS:
Equipment: [brand + model if visible, or description]
Check Item: [what is being inspected]
Reading/Finding: [specific values or observations]
Status: [Normal / Monitor / Action Required / Critical]
Notes: [engineering language; flag uncertainties explicitly; do NOT make recommendations beyond what is directly visible — record objective findings only]

NAMEPLATE_JSON:
{"is_nameplate":false}

If a nameplate IS visible, replace the NAMEPLATE_JSON line with the full JSON:
{"is_nameplate":true,"model":"...","serial":"...","capacity_kg":null,"year":"...","voltage":null,"brand":"...","vehicle_type_hint":"...","confirmNeeded":false,"confirmPrompt":null,"flags":[]}

vehicle_type_hint values: ICE_FORKLIFT | ELECTRIC_FORKLIFT | WALKIE | WHEEL_LOADER | SKID_STEER | UNKNOWN`;

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

export const PROMPT_REPORT_PD = `You are generating a DJJ Equipment Pre-Delivery Inspection (PD) report. Format it as a clean internal record.

Structure:
1. Header: vehicle details, date, technician
2. Checklist table: each item with result (✓ Checked / — Not recorded / ✗ Issue)
3. Issues & Abnormalities section (if any)
4. Sign-off line

Use English. Be concise. No customer-facing language needed — this is an internal record.
IMPORTANT: Report findings objectively. Do not make recommendations beyond what the photos and notes directly show. Do not replace the operator's judgment — flag observations only.`;

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

Use English. Concise engineering language.
IMPORTANT: Only include what was directly observed or recorded. Do not infer or add recommendations unless explicitly noted by the operator.`;

// ─── API Call Helper ──────────────────────────────────────────────────────────

// timeoutMs is per-attempt (not total); callers choose based on their budget
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

function basePayload(env, systemPrompt, userContent, maxTokens) {
  return {
    model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };
}

// ─── Exported Functions ───────────────────────────────────────────────────────

export async function analyzeImageWithClaude(imageData, env, timeoutMs = 25000, vehicleContext = null) {
  const { base64, mediaType } = imageData;

  let contextNote = '';
  if (vehicleContext) {
    contextNote = `\n\nVEHICLE CONTEXT FOR THIS SESSION:\n${vehicleContext}\nUse this context when interpreting ambiguous readings (e.g. electric forklifts do not have engine oil).`;
  }

  const payload = basePayload(env, PROMPT_IMAGE + contextNote, [
    { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
    { type: 'text', text: 'Please analyse this inspection photo.' },
  ], 1200);
  return callClaude(payload, env, timeoutMs);
}

export function parseAnalysisResponse(raw) {
  const analysisMatch = raw.match(/ANALYSIS:\n([\s\S]*?)(?=\nNAMEPLATE_JSON:|$)/);
  const jsonMatch = raw.match(/NAMEPLATE_JSON:\n(\{[\s\S]*\})/);

  const analysis = analysisMatch ? analysisMatch[1].trim() : raw.trim();

  let nameplateData = null;
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (parsed.is_nameplate === true) {
        nameplateData = parsed;
      }
    } catch (_) {}
  }

  return { analysis, nameplateData };
}

export async function analyzeTextWithClaude(text, env, timeoutMs = 25000) {
  const payload = basePayload(env, PROMPT_TEXT, text, 1024);
  return callClaude(payload, env, timeoutMs);
}

export async function generateReportWithClaude(summaries, datetime, reportType, vehicleInfo, env, timeoutMs = 25000) {
  const prompt = `Date/Time: ${datetime}
Vehicle: ${vehicleInfo}

Records:
${summaries}`;

  const payload = basePayload(
    env,
    reportType === 'PD' ? PROMPT_REPORT_PD : PROMPT_REPORT_SERVICE,
    prompt,
    2048,
  );
  return callClaude(payload, env, timeoutMs);
}
