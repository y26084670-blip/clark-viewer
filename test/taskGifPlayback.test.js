import test from "node:test";
import assert from "node:assert/strict";
import {createTaskGifPlayback} from "../src/services/taskGifPlayback.js";

function fixture(){
  const workers=[],timers=new Map(),draws=[];let time=0,id=0,state;
  const player=createTaskGifPlayback({publish:s=>state=s,draw:f=>draws.push(f.index),now:()=>time,
    schedule:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id;},cancel:key=>timers.delete(key),
    workerFactory:()=>{const w={messages:[],terminated:0,postMessage(m){this.messages.push(m);},terminate(){this.terminated++;},
      frame(index,count=3){this.onmessage({data:{index,count,delay:100}});}};workers.push(w);return w;}});
  return {player,workers,draws,timers,get state(){return state;},advance(ms){time+=ms;
    for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn();}}};
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
