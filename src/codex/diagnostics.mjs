export function safeDiagnostic(text,secrets=[],{maxLength=4096}={}) {
  if (typeof text!=='string') return null;
  let value=text.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1[REDACTED]');
  for (const secret of secrets) if (typeof secret==='string' && secret.length) value=value.replaceAll(secret,'[REDACTED]');
  return maxLength===null?value:value.slice(0,maxLength);
}
