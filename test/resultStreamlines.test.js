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
