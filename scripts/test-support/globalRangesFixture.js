import { sourceRecords, expectedPointCount, QUANTITIES, MU0 } from '../../src/services/results/resultMappings.js';
import { resultRangeChannels } from '../../src/services/results/resultRanges.js';

export function globalRangesTask() {
  const base = { dp: [[2], [2], [2]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0, model: 0, vkan: [0,0,0] };
  const elements = [
    { ...base, id: 1, recordIndex: 0, name: 'Сталь 1', targ: 0, rv: 1, xapName: 'steel' },
    { ...base, id: 2, recordIndex: 1, name: 'Катушка', targ: 2, xapName: '' },
    { ...base, id: 3, recordIndex: 2, name: 'Виртуальный', targ: 3, indAmp: 3, xapName: '' },
    { ...base, id: 4, recordIndex: 3, name: 'Сталь 4', targ: 0, rv: 1, xapName: 'steel' },
  ];
  const task = { general: { countTimeSteps: 2, timeStep: .1 }, elements,
    regions: [1,2].map((id, i) => ({ id, recordIndex: i, name: 'Площадка '+id, dp: [[2],[2]], symLs: 1 })), metadata: {} };
  for (const name of ['MH','JE','HS','AS','HV','AV','Q']) {
    const records = sourceRecords(task,name), channels = resultRangeChannels(name);
    const numbs = records.map(record => expectedPointCount(record,name));
    let offset = 1;
    const header = { columns: name==='Q'?1:3, arrCount: ['MH','JE'].includes(name)?2:1, hasCoo: true,
      numbs, inds1: numbs.map(n => { const first=offset; offset+=n; return first; }) };
    header.stride = 3 + header.columns*header.arrCount;
    const ranges = { available:true,state:'complete',runId:'minmax-fixture',revision:3,
      objectIds:records.map(record=>record.id), channelIds:channels.map(c=>c.id),channelUnits:channels.map(c=>c.unit),
      stepIds:[0,1,2],times:[0,.1,.2],minimum:[],maximum:[],validCount:[],invalidCount:[] };
    for (const [i, record] of records.entries()) for (const channel of channels) {
      const [key, component] = channel.id.split('.');
      const solved = !['H','E','MHdot','JEdot','Q'].includes(key) || record.targ===0;
      const factor = key==='As'||key==='Av'?MU0:1;
      const n = component==='norm';
      // Distinct norms, deliberately unrelated exact signed products.
      const amplitude = (i+1) * (['H','E'].includes(key)?2:1);
      ranges.minimum.push(!solved?NaN: component==='value'?-999 : (n?5:-3)*amplitude*factor);
      ranges.maximum.push(!solved?NaN: component==='value'?-111 : (n?50:30)*amplitude*factor);
      ranges.validCount.push(solved?numbs[i]*3:0); ranges.invalidCount.push(0);
    }
    task.metadata[name] = { header, ranges, steps: [0,1,2].map(index=>({index,key:String(index).padStart(6,'0')})) };
  }
  task.reader = { read: async ({name, step, start, count}) => {
    const header=task.metadata[name].header;
    return {stride:header.stride,start,count,every:1,values:new Float64Array(Array.from({length:count},(_,i)=>{
      const row=start+i;
      const xyz=[row%2, Math.floor(row/2)%2,Math.floor(row/4)*2];
      return [...xyz, ...(name==='Q'?[step-1]: [3*(step+1),4*(step+1),0]),
        ...(header.arrCount===2?[-6*(step+1),-8*(step+1),0]:[])];
    }).flat())};
  } };
  return task;
}
