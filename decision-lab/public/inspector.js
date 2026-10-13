// Frozen model inputs and outputs. Grading labels never enter this view.
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
  return freeze(structuredClone({provider,state,questions,includeRequest:true,includeResponse:true}));
}

export function retainSubmittedRequest(value) {
  if(!value || typeof value!=='object' || !value.body || typeof value.body!=='object')return null;
  return freeze({transport:value.transport,body:value.body});
}

export function retainReceivedResponse(value) {
  if(!value || typeof value!=='object' || !value.body || typeof value.body!=='object')return null;
  return freeze({transport:value.transport,body:value.body});
}

export function captureNormalizedResponse(result) {
  if(!result.answers || typeof result.answers!=='object' || Array.isArray(result.answers))return null;
  const keys=['answers','model','requestedModel','provider','upstreamProvider','usage','latencyMs','timing','confidenceKind','transport'];
  return freeze(structuredClone(Object.fromEntries(keys.filter(key=>key in result).map(key=>[key,result[key]]))));
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

function responseVersion(entry) {
  return `${entry.status}|${!!entry.submittedRequest}|${!!entry.receivedResponse}|${!!entry.normalizedResponse}|${entry.error || ''}`;
}

function renderResponseJSON() {
  const response=activeEntry()?.receivedResponse;
  if(!response) {
    $('#inspector-response-json').textContent='';
    $('#inspector-response-json-note').textContent=activeEntry()?.status==='pending'?'The model is still running. No provider response has arrived.':'The server did not return an exact provider response trace for this step.';
    return;
  }
  let preview=JSON.stringify(response.body,null,2);
  const truncated=preview.length>100_000;
  if(truncated)preview=preview.slice(0,100_000)+'\n… [on-screen preview truncated]';
  $('#inspector-response-json').textContent=preview;
  $('#inspector-response-json-note').textContent=truncated?'The on-screen response is shortened. Copy response and Download response preserve the complete provider body.':'Exact provider response body, before the adapter normalized the answers.';
}

function renderResponse(entry) {
  const response=entry.normalizedResponse,trace=entry.receivedResponse;
  const root=$('#inspector-response-answers');root.replaceChildren();
  const states={
    pending:'Waiting for the model. No response has been received for this step.',
    returned:'Response received. Application to the demo has not yet been confirmed.',
    applied:'Applied to the demo. The choices below are the adapter-normalized model answers.',
    stopped:'Response received after Stop. It is saved here and was not applied to the demo.',
    error:'This step ended with an error. Application to the demo was not confirmed.',
  };
  let description=states[entry.status] || 'Saved model response for this step.';
  if(response && entry.status!=='applied')description+=' Answers below are adapter-normalized decisions.';
  if(!trace && entry.status!=='pending')description+=' No exact provider response trace was returned.';
  if(entry.error)description+=` ${entry.error}`;
  $('#inspector-response-status').textContent=description;
  $('#inspector-copy-response').disabled=!trace;
  $('#inspector-download-response').disabled=!trace;
  $('#inspector-response-trace-label').textContent=trace?`Raw provider response JSON · ${trace.transport || 'native response'}`:entry.status==='pending'?'Awaiting provider response':'Raw provider response unavailable';
  const metadata=[];
  if(response?.model)metadata.push(response.model);
  if(Number.isFinite(response?.latencyMs))metadata.push(`${Math.round(response.latencyMs)} ms provider round trip`);
  if(response?.usage && Object.keys(response.usage).length)metadata.push(`Usage: ${JSON.stringify(response.usage)}`);
  $('#inspector-response-meta').textContent=metadata.join(' · ');
  if(response) {
    const native=response.confidenceKind==='native' && response.transport!=='chat';
    const percent=value=>`${(value*100).toFixed(1).replace(/\.0$/,'')}%`;
    const probability=value=>Number.isFinite(value) && value>=0 && value<=1;
    for(const [question,answer] of Object.entries(response.answers)) {
      const card=element('article','inspector-answer');card.append(element('h4','',question));
      const choice=typeof answer==='string'?answer:answer?.choice;
      card.append(element('strong','inspector-answer-choice',choice ?? 'No valid choice returned'));
      const meaning=entry.browserInput.questions?.[question]?.criteria?.[choice];
      if(meaning)card.append(element('p','inspector-answer-meaning',meaning));
      if(native && probability(answer?.confidence))card.append(element('p','inspector-answer-confidence',`Native confidence: ${percent(answer.confidence)}`));
      const probabilities=native && answer?.probabilities && typeof answer.probabilities==='object'?Object.entries(answer.probabilities).filter(([,value])=>probability(value)):[];
      if(probabilities.length) {
        card.append(element('p','inspector-answer-confidence','Native choice probabilities'));
        const distribution=element('dl','inspector-distribution');
        probabilities.sort((a,b)=>b[1]-a[1]).forEach(([label,value])=>distribution.append(element('dt','',label),element('dd','',percent(value))));
        card.append(distribution);
      }
      root.append(card);
    }
    if(!native)root.append(element('p','inspector-response-note','This response does not provide native choice confidence or probabilities.'));
  } else root.append(element('p','inspector-response-note',entry.status==='pending'?'The model’s answer will appear here when this request returns.':'No adapter-normalized answers were returned for this step.'));
  if($('#inspector-response-trace').open)renderResponseJSON();
  else {$('#inspector-response-json').textContent='';$('#inspector-response-json-note').textContent='';}
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
  renderedEntry=entry;renderedVersion=responseVersion(entry);
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
  renderResponse(entry);
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
  dialog.innerHTML=`<div class="inspector-header"><div><div class="inspector-eyebrow">MODEL REQUEST & RESPONSE</div><h2 id="inspector-title"></h2><p class="inspector-meta" id="inspector-meta"></p></div><button class="button quiet" id="inspector-close" aria-label="Close request and response inspector" autofocus>✕ Close</button></div><div class="inspector-toolbar"><label for="inspector-step">Request step</label><select id="inspector-step"></select><button class="button quiet" id="inspector-copy">Copy request</button><button class="button quiet" id="inspector-download">Download request</button></div><p class="inspector-notice" id="inspector-notice"></p><p class="inspector-request-status" id="inspector-request-status"></p><section class="inspector-response" id="inspector-response" aria-labelledby="inspector-response-title"><div class="inspector-response-heading"><h3 id="inspector-response-title">Model response</h3><div class="inspector-response-actions"><button class="button quiet" id="inspector-copy-response" disabled>Copy response</button><button class="button quiet" id="inspector-download-response" disabled>Download response</button></div></div><p id="inspector-response-status"></p><p id="inspector-response-meta"></p><div id="inspector-response-answers"></div><details id="inspector-response-trace"><summary id="inspector-response-trace-label">Raw provider response JSON</summary><p id="inspector-response-json-note"></p><pre class="inspector-json" id="inspector-response-json"></pre></details></section><div class="inspector-columns"><section class="inspector-section"><h3>Captured observation</h3><div id="inspector-observation"></div></section><section class="inspector-section"><h3>Instructions & allowed choices</h3><div id="inspector-questions"></div></section></div><details id="inspector-trace"><summary id="inspector-trace-label">Exact provider JSON</summary><p id="inspector-json-note"></p><pre class="inspector-json" id="inspector-json"></pre></details><p class="inspector-status" id="inspector-status" role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  $('#inspector-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{
    const destination=opener?.isConnected && !opener.disabled?opener:
      [$('#stop'),$('#reset'),$('#run')].find(node=>node && !node.hidden && !node.disabled);
    destination?.focus();
  });
  $('#inspector-step').onchange=()=>{currentStep=Number($('#inspector-step').value);renderSelected();};
  $('#inspector-trace').addEventListener('toggle',()=>{if($('#inspector-trace').open)renderJSON();});
  $('#inspector-response-trace').addEventListener('toggle',()=>{if($('#inspector-response-trace').open)renderResponseJSON();});
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
  $('#inspector-copy-response').onclick=async()=>{
    const body=activeEntry()?.receivedResponse?.body;if(!body)return;
    try {
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(JSON.stringify(body,null,2));
      $('#inspector-status').textContent='Complete provider response copied.';
    } catch {$('#inspector-status').textContent='Clipboard access is unavailable. Download response preserves the complete provider body.';}
  };
  $('#inspector-download-response').onclick=()=>{
    const entry=activeEntry();if(!entry?.receivedResponse)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(entry.receivedResponse.body,null,2)],{type:'application/json'}));
    const link=element('a');link.href=url;link.download=`decision-lab-${currentRecord.provider}-run-${currentRecord.round}-step-${entry.step}-provider-response.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#inspector-status').textContent='Complete provider response downloaded.';
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
  const version=responseVersion(entry);
  if(entry!==renderedEntry || version!==renderedVersion) {
    const scroll=dialog.scrollTop;renderSelected();dialog.scrollTop=scroll;
  }
}
