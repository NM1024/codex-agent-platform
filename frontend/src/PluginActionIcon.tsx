// Plugin-only actions stay in the lazy plugin page chunk.
const paths={
  settings:'M4 5h6 M14 5h6 M4 12h12 M20 12h0 M4 19h3 M11 19h9 M10 3v4 M16 10v4 M7 17v4',
  document:'M14 2H4v20h16V8l-6-6Z M14 2v6h6 M8 12h8 M8 16h8',
  eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
} as const;
export function PluginActionIcon({name}:{name:keyof typeof paths}) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>;
}
