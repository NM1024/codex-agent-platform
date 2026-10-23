// Composition of independent tool/artifact and delivery providers.
import {capabilityCatalog} from './capabilities/catalog.mjs';
import {deliveryCatalog} from './delivery/configured.mjs';
export function createPlatformCatalog(options) {
  const capabilities=capabilityCatalog(options),deliveries=deliveryCatalog(options);
  return {...capabilities,...deliveries,initializeStorage(context) {
    capabilities.initializeStorage(context);deliveries.initializeStorage(context);
  }};
}
