// Loader/Skid Steer Pre-Delivery Inspection template
export const template = {
  type: 'PD',
  vehicle: 'LOADER',
  title: 'Pre-Delivery Inspection — Loader',
  sections: [
    // PLACEHOLDER — to be replaced with actual checklist items
    { id: 'nameplate',        label: 'Nameplate / 铭牌',            na_for: [] },
    { id: 'engine_oil',       label: 'Engine Oil / 机油',           na_for: [] },
    { id: 'coolant',          label: 'Coolant / 冷却液',            na_for: [] },
    { id: 'hydraulic_oil',    label: 'Hydraulic Oil / 液压油',      na_for: [] },
    { id: 'transmission_oil', label: 'Transmission Oil / 变速箱油', na_for: [] },
    { id: 'brake_fluid',      label: 'Brake Fluid / 刹车油',        na_for: [] },
    { id: 'diff_oil',         label: 'Differential Oil / 差速器油', na_for: [] },
    { id: 'air_filter',       label: 'Air Filter / 空滤',           na_for: [] },
    { id: 'fan_belt',         label: 'Fan Belt / 皮带',             na_for: [] },
    { id: 'tyres',            label: 'Tyres & Wheel Nuts / 轮胎螺栓', na_for: [] },
    { id: 'grease_points',    label: 'Grease Points / 黄油嘴',      na_for: [] },
    { id: 'lights_alarms',    label: 'Lights & Alarms / 灯光警报',  na_for: [] },
    { id: 'functional_test',  label: 'Function Test / 操作测试',    na_for: [] },
  ],
};
