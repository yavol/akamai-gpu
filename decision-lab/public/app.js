import {createScenario} from './scenarios.js';
import {captureRequest,retainSubmittedRequest,retainReceivedResponse,captureNormalizedResponse,openRequestInspector,refreshRequestInspector} from './inspector.js';

const $ = (selector, root = document) => root.querySelector(selector);
const appBase = new URL('.', import.meta.url);
const apiURL = path => new URL(`api/${path}`, appBase);
const definitions = {
  courier: {name:'Neon Courier', title:'A race from observation to action', number:'01'},
  intake: {name:'Inbox to action', title:'Turn incoming requests into routed cases', number:'02'},
  procurement: {name:'Procurement desk', title:'Find the right supplier. Prepare the request.', number:'03'}
};
let models = [], catalogReady = false, kind = 'courier', lanes = [], running = false, generation = 0, records = [];
let modelSelections = [];
let roundNumber = 0;
const formatMs = ms => ms == null ? '—' : ms >= 1000 ? `${(ms/1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
const quantile = (values, p) => { if (!values.length) return null; const a = [...values].sort((x,y)=>x-y); return a[Math.max(0,Math.ceil(a.length*p)-1)]; };
const nameOf = id => models.find(m=>m.id===id)?.name || id;
function notice(message='') { $('#notice').textContent = message; $('#notice').hidden = !message; }
const availableModels = () => models.filter(m=>m.available && ($('#mode').value!=='vision' || m.vision));
function modelReason(model) { return !model.available ? model.unavailableReason || model.reason || 'Not configured on this server' : $('#mode').value==='vision' && !model.vision ? 'Text observations only' : ''; }
function makeOption(model, selected) { const o=document.createElement('option');const reason=modelReason(model);o.value=model.id;o.textContent=model.name+(reason?` · ${reason}`:'');o.title=reason || model.description || model.model || '';o.selected=selected===model.id;o.disabled=!!reason;return o; }
function syncControls() {
  const available=availableModels();
  $('#compare').disabled=running || available.length<2;
  $('#compare').parentElement.title=available.length<2 ? 'Configure at least two models that support this observation mode to compare them.' : '';
  $('#run').disabled=running || !catalogReady || !available.length;
  $('#run').textContent=$('#compare').checked?'▶ Run comparison':'▶ Run demo';
  document.querySelectorAll('.model-select').forEach(el=>el.disabled=running || !available.length);
}
function describeModel(el, id) {
  const model=models.find(m=>m.id===id);
  $('.model-description',el).textContent=model ? [model.description,model.model].filter(Boolean).join(' · ') : catalogReady?'No configured backend supports this observation mode.':'Waiting for the server model catalog…';
}
function recordForLane(lane) {
  const provider=$('.model-select',lane.el).value;
  if(lane.record?.provider===provider)return lane.record;
  return records.findLast(record=>record.kind===lane.kind && record.provider===provider);
}
function updateInspectorButton(lane) {
  const record=recordForLane(lane),count=record?.requests?.length || 0;
  const button=$('.inspect-request',lane.el);button.disabled=!count;
  button.title=count?'Inspect a frozen model request and its response':'Run the demo to capture a model request and response';
  $('.request-summary',lane.el).textContent=count?`${count} request${count===1?'':'s'} captured`:'No requests captured';
}

function mount() {
  const available=availableModels();
  if(available.length<2)$('#compare').checked=false;
  const preferred=['gpu','clef','luna','jev','luna-decisions'].map(id=>available.find(m=>m.id===id)).filter(Boolean);
  const first=preferred[0] || available[0];
  if(!available.some(m=>m.id===modelSelections[0]))modelSelections[0]=first?.id;
  if(!available.some(m=>m.id===modelSelections[1]))modelSelections[1]=(available.find(m=>m.id==='luna' && m.id!==modelSelections[0]) || preferred.find(m=>m.id!==modelSelections[0]) || available.find(m=>m.id!==modelSelections[0]))?.id;
  $('#lanes').replaceChildren();
  $('#lanes').classList.toggle('single', !$('#compare').checked);
  const total = $('#compare').checked ? 2 : 1;
  lanes = Array.from({length:total}, (_,i)=>{
    const el=document.createElement('article'); el.className='lane';
    el.innerHTML=`<div class="lane-header"><span class="lane-badge">${i?'B':'A'}</span><select class="model-select" aria-label="Model ${i?'B':'A'}"></select><span class="lane-state">READY</span></div><p class="context-note model-description"></p><div class="lane-inspector"><button class="button quiet inspect-request" disabled>⌕ Inspect request &amp; response</button><span class="request-summary">No requests captured</span></div><div class="scene"></div><div class="lane-stats"><div><span class="stat-label">LAST DECISION</span><span class="stat-value last">—</span></div><div><span class="stat-label">TASK TIME</span><span class="stat-value total">—</span></div><div><span class="stat-label">PROGRESS</span><span class="stat-value progress">0</span></div></div><p class="context-note model-timing" hidden></p><div class="probability-panel">Native choice probabilities appear here</div><div class="action-log">Ready · observation → model → action</div>`;
    const select=$('.model-select',el);
    models.forEach(m=>select.append(makeOption(m,modelSelections[i])));
    if(!available.length){const o=document.createElement('option');o.textContent=catalogReady?'No model available for this mode':'Loading models…';o.selected=true;o.disabled=true;o.value='';select.prepend(o);}
    select.disabled=running || !available.length;
    select.onchange=()=>{modelSelections[i]=select.value;describeModel(el,select.value);updateInspectorButton(lane);};
    describeModel(el,modelSelections[i]);
    $('#lanes').append(el);
    const scenario=createScenario(kind,$('.scene',el),{seed:Number($('#seed').value)||42});
    const lane={el,scenario,kind,index:i,calls:[],completed:0,correct:0,start:0,finished:false};
    $('.inspect-request',el).onclick=event=>openRequestInspector(recordForLane(lane),event.currentTarget);
    updateInspectorButton(lane);
    updateProgress(lane); return lane;
  });
  $('#experiment-kicker').textContent=`EXPERIMENT ${definitions[kind].number}`;
  $('#experiment-title').textContent=definitions[kind].title;
  const subject=$('#compare').checked?'Both models':'The model';
  $('#context-note').textContent=($('#mode').value==='vision' ? `${subject} receive${$('#compare').checked?'':'s'} a rendered image and task instructions. Jev is unavailable in visual mode because its endpoint accepts text only; select a model with image support.` : `${subject} receive${$('#compare').checked?'':'s'} the same seeded text observation and task rules. Each model’s actions change its own workspace.`)+(available.length<2 && catalogReady?' Side-by-side comparison needs a second configured model for this observation mode.':'');
  syncControls();
}
function updateProgress(lane) { const p=lane.scenario.progress(); $('.progress',lane.el).innerHTML=`${p.current ?? 0}<small> / ${p.total ?? '—'}</small>`; }
function setState(lane,text,busy=false) { const el=$('.lane-state',lane.el);el.textContent=text;el.classList.toggle('busy',busy); }
function log(lane,message,error=false) { const el=$('.action-log',lane.el);el.textContent=message;el.classList.toggle('error',error); }
function probabilities(lane,answers) {
  const panel=$('.probability-panel',lane.el);panel.replaceChildren();
  const first=Object.values(answers).find(a=>a?.probabilities && Object.keys(a.probabilities).length);
  if (!first) {panel.textContent='This provider does not return choice probabilities';return;}
  Object.entries(first.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([label,value])=>{
    const chip=document.createElement('span');chip.className='prob';const bar=document.createElement('i');bar.style.width=`${Math.max(0,Math.min(1,value))*100}%`;chip.append(bar,document.createTextNode(`${label} ${Math.round(value*100)}%`));panel.append(chip);
  });
}
function setRunning(value) {
  running=value;$('#run').hidden=value;$('#stop').hidden=!value;
  $('#stop').disabled=false;
  ['#reset','#mode','#seed','#repeats','#compare'].forEach(s=>$(s).disabled=value);
  document.querySelectorAll('.model-select,.demo-tab').forEach(el=>el.disabled=value);
  syncControls();
}
function renderRecords() {
  $('#results-body').replaceChildren();
  [...records].reverse().forEach(r=>{
    const tr=document.createElement('tr');
    const accuracy=`${r.correct}/${r.completed} decisions`;
    const values=[`${definitions[r.kind].name} / ${r.label}`,r.mode==='vision'?'Image + task':'Text state',r.status==='complete'?accuracy:`${accuracy} · ${r.status}`,`${r.calls.length}`,formatMs(r.p50),formatMs(r.p95),formatMs(r.totalMs)];
    values.forEach((v,i)=>{const td=document.createElement('td');td.textContent=v;if(i===0){const small=document.createElement('small');small.textContent=`seed ${r.seed} · run ${r.round} · ${r.model || r.provider}`;td.append(small);const inspect=document.createElement('button');inspect.className='button quiet inspect-run';const count=r.requests?.length || 0;inspect.textContent=`Inspect ${count} step${count===1?'':'s'}`;inspect.disabled=!count;inspect.onclick=()=>openRequestInspector(r,inspect);td.append(inspect);}tr.append(td);});
    $('#results-body').append(tr);
  });
  $('#export').disabled=!records.length;
}
async function runLane(lane, token, round) {
  const provider=$('.model-select',lane.el).value;
  const record={id:crypto.randomUUID(),kind,experimentName:definitions[kind].name,provider,label:nameOf(provider),requestedModel:models.find(model=>model.id===provider)?.model,mode:$('#mode').value,seed:Number($('#seed').value)||42,round,startedAt:new Date().toISOString(),calls:[],requests:[],completed:0,correct:0,status:'running'};
  lane.record=record;
  lane.start=performance.now();lane.finished=false;
  let status='complete';
  let currentRequest;
  try {
    while(token===generation) {
      const observation=lane.scenario.next({mode:record.mode});
      if (!observation) break;
      if (record.calls.length>=36) {status='step limit';log(lane,'Stopped after 36 decisions; task incomplete.',true);break;}
      setState(lane,'DECIDING',true);
      log(lane,`Reading ${record.mode==='vision'?'image':'state'} · decision ${record.calls.length+1}`);
      currentRequest={step:record.requests.length+1,status:'pending',startedAt:new Date().toISOString(),browserInput:captureRequest(provider,observation.state,observation.questions)};
      record.requests.push(currentRequest);updateInspectorButton(lane);refreshRequestInspector(record);
      const t=performance.now();
      const response=await fetch(apiURL('decide'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentRequest.browserInput)});
      const result=await response.json();
      const browserRoundTripMs=performance.now()-t;
      currentRequest.finishedAt=new Date().toISOString();currentRequest.browserRoundTripMs=browserRoundTripMs;
      currentRequest.submittedRequest=retainSubmittedRequest(result.submittedRequest);
      currentRequest.receivedResponse=retainReceivedResponse(result.receivedResponse);
      currentRequest.normalizedResponse=captureNormalizedResponse(result);
      currentRequest.returnedModel=result.model;currentRequest.status='returned';
      refreshRequestInspector(record);
      if(!response.ok) throw new Error(result.error || `Provider returned HTTP ${response.status}`);
      if(token!==generation) {status='stopped';currentRequest.status='stopped';refreshRequestInspector(record);break;}
      if (!result.answers || typeof result.answers!=='object') throw new Error('The provider returned no decisions.');
      const applied=lane.scenario.apply(result.answers);
      const {submittedRequest,receivedResponse,...decision}=result;
      const call={...decision,browserRoundTripMs,step:record.calls.length+1,requestStep:currentRequest.step,correct:applied.correct,detail:applied.detail,expected:observation.expected,observationMeta:observation.meta};
      record.calls.push(call);record.completed++;if(applied.correct)record.correct++;
      currentRequest.status='applied';refreshRequestInspector(record);
      record.model=result.model;
      lane.calls=record.calls;
      $('.last',lane.el).textContent=formatMs(result.latencyMs);
      const timing=$('.model-timing',lane.el);
      timing.hidden=!Number.isFinite(result.inferenceMs);
      timing.textContent=timing.hidden?'':`Server-reported GPU inference: ${formatMs(result.inferenceMs)} · Last decision includes network and request handling.`;
      $('.total',lane.el).textContent=formatMs(performance.now()-lane.start);
      updateProgress(lane);probabilities(lane,result.answers);log(lane,applied.detail || 'Decision applied');
      setState(lane,applied.done?'FINISHED':'ACTING');
      // Let the browser paint each actual action; no artificial latency handicap.
      await new Promise(resolve=>requestAnimationFrame(resolve));
      if(applied.done){
        const progress=lane.scenario.progress();
        record.taskProgress=progress;
        record.outcome=applied.outcome;
        if(kind==='courier' && progress.current<progress.total)status='incomplete';
        else if(applied.success===false)status='needs review';
        break;
      }
    }
    if(token!==generation)status='stopped';
  } catch(error) {status='error';record.error=error.message;if(currentRequest){currentRequest.status='error';currentRequest.error=error.message;currentRequest.finishedAt ||= new Date().toISOString();refreshRequestInspector(record);}log(lane,error.message,true);setState(lane,'ERROR');}
  record.status=status;record.totalMs=performance.now()-lane.start;record.finishedAt=new Date().toISOString();
  record.p50=quantile(record.calls.map(c=>c.latencyMs).filter(Number.isFinite),.5);record.p95=quantile(record.calls.map(c=>c.latencyMs).filter(Number.isFinite),.95);
  lane.finished=true;$('.total',lane.el).textContent=formatMs(record.totalMs);
  setState(lane,status==='complete'?'COMPLETE':status.toUpperCase());records.push(record);renderRecords();updateInspectorButton(lane);return record;
}
async function run() {
  if(running || !catalogReady || !availableModels().length)return;notice();mount();setRunning(true);const token=++generation;
  const repeats=Number($('#repeats').value);
  const timer=setInterval(()=>{lanes.forEach(l=>{if(l.start&&!l.finished)$('.total',l.el).textContent=formatMs(performance.now()-l.start);});},75);
  for(let n=0;n<repeats && token===generation;n++) {
    if(n>0){mount();setRunning(true);}
    roundNumber++;$('#run-status').textContent=`Run ${n+1} of ${repeats} · live requests in progress`;
    const results=await Promise.all(lanes.map(l=>runLane(l,token,roundNumber)));
    if(results.some(r=>r.status==='error')){notice('A provider returned an error. The exact failure is shown in its lane and preserved in the export.');break;}
  }
  clearInterval(timer);setRunning(false);$('#run-status').textContent=token===generation?'Run finished · results saved in this session':'Stopped · completed calls preserved';
}
$('#run').onclick=run;
$('#stop').onclick=()=>{generation++;$('#stop').disabled=true;$('#run-status').textContent='Stopping after in-flight requests finish…';notice('Stopping: the current API requests may still finish and be billed. No further decisions will be sent.');};
$('#reset').onclick=()=>{mount();notice();$('#run-status').textContent='Reset to the same seed';};
['#mode','#seed','#compare'].forEach(s=>$(s).onchange=()=>{mount();notice();});
document.querySelectorAll('.demo-tab').forEach(el=>el.onclick=()=>{kind=el.dataset.kind;document.querySelectorAll('.demo-tab').forEach(t=>{t.classList.toggle('active',t===el);t.setAttribute('aria-selected',String(t===el));});mount();notice();$('#run-status').textContent='Ready when you are';});
$('#export').onclick=()=>{
  const data={schemaVersion:1,exportedAt:new Date().toISOString(),methodology:{latency:'Server wall-clock provider request including proxy, network, and routing',total:'Browser wall-clock full task including rendering',percentile:'Nearest-rank; first call included',workloads:'Synthetic seeded browser sandboxes; each model applies its own choices',warning:'Different actions can yield different game trajectories. No inference-only speed claim. Small samples are exploratory.',luna:'GPT-6 Luna chat with structured JSON; decision providers use choice heads.'},runs:records};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`decision-lab-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
mount();
try {
  const response=await fetch(apiURL('models'));if(!response.ok)throw new Error('Model endpoint unavailable');const data=await response.json();
  const list=Array.isArray(data.providers)?data.providers:Object.entries(data.providers).map(([id,v])=>({id,...v}));
  models=list.map(m=>({ ...m,id:m.id || m.provider,name:m.name || m.label || m.id || m.provider,vision:m.vision ?? m.supportsImages ?? m.supports_images ?? false,available:m.available ?? m.configured ?? false}));
  // Preserve the actual server catalog, never silently substitute model IDs.
  catalogReady=true;$('#compare').checked=availableModels().length>=2;mount();$('#connection').textContent=`● ${models.filter(m=>m.available).length} providers configured`;
  if(!models.some(m=>m.available))notice('No inference backend is configured. The model menu shows the setup required for each provider.');
} catch(error) { $('#connection').textContent='● Server unavailable';notice('Start the Python server to connect the live models. '+error.message);$('#run').disabled=true; }

window.decisionLab={get records(){return records;},get lanes(){return lanes;},get running(){return running;}};
