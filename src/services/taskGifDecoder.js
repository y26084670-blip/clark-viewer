import { parseGIF, decompressFrame } from "gifuct-js";

// Retain compressed frames and at most two compositing canvases, not N RGBA frames.
export function createTaskGifDecoder(buffer) {
  const bytes=new Uint8Array(buffer);
  if(bytes.length<13 || bytes.length>128*1024*1024
    || !["GIF87a","GIF89a"].includes(String.fromCharCode(...bytes.subarray(0,6))))
    throw new Error("Некорректный GIF или размер файла больше 128 МиБ.");
  const gif=parseGIF(buffer), width=gif.lsd.width, height=gif.lsd.height;
  const frames=gif.frames.filter(frame=>frame.image);
  if(!width || !height || width*height>16777216 || !frames.length || frames.length>10000)
    throw new Error("GIF: недопустимый размер изображения или число кадров.");
  for(const frame of frames) {
    const d=frame.image.descriptor;
    if(!d.width || !d.height || d.left+d.width>width || d.top+d.height>height
      || !frame.image.data.blocks.length || frame.image.data.minCodeSize<2 || frame.image.data.minCodeSize>8
      || !(frame.image.lct ?? gif.gct)?.length)
      throw new Error("GIF содержит некорректный кадр.");
  }
  const pixels=new Uint8ClampedArray(width*height*4);
  let index=-1, previous=null, restore=null;
  const background=frame=>frame?.gce?.extras.transparentColorGiven || !gif.gct
    ? [0,0,0,0] : [...(gif.gct[gif.lsd.backgroundColorIndex] ?? [0,0,0]),255];
  function fill(rect,color) {
    for(let y=rect.top;y<rect.top+rect.height;y++)for(let x=rect.left;x<rect.left+rect.width;x++)
      pixels.set(color,(y*width+x)*4);
  }
  function next(reset=false) {
    if(reset || index<0) {
      index=-1;previous=null;restore=null;
      fill({top:0,left:0,width,height},background(frames[0]));
    }
    if(index+1>=frames.length)throw new Error("Конец GIF.");
    if(previous?.disposalType===2)fill(previous.dims,background(frames[index]));
    else if(previous?.disposalType===3 && restore)pixels.set(restore);
    const raw=frames[++index], frame=decompressFrame(raw,gif.gct,true);
    restore=frame.disposalType===3 ? pixels.slice() : null;
    const {left,top,width:w,height:h}=frame.dims;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const offset=(y*w+x)*4;
      if(frame.patch[offset+3])pixels.set(frame.patch.subarray(offset,offset+4),((y+top)*width+x+left)*4);
    }
    previous=frame;
    // Preserve valid short frame delays; GIF zero/missing delay uses 100 ms.
    return {width,height,index,count:frames.length,delay:raw.gce?.delay>0?raw.gce.delay*10:100,pixels:pixels.slice()};
  }
  return {next};
}
