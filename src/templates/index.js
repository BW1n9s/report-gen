export async function getTemplate(reportType, vehicleType) {
  // vehicleType: FORKLIFT_ICE | FORKLIFT_ELECTRIC | FORKLIFT_WALKIE | WHEEL_LOADER | SKID_STEER | UNKNOWN
  // reportType: PD | SERVICE

  const isLoader = vehicleType === 'WHEEL_LOADER' || vehicleType === 'SKID_STEER';

  if (reportType === 'PD') {
    return isLoader
      ? (await import('./pd_loader.js')).template
      : (await import('./pd_forklift.js')).template;
  } else {
    return isLoader
      ? (await import('./service_loader.js')).template
      : (await import('./service_forklift.js')).template;
  }
}
