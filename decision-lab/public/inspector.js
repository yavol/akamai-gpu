// Request snapshots contain model inputs only. Grading labels never enter this view.
const $ = selector => document.querySelector(selector);
let dialog, currentRecord, currentStep, opener, renderedEntry, renderedVersion;

function freeze(value) {
  if(value && typeof value==='object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function captureRequest(provider, state, questions) {
  return freeze(structuredClone({provider,state,questions,includeRequest:true}));
}

export function retainSubmittedRequest(value) {
  if(!value || typeof value!=='object' || !value.body || typeof value.body!=='object')return null;
  return freeze({transport:value.transport,body:value.body});
}

function element(tag, className, text) {
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!=null)node.textContent=text;
  return node;
}

function statusLabel(entry) {
  return ({pending:'In flight',returned:'Response received',applied:'Applied',stopped:'Returned after stop',error:'Failed'})[entry.status] || entry.status;
}

function activeEntry() {return currentRecord?.requests.find(entry=>entry.step===currentStep);}

function safeImageURL(value) {
  if(typeof value!=='string' || value.length>5_600_000)return false;
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!match || match[2].length%4!==0)return false;
  try {
    const header=atob(match[2].slice(0,32));
    return (match[1]==='png' && header.startsWith('\x89PNG\r\n\x1a\n')) ||
      (match[1]==='jpeg' && header.startsWith('\xff\xd8\xff')) ||
      (match[1]==='webp' && header.startsWith('RIFF') && header.slice(8,12)==='WEBP');
  } catch {return false;}
}

function renderObservation(state) {
  const root=$('#inspector-observation');root.replaceChildren();
  const parts=Array.isArray(state)?state:[state];
  let imageNumber=0;
  for(const part of parts) {
    if(typeof part==='string' || part?.type==='text') {
      root.append(element('pre','inspector-text',typeof part==='string'?part:part.text));
    } else if(part?.type==='image_url') {
      const url=part.image_url?.url;
      const figure=element('figure','inspector-image');
      const caption=element('figcaption','',`Submitted image ${++imageNumber} · frozen before the action`);
      if(safeImageURL(url)) {
        const img=element('img');img.alt=`Observation image ${imageNumber} sent at step ${currentStep}`;img.src=url;
        img.onerror=()=>{img.remove();caption.textContent='Image preview could not be decoded; the original input remains in the JSON.';};
        figure.append(img);
      } else caption.textContent='Image preview unavailable: only valid PNG, JPEG, or WebP data images are displayed.';
      figure.append(caption);root.append(figure);
    } else root.append(element('pre','inspector-text',JSON.stringify(part,null,2)));
  }
}

function renderQuestions(questions) {
  const root=$('#inspector-questions');root.replaceChildren();
  for(const [name,question] of Object.entries(questions || {})) {
    const article=element('article','inspector-question');
    article.append(element('h4','',`${name} · ${question.type || 'choice'}`));
    article.append(element('p','inspector-instructions',question.instructions || question.description || question.query || ''));
    const choices=element('dl','inspector-choices');
    for(const [id,description] of Object.entries(question.criteria || {})) {
      choices.append(element('dt','',id),element('dd','',description));
    }
    article.append(choices);root.append(article);
  }
}

function selectedPayload() {
  const entry=activeEntry();
  return entry?.submittedRequest?.body || entry?.browserInput;
}

function renderJSON() {
  const entry=activeEntry();if(!entry)return;
  let abbreviated=false;
  let preview=JSON.stringify(selectedPayload(),(_key,value)=>{
    if(typeof value==='string' && /^data:image\/(png|jpeg|webp);base64,/.test(value)) {
      abbreviated=true;
      return `${value.slice(0,value.indexOf(',')+1)}[${value.length-value.indexOf(',')-1} base64 characters; complete data in Copy / Download JSON]`;
    }
    return value;
  },2);
  if(preview.length>100_000){preview=preview.slice(0,100_000)+'\n… [on-screen preview truncated]';abbreviated=true;}
  $('#inspector-json').textContent=preview;
  $('#inspector-json-note').textContent=abbreviated?'This on-screen preview abbreviates image data or long content. Copy and Download JSON preserve the complete body.':'The JSON below is complete.';
}

function renderSelected() {
  const entry=activeEntry();if(!entry)return;
  renderedEntry=entry;renderedVersion=`${entry.status}|${!!entry.submittedRequest}|${entry.error || ''}`;
  const model=entry.returnedModel || currentRecord.requestedModel || currentRecord.model || currentRecord.provider;
  $('#inspector-title').textContent=`${currentRecord.label} · Step ${entry.step}`;
  $('#inspector-meta').textContent=`${currentRecord.experimentName || currentRecord.kind} · run ${currentRecord.round} · ${currentRecord.mode==='vision'?'Image + task':'Text state'} · ${model}`;
  $('#inspector-request-status').textContent=`${statusLabel(entry)}${entry.error?` · ${entry.error}`:''}`;
  $('#inspector-notice').textContent=entry.submittedRequest?
    'Frozen input for this step. The exact provider JSON below shows the adapter’s submitted body. New steps stay in the step menu; this view stays here.':
    entry.status==='pending'?'This request is in flight. The browser input is captured below; a provider trace will appear if the server returns one. New steps will not change this selection.':
    'No provider trace was returned. This view preserves the browser input to the adapter; it cannot verify the final body sent to the model.';
  $('#inspector-trace-label').textContent=entry.submittedRequest?`Exact provider JSON · ${entry.submittedRequest.transport || 'native request'}`:'Browser API input · provider trace unavailable';
  const kind=entry.submittedRequest?'provider request':'browser input';
  $('#inspector-copy').textContent=`Copy ${kind}`;
  $('#inspector-download').textContent=`Download ${kind}`;
  $('#inspector-status').textContent='';
  renderObservation(entry.browserInput.state);
  renderQuestions(entry.browserInput.questions);
  if($('#inspector-trace').open)renderJSON();
  else {$('#inspector-json').textContent='';$('#inspector-json-note').textContent='';}
}

function updateSteps() {
  const select=$('#inspector-step');
  const oldCount=select.options.length;
  currentRecord.requests.forEach((entry,index)=>{
    const option=select.options[index] || document.createElement('option');
    option.value=String(entry.step);option.textContent=`Step ${entry.step} · ${statusLabel(entry)}`;
    if(index>=oldCount)select.append(option);
  });
  select.value=String(currentStep);
}

function initialize() {
  if(dialog)return;
  dialog=element('dialog','request-inspector');dialog.id='request-inspector';
  dialog.setAttribute('aria-labelledby','inspector-title');dialog.setAttribute('aria-describedby','inspector-notice');
  // This template is static; all request/model content is inserted with textContent.
  dialog.innerHTML=`<div class="inspector-header"><div><div class="inspector-eyebrow">WHAT THE MODEL RECEIVES</div><h2 id="inspector-title"></h2><p class="inspector-meta" id="inspector-meta"></p></div><button class="button quiet" id="inspector-close" aria-label="Close request inspector" autofocus>✕ Close</button></div><div class="inspector-toolbar"><label for="inspector-step">Request step</label><select id="inspector-step"></select><button class="button quiet" id="inspector-copy">Copy request</button><button class="button quiet" id="inspector-download">Download request</button></div><p class="inspector-notice" id="inspector-notice"></p><p class="inspector-request-status" id="inspector-request-status"></p><div class="inspector-columns"><section class="inspector-section"><h3>Captured observation</h3><div id="inspector-observation"></div></section><section class="inspector-section"><h3>Instructions & allowed choices</h3><div id="inspector-questions"></div></section></div><details id="inspector-trace"><summary id="inspector-trace-label">Exact provider JSON</summary><p id="inspector-json-note"></p><pre class="inspector-json" id="inspector-json"></pre></details><p class="inspector-status" id="inspector-status" role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  $('#inspector-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{
    const destination=opener?.isConnected && !opener.disabled?opener:
      [$('#stop'),$('#reset'),$('#run')].find(node=>node && !node.hidden && !node.disabled);
    destination?.focus();
  });
  $('#inspector-step').onchange=()=>{currentStep=Number($('#inspector-step').value);renderSelected();};
  $('#inspector-trace').addEventListener('toggle',()=>{if($('#inspector-trace').open)renderJSON();});
  $('#inspector-copy').onclick=async()=>{
    const text=JSON.stringify(selectedPayload(),null,2);
    try {
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      $('#inspector-status').textContent=activeEntry().submittedRequest?'Complete provider request copied.':'Complete browser input copied; no provider trace was returned.';
    } catch {$('#inspector-status').textContent='Clipboard access is unavailable. Download JSON preserves the complete request.';}
  };
  $('#inspector-download').onclick=()=>{
    const entry=activeEntry();const payload=JSON.stringify(selectedPayload(),null,2);
    const url=URL.createObjectURL(new Blob([payload],{type:'application/json'}));
    const link=element('a');link.href=url;
    link.download=`decision-lab-${currentRecord.provider}-run-${currentRecord.round}-step-${entry.step}-${entry.submittedRequest?'provider-request':'browser-input'}.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#inspector-status').textContent='Complete JSON downloaded.';
  };
}

export function openRequestInspector(record, trigger, step) {
  if(!record?.requests?.length)return;
  initialize();currentRecord=record;currentStep=step || record.requests.at(-1).step;opener=trigger;
  $('#inspector-step').replaceChildren();updateSteps();renderSelected();
  if(!dialog.open)dialog.showModal();
  dialog.scrollTop=0;
}

export function refreshRequestInspector(record) {
  if(!dialog?.open || currentRecord!==record)return;
  updateSteps();const entry=activeEntry();
  const version=`${entry.status}|${!!entry.submittedRequest}|${entry.error || ''}`;
  if(entry!==renderedEntry || version!==renderedVersion) {
    const scroll=dialog.scrollTop;renderSelected();dialog.scrollTop=scroll;
  }
}
