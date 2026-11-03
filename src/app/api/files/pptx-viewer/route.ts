import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const nonce = randomBytes(18).toString("base64");
  // No same-origin permission, external network, links, forms or parent access.
  // Only a size-limited ArrayBuffer and navigation commands cross this boundary.
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f0f0f0;font-family:Arial,sans-serif}body{display:flex;align-items:center;justify-content:center}#stage{flex-shrink:0;transform-origin:center center;background:white;box-shadow:0 2px 18px #0000000d}#stage a{pointer-events:none}#stage>div{margin:0!important}
  </style></head><body><div id="stage"></div><script nonce="${nonce}" src="/file-viewers/pptx-preview-1.0.7.js"></script><script nonce="${nonce}">
    let viewer, file, channel, current=0;
    const stage=document.getElementById('stage');
    function reply(type, extra={}) { parent.postMessage({source:'agentcore-pptx',channel,type,...extra},'*'); }
    function resize() { stage.style.width='960px';stage.style.height='540px';stage.style.transform='scale('+Math.max(.1,Math.min((innerWidth-32)/960,(innerHeight-32)/540))+')'; }
    function page(index) { if(!viewer)return;current=Math.min(Math.max(index,0),viewer.slideCount-1);viewer.renderSingleSlide(current);reply('page',{index:current,count:viewer.slideCount}); }
    addEventListener('resize',resize);
    addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();},true);
    addEventListener('message',async event=>{
      if(event.source!==parent||!event.data||event.data.source!=='agentcore-host')return;
      const data=event.data;
      if(data.type==='load'&&data.buffer instanceof ArrayBuffer&&data.buffer.byteLength<=31457280){
        if(file)return;file=data.buffer;channel=data.channel;
        try{if(!window.pptxPreview)throw new Error('viewer');viewer=await window.pptxPreview.load(stage,file);resize();page(0);reply('loaded',{count:viewer.slideCount});}
        catch{reply('error');}
      }else if(data.channel===channel&&data.type==='page'&&Number.isInteger(data.index)){try{page(data.index);}catch{reply('error');}}
    });
    addEventListener('error',()=>reply('error'));
    addEventListener('unhandledrejection',()=>reply('error'));
  </script></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    },
  });
}
