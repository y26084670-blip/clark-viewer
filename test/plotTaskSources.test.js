import test from 'node:test';
import assert from 'node:assert/strict';
import { listPlotTasks, openPlotTask, createPlotTaskStore } from '../src/services/results/plotTaskSources.js';

const directory = (name, children = {}) => ({kind:'directory', name, async *entries(){yield* Object.entries(children);}});
const deferred = () => {let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject};};
function resultTask(entry) {const task={plotEntry:entry,closed:0};task.reader={close(){task.closed++;}};return task;}

test('flat list includes every project, preserves duplicate task names and natural ordering',async()=>{
 const root=directory('Root',{'Проект 10':directory('Проект 10',{'A':directory('A')}),
  'Проект 2':directory('Проект 2',{'A':directory('A'),'Задача 10':directory('Задача 10'),'Задача 2':directory('Задача 2'),'ignore':{kind:'file'}})});
 const rows=await listPlotTasks(root);
 assert.deepEqual(rows.map(r=>r.label),['Проект 2/Задача 2','Проект 2/Задача 10','Проект 2/A','Проект 10/A']);
 assert.ok(rows.every(r=>r.root===root));assert.equal(new Set(rows.map(r=>r.key)).size,4);
 assert.deepEqual(await listPlotTasks(null),[]);
 await assert.rejects(listPlotTasks({async *entries(){throw Error('access denied');}}),/access denied/);
});

test('selection retains sources used by curves and frees workers once no longer referenced',async()=>{
 const root={}, a={root,key:'A'}, b={root,key:'B'}, states=[], opened=[];
 const store=createPlotTaskStore({onChange:s=>states.push(s),open:async e=>{const task=resultTask(e);opened.push(task);return task;}});
 const taskA=await store.select(a);store.retain([taskA]);
 const taskB=await store.select(b);assert.equal(taskA.closed,0);
 await store.select(null);assert.equal(taskB.closed,1);assert.equal(taskA.closed,0);
 assert.equal(await store.select({...a}),taskA);assert.equal(opened.length,2);
 await store.select(null);store.retain([]);assert.equal(taskA.closed,1);
 store.clear();assert.equal(taskA.closed,1);assert.equal(states.at(-1).task,null);
});

test('late loads/errors cannot replace a newer selection or survive session cleanup',async()=>{
 const a=deferred(), b=deferred(), states=[], entries=[{key:'A'},{key:'B'}];
 const store=createPlotTaskStore({onChange:s=>states.push(s),open:e=>e===entries[0]?a.promise:b.promise});
 const pa=store.select(entries[0]), pb=store.select(entries[1]);
 const taskB=resultTask(entries[1]);b.resolve(taskB);await pb;
 const taskA=resultTask(entries[0]);a.resolve(taskA);await pa;
 assert.equal(states.at(-1).task,taskB);assert.equal(taskA.closed,1);
 store.clear();assert.equal(taskB.closed,1);
 const pending=deferred(), late=resultTask({key:'late'});
 const clean=createPlotTaskStore({open:()=>pending.promise});const p=clean.select(late.plotEntry);clean.clear();pending.resolve(late);await p;
 assert.equal(late.closed,1);
 const failed=createPlotTaskStore({onChange:s=>states.push(s),open:async()=>{throw Error('broken task');}});
 await failed.select({key:'bad'});assert.equal(states.at(-1).loading,false);assert.match(states.at(-1).error,/broken task/);
});

test('comparison loader opens standard results, reads own OM channels and closes after failure',async()=>{
 const entry={handle:{name:'B'},key:'project/B'}, source={manifest:{channels:[]}}, metadata={FM:{steps:[{index:0}]}};
 let closed=0, received;
 const reader={open:async()=>metadata,close(){closed++;}};
 const load=async()=>({handle:entry.handle,files:{FM:{}},general:{countTimeSteps:0,timeStep:0}});
 const task=await openPlotTask(entry,{load,createReader:()=>reader,loadOM:async t=>{received=t;return source;}});
 assert.equal(task,received);assert.equal(task.metadata,metadata);assert.deepEqual(task.plotSources,[source]);assert.equal(closed,0);
 const partial=await openPlotTask(entry,{load,createReader:()=>reader,loadOM:async()=>{throw Error('stale OM');}});
 assert.equal(partial.metadata,metadata);assert.match(partial.plotSourceError,/stale OM/);
 await assert.rejects(openPlotTask(entry,{load,createReader:()=>({...reader,open:async()=>{throw Error('bad HDF5');}})}),/bad HDF5/);
 assert.equal(closed,1);
});
