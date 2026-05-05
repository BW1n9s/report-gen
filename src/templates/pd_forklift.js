// Forklift Pre-Delivery Inspection template
// sections: ordered list of check items for this vehicle type
// each item: { id, label, na_for: [] }
// na_for: vehicle subtypes where this item is N/A (e.g. 'FORKLIFT_ELECTRIC')
export const template = {
  type: 'PD',
  vehicle: 'FORKLIFT',
  title: 'Pre-Delivery Inspection — Forklift',
  sections: [
    // PLACEHOLDER — to be replaced with actual checklist items
    { id: 'nameplate',          label: 'Nameplate / 铭牌',                 na_for: [] },
    { id: 'engine_oil',         label: 'Engine Oil / 机油',                na_for: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'] },
    { id: 'coolant',            label: 'Coolant / 冷却液',                  na_for: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'] },
    { id: 'hydraulic_oil',      label: 'Hydraulic Oil / 液压油',            na_for: [] },
    { id: 'transmission_oil',   label: 'Transmission Oil / 变速箱油',       na_for: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'] },
    { id: 'brake_fluid',        label: 'Brake Fluid / 刹车油',              na_for: ['FORKLIFT_WALKIE'] },
    { id: 'diff_oil',           label: 'Differential Oil / 差速器油',       na_for: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'] },
    { id: 'battery_charge',     label: 'Battery Charge / 电量',             na_for: ['FORKLIFT_ICE'] },
    { id: 'battery_connection', label: 'Battery Connection / 电池连接',     na_for: ['FORKLIFT_ICE'] },
    { id: 'air_filter',         label: 'Air Filter / 空滤',                 na_for: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'] },
    { id: 'fan_belt',           label: 'Fan Belt / 皮带',                   na_for: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'] },
    { id: 'tyres',              label: 'Tyres & Wheel Nuts / 轮胎螺栓',     na_for: [] },
    { id: 'mast_chain',         label: 'Mast & Chain / 门架链条',           na_for: [] },
    { id: 'fork_tyne',          label: 'Fork Tyne / 货叉',                  na_for: [] },
    { id: 'grease_points',      label: 'Grease Points / 黄油嘴',            na_for: [] },
    { id: 'lights_alarms',      label: 'Lights & Alarms / 灯光警报',        na_for: [] },
    { id: 'functional_test',    label: 'Function Test / 操作测试',          na_for: [] },
  ],
};
