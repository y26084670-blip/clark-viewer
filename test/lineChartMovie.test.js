import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import RealChart from "chart.js/auto";
import { batch, createEffect, createSignal, createRoot, on, onCleanup, onMount, untrack } from "solid-js/dist/solid.js";
import { chartPanLimits, chartZoomLimits, clampChartPoint } from "../src/services/visualization/chartZoom.js";

const source = await readFile(new URL("../src/components/LineChart.jsx", import.meta.url), "utf8");
const start = source.indexOf("export function LineChart(props) {") + "export function LineChart(props) {".length;
const end = source.indexOf('  return <div class="line-chart"', start);
// Execute the real Solid effects, capture adapter and pointer handlers. Only
// Chart.js drawing/canvas copying are boundary doubles; no browser is used.
const component = new Function("props", "dependencies", `
  const {batch,createEffect,createSignal,on,onCleanup,onMount,untrack,Chart,window,
    chartPanLimits,chartZoomLimits,clampChartPoint,captureMovieCanvas,testCanvas}=dependencies;
  const colors=["#1776bd","#d94943"],drawOverlayLegend=()=>[];
  ${source.slice(start,end)}
  canvas=testCanvas;
  return {chart:()=>chart,captureAdapter,toggleAutoScale,autoScale,limits,selection,
    capturing,setShowLegend,showLegend,startSelection,updateSelection,finishSelection,
    handleContextMenu,cancelOnEscape,renderError};
`);
const area = {left:40,right:360,top:20,bottom:180};
const series = (maximum=10) => [
  {label:"one",points:[{x:0,y:0,step:0},{x:maximum,y:maximum*2,step:1}]},
  {label:"two",points:[{x:0,y:-1,step:0},{x:maximum,y:maximum,step:1}]},
];
function runtime({initial=series(), failInit=false, autoScaleToggle=true, ChartImplementation=null}={}) {
  let dispose,api,registered;
  const copies=[], calls=[],captures=new Set(),canvas={width:800,height:400,style:{width:"100%",height:"100%"},
    getBoundingClientRect:()=>({left:0,top:0,width:400,height:200}),
    hasPointerCapture:id=>captures.has(id),setPointerCapture:id=>captures.add(id),releasePointerCapture:id=>captures.delete(id),
  };
  const context=new Proxy({canvas,measureText:text=>({width:String(text).length*6}),getLineDash:()=>[]},
    {get:(target,key)=>key in target?target[key]:(...args)=>calls.push({name:key,args})});
  canvas.getContext=()=>context;
  class FakeChart {
    constructor(canvas,config) {
      if(failInit) throw new Error("synthetic Chart init failure");
      this.canvas=canvas;this.data=config.data;this.options=config.options;this.plugins=config.plugins;
      this.width=400;this.height=200;this.currentDevicePixelRatio=2;this.chartArea=area;this.scales={};this.visibility=new Map();
      this.tooltip={setActiveElements:items=>{this.tooltipActive=items;}};this.tooltipActive=["hover"];
      this.ctx=Object.fromEntries(["save","restore","beginPath","rect","clip","setLineDash","moveTo","lineTo","stroke","arc","fill"].map(name=>[name,(...args)=>calls.push({name,args})]));
      this.update();
    }
    update(mode) {
      if(this.failUpdate) throw new Error("synthetic Chart update failure");
      this.lastMode=mode;
      for(const axis of ["x","y"]) {
        const values=this.data.datasets.flatMap((dataset,index)=>this.isDatasetVisible(index)?dataset.data.map(p=>p[axis]).filter(Number.isFinite):[]);
        const options=this.options.scales[axis],min=options.min??(values.length?Math.min(...values):0),max=options.max??(values.length?Math.max(...values):1);
        this.scales[axis]={min,max,getPixelForValue:value=>axis==="x"?area.left+(value-min)/(max-min)*(area.right-area.left):area.bottom-(value-min)/(max-min)*(area.bottom-area.top),
          getValueForPixel:pixel=>axis==="x"?min+(pixel-area.left)/(area.right-area.left)*(max-min):max-(pixel-area.top)/(area.bottom-area.top)*(max-min)};
      }
      this.draw();
    }
    draw(){for(const plugin of this.plugins)plugin.afterDatasetsDraw?.(this);}
    isDatasetVisible(index){return this.visibility.get(this.data.datasets[index])!==false;}
    setDatasetVisibility(index,visible){this.visibility.set(this.data.datasets[index],visible);}
    setActiveElements(items){this.active=items;}
    resize(){this.resizes=(this.resizes??0)+1;}
    destroy(){this.destroyed=true;}
  }
  createRoot(cleanup=>{
    dispose=cleanup;
    const [data,setSeries]=createSignal(initial),[frame,setFrame]=createSignal({step:0}),[cursor,setCursor]=createSignal(null),[error,setError]=createSignal("");
    const props={autoScaleToggle,get series(){return data();},get captureFrameKey(){return frame();},get movieCursor(){return cursor();},get captureError(){return error();},xLabel:"time",yLabel:"field",onCaptureReady:value=>{registered=value;}};
    api=component(props,{batch,createEffect,createSignal,on,onCleanup,onMount,untrack,Chart:ChartImplementation??FakeChart,
      window:{addEventListener(){},removeEventListener(){}},chartPanLimits,chartZoomLimits,clampChartPoint,testCanvas:canvas,
      captureMovieCanvas:(canvas,options)=>{const output={width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4)};copies.push({canvas,options,output});return output;}});
    Object.assign(api,{setSeries,setFrame,setCursor,setError,frame,
      publish(nextSeries,key,cursor=null){batch(()=>{setSeries(nextSeries);setFrame(key);setCursor(cursor);});}});
  });
  return {...api,dispose,canvas,copies,calls,captures,get registered(){return registered;}};
}
const bounds=chart=>({xMin:chart.scales.x.min,xMax:chart.scales.x.max,yMin:chart.scales.y.min,yMax:chart.scales.y.max});
const pointer=(x,y,button=0)=>({clientX:x,clientY:y,button,buttons:button===2?2:1,pointerId:1,isPrimary:true,preventDefault(){}});

test("capture follows Auto while preserving visibility and restores the original chart settings", async()=>{
  const h=runtime(),chart=h.chart();chart.setDatasetVisibility(1,false);h.setShowLegend(true);
  const initial=bounds(chart),first=h.frame();await h.captureAdapter.renderReady(first);
  h.captureAdapter.prepare();assert.equal(h.autoScale(),true);assert.equal(h.capturing(),true);
  assert.equal(chart.options.responsive,false);assert.equal(chart.options.devicePixelRatio,2);
  const next={step:1};h.publish(series(100),next);await h.captureAdapter.renderReady(next);
  assert.deepEqual(bounds(chart),{xMin:0,xMax:100,yMin:0,yMax:200});assert.equal(chart.isDatasetVisible(1),false);assert.equal(h.autoScale(),true);
  const image=h.captureAdapter.capture(next,{caption:"Frame 1"});assert.equal(h.copies[0].output,image);assert.equal(image.width,800);
  assert.equal(h.copies[0].options.caption,"Frame 1");assert.deepEqual(chart.tooltipActive,[]);assert.deepEqual(chart.active,[]);
  h.publish(series(),first);await h.captureAdapter.renderReady(first);
  h.captureAdapter.restore();assert.deepEqual(bounds(chart),initial);assert.equal(h.capturing(),false);assert.equal(chart.options.responsive,true);assert.equal(chart.options.devicePixelRatio,undefined);
  assert.deepEqual(h.canvas.style,{width:"100%",height:"100%"});assert.equal(chart.isDatasetVisible(1),false);assert.equal(h.autoScale(),true);assert.equal(h.showLegend(),true);
  h.publish(series(25),{step:2});assert.equal(chart.scales.x.max,25);h.dispose();assert.equal(h.registered,null);
});

test("manual zoom and Auto-off survive capture while interaction and native legend events are blocked",()=>{
  const h=runtime(),chart=h.chart();h.startSelection(pointer(80,40));h.finishSelection(pointer(240,140));
  const initial=bounds(chart),stored={...h.limits()};assert.equal(h.autoScale(),false);
  h.captureAdapter.prepare();h.toggleAutoScale();h.startSelection(pointer(100,70,2));h.updateSelection(pointer(300,150,2));h.finishSelection(pointer(300,150,2));
  assert.deepEqual(bounds(chart),initial);assert.deepEqual(h.limits(),stored);assert.equal(h.autoScale(),false);assert.equal(h.captures.size,0);
  assert.equal(chart.plugins.find(p=>p.id==="selectionFrame").beforeEvent(),false);
  h.publish(series(200),{step:2});h.captureAdapter.restore();assert.deepEqual(bounds(chart),initial);assert.deepEqual(h.limits(),stored);
  assert.equal(chart.plugins.find(p=>p.id==="selectionFrame").beforeEvent(),undefined);h.dispose();
});

test("renderReady resolves only the exact published identity after drawing; abort removes a pending wait",async()=>{
  const h=runtime();h.captureAdapter.prepare();const expected={step:1};let completed=false;
  const wait=h.captureAdapter.renderReady(expected).then(()=>{completed=true;});
  h.publish(series(20),{step:1});await Promise.resolve();assert.equal(completed,false);
  assert.throws(()=>h.captureAdapter.capture(expected),/ещё не отрисован/);
  h.publish(series(30),expected);await wait;assert.equal(completed,true);assert.equal(h.chart().lastMode,"none");
  const controller=new AbortController();const aborted=h.captureAdapter.renderReady({step:99},{signal:controller.signal});controller.abort();
  await assert.rejects(aborted,{name:"AbortError"});h.captureAdapter.restore();h.dispose();
});

test("history cursor draws only in capture, marks exact visible saved values and never changes axes or datasets",()=>{
  const h=runtime(),chart=h.chart();chart.setDatasetVisibility(1,false);chart.update("none");const before=bounds(chart),count=chart.data.datasets.length;
  h.setCursor({time:10,step:1});assert.equal(h.calls.filter(c=>c.name==="arc").length,0);
  h.captureAdapter.prepare();h.calls.length=0;
  const key={step:1};h.publish(series(),key,{time:10,step:1});
  assert.equal(chart.data.datasets.length,count);assert.deepEqual(bounds(chart),before);
  const arcs=h.calls.filter(c=>c.name==="arc");assert.equal(arcs.length,1);assert.deepEqual(arcs[0].args.slice(0,3),[360,20,4]);
  h.calls.length=0;h.publish(series(),{step:7},{time:5,step:7});assert.equal(h.calls.filter(c=>c.name==="arc").length,0);
  assert.ok(h.calls.some(c=>c.name==="lineTo"));h.captureAdapter.restore();h.calls.length=0;chart.draw();assert.equal(h.calls.length,0);h.dispose();
});

test("resize mismatch fails explicitly and restore re-enables the original responsive behavior",async()=>{
  const h=runtime();h.captureAdapter.prepare();h.canvas.width++;
  await assert.rejects(h.captureAdapter.renderReady(h.frame()),/Размер графика изменился/);
  assert.throws(()=>h.captureAdapter.capture(h.frame()),/Размер графика изменился/);
  h.captureAdapter.restore();assert.equal(h.chart().options.responsive,true);assert.equal(h.capturing(),false);h.dispose();
});

test("init, draw, read, empty and unmount failures reject capture instead of hanging",async()=>{
  const failed=runtime({failInit:true});assert.ok(failed.registered);await assert.rejects(failed.captureAdapter.renderReady(failed.frame()),/init failure/);assert.throws(()=>failed.captureAdapter.prepare());failed.dispose();
  const empty=runtime({initial:[]});assert.throws(()=>empty.captureAdapter.prepare(),/Нет видимых данных/);await assert.rejects(empty.captureAdapter.renderReady(empty.frame()),/Нет видимых данных/);empty.dispose();
  const h=runtime();h.captureAdapter.prepare();let waiter=h.captureAdapter.renderReady({step:4});h.setError("HDF5 missing step");await assert.rejects(waiter,/HDF5 missing step/);
  h.setError("");h.chart().failUpdate=true;waiter=h.captureAdapter.renderReady({step:5});h.publish(series(50),{step:5});await assert.rejects(waiter,/update failure/);
  await assert.rejects(h.captureAdapter.renderReady(h.frame()),/update failure/);h.chart().failUpdate=false;h.publish(series(60),{step:6});
  waiter=h.captureAdapter.renderReady({step:7});h.dispose();await assert.rejects(waiter,/закрыт/);h.captureAdapter.restore();assert.equal(h.capturing(),false);
});

test("restore keeps visibility for series temporarily absent on an error path",()=>{
  const h=runtime(),chart=h.chart();chart.setDatasetVisibility(1,false);h.captureAdapter.prepare();
  h.publish([series()[0]],{step:1});h.captureAdapter.restore();h.publish(series(20),{step:0});
  assert.equal(chart.isDatasetVisible(1),false);h.dispose();
});


test("real Chart.js preserves precise padded axes, visibility and restores automatic DPR resolution",async()=>{
  const h=runtime({ChartImplementation:RealChart}),chart=h.chart();
  chart.setDatasetVisibility(1,false);chart.update("none");
  const original=bounds(chart),rawDpr=chart.config.options.devicePixelRatio;
  assert.equal(rawDpr,undefined);assert.equal(chart.options.devicePixelRatio,1);
  h.toggleAutoScale();assert.equal(h.autoScale(),false);
  h.captureAdapter.prepare();assert.equal(chart.options.responsive,false);
  const key={step:1};h.publish(series(200),key,{time:200,step:1});await h.captureAdapter.renderReady(key);
  assert.deepEqual(bounds(chart),original);assert.equal(chart.isDatasetVisible(1),false);
  h.captureAdapter.capture(key);h.captureAdapter.restore();
  assert.equal(chart.config.options.devicePixelRatio,undefined);assert.equal(Object.hasOwn(chart.config.options,"devicePixelRatio"),false);
  assert.equal(chart.options.responsive,true);assert.equal(chart.isDatasetVisible(1),false);assert.equal(h.autoScale(),false);
  assert.deepEqual(bounds(chart),original);
  chart.platform.getDevicePixelRatio=()=>2;chart.update("none");chart.resize();assert.equal(chart.currentDevicePixelRatio,2);
  h.dispose();
});

function assertAutomaticAxes(chart) {
  for (const axis of ["x","y"]) {
    assert.equal(chart.options.scales[axis].min,undefined);
    assert.equal(chart.options.scales[axis].max,undefined);
  }
}

for (const autoScaleToggle of [true,false]) {
  test(`real Chart.js movie Auto matches ordinary viewing through large growth and shrinkage (toggle=${autoScaleToggle})`,async()=>{
    const initial=series(3.7),h=runtime({initial,autoScaleToggle,ChartImplementation:RealChart});
    const ordinary=runtime({initial,autoScaleToggle,ChartImplementation:RealChart});
    try {
      for (const current of [h,ordinary]) {
        current.chart().setDatasetVisibility(1,false);current.setShowLegend(true);current.chart().update("none");
      }
      const originalKey=h.frame(),original=bounds(h.chart());
      h.captureAdapter.prepare();assertAutomaticAxes(h.chart());
      const snapshots=[];
      for (const [step,maximum] of [0.0000137,8.42e8,0.000000026,197].entries()) {
        const key={step},data=series(maximum);
        ordinary.publish(data,key);h.publish(data,key);await h.captureAdapter.renderReady(key);
        assert.deepEqual(bounds(h.chart()),bounds(ordinary.chart()));assertAutomaticAxes(h.chart());
        h.captureAdapter.capture(key);
        assert.deepEqual(bounds(h.chart()),bounds(ordinary.chart()));assertAutomaticAxes(h.chart());
        assert.equal(h.chart().isDatasetVisible(1),false);snapshots.push(bounds(h.chart()));
      }
      assert.ok(snapshots[1].yMax>snapshots[0].yMax*1e12);
      assert.ok(snapshots[2].yMax<snapshots[1].yMax/1e12);
      h.publish(initial,originalKey);await h.captureAdapter.renderReady(originalKey);h.captureAdapter.restore();
      assert.deepEqual(bounds(h.chart()),original);assert.deepEqual(h.limits(),{});assertAutomaticAxes(h.chart());
      assert.equal(h.autoScale(),true);assert.equal(h.showLegend(),true);assert.equal(h.capturing(),false);
      const next=series(915);h.publish(next,{step:9});ordinary.publish(next,{step:9});
      assert.deepEqual(bounds(h.chart()),bounds(ordinary.chart()));
    } finally { h.captureAdapter.restore();h.dispose();ordinary.dispose(); }
  });
}

for (const mode of ["Auto-off","manual zoom","manual zoom without toggle"]) {
  test(`real Chart.js preserves ${mode} through movie frames and cancellation`,async()=>{
    const h=runtime({initial:series(3.7),autoScaleToggle:mode!=="manual zoom without toggle",ChartImplementation:RealChart});
    try {
      const originalKey=h.frame(),chart=h.chart();
      chart.setDatasetVisibility(1,false);chart.update("none");
      if (mode==="Auto-off") h.toggleAutoScale();
      else { h.startSelection(pointer(80,40));h.finishSelection(pointer(240,140)); }
      const original=bounds(chart),stored={...h.limits()},originalAuto=h.autoScale();
      assert.equal(Object.values(stored).length,4);
      h.captureAdapter.prepare();
      for (const [step,maximum] of [8.42e8,0.000000026].entries()) {
        const key={step};h.publish(series(maximum),key);await h.captureAdapter.renderReady(key);h.captureAdapter.capture(key);
        assert.deepEqual(bounds(chart),original);assert.deepEqual(h.limits(),stored);
      }
      const controller=new AbortController(),waiting=h.captureAdapter.renderReady({step:99},{signal:controller.signal});
      controller.abort();await assert.rejects(waiting,{name:"AbortError"});
      h.publish(series(3.7),originalKey);await h.captureAdapter.renderReady(originalKey);h.captureAdapter.restore();
      assert.deepEqual(bounds(chart),original);assert.deepEqual(h.limits(),stored);assert.equal(h.autoScale(),originalAuto);
      assert.equal(chart.isDatasetVisible(1),false);assert.equal(chart.options.responsive,true);assert.equal(h.capturing(),false);
      // Restoring also unlocks the original Auto toggle or one-shot reset.
      h.toggleAutoScale();h.publish(series(197),{step:5});assertAutomaticAxes(chart);assert.ok(chart.scales.x.max>=197);
    } finally { h.captureAdapter.restore();h.dispose(); }
  });
}

test("real Chart.js cancellation restores Auto after the final movie frame changed scale",async()=>{
  const h=runtime({initial:series(3.7),ChartImplementation:RealChart});
  try {
    const original=bounds(h.chart()),originalKey=h.frame();h.captureAdapter.prepare();
    const key={step:1};h.publish(series(8.42e8),key);await h.captureAdapter.renderReady(key);h.captureAdapter.capture(key);
    const controller=new AbortController(),waiting=h.captureAdapter.renderReady({step:2},{signal:controller.signal});
    controller.abort();await assert.rejects(waiting,{name:"AbortError"});
    // The tab restores its original time with a fresh lifecycle signal, then releases the renderer.
    h.publish(series(3.7),originalKey);await h.captureAdapter.renderReady(originalKey);h.captureAdapter.restore();
    assert.deepEqual(bounds(h.chart()),original);assertAutomaticAxes(h.chart());assert.deepEqual(h.limits(),{});
    assert.equal(h.autoScale(),true);assert.equal(h.capturing(),false);
    h.publish(series(0.000000026),{step:3});assert.ok(h.chart().scales.x.max<0.000001);
  } finally { h.captureAdapter.restore();h.dispose(); }
});
