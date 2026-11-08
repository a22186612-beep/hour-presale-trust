const solc=require('solc'),fs=require('fs'),path=require('path');
const src={};for(const f of ['HourToken.sol','HourTrust.sol','MockUSDC.sol'])src[f]={content:fs.readFileSync('contracts/'+f,'utf8')};
const input={language:'Solidity',sources:src,settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const out=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>{try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch(e){return{error:'nf '+p}}}}));
let bad=false;for(const e of out.errors||[]){console.log(e.severity,e.formattedMessage);if(e.severity==='error')bad=true}
if(bad)process.exit(1);
const art={};for(const f in out.contracts)for(const c in out.contracts[f])art[c]={abi:out.contracts[f][c].abi,bytecode:'0x'+out.contracts[f][c].evm.bytecode.object};
fs.writeFileSync('test/artifacts.json',JSON.stringify(art));console.log('compiled',Object.keys(art).map(k=>k+':'+(art[k].bytecode.length/2-1)+'B'));
