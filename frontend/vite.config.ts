import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {componentStyleNonce} from './build-style-nonce';
export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),base:'/admin/',plugins:[componentStyleNonce(),react()],
  build:{outDir:'../src/manager/web-dist',emptyOutDir:true,sourcemap:false,license:{fileName:'third-party-notices.md'}},
});
