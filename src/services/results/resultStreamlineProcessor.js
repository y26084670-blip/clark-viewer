export function createResultStreamlineProcessor({workerFactory=()=>new Worker(
  new URL("../../workers/resultStreamline.worker.js",import.meta.url),{type:"module"})}={}) {
  let worker=null,pending=null,sequence=0,closed=false;
  function release(error) {
    if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();worker=null;}
    const job=pending;pending=null;job?.reject(error);
  }
  return {
    process(input) {
      if(closed)return Promise.reject(new DOMException("Расчёт линий закрыт","AbortError"));
      if(pending)return Promise.reject(new Error("Предыдущие линии ещё рассчитываются"));
      return new Promise((resolve,reject)=>{
        try {
          if(!worker) {
            worker=workerFactory();
            worker.onmessage=({data})=>{
              if(!pending||data.id!==pending.id)return;
              const job=pending;pending=null;
              if(data.error)job.reject(new Error(data.error));else job.resolve(data.result);
            };
            worker.onerror=e=>release(new Error(e.message||"Ошибка расчёта линии"));
            worker.onmessageerror=()=>release(new Error("Ошибка передачи линии"));
          }
          const id=++sequence;pending={id,resolve,reject};
          worker.postMessage({id,input},input.domains.flatMap(d=>[d.positions.buffer,d.vectors.buffer]));
        } catch(e){release(e);reject(e);}
      });
    },
    close(){closed=true;release(new DOMException("Расчёт линий отменён","AbortError"));},
  };
}
