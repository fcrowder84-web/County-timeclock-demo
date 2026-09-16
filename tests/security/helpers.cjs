'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'../..');
function source(file){
  return process.env.SECURITY_BASELINE === '1'
    ? cp.execFileSync('git',['show','997dfa60f74e7ceed33969cfdb255db7ce6bfc32:'+file],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']})
    : fs.readFileSync(path.join(root,file),'utf8');
}
function load(file,mocks={},cache={}){
  if(cache[file])return cache[file].exports;
  const module={exports:{}};cache[file]=module;
  function localRequire(name){
    if(Object.prototype.hasOwnProperty.call(mocks,name))return mocks[name];
    if(name.startsWith('.')){
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),name));
      return load(target.endsWith('.js')?target:target+'.js',mocks,cache);
    }
    return require(name);
  }
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+source(file)+'\n})',{filename:file})(localRequire,module,module.exports,path.join(root,file),path.dirname(path.join(root,file)));
  return module.exports;
}
function routerMock(){
  const routes=[];
  const router={use(...handlers){routes.push({method:'use',handlers})}};
  for(const method of ['get','post','patch','delete','put'])router[method]=(route,...handlers)=>routes.push({method,route,handlers});
  return {router,routes,express:{Router:()=>router}};
}
function response(){
  return {statusCode:200,body:null,status(n){this.statusCode=n;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},redirect(v){this.location=v;return this},set(){return this},setHeader(){return this}};
}
async function invoke(handler,req,res=response()){
  let error;await handler(req,res,e=>{error=e});if(error)throw error;return res;
}
module.exports={source,load,routerMock,response,invoke,root};
