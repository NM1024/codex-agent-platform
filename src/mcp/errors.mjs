import { HttpError } from "../errors.mjs";

// All text is service-owned. Never include exception messages or upstream bodies.
const descriptions = {
  INVALID_TOOL_INPUT: [
    "Tool arguments do not match the required schema.",
    "Correct the listed fields and call the tool again.",
    true,
  ],
  INVALID_RESULT: [
    "The final result does not match the required schema.",
    "Correct the listed result fields and call complete_task again.",
    true,
  ],
  TOOL_NOT_ALLOWED: [
    "This tool is not available for this task.",
    "Use listTools and choose an available tool.",
    true,
  ],
  TASK_CLOSED: [
    "This task no longer accepts business operations.",
    "Stop business tool calls; only replay the existing completion receipt.",
  ],
  OPERATIONS_PENDING: [
    "A tool call is still in progress.",
    "Wait for in-progress calls before submitting the final result.",
    true,
  ],
  COMPLETION_CONFLICT: [
    "A different final result has already been committed.",
    "Replay the original complete_task result to retrieve its receipt.",
  ],
  UNAUTHORIZED: [
    "The task authorization is no longer valid.",
    "Stop tool calls and report the authorization failure.",
  ],
  PROCESSOR_NOT_ALLOWED: [
    "This processor is not available for this task.",
    "Choose a processor provided by this task's module.",
  ],
  RUNNER_UNAVAILABLE: [
    "The runtime could not complete the request.",
    "Check task state before attempting another call.",
  ],
  RUNNER_BUSY: [
    "The runtime has no free execution slot.",
    "Wait for runtime capacity before requesting another call.",
    true,
  ],
  RUNNER_RECOVERING: [
    "The runtime is still recovering its state.",
    "Wait for runtime recovery before requesting another call.",
    true,
  ],
  RUNNER_STOPPING: [
    "The runtime is shutting down.",
    "Stop processing and report the runtime shutdown.",
  ],
};

export function validationFields(errors = [], prefix = "") {
  return errors.map(({ instancePath = "", keyword, params }) => ({
    path: `${prefix}${instancePath}${keyword === "required" ? `/${params.missingProperty}` : ""}` || "/",
    rule: keyword,
    message: {
      type: "Use the required value type.",
      required: "Provide this required field.",
      additionalProperties: "Remove fields not declared in the schema.",
      enum: "Use a value listed in the schema.",
    }[keyword] ?? "Follow this field's schema constraints.",
  }));
}

// Only a module's explicit public description (or its validated runtime copy)
// may provide business text. Never use Error.message or upstream response bodies.
export function publicDescription(value) {
  if (!value || typeof value !== "object" ||
      typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.code) ||
      typeof value.message !== "string" || !value.message || value.message.length > 2048 ||
      typeof value.action !== "string" || !value.action || value.action.length > 2048 ||
      typeof value.retryable !== "boolean") return undefined;
  const fields = Array.isArray(value.fields) ? value.fields.slice(0, 64)
    .filter((field) => typeof field === "string" ? field.length <= 2048
      : field && ["path", "rule", "message"].every((key) => typeof field[key] === "string" && field[key].length <= 2048))
    .map((field) => typeof field === "string" ? field
      : { path: field.path, rule: field.rule, message: field.message }) : [];
  return { code: value.code, message: value.message, action: value.action, retryable: value.retryable,
    ...(fields.length ? { fields } : {}) };
}
export function mcpError(error, { module, operationStatus = "not_started", fields } = {}) {
  const coreCode = error instanceof HttpError && Object.hasOwn(descriptions, error.code)
    ? error.code : undefined;
  let declared;
  if (!coreCode) {
    try { declared = publicDescription(module?.describeError?.(error)); } catch {}
    declared ??= publicDescription(error?.publicToolError);
  }
  fields ??= declared?.fields;
  const code = coreCode ?? declared?.code ?? "TOOL_EXECUTION_FAILED";
  const [message, action, retryable = false] = descriptions[coreCode] ?? [
    declared?.message ?? "The tool could not complete safely.",
    declared?.action ?? "Check the task inputs and tool requirements; correct the cause before calling again.",
    declared?.retryable ?? (operationStatus === "unknown" ? null : operationStatus === "failed" || operationStatus === "not_started"),
  ];
  const status = operationStatus === "unknown" ? "unknown" : ({
    TASK_CLOSED: "closed",
    COMPLETION_CONFLICT: "completed",
    OPERATIONS_PENDING: "pending",
  }[code] ?? operationStatus);
  return {
    code,
    message,
    retryable,
    operation_status: status,
    action: status === "unknown" && !declared
      ? "The call outcome is unknown. Use this tool’s recovery guidance to decide the next action."
      : action,
    ...(fields?.length ? { fields } : {}),
  };
}
