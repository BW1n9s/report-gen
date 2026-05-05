import { template as forkliftPdiTemplate } from './pd_forklift.js';
import { template as loaderPdiTemplate } from './pd_loader.js';
import { template as forkliftServiceTemplate } from './service_forklift.js';
import { template as loaderServiceTemplate } from './service_loader.js';

// vehicleType: FORKLIFT_ICE | FORKLIFT_ELECTRIC | FORKLIFT_WALKIE | WHEEL_LOADER | UNKNOWN
// reportType:  PDI | SERVICE

export function getTemplate(reportType, vehicleType) {
  if (reportType === 'PDI') {
    if (vehicleType === 'WHEEL_LOADER') return loaderPdiTemplate;
    return forkliftPdiTemplate; // ICE / ELECTRIC / WALKIE / UNKNOWN
  }
  if (reportType === 'SERVICE') {
    if (vehicleType === 'WHEEL_LOADER') return loaderServiceTemplate;
    return forkliftServiceTemplate;
  }
  throw new Error('Unknown reportType: ' + reportType);
}
