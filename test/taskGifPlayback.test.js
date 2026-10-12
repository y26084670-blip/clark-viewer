import test from "node:test";
import assert from "node:assert/strict";
import {createTaskGifPlayback} from "../src/services/taskGifPlayback.js";

function fixture({failBlend=false}={}){
  const workers=[],timers=new Map(),animations=new Map(),draws=[],blends=[];let time=0,id=0,state;
  const player=createTaskGifPlayback({publish:s=>state=s,draw:(f,next,alpha)=>{
    if(failBlend&&next)throw new Error("canvas failed");
    draws.push(f.index);blends.push({index:f.index,next:next?.index,alpha});},now:()=>time,
    schedule:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id;},cancel:key=>timers.delete(key),
    requestFrame:fn=>{animations.set(++id,fn);return id;},cancelFrame:key=>animations.delete(key),
    workerFactory:()=>{const w={messages:[],terminated:0,postMessage(m){this.messages.push(m);},terminate(){this.terminated++;},
      frame(index,count=3,delay=100){this.onmessage({data:{index,count,delay}});}};workers.push(w);return w;}});
  return {player,workers,draws,blends,timers,animations,get state(){return state;},advance(ms){time+=ms;
    for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn();}},paint(){
    for(const [id,fn] of [...animations]){animations.delete(id);fn();}}};
}
test("default is one automatic pass, pause retains remaining delay, restart follows the final frame",()=>{
  const h=fixture();h.player.open("blob:a");const w=h.workers[0];w.frame(0);
  assert.equal(h.state.loop,false);h.advance(40);h.player.toggle();h.advance(1000);
  assert.equal(w.messages.length,1);assert.deepEqual(h.draws,[0]);
  h.player.toggle();h.advance(59);assert.equal(w.messages.length,1);h.advance(1);w.frame(1);
  h.advance(100);w.frame(2);h.advance(100);
  assert.equal(h.state.playing,false);assert.equal(h.state.ended,true);assert.equal(w.messages.length,3);
  h.player.toggle();assert.deepEqual(w.messages.at(-1),{type:"next",reset:true});w.frame(0);
  assert.equal(h.state.playing,true);h.player.dispose();assert.equal(h.timers.size,0);assert.equal(w.terminated,1);
});
test("pause while decoding freezes display, resumes the pending frame and looping is explicit",()=>{
  const h=fixture();h.player.open("a");const w=h.workers[0];w.frame(0,2);h.advance(100);
  h.player.toggle();w.frame(1,2);assert.deepEqual(h.draws,[0]);h.player.toggle();assert.deepEqual(h.draws,[0,1]);
  h.player.setLoop(true);h.advance(100);assert.equal(w.messages.at(-1).reset,true);w.frame(0,2);
  h.player.setLoop(false);h.advance(100);w.frame(1,2);h.advance(100);assert.equal(h.state.ended,true);
  h.player.dispose();
});
test("closing/reopening releases workers, ignores stale frames and resets looping; decode failures stop playback",()=>{
  const h=fixture();h.player.open("a");const old=h.workers[0];h.player.setLoop(true);h.player.open("b");
  assert.equal(old.terminated,1);old.frame(0);assert.deepEqual(h.draws,[]);assert.equal(h.state.loop,false);
  const current=h.workers[1];current.onmessage({data:{error:"bad GIF"}});
  assert.equal(current.terminated,1);assert.equal(h.state.error,"bad GIF");assert.equal(h.state.playing,false);
  h.player.open("c");h.workers[2].frame(0,1);assert.equal(h.state.playing,false);h.player.dispose();
});

test("crossfade prefetches one frame and fits every transition into its original, variable delay",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const w=h.workers[0];w.frame(0,3,500);
  assert.deepEqual(w.messages.at(-1),{type:"next",reset:false});w.frame(1,3,200);
  assert.equal(h.state.index,0);assert.equal(w.messages.length,2);
  h.advance(250);h.paint();assert.deepEqual(h.blends.at(-1),{index:0,next:1,alpha:.5});
  h.advance(249);h.paint();assert.equal(h.state.index,0);h.advance(1);
  assert.equal(h.state.index,1);assert.equal(w.messages.length,3);w.frame(2,3,300);
  h.advance(100);h.paint();assert.deepEqual(h.blends.at(-1),{index:1,next:2,alpha:.5});
  h.advance(100);assert.equal(h.state.index,2);assert.equal(h.animations.size,0);
  assert.equal(w.messages.length,3);h.advance(299);assert.equal(h.state.playing,true);
  h.advance(1);assert.equal(h.state.ended,true);assert.equal(h.state.playing,false);
  h.player.toggle();assert.deepEqual(w.messages.at(-1),{type:"next",reset:true});w.frame(0,3,500);
  assert.equal(h.state.index,0);h.player.dispose();
});

test("pause freezes the mixed image and resumes both progress and the remaining delay",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const w=h.workers[0];w.frame(0);w.frame(1);
  h.advance(40);h.paint();h.player.toggle();assert.equal(h.blends.at(-1).alpha,.4);
  const draws=h.draws.length;h.advance(1000);h.paint();
  assert.equal(h.draws.length,draws);assert.equal(h.timers.size,0);assert.equal(h.animations.size,0);
  h.player.toggle();h.paint();assert.equal(h.blends.at(-1).alpha,.4);
  h.advance(30);h.paint();assert.equal(h.blends.at(-1).alpha,.7);
  h.advance(29);assert.equal(h.state.index,0);h.advance(1);assert.equal(h.state.index,1);
  h.player.dispose();
});

test("late decoding and skipped redraws catch up to the existing deadline without duplicate requests",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const w=h.workers[0];w.frame(0);
  h.advance(120);assert.equal(w.messages.length,2);assert.equal(h.state.index,0);
  w.frame(1);assert.equal(h.state.index,1);assert.equal(w.messages.length,3);w.frame(2);
  h.paint();assert.equal(h.blends.at(-1).alpha,.2);
  h.advance(50);h.paint();assert.equal(h.blends.at(-1).alpha,.7);
  h.advance(30);assert.equal(h.state.index,2);h.advance(100);assert.equal(h.state.ended,true);
  h.player.dispose();
});

test("a prefetched reply during pause does not advance the frame or restart its interval",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const w=h.workers[0];w.frame(0);
  h.advance(30);h.player.toggle();w.frame(1);h.advance(1000);h.paint();assert.deepEqual(h.draws,[0]);
  h.player.toggle();h.paint();assert.equal(h.blends.at(-1).alpha,.3);
  assert.equal(w.messages.length,2);h.advance(70);assert.equal(h.state.index,1);h.player.dispose();
});

test("maximizing/restoring during playback preserves the worker, frame and deadline",()=>{
  const h=fixture();h.player.open("a");const w=h.workers[0];w.frame(0);
  h.advance(30);h.player.setCrossfade(true);assert.equal(w.messages.length,2);w.frame(1);
  h.paint();assert.equal(h.blends.at(-1).alpha,.3);
  h.advance(20);h.player.setCrossfade(false);assert.equal(h.animations.size,0);
  assert.deepEqual(h.blends.at(-1),{index:0,next:undefined,alpha:undefined});
  h.advance(50);assert.equal(h.state.index,1);assert.equal(w.messages.length,2);
  h.advance(100);assert.equal(w.messages.length,3);w.frame(2);h.advance(100);
  assert.equal(h.state.ended,true);assert.equal(h.workers.length,1);h.player.dispose();
});

test("looping blends the final frame to the first, and disabling it keeps the final frame",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const w=h.workers[0];w.frame(0,2);
  h.player.setLoop(true);w.frame(1,2);h.advance(100);
  assert.deepEqual(w.messages.at(-1),{type:"next",reset:true});w.frame(0,2);
  h.advance(40);h.paint();assert.deepEqual(h.blends.at(-1),{index:1,next:0,alpha:.4});
  h.player.setLoop(false);assert.equal(h.animations.size,0);assert.equal(h.blends.at(-1).next,undefined);
  h.advance(60);assert.equal(h.state.ended,true);assert.equal(h.state.index,1);
  h.player.toggle();assert.equal(h.state.index,0);assert.equal(w.messages.length,4);
  w.frame(1,2);h.player.setLoop(true);h.advance(100);w.frame(0,2);
  h.advance(100);assert.equal(h.state.index,0);assert.equal(h.state.playing,true);h.player.dispose();
});

test("closing and reopening cancels redraws, ignores old prefetched data and handles render errors",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const old=h.workers[0];old.frame(0);old.frame(1);
  assert.equal(h.animations.size,1);h.player.open("b");assert.equal(h.animations.size,0);
  old.frame(2);assert.equal(h.state.index,-1);const w=h.workers[1];w.frame(0);w.frame(1);
  h.player.dispose();assert.equal(h.animations.size,0);assert.equal(h.timers.size,0);assert.equal(w.terminated,1);

  const failing=fixture({failBlend:true});failing.player.setCrossfade(true);failing.player.open("c");
  const broken=failing.workers[0];broken.frame(0);broken.frame(1);failing.paint();
  assert.equal(failing.state.error,"canvas failed");assert.equal(failing.state.playing,false);
  assert.equal(broken.terminated,1);assert.equal(failing.animations.size,0);assert.equal(failing.timers.size,0);
  failing.player.dispose();
});

test("single-frame GIFs never request a transition or an animation frame",()=>{
  const h=fixture();h.player.setCrossfade(true);h.player.open("a");const w=h.workers[0];w.frame(0,1);
  h.player.setLoop(true);h.player.toggle();assert.equal(w.messages.length,1);
  assert.equal(h.animations.size,0);assert.equal(h.timers.size,0);assert.equal(h.state.playing,false);h.player.dispose();
});
