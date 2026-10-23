import type {Plugin} from 'vite';

// rc-component's temporary scrollbar/style probes do not receive ConfigProvider's
// CSP setting. Supply the document nonce at their shared style insertion boundary.
// Keep this narrow adapter checked against the locked dependency during builds.
export function componentStyleNonce():Plugin {
  return {
    name:'component-style-nonce',
    transform(code,id){
      if(!id.replaceAll('\\','/').endsWith('/@rc-component/util/es/Dom/dynamicCSS.js'))return;
      const anchor='export function injectCSS(css, option = {}) {';
      if(!code.includes(anchor))throw new Error('rc-component style insertion changed; review the CSP nonce adapter.');
      return code.replace(anchor,anchor+`
  const nonce = typeof document === 'undefined' ? null : document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content');
  if (nonce && !option.csp?.nonce) option = {...option, csp: {...option.csp, nonce}};
`);
    },
  };
}
