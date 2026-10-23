import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {componentStyleNonce} from './build-style-nonce.ts';
import {compressedAssets} from './build-compression.ts';
export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),base:'/admin/',plugins:[componentStyleNonce(),react(),compressedAssets()],
  build:{outDir:'../src/manager/web-dist',emptyOutDir:true,sourcemap:false,manifest:true,license:{fileName:'third-party-notices.md'}},
});
