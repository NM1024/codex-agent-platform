import {useEffect} from 'react';

// Mobile keyboards may resize only the visual viewport, leaving 100dvh unchanged.
export function useVisualViewport(){
  useEffect(()=>{
    const viewport=window.visualViewport,root=document.documentElement;
    let frame=0;
    const clear=()=>{root.style.removeProperty('--console-viewport-height');root.style.removeProperty('--console-viewport-top');delete root.dataset.compactViewport;delete root.dataset.tinyViewport;};
    const update=()=>{
      frame=0;
      if(!window.matchMedia('(max-width: 991px)').matches){clear();return;}
      // Keep browser pinch zoom and panning independent of application layout.
      if(!viewport||Math.abs(viewport.scale-1)>.01||viewport.height<=0)return;
      root.style.setProperty('--console-viewport-height',viewport.height+'px');
      root.style.setProperty('--console-viewport-top',Math.max(0,viewport.offsetTop)+'px');
      root.toggleAttribute('data-compact-viewport',viewport.height<=600);
      root.toggleAttribute('data-tiny-viewport',viewport.height<=320);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    update();viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);window.addEventListener('resize',schedule);
    return()=>{cancelAnimationFrame(frame);viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);clear();};
  },[]);
}
