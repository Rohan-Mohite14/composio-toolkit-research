#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs, promisify } from "node:util";

if (existsSync(".env")) loadEnvFile(".env");

const exec = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const [command, ...args] = process.argv.slice(2);
const { values } = parseArgs({args, options:{
  apps:{type:"string",default:"data/apps.json"},
  ids:{type:"string",default:"2,10,82,91,98"},
  db:{type:"string",default:"runs/pilot.sqlite"},
  output:{type:"string",default:"pilot"},
  mode:{type:"string",default:"codex"},
  run:{type:"string",default:"pilot-v1"},
  stage:{type:"string"},
  input:{type:"string"},
  trace:{type:"string"},
  queries:{type:"string"},
  attempts:{type:"string"},
  seed:{type:"string"},
  review:{type:"string"},
  grades:{type:"string"},
  workers:{type:"string",default:"2"}
}});
const schemaFile = new URL("./research-schema.json",import.meta.url);
const schema = await readJson(schemaFile);
const singleBrief = schema.properties.briefs.items;
const instructions = await readFile(new URL("./research-instructions.txt",import.meta.url),"utf8");
const fieldNames = Object.keys(singleBrief.properties.claims.properties);
const legacySchema = await readJson(new URL("./research-schema-v1.json",import.meta.url));
const stages = ["first","verified"];
// Plan limits reset on their own, so wait and retry the same stage instead of recording a failure.
const isUsageLimit = message => /usage.limit|out of credits|insufficient_quota|quota exceeded|credit balance/i.test(message);
const limitWaitMs = Number(process.env.LIMIT_WAIT_MS) || 900_000;
const model = process.env.CODEX_MODEL || "gpt-6-luna";
function matchesSchema(value, spec, path = "brief") {
  if (spec.enum && !spec.enum.includes(value)) throw Error(path + " has an unsupported label");
  if (spec.type === "string" && typeof value !== "string") throw Error(path + " must be text");
  if (spec.type === "integer" && !Number.isInteger(value)) throw Error(path + " must be an integer");
  if (spec.type === "array") {
    if (!Array.isArray(value)) throw Error(path + " must be an array");
    value.forEach((item, i) => matchesSchema(item,spec.items,path+"["+i+"]"));
  }
  if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(path + " must be an object");
    for (const key of spec.required ?? []) {
      if (!Object.hasOwn(value,key)) throw Error(path + "." + key + " is required");
      matchesSchema(value[key],spec.properties[key],path+"."+key);
    }
    if (Object.keys(value).some(key => !Object.hasOwn(spec.properties,key))) throw Error(path+" contains an unknown property");
  }
}
function firstParty(rawUrl, domains) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const repo = ((host==="raw.githubusercontent.com" ? "github.com" : host)+url.pathname).toLowerCase().replace(/\/$/,"");
  return domains.some(rule => {
    if (rule.startsWith("prefix:")) {
      const prefix = rule.slice(7).toLowerCase().replace(/\/$/,"");
      return repo===prefix || repo.startsWith(prefix+"/");
    }
    return host===rule || host.endsWith("."+rule);
  });
}
function validate(brief, app, stage, legacy=false) {
  matchesSchema(brief,legacy ? legacySchema.properties.briefs.items : singleBrief);
  const notices = [];
  const citationIssues=[];
  const citationIssue=message=>{citationIssues.push(message);notices.push(message);};
  if (!legacy) {
    const fields = new Set(["product","description",
      ...Object.keys(brief.claims).map(k=>"claims."+k),
      ...Object.keys(brief.integration).map(k=>"integration."+k),
      ...brief.actions.flatMap((action,i)=>Object.keys(action).filter(k=>k!=="source_url").map(k=>"actions."+i+"."+k))
    ]);
    const covered=new Set();
    for (const row of brief.evidence_ledger) {
      const keys=row.field.split(",").map(key=>key.trim());
      if (keys.some(key=>!fields.has(key))) citationIssue("Unknown ledger field "+row.field);
      if (!row.claim.trim() || !row.product_environment.trim()) citationIssue("Incomplete ledger context for "+row.field);
      if (row.status==="unresolved" && !row.checks.trim()) citationIssue("Missing checks for "+row.field);
      if (row.status!=="unresolved" && (!/^https?:\/\//.test(row.url) || !row.section.trim() || !row.support.trim() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(row.retrieved_on))) citationIssue("Incomplete citation for "+row.field);
      keys.forEach(key=>covered.add(key));
    }
    const missing=[...fields].filter(k=>!covered.has(k));
    if (missing.length) citationIssue("Missing ledger coverage: "+missing.join(", "));
    if (stage==="verified" && citationIssues.length) throw Error(citationIssues.join("; "));
  }
  if (brief.id !== app.id) throw Error("Mismatched app ID "+brief.id);
  if (!brief.product.trim() || !brief.description.trim()) throw Error("Missing product identity");
  if (brief.actions.length>3) throw Error("At most three starter actions");
  for (const [field, claim] of Object.entries(brief.claims)) {
    if (new Set(claim.labels).size !== claim.labels.length) throw Error(field+" contains duplicate labels");
    if (!claim.summary.trim()) throw Error(field+" requires a summary, including when unresolved");
    let official=0;
    for (const {url,section,support} of claim.evidence) {
      if (firstParty(url,app.domains) && section.trim() && support.trim()) official++;
      else notices.push(field+" has an unconfirmed source: "+url);
    }
    if (claim.labels.length && !official) {
      if (stage==="verified") throw Error(field+" has labels without first-party evidence");
      notices.push(field+" has labels without first-party evidence");
    }
  }
  for (const action of brief.actions) {
    if (!action.intent.trim() || !action.operation.trim()) throw Error("Starter action requires an intent and operation");
    if (!firstParty(action.source_url,app.domains)) {
      if (stage==="verified") throw Error("Starter action lacks an official source: "+action.intent);
      notices.push("Starter action lacks an official source: "+action.intent);
    }
  }
  return notices;
}

async function openState() {
  const { DatabaseSync }=await import("node:sqlite").catch(error=>{
    if (error.code==="ERR_UNKNOWN_BUILTIN_MODULE") {
      throw Error("Running or exporting the pilot requires Node.js 22.13 or newer. On this Mac, use /usr/local/bin/node or run-pilot.command.");
    }
    throw error;
  });
  await mkdir(resolve(values.db,".."),{recursive:true});
  const db = new DatabaseSync(values.db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000");
  db.exec("CREATE TABLE IF NOT EXISTS briefs (run TEXT, id INTEGER, stage TEXT, app TEXT, brief TEXT, trace TEXT, notices TEXT, saved_at TEXT, PRIMARY KEY(run, id, stage))");
  db.exec("CREATE TABLE IF NOT EXISTS failures (run TEXT, id INTEGER, stage TEXT, message TEXT, failed_at TEXT)");
  return db;
}
function get(db,id,stage) {
  const row=db.prepare("SELECT * FROM briefs WHERE run=? AND id=? AND stage=?").get(values.run,id,stage);
  return row&&{brief:JSON.parse(row.brief),trace:JSON.parse(row.trace)};
}
function save(db,app,stage,brief,trace,notices) {
  db.prepare("INSERT INTO briefs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(values.run,app.id,stage,JSON.stringify(app),
    JSON.stringify(brief),JSON.stringify(trace),JSON.stringify(notices),new Date().toISOString());
}

async function getApps() {
  const manifest = await readJson(values.apps);
  const ids = values.ids==="all" ? null : new Set(values.ids.split(",").map(Number));
  const selected=manifest.filter(a=>!ids||ids.has(a.id));
  if (!selected.length || ids && selected.length!==ids.size) throw Error("Choose valid app IDs or all");
  return selected;
}
function codexPath() {
  const bundled="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  return process.env.CODEX_BIN || (existsSync(bundled) ? bundled : "codex");
}
async function codexExec(dir,args,timeout) {
  const prompt=args.at(-1);
  const env={...process.env,CODEX_SQLITE_HOME:dir};
  delete env.COMPOSIO_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const invocation=exec(codexPath(),["--search","--ask-for-approval","never","-c","model="+JSON.stringify(model),"-c","model_reasoning_effort=\"low\"","-c","log_dir="+JSON.stringify(dir),"exec",
    "--json","--ephemeral","--skip-git-repo-check","--sandbox","read-only",...args.slice(0,-1),"-"],
    {cwd:dir,env,timeout,maxBuffer:24_000_000});
  invocation.child.stdin?.on("error",()=>{});
  invocation.child.stdin?.end(prompt);
  try {
    return (await invocation).stdout;
  } catch(error) {
    const stderr=error.stderr??"";
    if (error.code==="ENOENT") throw Error("Codex CLI executable not found. Install Codex CLI or set CODEX_BIN.");
    if (/failed to initialize in-process app-server client: (?:operation not permitted|permission denied)/i.test(stderr)) {
      throw Error("Codex CLI started, but this runner denied initialization of its in-process app server.");
    }
    if (["EPERM","EACCES"].includes(error.code)) {
      throw Error("Codex CLI was denied permission to start in this runner. Run the check in a regular Terminal session.");
    }
    if (error.code==="ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw Error("Codex diagnostic output exceeded the configured buffer.");
    if (error.killed) throw Error("Codex CLI stopped after the "+Math.round(timeout/1000)+"s timeout.");
    const events=parseEvents(error.stdout ?? "");
    const failure=events.filter(e=>e.type==="turn.failed" || e.type==="error").at(-1);
    const detail=failure?.error?.message || failure?.message ||
      stderr.trim().split("\n").filter(Boolean).at(-1) || "No diagnostic returned";
    let message=String(detail);
    for(const [key,value] of Object.entries(process.env)) {
      if (/(api_key|access_token|auth_token|password|client_secret)$/i.test(key) && value?.length>=6) message=message.replaceAll(value,"[redacted]");
    }
    const safe=message.replace(/(?:ak_|ck_|sk-)[\w-]+/g,"[redacted]").slice(0,650);
    throw Error("Codex CLI exit "+(error.signal || error.code)+": "+safe);

  }
}
function parseEvents(stdout) {
  return stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
async function codex(app,stage,first,discovery,correction) {
  const dir=await mkdtemp(join(tmpdir(),"toolkit-research-"));
  try {
    const output=join(dir,"brief.json");
    const schemaPath=join(dir,"schema.json");
    await writeFile(schemaPath,JSON.stringify(singleBrief));
    const ledgerFields=["product","description",...fieldNames.map(k=>"claims."+k),
      ...Object.keys(singleBrief.properties.integration.properties).map(k=>"integration."+k)];
    const actionKeys=Object.keys(singleBrief.properties.actions.items.properties).filter(k=>k!=="source_url");
    const ledgerRule="evidence_ledger.field must contain only these exact names, comma-separated; together the rows must cover every one: "+
      ledgerFields.join(", ")+". Also cover actions.N.KEY for every returned action index N and each KEY of: "+actionKeys.join(", ")+
      ". No other names: product and description take no prefix, and claims.product does not exist. If correction is present, fix every listed problem and keep the rest of previousDraft.";
    const context={app,discovery,firstPass:first ?? null,correction};
    const phase=stage==="first"
      ? "Use web search to read first-party vendor sources and write a first-pass brief."
      : "Audit the first pass independently. Search specifically for access, auth scope, product identity and MCP contradictions. Open the original sources, and confirm or amend each claim. Explain remaining gaps. Check operation names and scopes in the API reference.";
    const prompt=instructions+"\nComposio catalog matches are research leads only. An empty result does not establish absence of an API or MCP server.\n"+phase+"\n"+ledgerRule+"\n"+JSON.stringify(context);
    const stdout=await codexExec(dir,["--output-schema",schemaPath,"--output-last-message",output,prompt],900_000);
    const events=parseEvents(stdout);
    const searches=events.filter(e=>e.type==="item.completed"&&e.item?.type==="web_search").map(e=>e.item);
    return {brief:await readJson(output),trace:{provider:"Codex CLI",model,effort:"low",usage:events.filter(e=>e.type==="turn.completed").map(e=>e.usage),searches,discovery}};
  } finally {await rm(dir,{recursive:true,force:true});}
}

function composioError(error,step) {
  for (let cause=error;cause;cause=cause.cause) {
    if (cause.status===401) return Error("Composio rejected the configured project key (401) during "+step+".");
    if (cause.status===403) return Error("Composio denied "+step+" (403). Check the project's session permissions.");
    if (["ENOTFOUND","EAI_AGAIN"].includes(cause.code)) {
      return Error("DNS resolution failed during Composio "+step+". Use a runner with network access and working DNS.");
    }
    if (["EPERM","EACCES","ENETUNREACH"].includes(cause.code)) {
      return Error("Network access was blocked during Composio "+step+".");
    }
  }
  return Error("Composio "+step+" failed. "+error.message.split("\n")[0]);
}
async function connectComposio() {
  if (!process.env.COMPOSIO_API_KEY) throw Error("Set COMPOSIO_API_KEY in .env for Composio mode");
  const {Composio}=await import("@composio/core");
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    const {EnvHttpProxyAgent,setGlobalDispatcher}=await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
  const sdk=new Composio({apiKey:process.env.COMPOSIO_API_KEY});
  return {
    name:"Composio tool catalog",
    async search(query) {
      const tools=await sdk.tools.getRawComposioTools({search:query,limit:8},undefined,{timeout:20000})
        .catch(error=>{throw composioError(error,"tool catalog lookup");});
      const matches=tools.map(({slug,name,toolkit})=>({slug,name,toolkit:toolkit?.slug}));
      return {source:"Composio tool catalog",query,result:matches};
    }
  };
}
async function check() {
  const checks={
    "Composio tool catalog":async()=>{
      const provider=await connectComposio();
      await provider.search("HubSpot");
    },
    "Codex CLI":async()=>{
      const {stdout,stderr}=await exec(codexPath(),["login","status"],{timeout:10000})
        .catch(()=>{throw Error("Could not confirm CLI login. Check that Codex is installed and signed in.");});
      if (!/logged in using chatgpt/i.test(stdout+"\n"+stderr)) throw Error("The CLI must be signed in with ChatGPT for this check.");
      const dir=await mkdtemp(join(tmpdir(),"toolkit-research-check-"));
      try {
        const output=join(dir,"response.txt");
        const probeSchema=join(dir,"probe.json");
        await writeFile(probeSchema,JSON.stringify({type:"object",additionalProperties:false,required:["ready"],properties:{ready:{type:"boolean"}}}));
        await codexExec(dir,["--output-schema",probeSchema,"--output-last-message",output,"Return ready=true. Do not use tools."],45000);
        if ((await readJson(output)).ready!==true) throw Error("The CLI response did not match the preflight prompt.");
      } finally {await rm(dir,{recursive:true,force:true});}
    }
  };
  await Promise.all(Object.entries(checks).map(async ([name,probe])=>{
    try {await probe();console.log(name+" passed.");}
    catch(error) {console.error(name+" failed. "+error.message);process.exitCode=1;}
  }));
}
async function discover(apps) {
  const custom=values.queries?await readJson(values.queries):null;
  if (custom && apps.some(app=>typeof custom[app.id]!=="string"||!custom[app.id].trim())) {
    throw Error("Provide a nonempty search query for each selected app");
  }
  const provider=await connectComposio();
  const results=await Promise.all(apps.map(async app=>{
    const evidence=await provider.search(custom?.[app.id]??app.name);
    return {id:app.id,query:evidence.query,results:evidence.result};
  }));
  await mkdir(values.output,{recursive:true});
  await writeFile(join(values.output,"composio-discovery.json"),JSON.stringify({
    provider:provider.name,retrieved_at:new Date().toISOString(),results
  },null,2)+"\n");
  console.log("Composio discovery completed for "+results.length+" apps");

}
async function run(db,apps) {
  if (!["codex","composio"].includes(values.mode)) throw Error("Mode must be codex or composio");
  await exec(codexPath(),["login","status"],{timeout:10_000});
  const workers=Number(values.workers);
  if (!Number.isInteger(workers)||workers<1||workers>4) throw Error("Choose one to four workers");
  const search=values.mode==="composio" ? await connectComposio() : null;
  let next=0;
  await Promise.all(Array.from({length:workers},async()=>{
    while(next<apps.length) {
      const app=apps[next++];
      let currentStage="first";
      try {
        let first;
        for(const stage of stages) {
          currentStage=stage;
          const cached=get(db,app.id,stage);
          if (cached) { if(stage==="first") first=cached.brief; continue; }
          const discovery=search ? [await search.search(app.name)] : [];
          let result, notices, correction;
          for(let attempt=1; ; attempt++) {
            try {
              result=await codex(app,stage,first,discovery,correction);
              try {notices=validate(result.brief,app,stage);}
              catch(error) {
                if(attempt>=3) throw error;
                correction={validation:error.message,previousDraft:result.brief};
                console.error("Rechecking "+app.id+" "+stage+" after validation: "+error.message);
                continue;
              }
              break;
            }
            catch(error) {
              if(isUsageLimit(error.message)) {
                console.error("Usage limit at "+app.id+" "+stage+". Finished stages are saved. Retrying in 15 minutes. "+error.message);
                await new Promise(resolve=>setTimeout(resolve,limitWaitMs));
                attempt--;
                continue;
              }
              if(attempt>=3 || !/429|502|503|504|connection reset|temporarily unavailable|stream disconnected/i.test(error.message)) throw error;
              console.error("Retrying "+app.id+" "+stage+" after transient failure ("+attempt+"/3)");
              await new Promise(resolve=>setTimeout(resolve,5000*attempt));
            }
          }
          const {brief,trace}=result;

          save(db,app,stage,brief,trace,notices);
          if (stage==="first") first=brief;
          console.error("Saved "+app.id+" "+stage);
        }
      } catch(error) {
        db.prepare("INSERT INTO failures VALUES (?, ?, ?, ?, ?)").run(values.run,app.id,currentStage,error.message,new Date().toISOString());
        console.error("App "+app.id+" "+currentStage+" failed. "+error.message);
        process.exitCode=1;
      }
    }
  }));

}
async function ingest(db,apps) {
  if (!stages.includes(values.stage)||!values.input||!values.trace) throw Error("Ingest needs --stage, --input and --trace");
  const payload=await readJson(values.input);
  const trace=await readJson(values.trace);
  const legacy=payload.briefs?.length && payload.briefs.every(b=>!Object.hasOwn(b,"evidence_ledger") && !Object.hasOwn(b.integration??{},"vendor"));
  matchesSchema(payload,legacy ? legacySchema : schema,"response");
  const rows=payload.briefs;
  if (rows.length!==apps.length||new Set(rows.map(r=>r.id)).size!==apps.length) throw Error("Provider must return exactly one brief per requested app");
  const validated=rows.map(brief=>{
    const app=apps.find(a=>a.id===brief.id);
    if (!app) throw Error("Unexpected app in provider output");
    if (values.stage==="verified"&&!get(db,app.id,"first")) throw Error("Freeze first pass before verification");
    return {app,brief,notices:validate(brief,app,values.stage,legacy)};
  });
  db.exec("BEGIN");
  try {
    for (const {app,brief,notices} of validated) save(db,app,values.stage,brief,trace,notices);
    db.exec("COMMIT");
  } catch(error) {db.exec("ROLLBACK");throw error;}
  console.log("Saved "+rows.length+" "+values.stage+" briefs");
}
async function refine(db,apps) {
  if (!values.input||!values.seed||!values.review||!values.trace) {
    throw Error("Refine needs --input, --seed, --review and --trace");
  }
  const [work,seed,review,trace]=await Promise.all([
    readJson(values.input),readJson(values.seed),readJson(values.review),readJson(values.trace)
  ]);
  const legacy=!seed.briefs?.[0]?.evidence_ledger;
  matchesSchema(seed,legacy ? legacySchema : schema,"verification seed");
  const index=new Map(seed.briefs.map(b=>[b.id,b]));
  const decisionKey=a=>[a.round,a.id,a.field].join(":");
  const decisions=new Map(review.results.map(row=>[decisionKey(row),row]));
  if (decisions.size!==review.results.length || decisions.size!==work.attempts.length ||
      new Set(work.attempts.map(decisionKey)).size!==work.attempts.length) {
    throw Error("Each attempt needs one unique review decision");
  }
  for(const attempt of work.attempts) {
    const decision=decisions.get(decisionKey(attempt));
    const brief=index.get(attempt.id);
    if (!decision || !brief) throw Error("Attempt has no matching review or app");
    if (decision.decision!=="Accepted") continue;
    const app=apps.find(a=>a.id===attempt.id);
    if (!app || !attempt.structurally_eligible) throw Error("Attempt failed initial validation");
    const evidence=attempt.evidence.filter(e=>firstParty(e.url,app.domains)&&e.section.trim()&&e.support.trim());
    if (attempt.field.startsWith("action:")) {
      const index=Number(attempt.field.split(":")[1]);
      if (!Number.isInteger(index)||index<0||index>=brief.actions.length||attempt.action_index!==index) {
        throw Error("Attempt names an invalid action position");
      }
      brief.actions[index]=attempt.action;
    } else {
      if (!fieldNames.includes(attempt.field)) throw Error("Attempt names an invalid claim");
      brief.claims[attempt.field]={labels:[...new Set(attempt.labels)],summary:attempt.summary,evidence};
    }
    if (attempt.detail_key && attempt.detail_value && evidence.length &&
      Object.hasOwn(brief.integration,attempt.detail_key)) brief.integration[attempt.detail_key]=attempt.detail_value;
  }
  const validated=apps.map(app=>{
    if (!get(db,app.id,"first")) throw Error("Freeze first pass before selecting a verification result");
    const brief=index.get(app.id);
    return {app,brief,notices:validate(brief,app,"verified",legacy)};
  });
  db.exec("BEGIN");
  try {
    for(const {app,brief,notices} of validated) save(db,app,"verified",brief,{
      ...trace,attempts_considered:work.attempts.filter(a=>a.id===app.id).map(a=>({
        round:a.round,field:a.field,job_id:a.provider_job_id,decision:decisions.get(decisionKey(a)).decision
      }))
    },notices);
    db.exec("COMMIT");
  } catch(error) {db.exec("ROLLBACK");throw error;}
  console.log("Froze "+validated.length+" final briefs after "+work.attempts.length+" adjudicated attempts");
}

const toMd=value=>String(value??"").replaceAll("|","\\|").replaceAll("\n"," ");
const table=(headers,rows)=>[headers,headers.map(()=> "---"),...rows].map(row=>"| "+row.map(toMd).join(" | ")+" |").join("\n");
const sourceLinks=evidence=>[...new Set(evidence.map(e=>e.url))].map((url,i)=>"["+(i+1)+"]("+url+")").join(" ");
const csv=rows=>rows.map(row=>row.map(value=>'"'+String(value??"").replaceAll('"','""')+'"').join(",")).join("\n")+"\n";
function labelCounts(records,field) {
  const counts=new Map();
  for (const {id,brief} of records) {
    const labels=brief.claims[field].labels;
    for (const label of labels.length?labels:["unresolved"]) {
      if (!counts.has(label)) counts.set(label,[]);
      counts.get(label).push(id);
    }
  }
  return [...counts].sort(([a, x],[b, y])=>y.length-x.length||a.localeCompare(b));
}
async function render(db) {
  const rows=db.prepare("SELECT * FROM briefs WHERE run=? ORDER BY id, stage").all(values.run).map(row=>({
    id:row.id,stage:row.stage,app:JSON.parse(row.app),brief:JSON.parse(row.brief),trace:JSON.parse(row.trace),notices:JSON.parse(row.notices),saved_at:row.saved_at
  }));
  const failures=db.prepare("SELECT id,stage,message,failed_at FROM failures WHERE run=? ORDER BY failed_at").all(values.run);
  if (!rows.length && !failures.length) throw Error("No recorded research");
  await mkdir(values.output,{recursive:true});
  const verified=rows.filter(r=>r.stage==="verified");
  const lines=["# Research pilot", "", "Source-backed app briefs for toolkit implementation.", "",
    "## Run coverage", "",
    table(["Pass","Apps","Provider"],stages.map(stage=>[stage,rows.filter(r=>r.stage===stage).length,[...new Set(rows.filter(r=>r.stage===stage).map(r=>r.trace.provider))].join(", ")])), ""];
  if (failures.length) lines.push("## Failure history","",table(["App ID","Stage","Diagnostic","Time"],failures.map(f=>[f.id,f.stage,f.message,f.failed_at])),"");
  const joined=new Map(rows.filter(r=>r.stage==="first").map(r=>[r.id,r.brief]));
  if(values.grades) {
    const grades=await readJson(values.grades);
    const audited=grades.checks.map(c=>c.id+":"+c.field);
    const allowed=["correct","incorrect","unresolved"];
    if (new Set(audited).size!==audited.length ||
        grades.checks.some(c=>!fieldNames.includes(c.field) || !verified.some(r=>r.id===c.id) ||
          stages.some(stage=>!allowed.includes(c[stage])))) throw Error("Audit file contains an invalid or duplicate check");
    const numbers=stage=>Object.fromEntries(["correct","incorrect","unresolved"].map(key=>[key,grades.checks.filter(c=>c[stage]===key).length]));
    lines.push("## Pilot calibration", "",grades.description, "",
      table(["Pass","Correct","Incorrect","Unresolved"],stages.map(stage=>{const n=numbers(stage);return [stage,n.correct,n.incorrect,n.unresolved]})), "");
    const safeGrades = grades.checks.map(c=>[
      c.id,c.field,c.first,c.verified,c.note,c.source ? "[Reference]("+c.source+")" : ""
    ]);
    lines.push(table(["App","Field","First pass","Verified","Adjudication","Evidence"],safeGrades), "");
  }
  if(values.attempts) {
    const attempts=await readJson(values.attempts);
    lines.push("## Verification attempts","",attempts.description,"",
      table(["Round","App","Field","Decision","Why","Evidence"],attempts.results.map(a=>[
        a.round,a.id,a.field,a.decision,a.reason,a.source?"[Source]("+a.source+")":""
      ])),"");
  }
  const patterns=Object.fromEntries(["auth","production_access","buildability"].map(field=>[field,labelCounts(verified,field)]));
  lines.push("## Patterns in this run","",
    "An app can contribute to several auth or production labels. Counts use the "+verified.length+" verified app briefs as the denominator.","",
    table(["Field","Label","Apps","App IDs"],Object.entries(patterns).flatMap(([field,counts])=>
      counts.map(([label,ids])=>[field,label,ids.length,ids.join(", ")]))),"");
  const categories=[...new Set(verified.map(r=>r.app.category))];
  lines.push(table(["Category","Apps","Production paths and gates"],categories.map(category=>{
    const members=verified.filter(r=>r.app.category===category);
    return [category,members.length,labelCounts(members,"production_access").map(([label,ids])=>label+" ("+ids.length+")").join(", ")];
  })),"");
  lines.push("## App decisions","",table(["App","Category","Test","Live","Build route","Main blocker"],verified.map(({app,brief:b})=>[
    app.name,app.category,b.claims.test_access.labels.join(", "),b.claims.production_access.labels.join(", "),b.claims.buildability.summary,b.integration.blocker
  ])),"");
  for(const {app,brief:b,notices} of verified) {
    lines.push("## "+b.id+" "+b.product,"",b.description,"",
      table(["Field","First pass","Verified","Evidence"],fieldNames.map(field=>[
        field,joined.get(b.id)?.claims[field].summary,b.claims[field].summary,sourceLinks(b.claims[field].evidence)
      ])),"",
      "### Implementation prerequisites","",
      ...Object.entries(b.integration).filter(([,v])=>v&&v!=="Unknown").map(([k,v])=>"- **"+k.replaceAll("_"," ")+"** · "+v),"",
      "### Starter actions","",
      table(["Action","Operation","Inputs","Outputs","Permissions","Pagination","Side effect","Source"],b.actions.map(a=>[
        a.intent,a.operation,a.required_inputs,a.outputs,a.scopes,a.pagination,a.side_effect,"[Docs]("+a.source_url+")"
      ])),"");
    if (b.actions.some(a=>a.documented_example)) lines.push(...b.actions.map(a=>"- **"+a.intent+" example** · "+a.documented_example),"");
    if (b.evidence_ledger) {
      lines.push("### Claim evidence","",table(["Field","Claim","Status","Product and environment","Retrieved","Source and section","Support or checks"],b.evidence_ledger.map(e=>[
        e.field,e.claim,e.status,e.product_environment,e.retrieved_on,e.url ? "["+e.section+"]("+e.url+")" : e.section,[e.support,e.checks].filter(Boolean).join(" ")
      ])),"");
    }
    if(notices.length) lines.push("Source review notes", "", ...notices.map(n=>"- "+n),"");
  }
  const comparison=[["app_id","app","field","first_labels","first_summary","first_evidence","verified_labels","verified_summary","verified_evidence"]];
  for(const {app,brief} of verified) {
    for(const field of fieldNames) {
      const before=joined.get(app.id)?.claims[field], after=brief.claims[field];
      comparison.push([app.id,app.name,field,before?.labels.join(", "),before?.summary,before?.evidence.map(s=>s.url).join(" "),
        after.labels.join(", "),after.summary,after.evidence.map(s=>s.url).join(" ")]);
    }
  }
  await Promise.all([
    writeFile(join(values.output,"pilot-report.md"),lines.join("\n")+"\n"),
    writeFile(join(values.output,"research.json"),JSON.stringify({schema_version:rows.every(r=>r.brief.evidence_ledger)?2:rows.some(r=>r.brief.evidence_ledger)?"mixed":1,run:values.run,patterns,failures,records:rows},null,2)+"\n"),
    writeFile(join(values.output,"comparison.csv"),csv(comparison))
  ]);
  console.log("Exported "+verified.length+" verified briefs and "+(comparison.length-1)+" comparisons");
}

try {
  if(command==="check") {
    await check();
  } else if(command==="discover") {
    await discover(await getApps());
  } else if(!["run","ingest","refine","report"].includes(command)) {
    console.log("Usage: node research.mjs check\n       node research.mjs run [--mode codex|composio] [--ids 2,10,82,91,98|all]\n       node research.mjs discover --ids 2\n       node research.mjs ingest --stage first|verified --input response.json --trace trace.json\n       node research.mjs report [--grades audit.json]");
  } else {
    const db=await openState();
    try {
      if(command==="report") await render(db);
      else {
        const apps=await getApps();
        if(command==="run") await run(db,apps);
        else if(command==="refine") await refine(db,apps);
        else await ingest(db,apps);
      }
    } finally { db.close(); }
  }
} catch(error) {
  const message=error.message.split("\n")[0];
  console.error(/invalid api key/i.test(message)?"Composio rejected the configured project key (401).":message);
  process.exitCode=1;
}
