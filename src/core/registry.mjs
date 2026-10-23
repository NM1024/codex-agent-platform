import Ajv from "ajv";
import { createHash } from "node:crypto";
import { HttpError } from "../errors.mjs";
import { validateDefinition } from '../plugins/definition.mjs';
import { createConfiguredModule } from '../plugins/module.mjs';
import { configuredDelivery } from '../delivery/configured.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function fault(code, status = 409) {
  return new HttpError(status, code);
}
export class BusinessRegistry {
  constructor(modules = [], catalog = {}) {
    this.catalog = catalog;
    this.compiledDefinitions = new Map();
    this.modules = new Map();
    this.ajv = new Ajv({ allErrors: false, strict: true });
    for (const source of modules) {
      if (this.modules.has(source.type)) throw new Error("DUPLICATE_MODULE");
      const module = this.compile(source);
      this.modules.set(module.type, module);
    }
  }
  compile(source) {
      const module = { ...source, tools: source.tools ?? {} };
      module.checkInput = this.ajv.compile(module.inputSchema);
      module.checkResult = this.ajv.compile(module.resultSchema);
      module.tools = Object.fromEntries(Object.entries(module.tools).map(([name, tool]) => [
        name, { ...tool, check: this.ajv.compile(tool.inputSchema) },
      ]));
      return module;
  }
  compileDefinition(definition, options={}) {
    const validated=validateDefinition(definition,this.catalog,options);
    const key=JSON.stringify(validated);
    if (this.compiledDefinitions.has(key)) return this.compiledDefinitions.get(key);
    try {
      const module=this.compile(createConfiguredModule(validated,this.catalog));
      if(this.catalog.requirePluginConnections) {
        const availability=module.availability;
        module.availability=state=>this.pluginConnections&&!this.pluginConnections.status(module.type).ready?{ready:false,reason:'PLUGIN_CONNECTION_NOT_READY'}:(availability?.(state) ?? state);
        module.delivery=undefined;
      }
      this.compiledDefinitions.set(key,module);
      return module;
    }
    catch (error) {if (error instanceof HttpError) throw error;throw new HttpError(400,'INVALID_PLUGIN',`INVALID_PLUGIN: ${error.message}`);}
  }
  assertRoutes(module) {
    if(this.catalog.requirePluginConnections)return;
    for (const path of module.definition.routes ?? [])
      for (const existing of this.modules.values())
        if (existing.type!==module.type && existing.definition?.routes?.includes(path)) throw new HttpError(409,'ROUTE_CONFLICT',`ROUTE_CONFLICT: ${path}`);
  }
  registerDefinition(definition) {const module=this.compileDefinition(definition);this.assertRoutes(module);this.modules.set(module.type,module);return module;}
  routeFor(path) {return [...this.modules.values()].find(module=>module.definition?.routes?.includes(path));}
  forTask(row) {
    if (row.definition && (typeof row.definition==='string' ? JSON.parse(row.definition) : row.definition).type!==row.type) throw fault('INVALID_PLUGIN',400);
    const module=row.definition ? this.compileDefinition(typeof row.definition==='string' ? JSON.parse(row.definition) : row.definition,{snapshot:true}) : this.catalog.profiles?.[row.type] ? this.compile(this.catalog.profiles[row.type]) : this.get(row.type);
    if(!this.pluginConnections||!module.definition)return module;
    return {...module,
      availability:state=>this.pluginConnections.status(row.type).ready?(module.availability?.(state) ?? state):{ready:false,reason:'PLUGIN_CONNECTION_NOT_READY'},
      delivery:this.pluginConnections.callbackFor(row.type)?configuredDelivery(()=>this.pluginConnections.callbackFor(row.type)):undefined,
    };
  }
  get(type) {
    const module = this.modules.get(type);
    if (!module) throw fault("UNKNOWN_TYPE", 400);
    return module;
  }
  configurationErrors(){return [...this.modules.values()].flatMap(module=>{const error=module.configurationIssue?module.configurationIssue():module.configurationError;return error?[{type:module.type,error:error.code,message:error.message}]:[];});}
  normalize(body) {
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !["type", "request_id", "input"].includes(k),
      ) ||
      typeof body.request_id !== "string" ||
      !body.request_id.trim() ||
      body.request_id.length > 128
    )
      throw fault("INVALID_INPUT", 400);
    const module = this.get(body.type);
    if (module.definition?.enabled === false) throw fault('PLUGIN_DISABLED',409);
    if (!module.checkInput(body.input)) throw fault("INVALID_INPUT", 400);
    return { module, input: module.normalizeInput?.(body.input) ?? body.input };
  }
}
