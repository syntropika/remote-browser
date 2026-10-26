/** Synthetic browser pages for integration tests. */
export const PAGE =
  "<!doctype html><style>body{margin:0}iframe{position:absolute;left:16px;top:24px;width:800px;height:650px;border:0}</style>\n<script>window.ready=false;window.trace=[];onmessage=e=>{if(e.data?.kind==='ready')ready=true;if(e.data?.kind==='trace')trace.push(e.data.value)};</script><iframe src=\"/frame\"></iframe>";

export const FRAME =
  "<!doctype html><style>body{margin:0}button{position:absolute;left:0;top:0;width:160px;height:100px}iframe{position:absolute;left:220px;top:120px;width:350px;height:300px;border:0;transform:scale(1.5);transform-origin:top left}</style><button>Frame button</button><iframe src=\"/nested\"></iframe><script>\nconst report=e=>parent.postMessage({kind:'trace',value:{type:e.type,x:e.clientX,y:e.clientY,sx:e.screenX,sy:e.screenY,trusted:e.isTrusted}},'*');\nfor(const type of ['pointerover','pointerenter','pointermove','pointerdown','pointerup','click','dblclick'])document.querySelector('button').addEventListener(type,report);\nonmessage=e=>{if(e.data?.kind==='trace'||e.data?.kind==='ready')parent.postMessage(e.data,'*')};\n</script>";

export const NESTED =
  "<!doctype html><style>body{margin:0;height:1000px}button{position:absolute;left:0;top:40px;width:160px;height:100px}</style><button>Nested button</button><script>\nconst report=e=>parent.postMessage({kind:'trace',value:{type:e.type,x:e.clientX,y:e.clientY,sx:e.screenX,sy:e.screenY,trusted:e.isTrusted}},'*');\nfor(const type of ['pointerover','pointerenter','pointermove','pointerdown','pointerup','click','dblclick'])document.querySelector('button').addEventListener(type,report);\nscrollTo(0,40);requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({kind:'ready'},'*')));\n</script>";
