/** Targeted live recheck after shared prompt/outcome changes. Calls real providers.
 * Synthetic outcome-cap checks run separately and never enter benchmark export.
 * Requires the historical OpenRouter provider catalog; GPU-only deployment tests
 * must select their configured providers explicitly instead.
 */
const {chromium,launchOptions,appURL}=require('./browser-runtime.cjs');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const evidence=path.resolve(__dirname,'../evidence');
const url=appURL;
const report={startedAt:new Date().toISOString(),url,live:true,revision:'Final shared prompts and task outcome semantics',checks:[],consoleErrors:[],pageErrors:[],requestFailures:[],runs:[],syntheticChecks:[]};
const save=()=>fs.writeFileSync(path.join(evidence,'browser-qa-final.json'),JSON.stringify(report,null,2));
const log=(name,details={})=>{report.checks.push({name,passed:true,...details});console.log(JSON.stringify({check:name,...details}));save();};
(async()=>{
 const browser=await chromium.launch(launchOptions);
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,acceptDownloads:true});
  const page=await context.newPage();
  page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
  page.on('pageerror',e=>report.pageErrors.push(e.message));
  page.on('requestfailed',r=>report.requestFailures.push({url:r.url(),error:r.failure()?.errorText}));
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.decisionLab&&document.querySelector('#connection').textContent.includes('configured'));
  await page.screenshot({path:path.join(evidence,'final-courier-ready-1440x1000.png')});
  async function run(kind,{first='clef',second='luna',compare=true,label=kind}={}){
   await page.locator(`[data-kind="${kind}"]`).click();
   await page.locator('#compare').setChecked(compare);
   await page.locator('.model-select').first().selectOption(first);
   if(compare)await page.locator('.model-select').nth(1).selectOption(second);
   const before=await page.evaluate(()=>window.decisionLab.records.length);
   await page.locator('#run').click();
   await page.waitForFunction(()=>window.decisionLab.running);
   await page.waitForFunction(()=>!window.decisionLab.running,{},{timeout:180000});
   const rows=await page.evaluate(start=>window.decisionLab.records.slice(start),before);
   report.runs.push(...rows);save();
   await page.locator('.experiment').scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(evidence,`final-${label}-completed-1440x1000.png`)});
   await page.locator('.experiment').screenshot({path:path.join(evidence,`final-${label}-experiment.png`)});
   const summary=rows.map(r=>({kind:r.kind,provider:r.provider,status:r.status,outcome:r.outcome,taskProgress:r.taskProgress,correct:r.correct,completed:r.completed,calls:r.calls.length,p50:r.p50,p95:r.p95,totalMs:r.totalMs,error:r.error}));
   log(`Live ${label}`,{runs:summary});
   assert.ok(rows.every(r=>['complete','incomplete','needs review'].includes(r.status)),JSON.stringify(summary));
   assert.ok(rows.every(r=>r.calls.length>0&&r.calls.every(c=>c.latencyMs>0)));
   for(const r of rows){
    assert.ok(r.taskProgress,'Final task progress preserved');
    assert.ok(['success','failure'].includes(r.outcome),'Final outcome preserved');
    if(kind==='courier')assert.equal(r.status,r.taskProgress.current===r.taskProgress.total?'complete':'incomplete');
    else assert.equal(r.status,r.correct===r.completed?'complete':'needs review');
   }
   return rows;
  }
  await run('intake');
  await run('procurement');
  await run('procurement',{first:'jev',compare:false,label:'procurement-jev'});
  await run('courier',{first:'jev',compare:false,label:'courier-jev'});
  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();
  const download=await downloadPromise,exportPath=path.join(evidence,'browser-final-export.json');await download.saveAs(exportPath);
  const data=JSON.parse(fs.readFileSync(exportPath,'utf8'));assert.equal(data.runs.length,6);report.runs=data.runs;
  log('Final JSON export contains all six live runs',{exportPath,runs:data.runs.length});
  // A separate page intercepts every decision request. These synthetic calls never reach providers.
  const synthetic=await context.newPage();let fixtureCalls=0;
  await synthetic.route('**/api/decide',async route=>{
   const body=route.request().postDataJSON(),direction=Object.keys(body.questions.direction.criteria)[0];fixtureCalls++;
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({provider:'qa-fixture',model:'qa-fixture-no-inference',latencyMs:1,answers:{direction:{choice:direction,probabilities:null}}})});
  });
  await synthetic.goto(url,{waitUntil:'networkidle'});await synthetic.waitForFunction(()=>window.decisionLab);
  await synthetic.locator('#compare').uncheck();await synthetic.locator('#run').click();
  await synthetic.waitForFunction(()=>window.decisionLab.records.length===1&&!window.decisionLab.running);
  const fixture=await synthetic.evaluate(()=>window.decisionLab.records[0]);
  assert.equal(fixtureCalls,18);assert.equal(fixture.status,'incomplete');assert.equal(fixture.outcome,'failure');assert.ok(fixture.taskProgress.current<fixture.taskProgress.total);
  assert.equal(await synthetic.locator('.lane-state').textContent(),'INCOMPLETE');assert.match(await synthetic.locator('#results-body').textContent(),/incomplete/);
  report.syntheticChecks.push({name:'18-move game cap visibly marked incomplete',providerCalls:0,fixtureCalls,status:fixture.status,outcome:fixture.outcome,taskProgress:fixture.taskProgress});
  log('Synthetic game cap UI correctly says incomplete',{fixtureCalls,providerCalls:0,status:fixture.status});
  await synthetic.close();
  assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.requestFailures,[]);
  log('Browser console and network clean');report.finishedAt=new Date().toISOString();save();
 }catch(error){report.failure=error.stack;save();throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
