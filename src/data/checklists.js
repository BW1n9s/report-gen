// PD 检查模板，基于 Hangcha 交付检测报告
// 按车型分类，电叉跳过发动机相关项

export const VEHICLE_TYPES = {
  FORKLIFT_ICE: '内燃叉车 (ICE Forklift)',
  FORKLIFT_ELECTRIC: '电动叉车 (Electric Forklift)',
  FORKLIFT_WALKIE: '步行式叉车 (Walkie/Pallet Jack)',
  WHEEL_LOADER: '装载机 (Wheel Loader)',
  SKID_STEER: '滑移装载机 (Skid Steer)',
  UNKNOWN: '未识别车型',
};

// 从型号前缀判断车型
export function detectVehicleType(model) {
  if (!model) return 'UNKNOWN';
  const m = model.toUpperCase();
  // 电动叉车：CPDS, CPBS, CPQD (electric), CQD
  if (/^(CPDS|CPBS|CPQDS|CBD|CQD)/.test(m)) return 'FORKLIFT_ELECTRIC';
  // 步行式：CDWS, CDD, CBD walkie
  if (/^(CDWS|CDDW|CBDW|WR|PJ)/.test(m)) return 'FORKLIFT_WALKIE';
  // 内燃叉车：CPCD, CPQYD, CPYD, HELI, HANGCHA ICE
  if (/^(CPCD|CPQYD|CPYD|CPQD|H[A-Z]F)/.test(m)) return 'FORKLIFT_ICE';
  // Loader
  if (/^(LM|ZL|LG|SEM|XG|LGMA)/.test(m)) return 'WHEEL_LOADER';
  // Skid Steer
  if (/^(SSL|SK|SL)/.test(m)) return 'SKID_STEER';
  // 默认按叉车处理（最常见）
  return 'FORKLIFT_ICE';
}

// 检查项定义
// id: 用于匹配 covered_checks
// label: 显示名称
// applicable: 适用的车型列表（空数组=全部适用）
// photo_required: 是否通常需要拍照记录

export const CHECKLIST_ITEMS = [
  // ── 证件与配件 ──
  { id: 'certificate', label: 'Certificate of Conformity / 合格证', applicable: [], photo_required: false },
  { id: 'accessories', label: 'Accessories / Tools / Keys / 随机配件', applicable: [], photo_required: false },

  // ── 发动机系统（仅内燃车辆）──
  { id: 'engine_oil', label: 'Engine Oil Level & Leak / 发动机油位及泄漏', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: true },
  { id: 'coolant', label: 'Coolant Level & Leak / 冷却液液位及泄漏', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: true },
  { id: 'fan_belt', label: 'Fan Belt / Alternator Belt / 皮带检查', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: false },
  { id: 'air_filter', label: 'Air Filter / 空气滤芯', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: true },

  // ── 电池系统（仅电动车辆）──
  { id: 'battery_charge', label: 'Battery Charge Level / 电池电量', applicable: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'], photo_required: true },
  { id: 'battery_connection', label: 'Battery Connection & Water Level / 电池连接及液位', applicable: ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'], photo_required: true },

  // ── 液压系统（全部）──
  { id: 'hydraulic_oil', label: 'Hydraulic Oil Level & Leak / 液压油位及泄漏', applicable: [], photo_required: true },

  // ── 传动系统（内燃）──
  { id: 'transmission_oil', label: 'Transmission Oil Level & Leak / 变速箱油位及泄漏', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: true },
  { id: 'brake_fluid', label: 'Brake Fluid Level & Condition / 刹车油位及状态', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: true },
  { id: 'diff_oil', label: 'Differential Gear Oil / 差速器油位', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER'], photo_required: true },

  // ── 轮胎 ──
  { id: 'tyres', label: 'Tyre Condition & Wheel Nuts / 轮胎状态及螺栓', applicable: [], photo_required: false },

  // ── 车架与外观 ──
  { id: 'frame_paint', label: 'Frame Weld & Paint / 车架焊接及漆面', applicable: [], photo_required: false },

  // ── 电气系统 ──
  { id: 'lights_alarms', label: 'Lights / Alarms / Instruments / 灯光警报仪表', applicable: [], photo_required: false },

  // ── 门架与附属 ──
  { id: 'mast_chain', label: 'Mast & Chain Lubrication / 门架链条润滑', applicable: ['FORKLIFT_ICE', 'FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'], photo_required: false },
  { id: 'fork_tyne', label: 'Fork Tyne Condition & Lubrication / 叉齿固定及润滑', applicable: ['FORKLIFT_ICE', 'FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'], photo_required: false },

  // ── 整车 ──
  { id: 'grease_points', label: 'All Grease Nipples Lubricated / 全车黄油嘴加注', applicable: [], photo_required: false },
  { id: 'bolt_tightening', label: 'Full Vehicle Bolt Tightening / 全车螺栓紧固', applicable: [], photo_required: false },
  { id: 'engine_run', label: 'Engine Run Test / 发动机运行检查', applicable: ['FORKLIFT_ICE', 'WHEEL_LOADER', 'SKID_STEER'], photo_required: false },
  { id: 'functional_test', label: 'Drive / Steer / Brake / Hydraulic Function Test / 行驶操作测试', applicable: [], photo_required: false },
];

// 获取指定车型的检查项
export function getChecklistForType(vehicleType) {
  return CHECKLIST_ITEMS.filter(
    (item) => item.applicable.length === 0 || item.applicable.includes(vehicleType)
  );
}

// 图片分析结果 → 检查项 ID 映射（关键词匹配）
export const CHECK_KEYWORDS = {
  engine_oil: ['engine oil', 'motor oil', '发动机油', '机油', 'oil dipstick', '油尺'],
  coolant: ['coolant', 'cooling', '冷却液', '防冻液', 'radiator'],
  fan_belt: ['fan belt', 'drive belt', 'alternator belt', '皮带'],
  air_filter: ['air filter', '空气滤芯', '空滤'],
  battery_charge: ['battery', 'SOC', 'charge', '电量', '电池', 'BMS'],
  battery_connection: ['battery connection', 'terminal', '电池连接', '电解液'],
  hydraulic_oil: ['hydraulic oil', 'hydraulic', '液压油', 'HV46'],
  transmission_oil: ['transmission', 'gearbox', '变速箱', '变速器'],
  brake_fluid: ['brake fluid', '刹车油', 'brake'],
  diff_oil: ['differential', 'diff', '差速器', '前桥'],
  tyres: ['tyre', 'tire', 'wheel', '轮胎', '轮毂'],
  mast_chain: ['mast', 'chain', '门架', '链条'],
  fork_tyne: ['fork', '叉齿', '货叉'],
  grease_points: ['grease', 'nipple', '黄油', '润滑脂'],
};
