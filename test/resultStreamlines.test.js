import test from "node:test";
import assert from "node:assert/strict";
import { calculateStreamlines, prepareStreamlineDomain, sampleStreamlineVector } from "../src/services/visualization/resultStreamlineField.js";

export function grid({key="a",dims=[8,8,8],lo=[-2,-2,-2],hi=[2,2,2],field=()=>[1,0,0],Type=Float64Array}={}) {
  const vertices=Array.from({length:8},(_,i)=>[0,1,2].map(k=>(i>>k)&1?hi[k]:lo[k]));
  const positions=[],vectors=[];
  for(let i=0;i<dims[0];i++)for(let j=0;j<dims[1];j++)for(let k=0;k<dims[2];k++) {
    const p=[i,j,k].map((v,a)=>lo[a]+(hi[a]-lo[a])*(v+.5)/dims[a]);positions.push(...p);vectors.push(...field(...p));
  }
  return {key,source:{schemaId:"elements",recordIndex:key==="a"?0:1},instance:{ls:0,as:0,ps:0},dimensions:dims,vertices,
    positions:new Type(positions),vectors:new Type(vectors),coordinateBytes:Type.BYTES_PER_ELEMENT};
}
const trace=(domains,node=0,options={})=>calculateStreamlines({domains,seeds:[{id:1,domainKey:domains[0].key,node}],...options})[0];
const xyz=line=>line.paths.flatMap(p=>Array.from({length:p.positions.length/3},(_,i)=>Array.from(p.positions.subarray(i*3,i*3+3))));

test("constant vector traces both ways to the physical faces, including one-cell-thick elements",()=>{
  const d=grid({dims:[1,1,1],lo:[0,0,0],hi:[4,6,8]}); const line=trace([d]);
  assert.deepEqual(line.reasons,["boundary"]);assert.equal(line.paths.length,2);
  const ends=line.paths.map(p=>Array.from(p.positions.slice(-3)));
  assert.ok(Math.abs(ends[0][0])<1e-8);assert.ok(Math.abs(ends[1][0]-4)<1e-8);
  assert.ok(xyz(line).every(p=>p[0]>=-1e-9&&p[0]<=4+1e-9&&p[1]===3&&p[2]===4));
});
test("component interpolation preserves direction and extends nearest centres only at the physical boundary",()=>{
  const d=prepareStreamlineDomain(grid({field:(x,y,z)=>[x+2*y,3*y-z,z-x]}));
  const p=[.2,-.1,.4],s=sampleStreamlineVector(d,p);
  s.vector.forEach((v,k)=>assert.ok(Math.abs(v-[0,-.7,.2][k])<1e-12));
  const edge=sampleStreamlineVector(d,[2,0,0]);assert.ok(Math.abs(edge.vector[0]-1.75)<1e-12);
});
test("each line point carries the magnitude of interpolated components, not a unit tangent or interpolated endpoint magnitudes",()=>{
  const d=grid({dims:[2,1,1],lo:[0,0,0],hi:[2,2,2],field:x=>[1,2*(x-1),0]});
  const line=trace([d]);let smallest=Infinity;
  for(const path of line.paths) {
    assert.ok(path.magnitudes instanceof Float64Array);assert.equal(path.magnitudes.length,path.positions.length/3);
    for(let i=0;i<path.magnitudes.length;i++) {
      const x=Math.max(.5,Math.min(1.5,path.positions[i*3]));
      assert.ok(Math.abs(path.magnitudes[i]-Math.hypot(1,2*(x-1)))<1e-12);
      smallest=Math.min(smallest,path.magnitudes[i]);
    }
  }
  assert.ok(smallest<1.1,"equal endpoint magnitudes sqrt(2) must not produce a constant magnitude field");
  assert.ok(line.paths.some(path=>path.magnitudes.some(value=>value>1.4)),"tracing direction normalization must not erase amplitude");
});
test("shared seam points keep the distinct magnitudes on each side of a material boundary",()=>{
  const a=grid({dims:[1,1,1],lo:[0,0,0],hi:[1,1,1],field:()=>[2,0,0]});
  const b=grid({key:"b",dims:[1,1,1],lo:[1,0,0],hi:[2,1,1],field:()=>[5,0,0]});
  const line=trace([a,b]);
  assert.ok(line.paths.some(path=>path.key==="b"));
  for(const path of line.paths)assert.ok(path.magnitudes.every(value=>Math.abs(value-(path.key==="a"?2:5))<1e-12));
});
test("common-face neighbours continue the same line, while air gaps and opposing fields stop it",()=>{
  const a=grid({dims:[2,2,2],lo:[0,0,0],hi:[1,1,1]}),b=grid({key:"b",dims:[3,2,2],lo:[1,0,0],hi:[2,1,1]});
  const joined=trace([a,b]);assert.ok(xyz(joined).some(p=>p[0]>1.9));assert.ok(joined.paths.some(p=>p.key==="b"));
  for(const other of [grid({key:"b",lo:[1.001,0,0],hi:[2,1,1]}),grid({key:"b",lo:[1,0,0],hi:[2,1,1],field:()=>[-1,0,0]})]) {
    const stopped=trace([a,other]);assert.ok(xyz(stopped).every(p=>p[0]<=1+1e-9));
  }
});
test("an exact rotational field closes through the seed; a helix or inward spiral is not labelled closed",()=>{
  const circle=grid({dims:[16,16,1],field:(x,y)=>[-y,x,0]});
  const node=11*16+7, line=trace([circle],node);
  assert.equal(line.closed,true);assert.deepEqual(line.reasons,["closed"]);
  const radius=Math.hypot(...line.start.slice(0,2));
  assert.ok(xyz(line).every(p=>Math.abs(Math.hypot(p[0],p[1])-radius)<1e-4));
  for(const field of [(x,y)=>[-y,x,.003],(x,y)=>[-y-.01*x,x-.01*y,0]]) {
    const open=trace([grid({dims:[16,16,1],field})],node,{maxSteps:2000});
    assert.equal(open.closed,false);assert.ok(!open.reasons.includes("closed"));
  }
});
test("tolerance distinguishes a resolvable slow helix and reports limits separately from closure",()=>{
  const d=grid({dims:[16,16,1],field:(x,y)=>[-y,x,1e-4]});
  const line=trace([d],11*16+7,{tolerance:1e-5,maxSteps:1000});
  assert.equal(line.closed,false);assert.ok(line.reasons.includes("limit"));
});
test("zero, malformed and stale geometry never creates an invented streamline",()=>{
  const zero=trace([grid({field:()=>[0,0,0]})]);assert.deepEqual(zero.reasons,["zero"]);assert.equal(zero.paths.length,0);
  const stale=grid();stale.positions[0]+=.1;assert.match(trace([stale]).error,/не совпадают/);
  const bad=grid();bad.vectors[3]=NaN;assert.match(trace([bad]).error,/нечисловая/);
  const flat=grid({hi:[2,2,-2]});assert.match(trace([flat]).error,/Вырожденный/);
});
test("Float32 and Float64 saved coordinates work after a large translation",()=>{
  for(const Type of [Float32Array,Float64Array]) {
    const d=grid({Type,dims:[3,5,1],lo:[7000.125,-9000.875,15000.0625],hi:[7004.125,-8994.875,15008.0625]});
    const line=trace([d]);assert.equal(line.error,undefined);assert.equal(line.reasons[0],"boundary");
  }
});


function mappedGrid({dims=[4,4,4],vertices,field,key="mapped"}={}) {
  const map=u=>[0,1,2].map(axis=>vertices.reduce((sum,p,n)=>
    sum+p[axis]*u.reduce((w,value,k)=>w*((n>>k)&1?value:1-value),1),0));
  const positions=[],vectors=[];
  for(let i=0;i<dims[0];i++)for(let j=0;j<dims[1];j++)for(let k=0;k<dims[2];k++) {
    const p=map([i,j,k].map((v,a)=>(v+.5)/dims[a]));
    positions.push(...p);vectors.push(...field(...p));
  }
  return {key,source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:0},
    dimensions:dims,vertices,positions:new Float64Array(positions),vectors:new Float64Array(vectors),coordinateBytes:8,map};
}
function closeVector(actual,expected,tolerance=1e-11) {
  assert.equal(actual.length,expected.length);
  actual.forEach((value,k)=>assert.ok(Math.abs(value-expected[k])<=tolerance,
    `component ${k}: ${value} vs ${expected[k]}`));
}

test("the legacy method remains the default and keeps its nearest-centre boundary values",()=>{
  const raw=grid({dims:[2,2,2],lo:[0,0,0],hi:[1,1,1],field:(x,y,z)=>[x,y,z]});
  for(const method of [undefined,"trilinear"]) {
    const d=prepareStreamlineDomain({...raw,method});
    closeVector(sampleStreamlineVector(d,[0,1,0]).vector,[.25,.75,.25]);
  }
  const a=trace([raw]),b=trace([raw],0,{method:"trilinear"});
  assert.equal(a.method,"trilinear");assert.equal(b.method,"trilinear");
  assert.deepEqual(a.paths.map(p=>Array.from(p.positions)),b.paths.map(p=>Array.from(p.positions)));
});

test("boundary continuation reproduces an affine field on faces, edges and corners",()=>{
  const field=(x,y,z)=>[1+2*x-y,3*y-z,2*z+x];
  const raw=grid({dims:[4,5,3],lo:[-2,-1,0],hi:[2,3,2],field});
  const d=prepareStreamlineDomain({...raw,method:"trilinear-boundary"});
  for(const point of [[-2,.7,1],[2,3,.4],[-2,-1,0],[2,3,2],[0,0,1]]) {
    closeVector(sampleStreamlineVector(d,point).vector,field(...point));
  }
  const old=prepareStreamlineDomain({...raw,method:"trilinear"});
  assert.ok(Math.abs(sampleStreamlineVector(old,[2,3,2]).vector[0]-field(2,3,2)[0])>.1);
});

test("boundary continuation uses the solver hexahedron map on skew, nonuniform physical grids",()=>{
  const vertices=Array.from({length:8},(_,n)=>{
    const u=n&1,v=(n>>1)&1,w=(n>>2)&1;
    return [3+2*u+.2*v,-1+1.5*v+.1*w,2+w+.12*u*v];
  });
  const field=(x,y,z)=>[1+.3*x-.2*y,z+.4*x,2-y+.1*z];
  const raw=mappedGrid({vertices,field});
  const d=prepareStreamlineDomain({...raw,method:"trilinear-boundary"});
  for(const u of [[0,.31,.8],[1,1,.25],[0,0,0],[1,1,1],[.23,.61,.72]]) {
    const point=raw.map(u);closeVector(sampleStreamlineVector(d,point).vector,field(...point),1e-10);
  }
});

test("boundary continuation preserves one-cell axes and is exact with two centres",()=>{
  const raw=grid({dims:[1,2,1],lo:[0,0,0],hi:[2,4,6],field:(x,y,z)=>[7,2*y-3,11]});
  const d=prepareStreamlineDomain({...raw,method:"trilinear-boundary"});
  for(const point of [[0,0,0],[2,4,6],[1,2,3]])closeVector(sampleStreamlineVector(d,point).vector,[7,2*point[1]-3,11]);
  assert.ok(sampleStreamlineVector(d,[2,4,6]).vector.every(Number.isFinite));
});

test("a curved trajectory reaches the physical face on its integrated curve",()=>{
  const d=grid({dims:[8,4,1],lo:[0,0,0],hi:[1,1,1],field:(x,y)=>[1,y,0]});
  const line=trace([d],6*4+1,{method:"trilinear-boundary",tolerance:1e-6});
  assert.equal(line.error,undefined);assert.equal(line.method,"trilinear-boundary");
  assert.deepEqual(line.reasons,["boundary"]);
  closeVector(line.start,[.8125,.375,.5]);
  const forward=line.paths.at(-1),end=Array.from(forward.positions.slice(-3));
  closeVector(end,[1,.375*Math.exp(1-.8125),.5],1e-6);
  for(const path of line.paths)for(let i=0;i<path.magnitudes.length;i++)
    assert.ok(Math.abs(path.magnitudes[i]-Math.hypot(1,path.positions[3*i+1]))<1e-11);
});

test("a trajectory that touches a boundary tangentially continues inside the domain",()=>{
  const d=grid({dims:[2,2,1],lo:[-1,0,0],hi:[1,1,1],field:(x)=>[1,2*x,0]});
  const line=trace([d],0,{method:"trilinear-boundary",tolerance:1e-6});
  assert.equal(line.error,undefined);assert.deepEqual(line.reasons,["boundary"]);
  const forward=line.paths.at(-1);
  closeVector(Array.from(forward.positions.slice(-3)),[1,1,.5],1e-5);
  const points=xyz(line);assert.ok(points.some(p=>p[0]<-.1)&&points.some(p=>p[0]>.1));
  assert.ok(points.every(p=>p[1]>=-1e-7),"a tangent contact must not invent an outside display segment");
  assert.ok(points.every(p=>Math.abs(p[1]-p[0]*p[0])<1e-5));
});

test("edge exits with two inward face neighbours are reported as ambiguous",()=>{
  const a=grid({dims:[2,2,1],lo:[0,0,0],hi:[1,1,1],field:()=>[1,1,0]});
  const b=grid({key:"b",dims:[2,2,1],lo:[1,0,0],hi:[2,2,1],field:()=>[1,-1,0]});
  const c=grid({key:"c",dims:[2,2,1],lo:[0,1,0],hi:[2,2,1],field:()=>[-1,1,0]});
  const line=trace([a,b,c],0,{method:"trilinear-boundary",tolerance:1e-6});
  assert.ok(line.reasons.includes("ambiguous"));
  assert.ok(line.paths.every(path=>path.key==="a"));
  closeVector(Array.from(line.paths.at(-1).positions.slice(-3)),[1,1,.5],1e-7);
});

test("new methods retain separate values on the two sides of a seam",()=>{
  for(const method of ["trilinear-boundary","quadratic","tricubic"]) {
    const a=grid({dims:[4,4,4],lo:[0,0,0],hi:[1,1,1],field:x=>[2+x,0,0]});
    const b=grid({key:"b",dims:[5,4,4],lo:[1,0,0],hi:[2,1,1],field:x=>[7+x,0,0]});
    const line=trace([a,b],5,{method});
    assert.equal(line.error,undefined);assert.equal(line.method,method);
    assert.ok(Array.isArray(line.fallbacks));assert.ok(line.paths.some(path=>path.key==="b"));
    for(const path of line.paths)for(let i=0;i<path.magnitudes.length;i++)
      assert.ok(Math.abs(path.magnitudes[i]-(path.key==="a"?2:7)-path.positions[3*i])<1e-8);
  }
});

test("boundary methods do not bridge gaps or opposing directions across seams",()=>{
  for(const method of ["trilinear-boundary","quadratic","tricubic"]) {
    const a=grid({dims:[4,4,4],lo:[0,0,0],hi:[1,1,1]});
    for(const other of [grid({key:"b",lo:[1.001,0,0],hi:[2,1,1]}),
      grid({key:"b",lo:[1,0,0],hi:[2,1,1],field:()=>[-1,0,0]})]) {
      const line=trace([a,other],5,{method});
      assert.deepEqual(line.reasons,["boundary"]);
      assert.ok(line.paths.every(path=>path.key==="a"));
      assert.ok(xyz(line).every(p=>p[0]<=1+1e-8));
    }
  }
});

test("invalid method values are rejected",()=>{
  assert.throws(()=>trace([grid()],0,{method:"unknown"}),/метод|интерпол|Method|method/i);
});


test("a narrow boundary excursion is detected before the trajectory reenters",()=>{
  // The minimum is eight times deeper than the requested local tolerance.
  // Sixteen fixed event samples can all lie inside even though the curve exits.
  const c=.5625+Math.sqrt(.100001),delta=1e-6;
  const raw=grid({dims:[8,1,1],lo:[0,0,0],hi:[1,.2,1],field:x=>[1,2*(x-c),0]});
  const line=trace([raw],4,{method:"trilinear-boundary",tolerance:1e-6});
  const end=Array.from(line.paths.at(-1).positions.slice(-3));
  assert.equal(line.error,undefined);assert.deepEqual(line.reasons,["boundary"]);
  closeVector(end,[c-Math.sqrt(delta),0,.5],2e-5);
  assert.ok(xyz(line).every(p=>p[0]<c&&p[1]>=-1e-8),"the physical boundary must terminate the first branch");
});


test("quadratic reconstruction reproduces all physical quadratic terms including boundaries",()=>{
  const field=(x,y,z)=>[1+2*x-.7*y+.3*z+x*x+.2*x*y-.1*y*z,
    2-x+.5*y*y+.4*x*z,z+.8*z*z-.3*x*y];
  const raw=grid({dims:[5,5,5],lo:[-1,-1,-1],hi:[1,1,1],field});
  const d=prepareStreamlineDomain({...raw,method:"quadratic"});
  for(const p of [[.17,-.23,.31],[1,.25,-.6],[1,-1,1],[-1,-1,-1]]) {
    closeVector(sampleStreamlineVector(d,p).vector,field(...p),2e-9);
  }
});

test("tricubic interpolation reproduces a tensor cubic polynomial at the physical boundary",()=>{
  const field=(x,y,z)=>[1+x*x*x+.2*x*x*y- .1*y*z*z,
    2+y*y*y+.3*x*y*z,z*z*z+.2*x*x*x*y*y*y*z*z*z];
  const raw=grid({dims:[6,6,6],lo:[-1,-1,-1],hi:[1,1,1],field});
  const d=prepareStreamlineDomain({...raw,method:"tricubic"});
  for(const p of [[.17,-.23,.31],[1,.25,-.6],[1,-1,1],[-1,-1,-1]]) {
    closeVector(sampleStreamlineVector(d,p).vector,field(...p),2e-9);
  }
});

test("higher-order reconstruction degrades explicitly on thin grids without NaN or invented components",()=>{
  for(const method of ["quadratic","tricubic"])for(const dims of [[1,1,1],[2,2,2],[1,5,5]]) {
    const raw=grid({dims,lo:[0,0,0],hi:[1,1,1],field:()=>[3,-2,.5]});
    const d=prepareStreamlineDomain({...raw,method});
    closeVector(sampleStreamlineVector(d,[0,1,0]).vector,[3,-2,.5],1e-9);
    const line=trace([raw],0,{method});
    assert.equal(line.error,undefined);assert.equal(line.method,method);
    assert.ok(Array.isArray(line.fallbacks));
    if(dims.includes(2))assert.ok(line.fallbacks.length>0,"the reported method must include the reason for a reduced-order grid");
    assert.ok(xyz(line).every(p=>p.every(Number.isFinite)));
    for(const path of line.paths)assert.ok(path.magnitudes.every(m=>Math.abs(m-Math.hypot(3,-2,.5))<1e-9));
  }
});

test("higher-order methods stop on the first boundary exit even when the analytic curve reenters later",()=>{
  // y=x^3-.75*x: the positive seed at x=-.5 reaches y=0 at x=0,
  // then stays outside until x=sqrt(.75). A later return cannot bridge that gap.
  for(const method of ["quadratic","tricubic"]) {
    const raw=grid({dims:[6,4,3],lo:[-1,0,0],hi:[1,2,1],field:x=>[1,3*x*x-.75,0]});
    const line=trace([raw],(1*4)*3+1,{method,tolerance:1e-6});
    assert.equal(line.error,undefined);assert.ok(line.reasons.includes("boundary"));
    closeVector(line.start,[-.5,.25,.5]);
    closeVector(Array.from(line.paths.at(-1).positions.slice(-3)),[0,0,.5],2e-5);
    assert.ok(xyz(line).every(p=>p[0]<=2e-5&&p[1]>=-1e-7));
  }
});

test("higher-order zero fields retain the zero termination reason",()=>{
  for(const method of ["quadratic","tricubic"]) {
    const line=trace([grid({dims:[5,5,5],field:()=>[0,0,0]})],0,{method});
    assert.equal(line.error,undefined);assert.deepEqual(line.reasons,["zero"]);assert.equal(line.paths.length,0);
  }
});


test("a zero on the physical face terminates without inventing a seam crossing",()=>{
  const a=grid({dims:[8,1,1],lo:[0,0,0],hi:[1,1,1],field:x=>[1-x,0,0]});
  const b=grid({key:"b",dims:[4,1,1],lo:[1,0,0],hi:[2,1,1]});
  const line=trace([a,b],4,{method:"trilinear-boundary",tolerance:1e-6});
  assert.equal(line.error,undefined);assert.ok(line.reasons.includes("zero"));
  assert.ok(line.paths.every(path=>path.key==="a"));
  closeVector(Array.from(line.paths.at(-1).positions.slice(-3)),[1,.5,.5],1e-6);
  assert.ok(xyz(line).every(p=>p.every(Number.isFinite)&&p[0]<=1));
});

test("all four methods are compared on the same nonpolynomial data and converge with mesh refinement",()=>{
  const primitive=x=>.15*Math.sin(2*x)+.04*x*x*x;
  const errors=new Map();
  for(const n of [9,17]) {
    const raw=grid({dims:[n,16,1],lo:[-1,-2,0],hi:[1,2,1],
      field:x=>[1,.3*Math.cos(2*x)+.12*x*x,0]});
    const node=((n-1)/2)*16+7;
    const current={};
    for(const method of ["trilinear","trilinear-boundary","quadratic","tricubic"]) {
      const line=trace([raw],node,{method,tolerance:1e-6});
      closeVector(line.start,[0,-.125,.5]);
      assert.deepEqual(line.reasons,["boundary"]);
      let maximum=0;
      for(const point of xyz(line)) {
        const exact=line.start[1]+primitive(point[0])-primitive(line.start[0]);
        maximum=Math.max(maximum,Math.abs(point[1]-exact));
      }
      current[method]=maximum;
      assert.ok(maximum<1e-2,`unresolved trajectory for ${method}`);
      if(errors.has(method))assert.ok(maximum<errors.get(method)*.6,
        `refining the saved grid must reduce the error for ${method}`);
      errors.set(method,maximum);
    }
    // These inequalities belong to this analytic test, not to a universal
    // guarantee for high-order reconstruction of arbitrary saved data.
    assert.ok(current.quadratic<current.trilinear);
    assert.ok(current.tricubic<current.quadratic);
  }
});
