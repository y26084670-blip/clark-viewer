import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResultTable, validateChannelSource } from '../src/services/results/omResultChannels.js';
import { plotChannels, readPlotChannel, pairPlotChannels, pairPlotChannelsByTime, plotPointAtStep, validatePlotCurve, plotChannelLabel, readPlotCurves } from '../src/services/results/plotConstructor.js';
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

function comparisonTask(dt, values) {
 return {general:{countTimeSteps:values.length-1,timeStep:dt},metadata:{FM:{steps:values.map((_,index)=>({index})),pointCount:1,header:{stride:6}}},
  reader:{history:async()=>({steps:values.map((_,i)=>i),stride:6,values:Float64Array.from(values.flatMap(v=>[v,0,0,0,0,0]))})}};
}

test('cross-task time curves use their own complete grid and readers, even with identical channel objects',async()=>{
 const a=comparisonTask(.5,[1,2,3]), b=comparisonTask(.25,[10,20,30,40,50,60]);
 const time=plotChannels(a)[0], force=plotChannels(a).find(c=>c.key==='force');
 const base={xChannel:time,yChannel:force,x:{},y:{component:'0'}};
 const result=await readPlotCurves(a,[{...base,id:'a',taskLabel:'Проект/A'},{...base,id:'b',yTask:b,taskLabel:'Проект/B'}]);
 assert.equal(result.error,'');
 assert.deepEqual(result.series[0].points.map(p=>p.y),[1,2,3]);
 assert.deepEqual(result.series[1].points.map(p=>[p.x,p.y]),[[0,10],[.25,20],[.5,30],[.75,40],[1,50],[1.25,60]]);
 assert.match(result.series[1].label,/Проект\/B/);
 assert.match(result.series[1].tooltip(result.series[1].points[2]).join(' '),/шаг задания Y 2/);
 assert.deepEqual(result.series[1].points.filter(p=>plotPointAtStep(p,a,1)).map(p=>p.y),[30]);
});

test('cross-task XY pairs physical time rather than step number and preserves loops',()=>{
 const x=[2,-2,2].map((value,step)=>({value,step,time:step*.5}));
 const y=[10,20,30,40,50].map((value,step)=>({value,step,time:step*.25}));
 assert.deepEqual(pairPlotChannelsByTime(x,y).map(p=>[p.x,p.y,p.sourceStep]),[[2,10,0],[-2,30,2],[2,50,4]]);
 assert.throws(()=>pairPlotChannelsByTime(x,[{value:1,step:0,time:.123}]),/нет общих/);
 assert.equal(pairPlotChannelsByTime([{step:1,time:.1+.2,value:1}],[{step:3,time:.3,value:2}]).length,1);
});

test('cross-task XY reads X from the current task; failed comparison leaves original curve visible',async()=>{
 const a=comparisonTask(.5,[3,-3,3]), b=comparisonTask(.25,[1,2,3,4,5]);
 const force=plotChannels(a).find(c=>c.key==='force');
 const base={xChannel:force,yChannel:force,x:{component:'0'},y:{component:'0'}};
 const result=await readPlotCurves(a,[{...base,id:'a'},{...base,id:'b',yTask:b},
  {...base,id:'broken',yTask:{...b,reader:{history:async()=>{throw Error('Не удалось прочитать B')}}}}]);
 assert.deepEqual(result.series[1].points.map(p=>[p.x,p.y]),[[3,1],[-3,3],[3,5]]);
 assert.deepEqual(result.series.map(s=>s.key),['a','b']);
 assert.match(result.error,/Кривая 3.*прочитать B/);
});

test('automatic vectors expand into three signed components, pairing vector axes by name', async () => {
 const { expandPlotComponents } = await import('../src/services/results/plotConstructor.js');
 const t=comparisonTask(.5,[3,-4,0]);
 const time=plotChannels(t)[0], force=plotChannels(t).find(c=>c.key==='force');
 const base={id:'vector',x:{},y:{},xChannel:time,yChannel:force};
 const curves=expandPlotComponents(base);
 assert.deepEqual(curves.map(c=>c.y.component),['0','1','2']);
 assert.equal(new Set(curves.map(c=>c.id)).size,3);
 const result=await readPlotCurves(t,curves);
 assert.deepEqual(result.series.map(c=>c.points.map(p=>p.y)),[[3,-4,0],[0,0,0],[0,0,0]]);
 assert.ok(result.series.every(c=>!c.label.includes('модуль')));
 assert.deepEqual(expandPlotComponents({...base,xChannel:force}).map(c=>[c.x.component,c.y.component]),[['0','0'],['1','1'],['2','2']]);
 assert.equal(expandPlotComponents({...base,yChannel:{...force,productOffsets:[0,3]}}).length,1);
});

test('zero intervals use a value row and exact legend comments; sparse histories remain plots', async () => {
 const { expandPlotComponents, isSingleTimePlot, singleTimePlotRow } = await import('../src/services/results/plotConstructor.js');
 const t=comparisonTask(.5,[7]), other=comparisonTask(.5,[1,2]);
 const channels=plotChannels(t), base={id:'values',taskLabel:'Проект/Тест',x:{},y:{},xChannel:channels[0],yChannel:channels.find(c=>c.key==='force')};
 const curves=expandPlotComponents(base), result=await readPlotCurves(t,curves);
 assert.equal(isSingleTimePlot(t,curves),true);
 const row=singleTimePlotRow(result.series);
 assert.deepEqual(row.values,[7,0,0]); assert.equal(row.time,0);
 assert.equal(row.comment,result.series.map(c=>c.label).join('; '));
 assert.equal(isSingleTimePlot(other,curves),false);
 assert.equal(isSingleTimePlot(other,curves.map(c=>({...c,yTask:t}))),true);
 assert.equal(isSingleTimePlot(t,[{...base,xChannel:base.yChannel}]),false);
 assert.equal(singleTimePlotRow([]),null);
 assert.equal(singleTimePlotRow([{points:[{time:0,y:1},{time:1,y:2}]}]),null);
});
