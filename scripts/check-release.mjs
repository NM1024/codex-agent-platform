import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, dirname, relative, sep } from "node:path";

// Check the distributed files rather than relying on a developer's working tree.
// All local module specifiers in this service are literal ESM imports.
const root = process.cwd();
let checked = 0;
let checkedJson=0;
async function requireFile(path) {
  try {if ((await stat(join(root,path))).isFile())return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  throw new Error(`Missing release resource: ${path}`);
}
async function exists(path){try{return (await stat(join(root,path))).isFile();}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(
        `Source symlink is not self-contained: ${relative(root, file)}`,
      );
    if (entry.isDirectory()) {
      await walk(file);
      continue;
    }
    if (entry.isFile()&&file.endsWith('.json')) {
      try {JSON.parse(await readFile(file,'utf8'));checkedJson++;}catch {throw new Error(`Invalid JSON resource: ${relative(root,file)}`);}
    }
    if (!entry.isFile() || !(file.endsWith(".mjs")||file.endsWith('.js'))) continue;
    checked++;
    const source = await readFile(file, "utf8");
    const imports = [
      ...source.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g),
      ...source.matchAll(/\bimport\s*(?:\(\s*)?["'](\.{1,2}\/[^"']+)["']/g),
      ...source.matchAll(
        /new\s+URL\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*,?\s*\)/g,
      ),
    ];
    for (const match of imports) {
      const target = resolve(dirname(file), match[1]);
      const name = relative(root, target);
      if (name === ".." || name.startsWith(".." + sep))
        throw new Error(
          `Module is outside release: ${relative(root, file)} -> ${name}`,
        );
      let found = false;
      try {
        found = (await stat(target)).isFile();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!found)
        throw new Error(`Missing module: ${relative(root, file)} -> ${name}`);
    }
  }
}
try {
  if (await exists('src/main-manager.mjs'))
    {
      const index='src/manager/web-dist/index.html';
      for(const resource of [index,'src/manager/web-dist/favicon.svg','src/manager/web-dist/third-party-notices.md'])await requireFile(resource);
      const html=await readFile(join(root,index),'utf8');
      const assets=[...html.matchAll(/(?:src|href)=["']\/admin\/(assets\/[^"']+)["']/g)].map(match=>match[1]);
      if(!assets.some(path=>path.endsWith('.js'))||!assets.some(path=>path.endsWith('.css')))throw new Error('Missing bundled Admin JS/CSS references');
      for(const asset of assets)await requireFile('src/manager/web-dist/'+asset);
      const manifestPath='src/manager/web-dist/.vite/manifest.json';
      await requireFile(manifestPath);
      const manifest=JSON.parse(await readFile(join(root,manifestPath),'utf8'));
      for(const item of Object.values(manifest)) {
        for(const key of [...item.imports??[],...item.dynamicImports??[]])
          if(!manifest[key])throw new Error(`Missing Admin manifest dependency: ${key}`);
        for(const resource of [item.file,...item.css??[],...item.assets??[]]) {
          if(!/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(resource))throw new Error(`Invalid Admin manifest resource: ${resource}`);
          await requireFile('src/manager/web-dist/'+resource);
          for(const suffix of ['.gz','.br'])await requireFile('src/manager/web-dist/'+resource+suffix);
        }
      }
      const legacy=await stat(join(root,'src/manager/web')).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(legacy)throw new Error('Obsolete Admin source directory remains: src/manager/web');
    }
  if (await exists('src/application.mjs'))
    for (const resource of ['src/plugins/examples/content.review.json','src/plugins/examples/novel.illustrated.json'])await requireFile(resource);
  if(process.argv.includes('--manager-source')) {
    if(await exists('scripts/host-sandbox.py'))await requireFile('Dockerfile.sandbox');
    const required=['README.md','docs/ARCHITECTURE.md','frontend/src/pages/PluginsPage.tsx','frontend/src/PluginExecutionSettings.tsx','src/manager/server.mjs','src/manager/project-source.mjs','prompts/manager-project.md'];
    for(const resource of required)await requireFile(resource);
    const {createProjectSourceReader}=await import('../src/manager/project-source.mjs');
    const source=await createProjectSourceReader(root)({mode:'list',limit:200});
    for(const resource of required)if(!source.files.some(file=>file.path===resource&&!file.unavailable))throw new Error(`Manager source unavailable: ${resource}`);
  }
  if(await exists('scripts/host-sandbox.py'))for(const resource of ['scripts/sandbox_runtime.py','scripts/sandbox_files.py','scripts/sandbox_network.py','scripts/sandbox-requirements.txt'])await requireFile(resource);
  await walk(join(root, "src"));
  await walk(join(root, "scripts"));
  console.log(`Release source validation passed (${checked} modules, ${checkedJson} JSON resources).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
