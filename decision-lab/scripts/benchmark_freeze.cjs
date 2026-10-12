#!/usr/bin/env node
// Capture six reproducible text observations; no model requests are made here.
const {chromium, launchOptions, appURL} = require('./browser-runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.goto(appURL, {waitUntil:'networkidle'});
    const fixtures = await page.evaluate(async () => {
      const {createScenario} = await import(new URL('./scenarios.js', document.baseURI).href);
      const fixtures = [];
      for (const kind of ['courier','intake','procurement']) {
        const container = document.createElement('div');
        container.style.cssText = 'width:900px;min-height:650px;position:relative';
        document.body.append(container);
        const scenario = createScenario(kind, container, {seed:42});
        for (let index=0; index<2; index++) {
          const observation = scenario.next({mode:'text'});
          if (!observation) throw new Error(`${kind} is missing observation ${index+1}`);
          fixtures.push({id:`${kind}-${index+1}`,kind,seed:42,...structuredClone(observation)});
          // Ground truth advances the fixture builder only. The provider benchmark
          // sends state and questions, never expected or these fixture actions.
          const answer = Object.fromEntries(Object.entries(observation.expected).map(([key,value]) => [key, Array.isArray(value) ? value[0] : value]));
          scenario.apply(answer);
        }
        container.remove();
      }
      return fixtures;
    });
    const source = fs.readFileSync(path.join(root,'public','scenarios.js'));
    const report = {
      createdAt:new Date().toISOString(),
      seed:42,
      fixtureMethod:'First two text observations per scenario; expected choices advance a separate browser container only to construct the next observation. Frozen observations are not live task completion.',
      sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),
      fixtures
    };
    const destination = path.join(root,'evidence','frozen-observations.json');
    fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({destination,count:fixtures.length,ids:fixtures.map(x=>x.id)}));
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
