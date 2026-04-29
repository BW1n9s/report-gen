export function parseCorrection(text, session) {
  if (!text) return null;

  const fields = {};

  const patterns = [
    { regex: /(?:s\/n|serial(?:\s+number)?)\s*[:\s]\s*([A-Z0-9\-]+)/i, key: 'serial', source: 'MANUAL' },
    { regex: /model\s*[:\s]\s*([A-Z0-9\-]+)/i,                         key: 'model' },
    { regex: /voltage\s*[:\s]\s*(\d+\s*V?)/i,                          key: 'voltage' },
    { regex: /capacity\s*[:\s]\s*([\d,]+\s*k?g?)/i,                    key: 'capacity' },
    { regex: /hours?\s*[:\s]\s*(\d+)/i,                                 key: 'hours' },
    { regex: /(?:mfg\s*)?date\s*[:\s]\s*(\d{4}[-\/]\d{2})/i,           key: 'manufactureDate' },
  ];

  for (const { regex, key, source } of patterns) {
    const match = text.match(regex);
    if (match) {
      fields[key] = match[1].trim();
      if (source === 'MANUAL') fields['serialSource'] = 'MANUAL';
    }
  }

  if (Object.keys(fields).length === 0) {
    const bareSerial = text.match(/^([A-Z0-9]{6,12})$/);
    if (bareSerial) {
      fields.serial = bareSerial[1];
      fields.serialSource = 'MANUAL';
    }
  }

  return Object.keys(fields).length > 0 ? { fields } : null;
}
