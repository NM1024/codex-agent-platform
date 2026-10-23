// Prefer an accepted compressed representation; an explicit identity preference
// participates in negotiation. Never compress nonce HTML or authenticated data.
export function staticEncoding(header='') {
  const weights=new Map();
  for(const item of header.toLowerCase().split(',')) {
    const [name,...parameters]=item.trim().split(';');
    if(!name)continue;
    const value=parameters.map(part=>part.trim()).find(part=>part.startsWith('q='));
    const q=value===undefined?1:Number(value.slice(2));
    weights.set(name,Number.isFinite(q)&&q>=0&&q<=1?q:0);
  }
  const accepted=['br','gzip'].map(name=>[name,weights.get(name)??weights.get('*')??0]);
  if(weights.has('identity'))accepted.push(['identity',weights.get('identity')]);
  accepted.sort((a,b)=>b[1]-a[1]);
  if(accepted[0][1]>0)return accepted[0][0];
  return weights.get('identity')===0||weights.get('*')===0?null:'identity';
}
