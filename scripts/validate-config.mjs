import { createApplication } from "../src/application.mjs";
try {
  const {registry}=createApplication("gateway");
  console.log("Configuration valid (no credentials displayed).");
  console.log('Persisted HTTP targets are validated when Gateway opens its configuration store.');
  for(const item of registry.configurationErrors())console.warn(`Plugin unavailable: ${item.type} (${item.error}): ${item.message}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
