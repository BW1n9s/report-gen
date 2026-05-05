import { withRetry } from '../utils/retry.js';

// ─── System Prompts ───────────────────────────────────────────────────────────

export const PROMPT_IMAGE = `You are a forklift/loader inspection assistant. Analyse the photo and return ONLY a JSON object, no other text.

Output schema:
{
  "check_id": "one of: engine_oil|coolant|hydraulic_oil|transmission_oil|brake_fluid|diff_oil|battery_charge|battery_connection|air_filter|fan_belt|tyres|mast_chain|fork_tyne|grease_points|nameplate|service_sticker|general",
  "status": "ok|low|leak|dirty|missing|unreadable|n/a",
  "reading": "brief factual value or observation, max 15 words",
  "nameplate": null
}

If the photo shows a nameplate/data plate, set check_id="nameplate" and populate nameplate field:
{
  "check_id": "nameplate",
  "status": "ok",
  "reading": "nameplate visible",
  "nameplate": {
    "model": "string or null",
    "serial": "string or null — ONLY from SERIAL NO. field on metal plate",
    "capacity_kg": number or null,
    "year": "YYYY or null",
    "voltage": number or null,
    "vehicle_type": "ICE_FORKLIFT|ELECTRIC_FORKLIFT|WALKIE|WHEEL_LOADER|SKID_STEER|UNKNOWN",
    "confirm_needed": false,
    "confirm_prompt": null
  }
}

Rules:
- status "n/a" = item not relevant to this vehicle type (e.g. engine_oil on electric forklift)
- reading must be objective fact only, no recommendations
- uncertain digits: use [?] notation e.g. "3[6?]BE01543", set confirm_needed=true
- If vehicle context says ELECTRIC: engine_oil/transmission_oil/fuel → status "n/a"`;

export const PROMPT_TEXT = `Extract inspection note into JSON only, no other text.
{
  "check_id": "one of: engine_oil|coolant|hydraulic_oil|transmission_oil|brake_fluid|diff_oil|battery_charge|battery_connection|air_filter|tyres|mast_chain|fork_tyne|general",
  "status": "ok|low|leak|dirty|missing|noted",
  "reading": "brief factual summary, max 15 words",
  "raw": "copy of original text"
}`;

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

  const raw = await callClaude(payload, env, timeoutMs);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { check_id: 'general', status: 'unreadable', reading: 'parse error', nameplate: null };
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
