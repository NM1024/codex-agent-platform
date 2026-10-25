const paths={
  cpu:'M7 7h10v10H7z M4 9H2 M4 15H2 M22 9h-2 M22 15h-2 M9 4V2 M15 4V2 M9 22v-2 M15 22v-2 M4 4h16v16H4z',
  memory:'M3 6h18v12H3z M7 10h3v4H7z M14 10h3v4h-3z M7 18v3 M12 18v3 M17 18v3',
  disk:'M4 4h16l2 11H2L4 4Z M2 15v5h20v-5 M17 17.5h2',
  box:'m12 3 9 5-9 5-9-5 9-5Z M3 8v9l9 5 9-5V8 M12 13v9',
  activity:'M2 12h5l3-8 4 16 3-8h5',
  server:'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  pause:'M8 5v14 M16 5v14',
  play:'m8 4 12 8-12 8V4Z',
  alert:'m12 3 10 18H2L12 3Z M12 9v5 M12 17h.01',

  menu:'M4 6h16 M4 12h16 M4 18h16',
  conversations:'M3 4h18v13H8l-5 4V4Z M7 8h10 M7 12h6',
  repository:'M9 19c-4 1-4-2-6-2 M15 22v-4a3.5 3.5 0 0 0-1-2.7c3.3-.4 6.7-1.6 6.7-7.3a5.7 5.7 0 0 0-1.5-4 5.3 5.3 0 0 0-.1-4s-1.2-.4-4 1.5a13.5 13.5 0 0 0-7.2 0C5.1-.4 3.9 0 3.9 0a5.3 5.3 0 0 0-.1 4 5.7 5.7 0 0 0-1.5 4c0 5.7 3.4 6.9 6.7 7.3A3.5 3.5 0 0 0 8 18v4',
  language:'M3 5h12 M9 3v2 M5 5c1 5 4 8 9 10 M13 5c-1 5-4 8-9 10 M14 21l4-10 4 10 M16 17h4',
  logout:'M9 4H4v16h5 M13 8l4 4-4 4 M8 12h13',
  copy:'M9 8h11v13H9z M6 16H3V3h11v2',
  check:'m5 12 4 4L19 6',
  download:'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  image:'M3 3h18v18H3z M3 16l5-5 5 5 3-3 5 5 M15 7h.01',
  send:'m4 4 17 8-17 8 3-8-3-8 M7 12h14',
  trash:'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  close:'m6 6 12 12 M18 6 6 18',
} as const;

export function Icon({name}:{name:keyof typeof paths}) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>;
}
