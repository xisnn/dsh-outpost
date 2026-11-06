import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';
function load(file, modules) {
 const exports = {};
 const code = ts.transpileModule(fs.readFileSync(new URL('../src/core/'+file+'.ts', import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 vm.runInNewContext(code,{exports,URLSearchParams,require(name){assert.ok(name in modules,name);return modules[name];}});
 return exports;
}
const preview = load('filePreview', {});
test('excerpts bound long lines, line count, BOM and UTF16 boundaries',()=>{
 assert.equal(preview.fileExcerpt('﻿hello\r\nworld'),'hello\nworld');
 assert.equal(preview.fileExcerpt('a\n'.repeat(10000)).split('\n').length,8);
 assert.ok(preview.fileExcerpt('x'.repeat(50000)).length<=1200);
 assert.ok(!/[\uD800-\uDBFF]$/.test(preview.fileExcerpt('x'.repeat(1199)+'😀')));
 for(const name of ['r.md','r.JSON','r.txt','r.ts']) assert.ok(preview.isTextPreviewable(name));
 for(const name of ['r.apk','r.zip','r.exe','r.png']) assert.ok(!preview.isTextPreviewable(name));
});
for(const oversize of ['declared','actual']) test(`gateway cancels ${oversize} oversize preview before buffering/writing`,async()=>{
 const sent=[];let writes=0;
 const api=load('gatewayFiles',{'react-native-blob-util':{default:{fs:{dirs:{CacheDir:'/cache'},writeFile:async()=>{writes++;}}}}});
 const channel={send:f=>sent.push(f),waitFor:async(kind)=>kind==='file-download-opened'?{transferId:'t',size:oversize==='declared'?100:3,name:'r.md'}:{data:'YWJjZA==',eof:true}};
 await assert.rejects(api.downloadWorkspaceFile(channel,'s','r.md',undefined,{maxBytes:3}),/文件较大/);
 assert.equal(writes,0);assert.equal(sent.at(-1).type,'file-download-cancel');
 assert.equal(sent.filter(f=>f.type==='file-download-read').length,oversize==='declared'?0:1);
});
function httpHarness({cachedSize=0,responseSize=4,emitProgress=false}){
 let downloads=0,cancelled=0,deleted=0;const paths=[];
 const blob={fs:{dirs:{CacheDir:'/cache'},exists:async()=>true,stat:async()=>({size:cachedSize||responseSize}),unlink:async()=>{deleted++;}},config:({path})=>({fetch(){
  downloads++;paths.push(path);const request=Promise.resolve({info:()=>({status:200})});
  request.progress=(_config,fn)=>{if(emitProgress)fn(4,1000);return request;};request.cancel=()=>{cancelled++;};return request;
 }})};
 const api=load('fileUrl',{'react-native-blob-util':{default:blob},'./net-security':{assertSecureUrl(){}},'./installable':{isInstallablePackage:()=>false},'./pendingSend/fingerprint':{sha256Hex:s=>createHash('sha256').update(s).digest('hex')}});
 return {api,paths,counts:()=>({downloads,cancelled,deleted})};
}
test('HTTP preview size cap rejects cached content without redownloading it',async()=>{
 const h=httpHarness({cachedSize:100});await assert.rejects(h.api.fetchRemoteFile('https://one.test','cookie','/r.md',{maxBytes:3}),/文件较大/);
 assert.equal(h.counts().downloads,0);
});
test('HTTP preview cancels large progress and removes the partial file',async()=>{
 const h=httpHarness({emitProgress:true});await assert.rejects(h.api.fetchRemoteFile('https://one.test','cookie','/r.md',{forceDownload:true,maxBytes:3}),/文件较大/);
 assert.equal(h.counts().cancelled,1);assert.ok(h.counts().deleted>=1);
});
test('HTTP final stat enforces the cap even when progress callbacks are absent',async()=>{
 const h=httpHarness({responseSize:100});await assert.rejects(h.api.fetchRemoteFile('https://one.test','cookie','/r.md',{forceDownload:true,maxBytes:3}),/文件较大/);
 assert.equal(h.counts().cancelled,0);assert.ok(h.counts().deleted>=1);
});
test('HTTP cached paths isolate service and authenticated identity',async()=>{
 const h=httpHarness({});
 for(const [base,cookie]of [['https://one.test','a'],['https://two.test','a'],['https://one.test','b']])await h.api.fetchRemoteFile(base,cookie,'/r.md',{forceDownload:true});
 assert.equal(new Set(h.paths).size,3);assert.ok(h.paths.every(p=>!p.includes('cookie')));
});
