import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    html,body{margin:0;min-height:100%;background:#eceeed;color:#202124;font-family:Arial,sans-serif}body{overflow-x:hidden}#viewport{position:relative;margin:16px auto}#stage{position:absolute;top:0;left:0;width:max-content;transform-origin:top left}.docx-wrapper{padding:0!important;background:transparent!important}.docx-wrapper>section.docx{margin-bottom:16px!important;box-shadow:0 2px 12px #00000012}#stage a{pointer-events:none}
  </style></head><body><div id="viewport"><div id="stage"></div></div><script nonce="${nonce}" src="/file-viewers/docx-preview-0.4.0.js"></script><script nonce="${nonce}">
    let channel,loaded=false,busy=false;
    const stage=document.getElementById('stage'),viewport=document.getElementById('viewport');
    function reply(type,extra={}){parent.postMessage({source:'agentcore-docx',channel,type,...extra},'*');}
    function resize(){if(!loaded)return;const width=stage.scrollWidth,height=stage.scrollHeight;const scale=Math.min(1,Math.max(1,innerWidth-32)/Math.max(1,width));stage.style.transform='scale('+scale+')';viewport.style.width=(width*scale)+'px';viewport.style.height=(height*scale)+'px';}
    addEventListener('resize',resize);
    addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();},true);
    addEventListener('message',async event=>{
      if(event.source!==parent||event.data?.source!=='agentcore-host'||busy)return;
      const data=event.data;
      if(data.type!=='load'||!(data.buffer instanceof ArrayBuffer)||data.buffer.byteLength>31457280||typeof data.channel!=='string')return;
      channel=data.channel;busy=true;
      try{
        const count=await window.docxPreview.load(stage,data.buffer);
        await document.fonts.ready;
        await Promise.all(Array.from(stage.querySelectorAll('img')).map(img=>img.decode().catch(()=>{})));
        loaded=true;resize();reply('loaded',{count});
      }catch{stage.replaceChildren();reply('error');}
    });
    addEventListener('error',()=>reply('error'));
    addEventListener('unhandledrejection',()=>reply('error'));
  </script></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    },
  });
}
