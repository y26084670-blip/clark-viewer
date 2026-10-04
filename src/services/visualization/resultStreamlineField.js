// Streamlines of the saved vector field, parameterized by arc length in mm.
// The hexahedron map uses solver vertex order (D1=12, D2=13, D3=15).
export const STREAMLINE_LIMITS = Object.freeze({ lines: 64, domains: 128, nodes: 200_000, steps: 8192 });
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
  return {...input,origin,localVertices,min,max,extent,cellSize,maxMagnitude};
}

// Interpolate components, not magnitudes. Between centres and the physical
// boundary the nearest-centre value is extended constantly along that axis.
export function sampleStreamlineVector(domain, point, guess) {
  const u=streamlineCoordinates(domain,point,guess);
  if(!u) return null;
  const dims=domain.dimensions, lower=[], upper=[], weight=[];
  for(let k=0;k<3;k++) {
    const q=clamp(u[k]*dims[k]-.5,0,dims[k]-1);
    lower[k]=Math.floor(q); upper[k]=Math.min(dims[k]-1,lower[k]+1); weight[k]=q-lower[k];
  }
  const vector=[0,0,0];
  for(const b of bits) {
    const p=b.map((v,k)=>v?upper[k]:lower[k]), w=b.reduce((a,v,k)=>a*(v?weight[k]:1-weight[k]),1);
    const index=((p[0]*dims[1]+p[1])*dims[2]+p[2])*3;
    for(let k=0;k<3;k++) vector[k]+=w*domain.vectors[index+k];
  }
  const magnitude=norm(vector);
  return {u,vector,magnitude};
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
function boundaryPoint(domain,p,next) {
  let lo=0,hi=1;
  for(let n=0;n<40;n++) {
    const mid=(lo+hi)/2, q=p.map((v,k)=>v+mid*(next[k]-v));
    if(inside(streamlineCoordinates(domain,q),0))lo=mid;else hi=mid;
  }
  return p.map((v,k)=>v+lo*(next[k]-v));
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
    const one=rk4(domain,p,h,sign), half=rk4(domain,p,h/2,sign), two=half&&rk4(domain,half,h/2,sign);
    if(!one||!two) { if(h>domain.cellSize*1e-6){h/=2;continue;} return finish("zero"); }
    const error=distance(one,two)/15, allowed=domain.cellSize*tolerance;
    if(error>allowed) { if(h<=domain.cellSize*1e-6)return finish("accuracy"); h*=Math.max(.2,.8*(allowed/error)**.2);continue; }
    const next=two, u=streamlineCoordinates(domain,next);
    if(!inside(u,0)) {
      const edge=boundaryPoint(domain,p,next);
      length+=distance(p,edge); points.push(edge);
      const tangent=direction(domain,edge,sign);
      if(!tangent)return finish("zero");
      const found=neighbour(domains,domain,edge,tangent,sign);
      if(!found.domain)return finish(found.reason);
      domain=found.domain; p=found.point;
      pieces.push({key:domain.key,source:domain.source,instance:domain.instance,start:points.length-1});
      points.push(p); h=Math.min(h,domain.cellSize*.25);continue;
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
        const dt=(low+high)/2, middle=rk4(domain,p,dt/2,sign);
        const q=middle&&rk4(domain,middle,dt/2,sign);
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

export function calculateStreamlines({domains:inputs,seeds,tolerance=STREAMLINE_DEFAULT_TOLERANCE,maxSteps=STREAMLINE_LIMITS.steps}) {
  if(!Number.isFinite(tolerance)||tolerance<1e-7||tolerance>1e-2)throw new Error("Допуск линии вне диапазона");
  if(!Number.isSafeInteger(maxSteps)||maxSteps<32||maxSteps>STREAMLINE_LIMITS.steps)throw new Error("Некорректный предел шагов линии");
  if(seeds.length>STREAMLINE_LIMITS.lines||inputs.length>STREAMLINE_LIMITS.domains
    ||inputs.reduce((s,d)=>s+d.dimensions.reduce((a,b)=>a*b,1),0)>STREAMLINE_LIMITS.nodes)throw new Error("Превышен предел расчёта линий поля");
  const domains=[],invalid=new Map();
  for(const input of inputs)try{domains.push(prepareStreamlineDomain(input));}catch(e){invalid.set(input.key,e.message);}
  return seeds.map(seed=>{
    const domain=domains.find(d=>d.key===seed.domainKey);
    const base={id:seed.id,quantityKey:seed.quantityKey,source:seed.source,instance:seed.instance};
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
      reasons:[...new Set([backward?.reason,forward.reason].filter(Boolean))],tolerance};
  });
}
