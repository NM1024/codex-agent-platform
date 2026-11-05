export function safeDiagnostic(text,secrets=[],{maxLength=4096}={}) {
  if (typeof text!=='string') return null;
  let value=text.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1[REDACTED]');
  for (const secret of secrets) if (typeof secret==='string' && secret.length) value=value.replaceAll(secret,'[REDACTED]');
  return maxLength===null?value:value.slice(0,maxLength);
}

const rpcReasons = new Map([
  [-32700, ['parse_error', 'Upstream could not parse the RPC request.']],
  [-32600, ['invalid_request', 'Upstream rejected the RPC request format.']],
  [-32601, ['method_not_found', 'Upstream does not support this RPC method.']],
  [-32602, ['invalid_params', 'Upstream rejected the RPC parameters.']],
  [-32603, ['internal_error', 'Upstream encountered an internal RPC error.']],
]);
const rpcMessageReasons = new Map([
  ['thread not found', ['thread_not_found', 'The requested Codex thread was not found.']],
  ['rate limit exceeded', ['rate_limited', 'Upstream rate limit exceeded.']],
  ['authentication required', ['authentication_required', 'Upstream authentication is required.']],
  ['model not found', ['model_not_found', 'The requested model was not found.']],
  ['server is busy', ['server_busy', 'Upstream is busy.']],
]);

// RPC messages can echo prompts, paths, account details and credentials that
// pattern redaction cannot reliably identify. Retain only a bounded integer and
// service-owned explanations; never copy message text, data or the raw error.
export function safeRpcDiagnostic(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error) ||
      !Number.isInteger(error.code) || error.code < -2147483648 || error.code > 2147483647 ||
      typeof error.message !== 'string') {
    return {category:'unknown', reason:'Upstream RPC request failed.'};
  }
  const code=error.code;
  const known=rpcReasons.get(code);
  const allowlisted=error.message.length<=256
    ? rpcMessageReasons.get(error.message.trim().toLowerCase()) : undefined;
  const [category,reason]=known ?? allowlisted ?? (code>=-32099 && code<=-32000
    ? ['server_error','Upstream reported an RPC server error.']
    : ['upstream_error','Upstream RPC request failed.']);
  return {code,category,reason};
}
