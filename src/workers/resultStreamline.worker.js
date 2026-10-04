import { calculateStreamlines } from "../services/visualization/resultStreamlineField.js";
self.onmessage=({data})=>{
  try {
    const result=calculateStreamlines(data.input);
    self.postMessage({id:data.id,result},result.flatMap(line=>line.paths.map(path=>path.positions.buffer)));
  } catch(error){self.postMessage({id:data.id,error:error.message??String(error)});}
};
