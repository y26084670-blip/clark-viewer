import { createTaskGifDecoder } from "../services/taskGifDecoder.js";

let decoder;
self.onmessage=async ({data})=>{
  try {
    if(data.type==="open") {
      const response=await fetch(data.url);
      if(!response.ok)throw new Error("Не удалось прочитать GIF.");
      decoder=createTaskGifDecoder(await response.arrayBuffer());
    }
    if(!decoder)throw new Error("GIF не открыт.");
    const frame=decoder.next(data.reset===true);
    self.postMessage(frame,[frame.pixels.buffer]);
  } catch(error) { self.postMessage({error:error.message||String(error)}); }
};
