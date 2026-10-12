// Live deployed-GPU browser verification. Supply APP_URL and, for Jupyter,
// WORKSHOP_JUPYTER_TOKEN through the environment. No credentials are persisted.
const { chromium, launchOptions, appURL } = require('./browser-runtime.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
 const target=new URL(appURL);
 const proxy=process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
 const remote=!['127.0.0.1','localhost'].includes(target.hostname);
 const browser=await chromium.launch({...launchOptions,...(remote&&proxy?{proxy:{server:proxy}}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 if(process.env.WORKSHOP_JUPYTER_TOKEN){
  await context.route('**/*',route=>{
   const request=route.request(),headers={...request.headers()};
   if(new URL(request.url()).origin===target.origin)headers.Authorization=`token ${process.env.WORKSHOP_JUPYTER_TOKEN}`;
   return route.continue({headers});
  });
 }
 const page=await context.newPage();
 const report={startedAt:new Date().toISOString(),deployment:'Authenticated workshop GPU',runs:[],errors:[],checks:[]};
 page.on('pageerror',e=>report.errors.push(e.message));
 const out=process.env.QA_OUTPUT || path.join(__dirname,'../evidence');await fs.mkdir(out,{recursive:true});
 try{
  await page.goto(appURL,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('.model-select')?.value==='gpu');
  report.checks.push('Configured GPU is selected by default');
  const configuredModels=await page.locator('.model-select').first().locator('option:not(:disabled)').count();
  if(configuredModels===1){
   assert.equal(await page.locator('#compare').isChecked(),false);
   assert.equal(await page.locator('#compare').isDisabled(),true);
   report.checks.push('GPU-only catalog disables comparison');
  }else{
   assert.ok(configuredModels>1,'Expected at least one configured model');
   assert.equal(await page.locator('#compare').isDisabled(),false);
   await page.locator('#compare').uncheck();
   report.checks.push('Comparison is available; selected a single GPU lane for verification');
  }
  const samples=[['courier','text'],['intake','text'],['procurement','text'],['courier','vision']];
  for(const [kind,mode] of samples){
   await page.locator(`[data-kind="${kind}"]`).click();
   await page.locator('#mode').selectOption(mode);
   const before=await page.evaluate(()=>window.decisionLab.records.length);
   await page.locator('#run').click();
   await page.waitForFunction(n=>!window.decisionLab.running&&window.decisionLab.records.length>n,before,{timeout:180000});
   const record=await page.evaluate(()=>window.decisionLab.records.at(-1));report.runs.push(record);
   assert.notEqual(record.status,'error',record.error);
   assert.equal(record.provider,'gpu');
   assert.equal(record.model,'Cloudflare/clef-flash');
   await page.locator('.experiment').screenshot({path:path.join(out,`gpu-${kind}-${mode}.png`)});
   console.log(JSON.stringify({kind,mode,status:record.status,correct:record.correct,completed:record.completed,p50:record.p50,totalMs:record.totalMs,progress:record.taskProgress}));
   assert.equal(record.status,'complete',`${kind}/${mode} did not finish successfully`);
   // A courier can recover from a non-optimal move and still finish its task.
   // Preserve decision accuracy in the report; completion is the UI smoke check.
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-kind="procurement"]').click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  report.checks.push('Mobile layout has no page overflow');
  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();
  const download=await downloadPromise;await download.saveAs(path.join(out,'gpu-browser-export.json'));
  report.checks.push('Live JSON export downloads');
  assert.equal(report.errors.length,0);
  report.complete=true;
 }finally{
  report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'gpu-browser.json'),JSON.stringify(report,null,2));await browser.close();
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
