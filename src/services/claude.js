import { withRetry } from '../utils/retry.js';

// ─── System Prompts ───────────────────────────────────────────────────────────

export const PROMPT_IMAGE = `You are a forklift/loader inspection assistant. Analyse the photo and return ONLY a valid JSON object, no other text.

Output schema:
{
  "check_id": "<section id from list below>",
  "reading": "<objective observation only, max 12 words, no judgement>",
  "nameplate": null
}

Section IDs — pick the single best match:
  nameplate              — data plate, serial number plate, rating plate
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
  }
}

Rules:
- reading = objective observation only, never use ok/good/normal/bad/damaged
- uncertain digits in serial: "3[6?]BE01543", confirm_needed=true
- If ELECTRIC context: note engine/transmission items as not applicable in reading`;

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

// timeoutMs is per-attempt (not total); maxAttempts=1 for image analysis (no retry on timeout)
async function callClaude(payload, env, timeoutMs = 25000, maxAttempts = 4) {
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
  }, { maxAttempts });

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
    max_tokens: 300,
    system: PROMPT_IMAGE + contextNote,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
      { type: 'text', text: 'Analyse.' },
    ]}],
  };

  const raw = await callClaude(payload, env, 20000, 1); // 20s, no retry for image analysis
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { check_id: 'general', status: 'unreadable', reading: 'parse error', nameplate: null };
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
