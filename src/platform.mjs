// Composition of independent tool/artifact and delivery providers.
import {capabilityCatalog} from './capabilities/catalog.mjs';
import {deliveryCatalog} from './delivery/configured.mjs';
import {notificationCatalog} from './notifications/catalog.mjs';
export function createPlatformCatalog(options) {
  const capabilities=capabilityCatalog(options),deliveries=deliveryCatalog(options),notifications=notificationCatalog();
  return {...capabilities,...deliveries,tools:{...capabilities.tools,...notifications.tools},deleteTaskHistory(context) {
    capabilities.deleteTaskHistory(context);deliveries.deleteTaskHistory(context);notifications.deleteTaskHistory(context);
  },initializeStorage(context) {
    capabilities.initializeStorage(context);deliveries.initializeStorage(context);notifications.initializeStorage(context);
  }};
}
