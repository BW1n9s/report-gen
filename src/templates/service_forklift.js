// Forklift Service Report template
export const template = {
  type: 'SERVICE',
  vehicle: 'FORKLIFT',
  title: 'Service Report — Forklift',
  sections: [
    // PLACEHOLDER — service reports are less structured than PD
    // sections here define the output grouping order
    { id: 'nameplate',      label: 'Vehicle Info' },
    { id: 'engine_oil',     label: 'Engine Oil' },
    { id: 'coolant',        label: 'Coolant' },
    { id: 'hydraulic_oil',  label: 'Hydraulic Oil' },
    { id: 'battery_charge', label: 'Battery' },
    { id: 'tyres',          label: 'Tyres' },
    { id: 'general',        label: 'Other / Additional Work' },
  ],
};
