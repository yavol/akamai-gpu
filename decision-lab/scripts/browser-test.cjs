/** Real-browser, real-provider smoke test. Runs are opt-in via QA_LIVE=1.
 * node scripts/browser-test.cjs
 * QA_LIVE=1 node scripts/browser-test.cjs
 * QA_LIVE=1 QA_VISION=1 QA_ONLY=vision node scripts/browser-test.cjs
 * This historical OpenRouter suite assumes Clef/Luna defaults and no configured
 * GPU. GPU deployment checks must account for the catalog's GPU-first default.
 */
const {chromium,launchOptions,appURL}=require('./browser-runtime.cjs');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const evidence=path.resolve(__dirname,'../evidence');
const live=process.env.QA_LIVE==='1';
const vision=process.env.QA_VISION==='1';
const onlyVision=process.env.QA_ONLY==='vision';
const url=appURL;
fs.mkdirSync(evidence,{recursive:true});
const report={startedAt:new Date().toISOString(),url,live,vision,checks:[],consoleErrors:[],pageErrors:[],requestFailures:[],runs:[]};
function check(name,details){report.checks.push({name,details,passed:true});console.log(JSON.stringify({check:name,...details}));}
function save(){fs.writeFileSync(path.join(evidence,live?(onlyVision?'browser-qa-vision.json':'browser-qa-live.json'):'browser-qa-layout.json'),JSON.stringify(report,null,2));}
(async()=>{
 const browser=await chromium.launch(launchOptions);
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1080},deviceScaleFactor:1,acceptDownloads:true});
  const page=await context.newPage();
  page.on('console',msg=>{if(msg.type()==='error')report.consoleErrors.push(msg.text());});
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  page.on('requestfailed',req=>report.requestFailures.push({url:req.url(),error:req.failure()?.errorText}));
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.decisionLab&&document.querySelector('#connection').textContent.includes('configured'));
  assert.equal(await page.locator('.lane').count(),2);
  assert.match(await page.locator('h1').textContent(),/See the next move/);
  await page.screenshot({path:path.join(evidence,'desktop-courier-ready.png'),fullPage:true});
  check('Desktop initial render',{connection:await page.locator('#connection').textContent()});
  for(const kind of ['intake','procurement','courier']){
   await page.locator(`[data-kind="${kind}"]`).click();
   assert.equal(await page.locator(`[data-kind="${kind}"]`).getAttribute('aria-selected'),'true');
   assert.equal(await page.locator('.lane').count(),2);
   await page.screenshot({path:path.join(evidence,`desktop-${kind}-ready.png`),fullPage:true});
   if(kind!=='courier')assert.equal(await page.locator('.sc-action-form').count(),2);
  }
  check('All three experiment tabs render',{experiments:['courier','intake','procurement']});
  await page.locator('.model-select').first().selectOption('jev');
  await page.locator('#mode').selectOption('vision');
  assert.equal(await page.locator('.model-select').first().inputValue(),'clef');
  assert.equal(await page.locator('.model-select').first().locator('option[value="jev"]').isDisabled(),true);
  assert.match(await page.locator('#context-note').textContent(),/Jev is unavailable/);
  check('Vision mode prevents JEV selection and explains why',{});
  await page.locator('#mode').selectOption('text');
  await page.locator('#compare').uncheck();
  assert.equal(await page.locator('.lane').count(),1);
  await page.locator('#compare').check();
  assert.equal(await page.locator('.lane').count(),2);
  await page.locator('#seed').fill('123');
  await page.locator('#seed').blur();
  await page.locator('#reset').click();
  assert.match(await page.locator('#run-status').textContent(),/Reset to the same seed/);
  await page.locator('#seed').fill('42');
  await page.locator('#seed').blur();
  check('Compare toggle, seed change, and reset controls work',{});
  const mobile=await context.newPage();
  await mobile.setViewportSize({width:390,height:844});
  await mobile.goto(url,{waitUntil:'networkidle'});
  await mobile.waitForFunction(()=>window.decisionLab);
  for(const kind of ['courier','intake','procurement']){
   await mobile.locator(`[data-kind="${kind}"]`).click();
   const dimensions=await mobile.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,lanes:[...document.querySelectorAll('.lane')].map(x=>{const r=x.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};})}));
   assert.ok(dimensions.document<=dimensions.viewport+1,`Mobile horizontal page overflow in ${kind}: ${JSON.stringify(dimensions)}`);
   assert.ok(dimensions.lanes[1].y>dimensions.lanes[0].y,'Mobile lanes must stack');
   await mobile.screenshot({path:path.join(evidence,`mobile-${kind}.png`),fullPage:true});
   check(`Mobile ${kind} layout`,dimensions);
  }
  await mobile.close();
  if(live){
   async function run(kind,{first='clef',second='luna',mode='text',compare=true,label=kind}={}){
    await page.locator(`[data-kind="${kind}"]`).click();
    await page.locator('#mode').selectOption(mode);
    await page.locator('#compare').setChecked(compare);
    await page.locator('.model-select').first().selectOption(first);
    if(compare)await page.locator('.model-select').nth(1).selectOption(second);
    const before=await page.evaluate(()=>window.decisionLab.records.length);
    await page.locator('#run').click();
    await page.waitForFunction(()=>window.decisionLab.running);
    await page.screenshot({path:path.join(evidence,`desktop-${label}-running.png`),fullPage:true});
    await page.waitForFunction(()=>!window.decisionLab.running,{},{timeout:180000});
    const rows=await page.evaluate(start=>window.decisionLab.records.slice(start),before);
    report.runs.push(...rows);save();
    await page.screenshot({path:path.join(evidence,`desktop-${label}-completed.png`),fullPage:true});
    const summary=rows.map(r=>({kind:r.kind,provider:r.provider,status:r.status,correct:r.correct,completed:r.completed,calls:r.calls.length,p50:r.p50,p95:r.p95,totalMs:r.totalMs,error:r.error}));
    check(`Live ${label} finished`,{runs:summary});
    assert.ok(rows.every(r=>['complete','incomplete','needs review'].includes(r.status)),`${label}: provider error: ${JSON.stringify(summary)}`);
    assert.ok(rows.every(r=>r.calls.length>0),`${label}: missing API calls`);
    assert.ok(rows.every(r=>r.calls.every(c=>Number.isFinite(c.latencyMs)&&c.latencyMs>0)),`${label}: missing provider timing`);
    return rows;
   }
   if(!onlyVision){
   await run('courier');
   await run('intake');
   await run('procurement');
   await run('intake',{first:'jev',compare:false,label:'intake-jev'});
   // Two stop cycles prove the Stop control is reusable; in-flight requests may still be billed.
   for(let i=0;i<2;i++){
    const before=await page.evaluate(()=>window.decisionLab.records.length);
    await page.locator('#run').click();
    await page.waitForFunction(()=>window.decisionLab.running);
    assert.equal(await page.locator('#stop').isEnabled(),true);
    await page.locator('#stop').click();
    await page.waitForFunction(()=>!window.decisionLab.running,{},{timeout:60000});
    const stopped=await page.evaluate(start=>window.decisionLab.records.slice(start),before);
    assert.ok(stopped.every(r=>r.status==='stopped'),'Stop records preserve stopped status');
    check(`Stop cycle ${i+1} completes and unlocks controls`,{rows:stopped.map(r=>({status:r.status,calls:r.calls.length}))});
   }
   await page.locator('#reset').click();
   assert.equal(await page.locator('#run').isEnabled(),true);
   }
   if(vision)await run('courier',{first:'clef',compare:false,mode:'vision',label:'courier-vision'});
   const downloadPromise=page.waitForEvent('download');
   await page.locator('#export').click();
   const download=await downloadPromise;
   const exportPath=path.join(evidence,onlyVision?'browser-vision-export.json':'browser-live-export.json');
   await download.saveAs(exportPath);
   const data=JSON.parse(fs.readFileSync(exportPath,'utf8'));
   const recordCount=await page.evaluate(()=>window.decisionLab.records.length);
   assert.equal(data.schemaVersion,1);assert.equal(data.runs.length,recordCount);
   check('JSON export contains every session run and methodology',{runs:data.runs.length,exportPath});
   report.runs=data.runs;
  }
  assert.deepEqual(report.pageErrors,[],'No runtime errors');
  assert.deepEqual(report.consoleErrors,[],'No console errors');
  assert.deepEqual(report.requestFailures,[],'No failed browser requests');
  check('Browser console and network clean',{});
  report.finishedAt=new Date().toISOString();save();
 }catch(error){report.failure=error.stack;save();throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
