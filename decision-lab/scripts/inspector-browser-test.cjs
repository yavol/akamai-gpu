/** Request/response-inspector behavior and opt-in integration checks.
 * Default: only synthetic HTTP responses; no provider inference calls.
 * --live: one real JEV text, Luna text, and GPU image decision; subsequent
 * requests are stopped before forwarding. Set APP_URL and private QA_OUTPUT.
 */
'use strict';
const {chromium,launchOptions,appURL}=require('./browser-runtime.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const live=process.argv.includes('--live');
const testURL=live?appURL:'http://127.0.0.1:37991/';
const output=process.env.QA_OUTPUT||path.join(require('node:os').tmpdir(),'decision-lab-inspector-'+(live?'live':'mocked')+'-'+Date.now());
const models=[{id:'jev',name:'JEV QA',model:'typesafe/jev-1.13',supportsImages:false,available:true},{id:'luna',name:'Luna QA',model:'openai/gpt-6-luna',supportsImages:true,available:true},{id:'gpu',name:'GPU QA',model:'Cloudflare/clef-flash',supportsImages:true,available:true}];
const report={schemaVersion:1,startedAt:new Date().toISOString(),mode:live?'live-single-decision-integration':'synthetic-behavior-tests',methodology:{purpose:'Request/response-inspector fidelity and interaction checks, not a model benchmark.',live:'Exactly one real provider request per sample; the next browser request is intercepted before forwarding, Stop is clicked, and an empty synthetic response is discarded by the run generation check. This deliberately records stopped workflows with one applied real call each.',mocked:'Static assets and API responses are intercepted locally; no server or provider inference requests are made.',privacy:'Reports, downloads, and screenshots are private QA evidence. The harness does not persist APP_URL or inject authentication headers.',network:process.env.QA_NETWORK_DESCRIPTION||'Browser timing includes the configured APP_URL transport; provider latency is measured by the hosted adapter.'},complete:false,providerCalls:0,checks:[],errors:[],runs:[]};
const clone=x=>JSON.parse(JSON.stringify(x));
const save=async()=>fs.writeFile(path.join(output,'inspector-qa.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const check=async(name,details={})=>{report.checks.push({name,passed:true,...details});await save();console.log(JSON.stringify({check:name,...details}));};
async function until(predicate,label,timeout=15000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('Timed out: '+label);await new Promise(r=>setTimeout(r,25));}}
function assertNoScoringLabels(body){
 const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){assert.ok(!['expected','groundTruth','correct','observationMeta'].includes(key),'Scoring label in outgoing request: '+key);visit(item);}};
 visit(body);
}
const malicious='<img id="response-xss-probe" src="x" onerror="window.__inspectorResponseExecuted=1">';
function syntheticResponse(input,sequence){
 const chat=input.provider==='luna';
 const answers=Object.fromEntries(Object.entries(input.questions).map(([key,q])=>{const options=Object.keys(q.criteria);return[key,{type:'choice',choice:options[0],confidence:chat?null:.83,probabilities:chat?null:Object.fromEntries(options.map((x,i)=>[x,i===0?.64:.36/(options.length-1)]))}];}));
 let body,transport,raw;
 if(chat){
  transport='chat';body={model:'openai/gpt-6-luna',messages:[{role:'system',content:'Synthetic QA provider payload. Named choice questions: '+JSON.stringify(input.questions)},{role:'user',content:input.state}],reasoning:{effort:'none'},response_format:{type:'json_schema',json_schema:{name:'decisions',strict:true,schema:{type:'object',properties:{answers:{type:'object'}},required:['answers'],additionalProperties:false}}}};
  raw={id:'synthetic-'+sequence,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({answers:Object.fromEntries(Object.entries(answers).map(([key,value])=>[key,value.choice])),note:malicious})}}],usage:{prompt_tokens:101,completion_tokens:12,total_tokens:113}};
 }else{
  transport='decisions';body={model:input.provider==='gpu'?'Cloudflare/clef-flash':'typesafe/jev-1.13',state:input.state,questions:input.questions};
  if(input.provider==='gpu'&&Array.isArray(input.state)){body.state=input.state.filter(x=>typeof x==='string').join('\n\n');body.images=input.state.filter(x=>x?.type==='image_url').map(x=>x.image_url.url);}
  raw={id:'synthetic-'+sequence,model:body.model,answers:clone(answers),usage:{input_tokens:123,output_tokens:6},annotation:malicious};
 }
 return{answers,provider:input.provider,model:body.model,latencyMs:7,transport,confidenceKind:chat?'unavailable':'native',usage:clone(raw.usage),submittedRequest:{transport,body},receivedResponse:{transport,body:raw}};
}
async function inspectStep(page,opener,step){await opener.click();await page.locator('#request-inspector').waitFor({state:'visible'});await page.locator('#inspector-step').selectOption(String(step));}
async function displayedJson(page){if(!await page.locator('#inspector-trace').evaluate(el=>el.open))await page.locator('#inspector-trace > summary').click();await page.waitForFunction(()=>document.querySelector('#inspector-json').textContent.length>0);return JSON.parse(await page.locator('#inspector-json').textContent());}
async function escapeAndCheckFocus(page,opener){await page.keyboard.press('Escape');await page.locator('#request-inspector').waitFor({state:'hidden'});assert.equal(await opener.evaluate(el=>document.activeElement===el),true,'Escape should restore focus to the invoking control');}
async function downloadBody(page,response=false){const pending=page.waitForEvent('download');await page.locator(response?'#inspector-download-response':'#inspector-download').click();const download=await pending;const filename=path.join(output,'inspected-'+(response?'response':'request')+'-'+Date.now()+'.json');await download.saveAs(filename);await fs.chmod(filename,0o600);return JSON.parse(await fs.readFile(filename,'utf8'));}

async function displayedResponse(page){if(!await page.locator('#inspector-trace').evaluate(el=>el.open))await page.locator('#inspector-trace > summary').click();await page.waitForFunction(()=>document.querySelector('#inspector-response-json').textContent.length>0);return JSON.parse(await page.locator('#inspector-response-json').textContent());}
async function assertAnswerChoices(page,answers){const text=await page.locator('#inspector-response-answers').textContent();for(const [question,answer]of Object.entries(answers)){assert.ok(text.includes(question),'Response identifies each question');assert.ok(text.includes(typeof answer==='string'?answer:answer.choice),'Response shows each actual choice');}}
async function noRawResponse(page){assert.equal(await page.locator('#inspector-copy-response').isDisabled(),true);assert.equal(await page.locator('#inspector-download-response').isDisabled(),true);assert.equal((await page.locator('#inspector-response-json').textContent()).trim(),'','No fabricated or stale raw response body');}
async function copyResponse(page,body){await page.locator('#inspector-copy-response').click();await page.waitForFunction(()=>/response copied|Clipboard access is unavailable/.test(document.querySelector('#inspector-status').textContent));const status=await page.locator('#inspector-status').textContent();if(/unavailable/.test(status)){await check('Clipboard unavailable; full response download remains tested');return;}assert.match(status,/response copied/);assert.deepEqual(JSON.parse(await page.evaluate(()=>navigator.clipboard.readText())),body,'Copy preserves exact provider response body');}
async function responseScreenshot(page,name){await page.locator('#request-inspector').evaluate(el=>{el.scrollTop=0;});await page.screenshot({path:path.join(output,name+'.png')});}

(async()=>{
 await fs.mkdir(output,{recursive:true,mode:0o700});
 // Relay setups keep credentials server-side. This harness never injects auth headers.
 const browser=await chromium.launch(launchOptions);
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(testURL).origin});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 const pending=[];
 try{
  if(!live){
   const publicRoot=path.resolve(__dirname,'../public');
   await page.route('http://127.0.0.1:37991/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    const filename=path.resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname));
    assert.ok(filename.startsWith(publicRoot+path.sep));
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
    try{await route.fulfill({status:200,contentType:types[path.extname(filename)]||'application/octet-stream',body:await fs.readFile(filename)});}catch{await route.fulfill({status:404,body:'Not found'});}
   });
   await page.route('**/api/models',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({providers:models})}));
   await page.route('**/api/decide',async route=>{
    const input=route.request().postDataJSON();assert.equal(input.includeRequest,true,'Inspector must opt into the exact submitted body');assert.equal(input.includeResponse,true,'Inspector must opt into the exact received body');assertNoScoringLabels(input);
    await new Promise(resolve=>pending.push({route,input:clone(input),response:syntheticResponse(input,pending.length+1),release:resolve,done:false}));
   });
  }
  await page.goto(testURL,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.decisionLab&&document.querySelector('.model-select')?.options.length>0);
  async function release(entry){assert.ok(entry&&!entry.done);entry.done=true;await entry.route.fulfill({status:entry.httpStatus||200,contentType:'application/json',body:JSON.stringify(entry.response)});entry.release();}
  if(!live){
   await page.locator('[data-kind="intake"]').click();await page.locator('#compare').check();await page.locator('.model-select').nth(0).selectOption('jev');await page.locator('.model-select').nth(1).selectOption('luna');
   await page.locator('#run').click();await until(()=>pending.length===2,'both first model requests');
   const jevFirst=pending.find(x=>x.input.provider==='jev'),lunaFirst=pending.find(x=>x.input.provider==='luna');
   const pendingOpener=page.locator('.lane').nth(0).locator('.inspect-request');await inspectStep(page,pendingOpener,1);assert.deepEqual(await displayedJson(page),jevFirst.input);assert.match(await page.locator('#inspector-trace-label').textContent(),/provider trace unavailable/);
   await noRawResponse(page);assert.match(await page.locator('#inspector-response-status').textContent(),/Waiting for the model/);assert.equal(await page.locator('#inspector-response-answers .inspector-answer').count(),0);await check('Pending step shows captured request but no invented response or enabled raw-response exports');
   jevFirst.response.model=malicious;jevFirst.response.receivedResponse.body.model=malicious;
   await release(jevFirst);await until(()=>pending.length===3,'JEV second request');assert.equal(await page.locator('#inspector-step').inputValue(),'1');
   assert.deepEqual(await displayedResponse(page),jevFirst.response.receivedResponse.body);await assertAnswerChoices(page,jevFirst.response.answers);assert.match(await page.locator('#inspector-response-answers').textContent(),/Native confidence: 83%/);assert.match(await page.locator('#inspector-response-answers').textContent(),/64%/);
   assert.ok((await page.locator('#inspector-response-meta').textContent()).includes(malicious));assert.equal(await page.locator('#response-xss-probe').count(),0);assert.equal(await page.evaluate(()=>window.__inspectorResponseExecuted),undefined);
   assert.deepEqual(await downloadBody(page,true),jevFirst.response.receivedResponse.body);await copyResponse(page,jevFirst.response.receivedResponse.body);await responseScreenshot(page,'inspector-response-native');
   await check('Response appears on the pinned pending step; native confidence, full copy/download, and untrusted text are faithful');await escapeAndCheckFocus(page,pendingOpener);
   await release(lunaFirst);await until(()=>pending.length===4,'both second model requests');
   const jevOpener=page.locator('.lane').nth(0).locator('.inspect-request');
   await inspectStep(page,jevOpener,1);
   assert.deepEqual(await displayedJson(page),jevFirst.response.submittedRequest.body);
   assert.match(await page.locator('#inspector-title').textContent(),/JEV QA/);
   const frozenText=await page.locator('#inspector-observation').textContent();assert.ok(frozenText.includes(jevFirst.input.state),'Inspector must show the state captured before this decision');
   const questionText=await page.locator('#inspector-questions').textContent();for(const key of Object.keys(jevFirst.input.questions))assert.ok(questionText.includes(key));
   // Let subsequent model actions finish while the first request is pinned in view.
   while(await page.evaluate(()=>window.decisionLab.running)){
    const waiting=pending.filter(x=>!x.done);for(const entry of waiting)await release(entry);
    await new Promise(r=>setTimeout(r,30));
   }
   assert.equal(await page.locator('#inspector-step').inputValue(),'1','New actions must not change the inspected step');
   assert.equal(await page.locator('#inspector-observation').textContent(),frozenText);
   assert.deepEqual(await displayedJson(page),jevFirst.response.submittedRequest.body);
   assert.equal(await page.locator('#inspector-step option').count(),4);
   assert.deepEqual(await displayedResponse(page),jevFirst.response.receivedResponse.body);await assertAnswerChoices(page,jevFirst.response.answers);
   await check('Pinned first request and response remain immutable while later actions complete',{requests:pending.length});
   await escapeAndCheckFocus(page,jevOpener);
   const lunaOpener=page.locator('.lane').nth(1).locator('.inspect-request');await inspectStep(page,lunaOpener,1);
   assert.match(await page.locator('#inspector-title').textContent(),/Luna QA/);
   assert.deepEqual(await displayedJson(page),lunaFirst.response.submittedRequest.body);
   assert.equal((await displayedJson(page)).response_format.type,'json_schema');assert.ok(Array.isArray((await displayedJson(page)).messages));
   assertNoScoringLabels(await displayedJson(page));assert.deepEqual(await displayedResponse(page),lunaFirst.response.receivedResponse.body);await assertAnswerChoices(page,lunaFirst.response.answers);
   const lunaAnswers=await page.locator('#inspector-response-answers').textContent();assert.match(lunaAnswers,/does not provide native choice confidence/);assert.ok(!lunaAnswers.includes('Native confidence:')&&!lunaAnswers.includes('Native choice probabilities'));
   assert.equal(typeof (await displayedResponse(page)).choices[0].message.content,'string');assert.deepEqual(await downloadBody(page,true),lunaFirst.response.receivedResponse.body);await copyResponse(page,lunaFirst.response.receivedResponse.body);assert.equal(await page.evaluate(()=>window.__inspectorResponseExecuted),undefined);
   await responseScreenshot(page,'inspector-response-luna');await escapeAndCheckFocus(page,lunaOpener);await check('Luna shows actual content JSON and normalized answers without fabricated native confidence');
   await check('Each model shows its own exact provider payload, including Luna messages and schema');
   await page.locator('#reset').click();await page.locator('[data-kind="procurement"]').click();
   const historical=page.locator('#results-body tr').filter({hasText:'JEV QA'}).locator('.inspect-run');
   await inspectStep(page,historical,1);assert.deepEqual(await displayedJson(page),jevFirst.response.submittedRequest.body);assert.equal(await page.locator('#inspector-observation').textContent(),frozenText);assert.deepEqual(await displayedResponse(page),jevFirst.response.receivedResponse.body);
   await escapeAndCheckFocus(page,historical);await check('Historical request remains available and unchanged after reset and scenario change');
   await page.setViewportSize({width:390,height:844});await inspectStep(page,historical,1);
   const bounds=await page.locator('#request-inspector').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391,'Inspector fits mobile viewport');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No mobile page overflow');
   await assertAnswerChoices(page,jevFirst.response.answers);await responseScreenshot(page,'inspector-mobile');await escapeAndCheckFocus(page,historical);await check('Mobile dialog fits and keyboard Escape restores focus');
   await page.setViewportSize({width:1440,height:1000});await page.locator('[data-kind="courier"]').click();await page.locator('#compare').uncheck();await page.locator('#mode').selectOption('vision');await page.locator('.model-select').selectOption('gpu');
   const count=pending.length;await page.locator('#run').click();await until(()=>pending.length===count+1,'first image request');const imageFirst=pending[count];await release(imageFirst);await until(()=>pending.length===count+2,'second image request');
   const imageOpener=page.locator('.inspect-request');await inspectStep(page,imageOpener,1);
   const expectedImage=imageFirst.input.state.find(x=>x?.type==='image_url').image_url.url;
   const preview=page.locator('#inspector-observation img');assert.equal(await preview.getAttribute('src'),expectedImage);await preview.evaluate(img=>img.decode());assert.ok(await preview.evaluate(img=>img.naturalWidth>0));
   assert.ok((await page.locator('#inspector-json-note').textContent()).trim().length>0,'Abbreviated image JSON is explained');
   assert.deepEqual(await downloadBody(page),imageFirst.response.submittedRequest.body,'Download preserves complete image bytes and exact provider body');
   assert.deepEqual(await displayedResponse(page),imageFirst.response.receivedResponse.body);await assertAnswerChoices(page,imageFirst.response.answers);await responseScreenshot(page,'inspector-image');await escapeAndCheckFocus(page,imageOpener);await page.locator('#stop').click();await release(pending[count+1]);await page.waitForFunction(()=>!window.decisionLab.running);
   await check('Image preview uses the frozen request image; download preserves full GPU images payload');
   const stoppedRecord=await page.evaluate(()=>window.decisionLab.records.at(-1));assert.equal(stoppedRecord.calls.length,1);assert.equal(stoppedRecord.requests.length,2);assert.equal(stoppedRecord.requests[1].status,'stopped');
   assert.deepEqual(stoppedRecord.requests[1].submittedRequest.body,pending[count+1].response.submittedRequest.body);assert.deepEqual(stoppedRecord.requests[1].receivedResponse.body,pending[count+1].response.receivedResponse.body);assert.deepEqual(stoppedRecord.requests[1].normalizedResponse.answers,pending[count+1].response.answers);
   const stoppedOpener=page.locator('#results-body tr').first().locator('.inspect-run');await inspectStep(page,stoppedOpener,2);assert.match(await page.locator('#inspector-request-status').textContent(),/Returned after stop/);
   assert.deepEqual(await downloadBody(page),pending[count+1].response.submittedRequest.body);assert.deepEqual(await displayedResponse(page),pending[count+1].response.receivedResponse.body);await assertAnswerChoices(page,pending[count+1].response.answers);assert.match(await page.locator('#inspector-response-status').textContent(),/was not applied/);await responseScreenshot(page,'inspector-stopped');await escapeAndCheckFocus(page,stoppedOpener);
   await check('Returned-after-stop request and response remain inspectable without becoming an applied call',{requests:2,appliedCalls:1});
   await page.locator('[data-kind="intake"]').click();await page.locator('#mode').selectOption('text');await page.locator('.model-select').selectOption('jev');
   const errorCount=pending.length;await page.locator('#run').click();await until(()=>pending.length===errorCount+1,'error fixture request');const failed=pending[errorCount];failed.httpStatus=502;failed.response={error:'Synthetic QA provider failure: no upstream trace available'};await release(failed);await page.waitForFunction(()=>!window.decisionLab.running);
   const failedRecord=await page.evaluate(()=>window.decisionLab.records.at(-1));assert.equal(failedRecord.status,'error');assert.equal(failedRecord.calls.length,0);assert.equal(failedRecord.requests.length,1);assert.equal(failedRecord.requests[0].submittedRequest,null);
   const failedOpener=page.locator('#results-body tr').first().locator('.inspect-run');await inspectStep(page,failedOpener,1);assert.deepEqual(await displayedJson(page),failed.input);assert.match(await page.locator('#inspector-trace-label').textContent(),/provider trace unavailable/);assert.match(await page.locator('#inspector-notice').textContent(),/cannot verify the final body/);
   await noRawResponse(page);assert.match(await page.locator('#inspector-response-status').textContent(),/error/);assert.equal(await page.locator('#inspector-response-answers .inspector-answer').count(),0);await responseScreenshot(page,'inspector-error');await escapeAndCheckFocus(page,failedOpener);await check('Failed request preserves browser input and explicitly disclaims unavailable provider trace');
   // An older adapter may return normalized answers without an exact upstream body.
   const legacyCount=pending.length;await page.locator('#run').click();await until(()=>pending.length===legacyCount+1,'normalized-only response');const legacy=pending[legacyCount];delete legacy.response.receivedResponse;await release(legacy);await until(()=>pending.length===legacyCount+2,'normalized-only next request');
   const legacyOpener=page.locator('.inspect-request');await inspectStep(page,legacyOpener,1);await assertAnswerChoices(page,legacy.response.answers);await noRawResponse(page);assert.match(await page.locator('#inspector-response-status').textContent(),/adapter-normalized/);assert.match(await page.locator('#inspector-response-status').textContent(),/No exact provider response trace/);await responseScreenshot(page,'inspector-normalized-only');await escapeAndCheckFocus(page,legacyOpener);await page.locator('#stop').click();await release(pending[legacyCount+1]);await page.waitForFunction(()=>!window.decisionLab.running);
   await check('Normalized-only legacy response remains readable without fabricating a raw response or export');
   report.runs=await page.evaluate(()=>window.decisionLab.records);
   assert.equal(report.providerCalls,0);await check('Synthetic behavior pass made zero provider inference requests');
  }else{
   await page.locator('#compare').uncheck();await page.locator('#repeats').selectOption('1');
   for(const sample of [{provider:'jev',kind:'intake',mode:'text'},{provider:'luna',kind:'intake',mode:'text'},{provider:'gpu',kind:'courier',mode:'vision'}]){
    const forwarded=[];const received=[];let gated=0;
    const handler=async route=>{
     const input=route.request().postDataJSON();assert.equal(input.includeRequest,true);assert.equal(input.includeResponse,true);assertNoScoringLabels(input);
     if(!forwarded.length){forwarded.push(clone(input));report.providerCalls++;const response=await route.fetch();received.push(await response.json());await route.fulfill({response});}
     else{
      // Cancel the workflow before this second request reaches the real API.
      gated++;await page.evaluate(()=>document.querySelector('#stop').click());await route.fulfill({status:200,contentType:'application/json',body:'{"answers":{}}'});
     }
    };
    await page.route('**/api/decide',handler);
    await page.locator(`[data-kind="${sample.kind}"]`).click();await page.locator('#mode').selectOption(sample.mode);await page.locator('.model-select').selectOption(sample.provider);
    const before=await page.evaluate(()=>window.decisionLab.records.length);await page.locator('#run').click();await page.waitForFunction(n=>!window.decisionLab.running&&window.decisionLab.records.length>n,before,{timeout:90000});
    const record=await page.evaluate(()=>window.decisionLab.records.at(-1));report.runs.push(record);await save();
    assert.equal(forwarded.length,1);assert.equal(record.calls.length,1,record.error||'Expected exactly one completed real provider call');
    const entry=record.requests.find(r=>r.step===record.calls[0].requestStep);const actual=entry?.submittedRequest;assert.ok(actual?.body,'Server returned the opt-in upstream request');assertNoScoringLabels(actual.body);
    const opener=page.locator('#results-body tr').first().locator('.inspect-run');await inspectStep(page,opener,1);
    if(sample.provider==='jev'){assert.equal(actual.transport,'decisions');assert.equal(actual.body.state,forwarded[0].state);assert.deepEqual(actual.body.questions,forwarded[0].questions);assert.equal(actual.body.messages,undefined);assert.deepEqual(await displayedJson(page),actual.body);}
    if(sample.provider==='luna'){assert.equal(actual.transport,'chat');assert.ok(Array.isArray(actual.body.messages));assert.equal(actual.body.response_format.type,'json_schema');assert.equal(actual.body.response_format.json_schema.strict,true);assert.deepEqual(await displayedJson(page),actual.body);}
    if(sample.provider==='gpu'){assert.equal(actual.transport,'decisions');assert.equal(typeof actual.body.state,'string');assert.ok(actual.body.images?.[0].startsWith('data:image/'));assert.equal(await page.locator('#inspector-observation img').getAttribute('src'),actual.body.images[0]);assert.deepEqual(await downloadBody(page),actual.body);}
    const rawResponse=entry.receivedResponse;assert.ok(rawResponse?.body,'Server returned opt-in exact provider response');assert.deepEqual(rawResponse,received[0].receivedResponse);assert.deepEqual(entry.normalizedResponse.answers,received[0].answers);assert.deepEqual(await displayedResponse(page),rawResponse.body);await assertAnswerChoices(page,received[0].answers);assert.deepEqual(await downloadBody(page,true),rawResponse.body);await copyResponse(page,rawResponse.body);
    if(sample.provider==='luna'){assert.equal(rawResponse.transport,'chat');assert.equal(typeof rawResponse.body.choices[0].message.content,'string');assert.match(await page.locator('#inspector-response-answers').textContent(),/does not provide native choice confidence/);assert.equal(await page.locator('#inspector-response-answers .inspector-distribution').count(),0);}
    else{assert.equal(rawResponse.transport,'decisions');assert.ok(rawResponse.body.answers);}
    await responseScreenshot(page,`inspector-live-${sample.provider}`);await escapeAndCheckFocus(page,opener);
    await page.unroute('**/api/decide',handler);
    await check('Live provider request and raw response match displayed and exported bodies',{...sample,realCalls:forwarded.length,subsequentRequestsStoppedBeforeForwarding:gated,accuracy:record.calls[0].correct,latencyMs:record.calls[0].latencyMs});
   }
  }
  assert.deepEqual(report.errors,[]);report.complete=true;report.finishedAt=new Date().toISOString();await save();
 }catch(error){report.failure=error.stack;await save();throw error;}finally{
  for(const entry of pending)if(!entry.done)entry.release();
  await browser.close();
  for(const filename of await fs.readdir(output)){const p=path.join(output,filename);if((await fs.stat(p)).isFile())await fs.chmod(p,0o600);}
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
