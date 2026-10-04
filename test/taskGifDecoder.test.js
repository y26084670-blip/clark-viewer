import test from "node:test";
import assert from "node:assert/strict";
import {createTaskGifDecoder} from "../src/services/taskGifDecoder.js";

// Independent tiny GIF fixture: clear-code before each pixel keeps codes 3-bit.
function gif(frames,{width=2,height=1}={}) {
  const u16=n=>[n&255,n>>8];
  const bytes=[...Buffer.from("GIF89a"),...u16(width),...u16(height),0x81,0,0,
    0,0,0,255,0,0,0,255,0,0,0,255];
  for(const {pixels,left=0,top=0,w=width,h=height,disposal=1,transparent=false,delay=2,interlaced=false} of frames) {
    const codes=pixels.flatMap(p=>[4,p]).concat(5), packed=[];let bits=0,value=0;
    for(const code of codes){value|=code<<bits;bits+=3;while(bits>=8){packed.push(value&255);value>>=8;bits-=8;}}
    if(bits)packed.push(value&255);
    bytes.push(0x21,0xf9,4,(disposal<<2)|(transparent?1:0),...u16(delay),0,0,
      0x2c,...u16(left),...u16(top),...u16(w),...u16(h),interlaced?64:0,2,packed.length,...packed,0);
  }
  return Uint8Array.from([...bytes,0x3b]).buffer;
}
const rgba=frame=>Array.from(frame.pixels);
test("real GIF decoding preserves short delays, overlays transparency and resets a loop",()=>{
  const decoder=createTaskGifDecoder(gif([{pixels:[1,1]},{pixels:[0,2],transparent:true,delay:3}]));
  const first=decoder.next();assert.equal(first.count,2);assert.equal(first.delay,20);
  assert.deepEqual(rgba(first),[255,0,0,255,255,0,0,255]);
  const second=decoder.next();assert.equal(second.delay,30);
  assert.deepEqual(rgba(second),[255,0,0,255,0,255,0,255]);
  assert.deepEqual(rgba(decoder.next(true)),rgba(first));
});
test("partial frames restore previous pixels for disposal 3 and clear only their bounds for disposal 2",()=>{
  for(const disposal of [2,3]) {
    const decoder=createTaskGifDecoder(gif([{pixels:[1,1]},
      {pixels:[3],w:1,disposal,transparent:true},{pixels:[2],w:1,left:1}]));
    decoder.next();assert.deepEqual(rgba(decoder.next()),[0,0,255,255,255,0,0,255]);
    assert.deepEqual(rgba(decoder.next()),disposal===3?[255,0,0,255,0,255,0,255]:[0,0,0,0,0,255,0,255]);
  }
});
test("interlaced rows are reconstructed; oversized and malformed frames fail before expansion",()=>{
  const order=[0,4,2,6,1,3,5,7],pixels=order.map(y=>1+y%3);
  const decoder=createTaskGifDecoder(gif([{pixels,interlaced:true}],{width:1,height:8}));
  const data=decoder.next().pixels;
  for(let y=0;y<8;y++)assert.equal(data[y*4+y%3],255);
  assert.throws(()=>createTaskGifDecoder(new ArrayBuffer(4)),/GIF/);
  assert.throws(()=>createTaskGifDecoder(gif([{pixels:[1],w:3}])),/некорректный кадр/);
  const huge=new Uint8Array(gif([{pixels:[1],w:1,h:1}]));huge.set([255,255,255,255],6);
  assert.throws(()=>createTaskGifDecoder(huge.buffer),/размер/);
});
