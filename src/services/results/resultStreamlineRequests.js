import { QUANTITIES, elementLayout } from "./resultMappings.js";
import { resultObjects } from "./resultRequests.js";
import { toStorage } from "../model/arrayShape.js";
import { unpackKvVertices } from "../solver/geometryKv.js";
import { expandElementSymmetry } from "../solver/symmetryExpansion.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { buildGeometryTimeModel } from "../visualization/geometryTimeModel.js";
import { STREAMLINE_LIMITS } from "../visualization/resultStreamlineField.js";

export const streamlineDomainKey = (source, instance) => `${source.schemaId}:${source.recordIndex}:${instance.ls}:${instance.as}:${instance.ps}`;

// Solver src/core/03_kv.jl and src/vsolver/05_clfieldv.jl FieldV:
// coil sampling reverses some axes as well as permuting the loop dimensions.
export function streamlineVertexOrder(record, full) {
  if (!full) return [0,1,2,3,4,5,6,7];
  return ({1:[4,0,6,2,5,1,7,3],2:[0,4,1,5,2,6,3,7],3:[2,0,3,1,6,4,7,5]})[record.indAmp] ?? [0,1,2,3,4,5,6,7];
}

function descriptors(task, quantityKey, time) {
  const q=QUANTITIES[quantityKey];
  if(!q||q.components!==3||q.group!=="elements")throw new Error("Линия доступна для векторного поля в объёмном элементе");
  const full=q.file==="HV"||q.file==="AV", projected=buildGeometryTimeModel(task,task.moves,time);
  const result=[];
  for(const object of resultObjects(task,quantityKey)) {
    const record=projected.model.elements[object.record.recordIndex], layout=elementLayout(record,full);
    if(projected.diagnostics.some(d=>d.schemaId==="elements"&&d.recordIndex===object.record.recordIndex))continue;
    const geo=Array.isArray(record.geo?.[0])?toStorage(record.geo,{nColumns:3,order:"row"}):record.geo;
    if(!geo||![0,1,2,3,4].includes(record.geoType))continue;
    const unpacked=unpackKvVertices(geo,record.geoType);
    if(unpacked.err)continue;
    const order=streamlineVertexOrder(record,full), vertices=order.map(i=>unpacked.vertices[i]);
    const copyCount=layout.copies.reduce((a,b)=>a*b,1), nodeCount=layout.dimensions.reduce((a,b)=>a*b,1);
    // Bound descriptor construction before expanding any large symmetry table.
    if(result.length+copyCount>4096)throw new Error("Для поиска соседних ШГ доступно не более 4096 образов");
    const images=expandElementSymmetry({...record,symLs:layout.copies[0],symAs:layout.copies[1],symPs:layout.copies[2]});
    for(const image of images) {
      const source={schemaId:"elements",recordIndex:object.record.recordIndex,name:record.name};
      const instance={ls:image.ls,as:image.as,ps:image.ps}, points=vertices.map(p=>applyMatrix4ToPoint(image.matrix,p));
      const copy=(image.ls*layout.copies[1]+image.as)*layout.copies[2]+image.ps;
      const min=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))), max=[0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
      result.push({key:streamlineDomainKey(source,instance),source,instance,vertices:points,dimensions:layout.dimensions,
        start:object.start+copy,count:(nodeCount-1)*copyCount+1,every:copyCount,nodeCount,min,max});
    }
  }
  return result;
}
function connectedCandidates(all,seeds) {
  const byKey=new Map(all.map(d=>[d.key,d])), kept=new Map(), queue=[];
  for(const seed of seeds)if(byKey.has(seed.domainKey)&&!kept.has(seed.domainKey)) {
    const domain=byKey.get(seed.domainKey);kept.set(domain.key,domain);queue.push(domain);
  }
  // Conservative broad phase only. The integrator requires actual common-face
  // contact and inward directions; a bounding-box overlap cannot bridge air.
  while(queue.length) {
    const a=queue.pop();
    for(const b of all)if(!kept.has(b.key)) {
      const size=Math.min(Math.hypot(...a.max.map((v,k)=>v-a.min[k])),Math.hypot(...b.max.map((v,k)=>v-b.min[k])));
      if(a.min.every((v,k)=>v<=b.max[k]+size*1e-10&&a.max[k]>=b.min[k]-size*1e-10)) {
        kept.set(b.key,b);queue.push(b);
        if(kept.size>STREAMLINE_LIMITS.domains)throw new Error("Связная группа линий превышает 128 образов ШГ");
      }
    }
  }
  return [...kept.values()];
}

export async function readResultStreamlines(request,processor) {
  const seeds=request.streamlineSeeds??[];
  if(!seeds.length)return [];
  if(seeds.length>STREAMLINE_LIMITS.lines)throw new Error("Допускается не более 64 линий поля");
  const groups=new Map();
  for(const seed of seeds) {
    if(!groups.has(seed.quantityKey))groups.set(seed.quantityKey,[]);
    groups.get(seed.quantityKey).push({...seed,domainKey:streamlineDomainKey(seed.source,seed.instance)});
  }
  const output=[];
  for(const [quantityKey,group] of groups) {
    try {
      const selected=connectedCandidates(descriptors(request.task,quantityKey,request.time),group);
      if(selected.reduce((n,d)=>n+d.nodeCount,0)>STREAMLINE_LIMITS.nodes)throw new Error("Для линий поля связная группа превышает 200 000 узлов");
      const q=QUANTITIES[quantityKey], domains=[];
      // Read one saved image by HDF5 stride, without all the other symmetry
      // images or a display sample. The task reader already serializes I/O.
      for(const d of selected) {
        const frame=await request.task.reader.read({name:q.file,step:request.time,start:d.start,count:d.count,every:d.every});
        if(frame.count!==d.nodeCount)throw new Error("Сетка линии не совпадает с данными HDF5");
        const positions=new Float64Array(d.nodeCount*3),vectors=new Float64Array(d.nodeCount*3);
        for(let n=0;n<d.nodeCount;n++) {
          positions.set(frame.values.subarray(n*frame.stride,n*frame.stride+3),n*3);
          for(let k=0;k<3;k++)vectors[n*3+k]=frame.values[n*frame.stride+q.offset+k]*(q.factor??1);
        }
        domains.push({...d,positions,vectors,coordinateBytes:frame.values.BYTES_PER_ELEMENT});
      }
      output.push(...await processor.process({domains,seeds:group,tolerance:request.streamlineTolerance,method:request.streamlineMethod??"trilinear"}));
    } catch(error) {
      if(error.name==="AbortError")throw error;
      output.push(...group.map(seed=>({...seed,paths:[],error:error.message??String(error)})));
    }
  }
  return output;
}
