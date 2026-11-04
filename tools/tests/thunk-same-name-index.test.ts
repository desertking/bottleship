import {describe,it,expect,spyOn,afterEach} from 'bun:test';
import {ThunkDispatcher} from '../../src/worker/core/thunking/thunk-dispatcher';
import {ThunkGenerator} from '../../src/worker/core/thunking/thunk-generator';

// Frozen reference from pre-index dispatcher SHA d73a1599c731298d0e131e16892b9c37300e3d4b0539391f243ae0e8828e50f8.
// Deliberately does NOT read the candidate source, transform it, or use a loader.
// Reference registration/log sinks are no-ops; compare real binding metadata.
const hypercallDataManager={registerFunction(..._args:unknown[]){}};
const Logger={info(..._args:unknown[]){}};
const LogCategory={THUNK:0};
function reference(this:any,functionId:number):any {
        const stub = this.thunkGenerator.getStubById(functionId);
        if (!stub) return null;

        const dllLower = stub.dllName.toLowerCase();
        const funcName = stub.functionName;

        const allStubs = this.thunkGenerator.getAllStubs();
        for (const s of allStubs) {
            if (s.functionId === functionId) continue;
            if (s.dllName.toLowerCase() !== dllLower || s.functionName !== funcName) continue;

            const existingImpl = this.dispatchTable[s.functionId];
            if (existingImpl) {
                this.dispatchTable[functionId] = existingImpl;
                this.argCountsTable[functionId] = this.argCountsTable[s.functionId];
                if (this.stackCleanupTable[s.functionId] >= 0) {
                    this.stackCleanupTable[functionId] = this.stackCleanupTable[s.functionId];
                }
                this.namesTable[functionId] = `${stub.dllName}:${funcName}`;

                const fp = this.fastPathTable[s.functionId];
                if (fp) this.fastPathTable[functionId] = fp;
                if (this.trivialFastPathTable[s.functionId]) {
                    this.trivialFastPathTable[functionId] = 1;
                }

                hypercallDataManager.registerFunction(stub.dllName, funcName, functionId);

                Logger.info(LogCategory.THUNK,
                    `Same-name lookup: ${stub.dllName}:${funcName} id ${functionId} < id ${s.functionId}`);
                return existingImpl;
            }
        }
        return null;
}
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanups.splice(0))f()});
const noop=()=>0;
function fresh(){const g=new ThunkGenerator();return {g,d:new ThunkDispatcher({add_listener(){}} as any,g) as any}}
function add(g:ThunkGenerator,path:number,dll:string,name:string,args=2){
 if(path===0){g.generateStubDll(dll,[{name,argCount:args}]);return g.getAllStubs().at(-1)!}
 const out=path===1?g.allocateOneStub(dll,name,args):g.allocateStubAt(0x400000+g.getAllStubs().length*32,dll,name,args);
 return g.getStubByAddress(out.address)!;
}
function snapshot(d:any,id:number){return [d.dispatchTable[id],d.argCountsTable[id],d.stackCleanupTable[id],d.namesTable[id],d.fastPathTable[id],d.trivialFastPathTable[id]]}
function compare(d:any,id:number){
 const fields=['dispatchTable','argCountsTable','stackCleanupTable','namesTable','fastPathTable','trivialFastPathTable'];
 const ref={thunkGenerator:d.thunkGenerator};for(const field of fields)(ref as any)[field]=d[field].slice();
 const expected=reference.call(ref,id);const actual=d._trySameNameLookup(id);
 expect(actual).toBe(expected);expect(snapshot(d,id)).toEqual(snapshot(ref,id));return actual;
}
describe('same-name index, frozen original semantics',()=>{
 it('does not overwrite optional target metadata when donor metadata is absent',()=>{
  const {g,d}=fresh();const donor=add(g,1,'x','Fn'),target=add(g,1,'x','Fn');
  d.dispatchTable[donor.functionId]=noop;d.stackCleanupTable[donor.functionId]=-1;
  d.stackCleanupTable[target.functionId]=28;d.fastPathTable[target.functionId]=noop;
  d.trivialFastPathTable[target.functionId]=1;
  expect(compare(d,target.functionId)).toBe(noop);
  expect(d.stackCleanupTable[target.functionId]).toBe(28);
 });
 for(const path of [0,1,2])it('indexes source insertion path '+path+' and copies all binding metadata',()=>{
  const {g,d}=fresh();const donor=add(g,path,'KeRnEl32','ExactFn',3),target=add(g,1,'kernel32','ExactFn',1);
  d.dispatchTable[donor.functionId]=noop;d.argCountsTable[donor.functionId]=3;d.stackCleanupTable[donor.functionId]=12;
  d.fastPathTable[donor.functionId]=noop;d.trivialFastPathTable[donor.functionId]=1;
  expect(compare(d,target.functionId)).toBe(noop);
 });
 it('keeps function case, decoration and DLL boundaries strict',()=>{
  const {g,d}=fresh();for(const [dll,name] of [['x','exact'],['other','Exact'],['x','_Exact@8'],['x','ExactA']]){
   const s=add(g,1,dll,name);d.dispatchTable[s.functionId]=noop;
  }
  const target=add(g,1,'x','Exact');expect(compare(d,target.functionId)).toBe(null);
 });
 it('preserves first implemented donor insertion order, skipping unimplemented entries',()=>{
  const {g,d}=fresh();add(g,1,'x','Fn');const a=add(g,2,'x','Fn'),b=add(g,1,'x','Fn'),target=add(g,1,'x','Fn');
  const first=()=>1,second=()=>2;d.dispatchTable[a.functionId]=first;d.dispatchTable[b.functionId]=second;
  expect(compare(d,target.functionId)).toBe(first);
 });
 it('excludes self and returns null for an unknown ID',()=>{
  const {g,d}=fresh();const target=add(g,1,'x','Fn');d.dispatchTable[target.functionId]=noop;
  expect(compare(d,target.functionId)).toBe(null);expect(compare(d,65500)).toBe(null);
 });
 it('sees a late regular registration immediately after a miss',()=>{
  const {g,d}=fresh();add(g,1,'x','Fn');const target=add(g,1,'x','Fn');
  expect(compare(d,target.functionId)).toBe(null);d.register('x','Fn',noop);
  expect(compare(d,target.functionId)).toBe(noop);
 });
 for(const path of [0,1,2])it('sees a new donor after miss through insertion path '+path,()=>{
  const {g,d}=fresh();const target=add(g,2,'x','Fn');expect(compare(d,target.functionId)).toBe(null);
  const donor=add(g,path,'x','Fn');d.dispatchTable[donor.functionId]=noop;expect(compare(d,target.functionId)).toBe(noop);
 });
 it('sees pending registration binding without an epoch or cache flush',()=>{
  const {g,d}=fresh();d.register('x','Fn',noop);add(g,1,'x','Fn');const target=add(g,1,'x','Fn');
  expect(compare(d,target.functionId)).toBe(null);d.applyPendingRegistrations();
  d.dispatchTable[target.functionId]=null;expect(compare(d,target.functionId)).toBe(noop);
 });
 it('reset clears index and dispatch table despite function ID reuse',()=>{
  const {g,d}=fresh();const donor=add(g,1,'x','Fn'),target=add(g,1,'x','Fn');d.dispatchTable[donor.functionId]=noop;
  expect(compare(d,target.functionId)).toBe(noop);
  // No scheduler/SEH runtime in this fixture; exercise real table/index reset.
  d._clearSehTransientRanges=()=>{};d.reset();g.reset();
  const next=add(g,2,'different','Fn');expect(next.functionId).toBe(donor.functionId);
  expect(compare(d,next.functionId)).toBe(null);expect(g.findStubsByName('x','Fn')).toEqual([]);
 });
 it('negative lookups never call getAllStubs, even repeatedly',()=>{
  const {g,d}=fresh();const target=add(g,1,'x','Missing');
  const spy=spyOn(g,'getAllStubs').mockImplementation(()=>{throw Error('Full scan forbidden')});cleanups.push(()=>spy.mockRestore());
  for(let i=0;i<100;i++)expect(d._trySameNameLookup(target.functionId)).toBe(null);
 });
});
