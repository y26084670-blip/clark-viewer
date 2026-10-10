import { prepareStreamlineReconstruction, sampleReconstructedVector } from "./resultStreamlineReconstruction.js";

// Streamlines of the saved vector field, parameterized by arc length in mm.
// The hexahedron map uses solver vertex order (D1=12, D2=13, D3=15).
export const STREAMLINE_LIMITS = Object.freeze({ lines: 64, domains: 128, nodes: 200_000, steps: 8192 });
export const STREAMLINE_METHODS = Object.freeze({
  trilinear: "Трилинейный (контроль)",
  "trilinear-boundary": "Трилинейный · границы",
  quadratic: "Квадратичная реконструкция",
  tricubic: "Трикубический Эрмит",
});
export const STREAMLINE_DEFAULT_TOLERANCE = 1e-4; // fraction of the local grid spacing
const bits = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
const add = (a, b, scale = 1) => a.map((v, i) => v + scale * b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = a => Math.hypot(...a);
const distance = (a, b) => norm(sub(a, b));
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const inside = (u, eps = 1e-10) => u && u.every(v => v >= -eps && v <= 1 + eps);

function mapping(vertices, u) {
  const point = [0, 0, 0], jacobian = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let n = 0; n < 8; n++) {
    const f = bits[n].map((bit, axis) => bit ? u[axis] : 1-u[axis]);
    for (let axis = 0; axis < 3; axis++) {
      point[axis] += vertices[n][axis] * f[0]*f[1]*f[2];
      for (let k = 0; k < 3; k++) jacobian[k][axis] += vertices[n][axis]
        * (bits[n][k] ? 1 : -1) * f[(k+1)%3] * f[(k+2)%3];
    }
  }
  return { point, jacobian };
}
function solve(j, rhs) {
  const c = [cross(j[1],j[2]), cross(j[2],j[0]), cross(j[0],j[1])];
  const det = dot(j[0],c[0]), scale = norm(j[0])*norm(j[1])*norm(j[2]);
  if (!Number.isFinite(det) || Math.abs(det) <= scale*1e-12 || scale === 0) return null;
  return c.map(row => dot(row,rhs)/det);
}
export function streamlineCoordinates(domain, point, guess = [0.5,0.5,0.5]) {
  const local = sub(point,domain.origin), u = [...guess];
  for (let n = 0; n < 16; n++) {
    const at = mapping(domain.localVertices,u), residual = sub(local,at.point);
    if (norm(residual) <= domain.extent*2e-11) return u;
    const delta = solve(at.jacobian,residual);
    if (!delta || delta.some(v => !Number.isFinite(v))) return null;
    for (let k = 0; k < 3; k++) u[k] += delta[k];
    if (u.some(v => Math.abs(v)>10)) return null;
  }
  return distance(mapping(domain.localVertices,u).point,local) <= domain.extent*1e-9 ? u : null;
}
export function prepareStreamlineDomain(input) {
  const { vertices, dimensions: dims, positions, vectors } = input;
  if (!vertices || vertices.length !== 8 || !vertices.every(p => p.length === 3 && p.every(Number.isFinite))
    || !dims || dims.length !== 3 || !dims.every(n => Number.isSafeInteger(n)&&n>0)) throw new Error("Некорректная геометрия линии поля");
  const count = dims.reduce((a,b)=>a*b,1);
  if (count>STREAMLINE_LIMITS.nodes || positions.length!==count*3 || vectors.length!==count*3
    || !positions.every(Number.isFinite) || !vectors.every(Number.isFinite)) throw new Error("Неполная или нечисловая сетка векторного поля");
  const origin = [...vertices[0]], localVertices = vertices.map(p=>sub(p,origin));
  const min = [0,1,2].map(k=>Math.min(...vertices.map(p=>p[k]))), max = [0,1,2].map(k=>Math.max(...vertices.map(p=>p[k])));
  const extent = distance(min,max), center = mapping(localVertices,[0.5,0.5,0.5]);
  const cellSize = Math.min(...center.jacobian.map((v,k)=>norm(v)/dims[k]));
  if (!(cellSize>0) || !solve(center.jacobian,[1,1,1])) throw new Error("Вырожденный шестигранник");
  const orientation = Math.sign(dot(center.jacobian[0],cross(center.jacobian[1],center.jacobian[2])));
  for (const x of [0.001,0.5,0.999]) for (const y of [0.001,0.5,0.999]) for (const z of [0.001,0.5,0.999]) {
    const j=mapping(localVertices,[x,y,z]).jacobian;
    if (Math.sign(dot(j[0],cross(j[1],j[2])))!==orientation || !solve(j,[1,1,1])) throw new Error("Сложенная или вырожденная геометрия ШГ");
  }
  const eps = input.coordinateBytes===4 ? 2**-23 : Number.EPSILON;
  let maxMagnitude=0;
  for (let i=0;i<dims[0];i++) for(let j=0;j<dims[1];j++) for(let k=0;k<dims[2];k++) {
    const index=(i*dims[1]+j)*dims[2]+k;
    const expected=add(origin,mapping(localVertices,[(i+.5)/dims[0],(j+.5)/dims[1],(k+.5)/dims[2]]).point);
    for(let axis=0;axis<3;axis++) {
      const saved=positions[index*3+axis];
      const tolerance=Math.min(cellSize*1e-3,8*eps*Math.max(Math.abs(saved),Math.abs(expected[axis]),extent)+extent*1e-10);
      if(Math.abs(saved-expected[axis])>tolerance) throw new Error("Координаты HDF5 не совпадают с границами ШГ");
    }
    maxMagnitude=Math.max(maxMagnitude,Math.hypot(vectors[index*3],vectors[index*3+1],vectors[index*3+2]));
  }
  const domain={...input,origin,localVertices,min,max,extent,cellSize,maxMagnitude,
    method: input.method ?? "trilinear", fallbacks: new Set()};
  if(domain.method==="quadratic" || domain.method==="tricubic") {
    const preparation=prepareStreamlineReconstruction(domain,domain.method);
    if(preparation.fallback)domain.fallbacks.add(preparation.fallback);
  }
  return domain;
}

// The control sampler retains the original centre clamping. The improved
// sampler uses the first/last centre interval to reach the physical face.
// RK trial stages use a bounded extension of face values outside the domain;
// only physical points are accepted into the displayed trajectory.
export function sampleStreamlineVector(domain, point, guess) {
  const u=streamlineCoordinates(domain,point,guess);
  if(!u) return null;
  if(domain.monitorBoundaryStages && !inside(u,0)) domain.trialOutside=true;
  if(domain.method==="quadratic" || domain.method==="tricubic") {
    const bounded=u.map(v=>clamp(v));
    const sample=sampleReconstructedVector(domain,bounded,inside(u,0)?point:physicalPoint(domain,bounded),domain.method);
    if(sample.fallback)domain.fallbacks.add(sample.fallback);
    if(sample.vector)return {u,vector:sample.vector,magnitude:norm(sample.vector)};
    domain.fallbacks.add("Используется трилинейная реконструкция с продолжением до граней");
  }
  const dims=domain.dimensions, lower=[], upper=[], weight=[];
  for(let k=0;k<3;k++) {
    if(domain.method==="trilinear" || !domain.method) {
      const q=clamp(u[k]*dims[k]-.5,0,dims[k]-1);
      lower[k]=Math.floor(q); upper[k]=Math.min(dims[k]-1,lower[k]+1); weight[k]=q-lower[k];
    } else if(dims[k]===1) {
      lower[k]=upper[k]=0;weight[k]=0;
    } else {
      const q=clamp(u[k])*dims[k]-.5;
      lower[k]=clamp(Math.floor(q),0,dims[k]-2);upper[k]=lower[k]+1;weight[k]=q-lower[k];
    }
  }
  const vector=[0,0,0];
  for(const b of bits) {
    const p=b.map((v,k)=>v?upper[k]:lower[k]), w=b.reduce((a,v,k)=>a*(v?weight[k]:1-weight[k]),1);
    const index=((p[0]*dims[1]+p[1])*dims[2]+p[2])*3;
    for(let k=0;k<3;k++) vector[k]+=w*domain.vectors[index+k];
  }
  return {u,vector,magnitude:norm(vector)};
}
function direction(domain,p,sign) {
  const s=sampleStreamlineVector(domain,p);
  if(!s || !Number.isFinite(s.magnitude) || s.magnitude<=domain.maxMagnitude*1e-12 || s.magnitude===0) return null;
  return s.vector.map(v=>sign*v/s.magnitude);
}
function rk4(domain,p,h,sign) {
  const a=direction(domain,p,sign); if(!a)return null;
  const b=direction(domain,add(p,a,h/2),sign); if(!b)return null;
  const c=direction(domain,add(p,b,h/2),sign); if(!c)return null;
  const d=direction(domain,add(p,c,h),sign); if(!d)return null;
  return p.map((v,k)=>v+h*(a[k]+2*b[k]+2*c[k]+d[k])/6);
}
function integratedPoint(domain,p,h,sign) {
  const middle=rk4(domain,p,h/2,sign);
  return middle && rk4(domain,middle,h/2,sign);
}
function physicalPoint(domain,u) {
  return add(domain.origin,mapping(domain.localVertices,u.map(v=>clamp(v))).point);
}
function boundaryViolation(domain,p,u=streamlineCoordinates(domain,p)) {
  if(!u)return Infinity;
  return inside(u,0) ? 0 : distance(p,physicalPoint(domain,u));
}
function nearBoundary(domain,p,h) {
  const u=streamlineCoordinates(domain,p);
  if(!u)return true;
  const j=mapping(domain.localVertices,u).jacobian;
  const c=[cross(j[1],j[2]),cross(j[2],j[0]),cross(j[0],j[1])],det=Math.abs(dot(j[0],c[0]));
  return u.some((v,k)=>Math.min(v,1-v)*det/Math.max(norm(c[k]),Number.MIN_VALUE)<=h*1.5);
}
function localDirection(domain,point,sign) {
  const u=streamlineCoordinates(domain,point),d=direction(domain,point,sign);
  return u && d ? solve(mapping(domain.localVertices,u).jacobian,d) : null;
}
// Search in increasing arc-length order, including trial curves that leave
// and re-enter a domain. The root is refined on the integrated curve itself.
// Excursions within the integration error are treated as numerical tangency.
function boundaryPoint(domain,p,h,sign,next,allowed,stageOutside) {
  if(!stageOutside && boundaryViolation(domain,next)<=allowed && !nearBoundary(domain,p,h))return null;
  let previousTime=0,previousPoint=p,sampleTime=0,sampleSlope=localDirection(domain,p,sign);
  const segments=16;
  for(let n=1;n<=segments;n++) {
    const time=h*n/segments,q=n===segments?next:integratedPoint(domain,p,time,sign);
    if(!q)return null;
    const u=streamlineCoordinates(domain,q),slope=localDirection(domain,q,sign),candidates=[];
    // A narrow exit and return may lie between all uniform trial samples.
    // Locate minima/maxima of local face coordinates before accepting a step.
    if(sampleSlope && slope)for(let axis=0;axis<3;axis++) {
      if(sampleSlope[axis]*slope[axis]>=0)continue;
      let low=sampleTime,high=time,extremum=q;
      for(let i=0;i<32;i++) {
        const middle=(low+high)/2,point=integratedPoint(domain,p,middle,sign);
        if(!point)break;
        const derivative=localDirection(domain,point,sign);
        if(!derivative)break;
        extremum=point;
        if(sampleSlope[axis]*derivative[axis]>0)low=middle;else high=middle;
      }
      if(boundaryViolation(domain,extremum)>allowed)candidates.push({time:(low+high)/2,point:extremum});
    }
    if(boundaryViolation(domain,q,u)>allowed)candidates.push({time,point:q});
    candidates.sort((a,b)=>a.time-b.time);
    if(candidates.length) {
      let lo=previousTime,hi=candidates[0].time,edge=previousPoint;
      const target=Math.max(domain.extent*4e-12,allowed*.001);
      for(let i=0;i<48;i++) {
        const t=(lo+hi)/2,middle=integratedPoint(domain,p,t,sign);
        if(!middle){hi=t;continue;}
        if(inside(streamlineCoordinates(domain,middle),0)){lo=t;edge=middle;}else hi=t;
        if(hi-lo<=target)break;
      }
      const local=streamlineCoordinates(domain,edge);
      if(!local)return null;
      // Snap the nearest face, rather than leaving a seam-sized residual gap.
      let axis=0;
      for(let k=1;k<3;k++)if(Math.min(local[k],1-local[k])<Math.min(local[axis],1-local[axis]))axis=k;
      local[axis]=local[axis]<.5?0:1;
      return {point:physicalPoint(domain,local),time:(lo+hi)/2};
    }
    if(inside(u,0)){previousTime=time;previousPoint=q;}
    sampleTime=time;sampleSlope=slope;
  }
  return null;
}
function neighbour(domains,current,point,tangent,sign) {
  const hits=[];
  for(const d of domains) {
    if(d===current)continue;
    const eps=Math.min(d.cellSize,current.cellSize)*1e-7;
    if(point.some((v,k)=>v<d.min[k]-eps||v>d.max[k]+eps))continue;
    const u=streamlineCoordinates(d,point);
    // Contact at a face is required; overlapping interiors do not define a seam.
    if(!inside(u,1e-8)||!u.some(v=>Math.min(Math.abs(v),Math.abs(1-v))<1e-8))continue;
    if(!inside(streamlineCoordinates(d,add(point,tangent,eps)),0))continue;
    const own=direction(d,point,sign);
    if(!own || !inside(streamlineCoordinates(d,add(point,own,eps)),0))continue;
    hits.push({domain:d,point:add(point,own,eps)});
  }
  return hits.length===1 ? hits[0] : {reason:hits.length ? "ambiguous" : "boundary"};
}

function traceDirection(domains,first,seed,sign,tolerance,maxSteps) {
  let domain=first,p=[...seed],h=first.cellSize*.25,length=0,attempts=0,firstReturn=null;
  const points=[p], pieces=[{key:first.key,source:first.source,instance:first.instance,start:0}], startDirection=direction(first,p,sign);
  if(!startDirection)return {points,pieces,reason:"zero",length};
  const closeDistance=first.cellSize*tolerance*2, maxLength=Math.max(...domains.map(d=>d.extent))*1000;
  const finish=(reason)=>({points,pieces,reason,length});
  while(points.length<maxSteps && attempts++<maxSteps*16 && length<maxLength) {
    h=Math.min(h,domain.cellSize*.35);
    domain.trialOutside=false;domain.monitorBoundaryStages=true;
    const one=rk4(domain,p,h,sign), two=integratedPoint(domain,p,h,sign);
    domain.monitorBoundaryStages=false;
    const stageOutside=domain.trialOutside;
    if(!one||!two) { if(h>domain.cellSize*1e-6){h/=2;continue;} return finish("zero"); }
    const error=distance(one,two)/15, allowed=domain.cellSize*tolerance;
    if(error>allowed) { if(h<=domain.cellSize*1e-6)return finish("accuracy"); h*=Math.max(.2,.8*(allowed/error)**.2);continue; }
    let next=two;
    const event=boundaryPoint(domain,p,h,sign,next,allowed,stageOutside);
    if(event) {
      const edge=event.point;
      length+=distance(p,edge); points.push(edge);
      const tangent=direction(domain,edge,sign);
      if(!tangent)return finish("zero");
      const found=neighbour(domains,domain,edge,tangent,sign);
      if(!found.domain)return finish(found.reason);
      domain=found.domain; p=found.point;
      pieces.push({key:domain.key,source:domain.source,instance:domain.instance,start:points.length-1});
      points.push(p); h=Math.min(h,domain.cellSize*.25);continue;
    }
    const local=streamlineCoordinates(domain,next);
    if(!inside(local,0)) {
      if(boundaryViolation(domain,next,local)>allowed){h/=2;continue;}
      next=physicalPoint(domain,local);
    }
    const travelled=distance(p,next);
    if(travelled<=domain.cellSize*1e-10)return finish("stagnation");
    length+=travelled;
    // Poincare return to the seed plane, in the same direction. Two returns
    // must agree within tolerance. Nearby turns of a drifting helix/spiral are
    // never joined merely because two sampled points happen to be close.
    const before=dot(sub(p,seed),startDirection), after=dot(sub(next,seed),startDirection);
    if(domain.key===first.key && points.length>16 && length>first.cellSize*4 && before<0 && after>=0) {
      // Locate the return on the integrated curve, not on its display chord:
      // chord sagitta is O(h²), much larger than the RK integration tolerance.
      let low=0,high=h,crossing=next;
      for(let i=0;i<28;i++) {
        const dt=(low+high)/2,q=integratedPoint(domain,p,dt,sign);
        if(!q)break;
        crossing=q;
        if(dot(sub(q,seed),startDirection)<0)low=dt;else high=dt;
      }
      const dir=direction(domain,crossing,sign);
      if(distance(crossing,seed)<=closeDistance && dir && dot(dir,startDirection)>0.9999) {
        if(firstReturn && distance(crossing,firstReturn.point)<=closeDistance) {
          points.splice(firstReturn.index); points.push([...seed]);
          while(pieces.length>1&&pieces.at(-1).start>=points.length-1)pieces.pop();
          return {...finish("closed"),length:firstReturn.length};
        }
        firstReturn={point:crossing,index:points.length,length:length-travelled+(low+high)/2};
      } else firstReturn=null;
    }
    points.push(next);p=next;
    if(error<allowed/32)h*=1.5;
  }
  return finish("limit");
}

export const STREAMLINE_REASONS = Object.freeze({ boundary:"граница доступного поля", ambiguous:"неоднозначное соседство",
  zero:"нулевое или неопределённое поле", closed:"замкнута в пределах допуска", limit:"предел длины/шагов",
  stagnation:"слишком малый шаг", accuracy:"не достигнут допуск" });

export function calculateStreamlines({domains:inputs,seeds,tolerance=STREAMLINE_DEFAULT_TOLERANCE,maxSteps=STREAMLINE_LIMITS.steps,method="trilinear"}) {
  if(!Object.hasOwn(STREAMLINE_METHODS,method))throw new Error("Неизвестный метод линии поля");
  if(!Number.isFinite(tolerance)||tolerance<1e-7||tolerance>1e-2)throw new Error("Допуск линии вне диапазона");
  if(!Number.isSafeInteger(maxSteps)||maxSteps<32||maxSteps>STREAMLINE_LIMITS.steps)throw new Error("Некорректный предел шагов линии");
  if(seeds.length>STREAMLINE_LIMITS.lines||inputs.length>STREAMLINE_LIMITS.domains
    ||inputs.reduce((s,d)=>s+d.dimensions.reduce((a,b)=>a*b,1),0)>STREAMLINE_LIMITS.nodes)throw new Error("Превышен предел расчёта линий поля");
  const domains=[],invalid=new Map();
  for(const input of inputs)try{domains.push(prepareStreamlineDomain({...input,method}));}catch(e){invalid.set(input.key,e.message);}
  return seeds.map(seed=>{
    for(const d of domains)d.fallbacks.clear();
    const domain=domains.find(d=>d.key===seed.domainKey);
    const base={id:seed.id,quantityKey:seed.quantityKey,source:seed.source,instance:seed.instance,method,fallbacks:[]};
    if(!domain)return {...base,error:invalid.get(seed.domainKey)||"Нет данных выбранного элемента",paths:[]};
    if(!Number.isSafeInteger(seed.node)||seed.node<0||seed.node>=domain.positions.length/3)return {...base,error:"Узел линии вне сетки",paths:[]};
    const start=Array.from(domain.positions.subarray(seed.node*3,seed.node*3+3));
    const forward=traceDirection(domains,domain,start,1,tolerance,maxSteps);
    const backward=forward.reason==="closed"?null:traceDirection(domains,domain,start,-1,tolerance,maxSteps);
    const paths=[];
    for(const branch of [backward,forward].filter(Boolean)) for(let i=0;i<branch.pieces.length;i++) {
      const piece=branch.pieces[i],end=branch.pieces[i+1]?.start??branch.points.length-1;
      const points=branch.points.slice(piece.start,end+1);
      if(points.length>1) {
        // Sample the original interpolated components, never the normalized
        // integration direction. Shared seam endpoints use each side's field.
        const owner=domains.find(item=>item.key===piece.key);
        const magnitudes=Float64Array.from(points,point=>sampleStreamlineVector(owner,point)?.magnitude??NaN);
        paths.push({...piece,positions:Float64Array.from(points.flat()),magnitudes});
      }
    }
    return {...base,paths,start,length:forward.length+(backward?.length??0),closed:forward.reason==="closed",
      reasons:[...new Set([backward?.reason,forward.reason].filter(Boolean))],tolerance,
      fallbacks:[...new Set(domains.flatMap(d=>[...d.fallbacks]))]};
  });
}
