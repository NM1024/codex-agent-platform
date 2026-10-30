import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
const fixture={name:'notification-test-page',configureServer(server){server.middlewares.use('/fixture.html',async(_request,response)=>{
  response.setHeader('Content-Type','text/html');
  response.end(await server.transformIndexHtml('/fixture.html','<html><body><div id="root"></div><script type="module" src="/tests/browser/notification-harness.tsx"></script></body></html>'));
});}};
const server=await createServer({configFile:false,root,plugins:[react(),fixture],server:{host:'127.0.0.1',port:4329,strictPort:true}});
await server.listen();
