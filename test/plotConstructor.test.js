import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResultTable, validateChannelSource } from '../src/services/results/omResultChannels.js';
import { plotChannels, readPlotChannel, pairPlotChannels, validatePlotCurve, plotChannelLabel, readPlotCurves } from '../src/services/results/plotConstructor.js';
const task={ general:{countTimeSteps:2,timeStep:.5},metadata:{MH:{ranges:{runId:'run-1'}}} };
const manifest={schema:'clark-result-channels/1',model:'inertia',role:'derived',complete:true,
  fieldRunId:'run-1',grid:{steps:2,dt:.5},dataFile:'energy.tsv',channels:[{column:'energy_J',label:'Механическая энергия',unit:'Дж'}]};
const data='step\ttime_s\tenergy_J\n0\t0\t0\n1\t0.5\t7\n2\t1\t3\n';
test('arbitrary derived model channel is selectable in a normal field task',async()=>{
 const source=validateChannelSource(manifest,parseResultTable(data,manifest.channels),task);
 const channels=plotChannels(task,[source]);assert.equal(channels[1].unit,'Дж');
 assert.deepEqual(await readPlotChannel(task,channels[1]),[{step:0,time:0,value:0},{step:1,time:.5,value:7},{step:2,time:1,value:3}]);
});
test('rejects stale run, incompatible grid, incomplete complete flag and nonfinite values',()=>{
 const table=parseResultTable(data,manifest.channels);
 for(const delta of [{fieldRunId:'previous'},{grid:{steps:2,dt:.1}},{channels:[{...manifest.channels[0],column:'../energy'}]}])
  assert.throws(()=>validateChannelSource({...manifest,...delta},table,task));
 assert.throws(()=>validateChannelSource(manifest,{...table,rows:table.rows.slice(1)},task),/не все/);
 assert.throws(()=>parseResultTable(data.replace('\t7','\tNaN'),manifest.channels),/строка/);
 assert.throws(()=>parseResultTable(data.replace('1\t0.5','0\t0.5'),manifest.channels),/возрастать/);
 assert.match(validateChannelSource({...manifest,fieldRunId:null},table,task).warning,/не подтверждена/);
});
test('XY keeps time order of a loop and pairs only shared steps',()=>{
 const x=[{step:0,time:0,value:2},{step:1,time:.5,value:-2},{step:2,time:1,value:2}];
 const y=x.map((p,i)=>({...p,value:i}));
 assert.deepEqual(pairPlotChannels(x,y).map(p=>p.x),[2,-2,2]);
 assert.equal(pairPlotChannels(x,y.slice(1)).length,2);
 assert.throws(()=>pairPlotChannels(x,[{...y[0],time:9}]),/не совпадают/);
 assert.throws(()=>pairPlotChannels(x,[]),/нет общих/);
});
test('field vector units/components reuse the Viewer quantity mapping',async()=>{
 const fieldTask={general:task.general,metadata:{MH:{steps:[{index:0},{index:2}],pointCount:1,header:{stride:9}}},
 reader:{history:async()=>({stride:9,steps:[0,2],values:Float64Array.from([0,0,0,3,4,0,0,0,0,0,0,0,-3,0,4,0,0,0])})}};
 const c=plotChannels(fieldTask).find(c=>c.key==='field:M');
 assert.deepEqual((await readPlotChannel(fieldTask,c)).map(p=>p.value),[5,5]);
 assert.deepEqual((await readPlotChannel(fieldTask,c,{component:'0'})).map(p=>p.value),[3,-3]);
 await assert.rejects(readPlotChannel(fieldTask,c,{point:2}),/Номер точки/);
});

test('adding a curve validates point indices and both axis units',()=>{
 const time={key:'time',kind:'time',unit:'с'}, field={key:'field:M',kind:'field',unit:'кА/м',points:2,components:3,label:'M'};
 const curve={id:'one',x:{},y:{point:1,component:'0'},xChannel:time,yChannel:field};
 assert.equal(validatePlotCurve(curve,curve),curve);
 assert.throws(()=>validatePlotCurve({...curve,y:{point:0}}),/номер точки/);
 assert.throws(()=>validatePlotCurve({...curve,yChannel:{...field,unit:'Тл'}},curve),/Ось Y/);
 assert.throws(()=>validatePlotCurve({...curve,xChannel:{...time,unit:'А'}},curve),/Ось X/);
 assert.match(plotChannelLabel(field,curve.y),/X · точка 1, кА\/м/);
});

test('multiple curves retain loop order and good curves survive an invalid source',async()=>{
 const source=validateChannelSource(manifest,parseResultTable(data,manifest.channels),task);
 const [time,energy]=plotChannels(task,[source]);
 const curves=[{id:'energy',x:{},y:{},xChannel:time,yChannel:energy},
  {id:'loop',x:{},y:{},xChannel:energy,yChannel:time},
  {id:'bad',x:{},y:{},xChannel:time,yChannel:{kind:'unknown'}}];
 const plot=await readPlotCurves(task,curves);
 assert.deepEqual(plot.series.map(s=>s.key),['energy','loop']);
 assert.deepEqual(plot.series[1].points.map(p=>p.x),[0,7,3]);
 assert.match(plot.error,/Кривая 3/);
 assert.match(plot.series[0].tooltip(plot.series[0].points[1]).join(' '),/Механическая энергия/);
});
