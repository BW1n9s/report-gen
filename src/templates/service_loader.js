// Loader Service Report template
export const template = {
  type: 'SERVICE',
  vehicle: 'LOADER',
  title: 'Wheel Loader Service Record / 装载机服务记录',

  sections: [

    {
      id: 'job_info',
      label: 'Job Information / 工单信息',
      has_result: false,
      na_for: [],
      fields: [
        'customer', 'job_number', 'machine_type', 'model',
        'serial_number', 'hour_meter', 'date', 'technician', 'location',
        'labour_hours', 'charge_amount',
      ],
    },

    {
      id: 'service_scope',
      label: 'Service Scope / 服务类型',
      has_result: false,
      na_for: [],
      options: [
        { id: 'sc_scheduled',  label: 'Scheduled maintenance / 定期保养' },
        { id: 'sc_breakdown',  label: 'Breakdown repair / 故障维修' },
        { id: 'sc_customer',   label: 'Customer requested / 应客要求' },
        { id: 'sc_warranty',   label: 'Warranty claim / 保修' },
        { id: 'sc_inspection', label: 'Inspection only / 仅检查' },
        { id: 'sc_other',      label: 'Other / 其他', allow_note: true },
      ],
    },

    {
      id: 'work_performed',
      label: 'Work Performed / 已完成工作',
      has_result: false,
      na_for: [],
      items: [
        { id: 'wp_engine_oil_change',  label: 'Engine oil changed / 已更换机油' },
        { id: 'wp_oil_filter',         label: 'Engine oil filter changed / 已更换机油滤芯' },
        { id: 'wp_air_filter_clean',   label: 'Air filter cleaned / 已清理空气滤芯' },
        { id: 'wp_air_filter_replace', label: 'Air filter replaced / 已更换空气滤芯' },
        { id: 'wp_hydraulic_oil',      label: 'Hydraulic oil topped up / changed / 液压油' },
        { id: 'wp_hydraulic_filter',   label: 'Hydraulic filter replaced / 液压滤芯' },
        { id: 'wp_transmission',       label: 'Transmission fluid changed / topped up / 变速箱油' },
        { id: 'wp_trans_filter',       label: 'Transmission filter replaced / 变速箱滤芯' },
        { id: 'wp_fuel_filter',        label: 'Fuel filter replaced / 燃油滤芯' },
        { id: 'wp_water_sep',          label: 'Water separator checked / drained / 油水分离器' },
        { id: 'wp_coolant',            label: 'Coolant topped up / 已添加冷却液' },
        { id: 'wp_brake_fluid',        label: 'Brake fluid checked / topped up / 刹车油' },
        { id: 'wp_fuel_level',         label: 'Fuel level checked / 燃油液位' },
        { id: 'wp_axle_oil',           label: 'Front and rear diff oil checked / topped up / 前后桥油' },
        { id: 'wp_grease',             label: 'Grease points serviced / 已加注黄油点' },
        { id: 'wp_arm_pins_grease',    label: 'Loader arm and bucket pins greased / 大臂铲斗销轴润滑' },
        { id: 'wp_tyre_pressure',      label: 'Tyre pressure checked / 已检查胎压' },
        { id: 'wp_wheel_torque',       label: 'Wheel nut torque checked / 已检查轮胎螺丝扭矩' },
        { id: 'wp_test_drive',         label: 'Test drive completed / 已完成试车' },
        { id: 'wp_other',              label: 'Other work / 其他工作', allow_note: true },
      ],
    },

    {
      id: 'parts_used',
      label: 'Parts Used / 使用配件',
      has_result: false,
      na_for: [],
      // 动态数组: { part_name: string, part_number: string, quantity: number }
    },

    {
      id: 'findings',
      label: 'Findings / 检查发现',
      has_result: false,
      na_for: [],
      // 动态数组: { description: string, action_taken: string, status: 'completed'|'pending'|'monitor'|'quoted' }
    },

    {
      id: 'recommendations',
      label: 'Recommendations / 建议跟进项',
      has_result: false,
      na_for: [],
      // 动态数组: { description: string, priority: 'urgent'|'soon'|'monitor' }
    },

    {
      id: 'test_result',
      label: 'Post-Service Test Result / 服务后测试结果',
      has_result: true,
      result_options: ['OK', 'NG', 'Partial'],
      na_for: [],
      items: [
        { id: 'tr_tested',     label: 'Machine tested after service / 服务后已测试' },
        { id: 'tr_functional', label: 'Machine functional / 车辆功能正常' },
        { id: 'tr_no_faults',  label: 'No active faults / 无当前故障' },
      ],
      final_fields: ['final_comments', 'technician', 'date', 'signature'],
    },

  ],
};
