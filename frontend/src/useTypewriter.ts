import {useEffect,useRef,useState} from 'react';

const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});

export function useTypewriter(text:string,live:boolean,onReveal?:()=>void) {
  // Reopening history (including an already-running reply) starts at its saved text.
  const [visible,setVisible]=useState(text),shown=useRef(text),wasLive=useRef(live);
  const reveal=useRef(onReveal);reveal.current=onReveal;
  useEffect(()=>{
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const animate=live||wasLive.current;wasLive.current=live;
    if(!animate||reduced.matches||!text.startsWith(shown.current)) {
      shown.current=text;setVisible(text);reveal.current?.();return;
    }
    let frame:number,last=0;
    const tick=(now:number)=>{
      if(now-last<24){frame=requestAnimationFrame(tick);return;}
      const count=Math.max(1,Math.ceil((now-(last||now-24))*0.07),Math.ceil((text.length-shown.current.length)/8));last=now;
      const rest=text.slice(shown.current.length);let end=0;
      for(const part of segmenter.segment(rest)){end=part.index+part.segment.length;if(end>=count)break;}
      shown.current+=rest.slice(0,end);setVisible(shown.current);reveal.current?.();
      if(shown.current.length<text.length)frame=requestAnimationFrame(tick);
    };
    if(shown.current!==text)frame=requestAnimationFrame(tick);
    const motionChanged=()=>{if(reduced.matches){cancelAnimationFrame(frame);shown.current=text;setVisible(text);reveal.current?.();}};
    reduced.addEventListener('change',motionChanged);
    return()=>{cancelAnimationFrame(frame);reduced.removeEventListener('change',motionChanged);};
  },[text,live]);
  return {visible,typing:visible!==text};
}
