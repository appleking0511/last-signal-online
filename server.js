const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const rooms = new Map();
let cardUid = 1;

const CARDS = {
  weak:{name:'약공격',type:'attack',rarity:'common',text:'다음 생존자에게 3 피해',damage:3},
  strong:{name:'강공격',type:'attack',rarity:'common',text:'다음 생존자에게 5 피해',damage:5},
  trade:{name:'등가교환',type:'attack',rarity:'common',text:'대상 6 피해 · 자신 3 피해',damage:6,selfDamage:3},
  counter:{name:'반격',type:'attack',rarity:'common',text:'공격을 막고 피해 +3 전달',counter:true},
  allin:{name:'이판사판 공격',type:'attack',rarity:'rare',text:'10 피해 · 완전 방어 시 반동',damage:10,allin:true},
  pierce:{name:'관통 공격',type:'attack',rarity:'rare',text:'일반 방어를 무시하는 4 피해',damage:4,pierce:true},
  block3:{name:'적당한 방어',type:'defense',rarity:'common',text:'들어온 피해 3 감소',block:3},
  block5:{name:'괜찮은 방어',type:'defense',rarity:'common',text:'들어온 피해 5 감소',block:5},
  full:{name:'완전한 방어',type:'defense',rarity:'rare',text:'공격 피해 완전 무효',full:true},
  thorn:{name:'가시 돋친 방어',type:'defense',rarity:'rare',text:'공격 반사 · 실패 시 5 자해',reflect:true},
  rainbow:{name:'무지개 방어',type:'defense',rarity:'legendary',text:'모든 형태의 공격 무효',rainbow:true},
  supply:{name:'보급',type:'production',rarity:'common',text:'카드 2장 획득'},
  heal:{name:'응급 치료',type:'production',rarity:'common',text:'HP 3 회복'},
  forge:{name:'무기 제작',type:'production',rarity:'common',text:'다음 공격 피해 +2'},
  shield:{name:'방패 제작',type:'production',rarity:'common',text:'다음 수치 방어량 +2'},
  stock:{name:'자원 축적',type:'production',rarity:'common',text:'다음 라운드 카드 3장'},
  recycle:{name:'재활용',type:'production',rarity:'common',text:'버린 일반 카드 1장 회수'},
  factory:{name:'군수공장',type:'production',rarity:'rare',text:'3라운드 동안 추가 보급'},
  scout:{name:'정찰',type:'intel',rarity:'common',text:'무작위 상대 손패 1장 확인'},
  intercept:{name:'감청',type:'intel',rarity:'common',text:'시작 플레이어 선택 확인'},
  predict:{name:'예측',type:'intel',rarity:'common',text:'다음 사건 카드 확인'},
  hack:{name:'해킹',type:'intel',rarity:'common',text:'상대 일반 카드 1장 폐기'},
  wiretap:{name:'도청',type:'intel',rarity:'common',text:'공격 제출자 확인'},
  bluff:{name:'심리전',type:'intel',rarity:'common',text:'가짜 카드 신호 전송'},
  foresight:{name:'미래예지',type:'intel',rarity:'rare',text:'모든 제출 카드 미리 확인'}
};
const POOLS = {
  attack:{common:['weak','weak','strong','trade','counter'],rare:['allin','pierce']},
  defense:{common:['block3','block3','block5'],rare:['full','thorn'],legendary:['rainbow']},
  production:{common:['supply','heal','forge','shield','stock','recycle'],rare:['factory']},
  intel:{common:['scout','intercept','predict','hack','wiretap','bluff'],rare:['foresight']}
};
const EVENTS = [
  {id:'mass',name:'대량 보급',icon:'📦',text:'모든 생존자가 카드 1장을 뽑습니다.'},
  {id:'peace',name:'평화 협정',icon:'☮',text:'이번 라운드 모든 공격 피해가 절반입니다.'},
  {id:'medical',name:'의료 지원',icon:'✚',text:'모든 생존자가 HP 2를 회복합니다.'},
  {id:'arms',name:'무기 보급',icon:'⚔',text:'이번 라운드 모든 공격 피해 +2.'},
  {id:'fortify',name:'방어 공사',icon:'⬡',text:'이번 라운드 수치형 방어량 +2.'},
  {id:'energy',name:'에너지 충전',icon:'ϟ',text:'다음 라운드 시작 시 모두 카드 1장 획득.'},
  {id:'market',name:'시장 개방',icon:'↻',text:'카드 1장을 버리고 2장을 뽑습니다.'},
  {id:'emergency',name:'비상사태',icon:'!',text:'모든 플레이어가 반드시 카드를 제출합니다.'},
  {id:'drought',name:'자원 고갈',icon:'∅',text:'이번 라운드에는 카드를 뽑을 수 없습니다.'},
  {id:'race',name:'군비 경쟁',icon:'🔥',text:'공격 +3, 수치형 방어 +1.'}
];
const OPENING_EVENT={id:'opening',name:'공격 개시',icon:'⚔',text:'첫 라운드는 공격 카드로 시작합니다. 시작 플레이어부터 시계방향으로 공개합니다.'};

const pick = a => a[Math.floor(Math.random()*a.length)];
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function token(){return crypto.randomBytes(18).toString('hex')}
function roomCode(){let code;do{code=String(Math.floor(100000+Math.random()*900000))}while(rooms.has(code));return code}
function makeCard(id){return {id,uid:cardUid++,...CARDS[id]}}
function makePlayer(name,index){return {id:token(),name:String(name||'플레이어').trim().slice(0,10),seat:index,ready:false,connected:true,hp:20,alive:true,hand:[],discard:[],choice:null,choiceUsed:false,buffs:{weapon:0,shield:0,stock:0,factory:0},intel:[]}}
function alive(room){return room.players.filter(p=>p.alive)}
function ordered(room){const out=[];for(let i=0;i<room.players.length;i++){const p=room.players[(room.startIndex+i)%room.players.length];if(p.alive)out.push(p)}return out}
function nextAlive(room,p){let i=room.players.indexOf(p);do{i=(i+1)%room.players.length}while(!room.players[i].alive);return room.players[i]}
function addLog(room,text,kind='normal'){room.logs.unshift({id:token().slice(0,8),text,kind,at:Date.now()});room.logs=room.logs.slice(0,80)}
function addEffect(room,type,actor,target,card,text=''){
  room.fxSeq=(room.fxSeq||0)+1;room.effects.push({seq:room.fxSeq,type,actorId:actor?.id||null,targetId:target?.id||null,card:publicCard(card),text});room.effects=room.effects.slice(-30);
}
function draw(room,p,forcedType=null,starter=false){
  let type=forcedType||pick(['attack','attack','attack','defense','defense','defense','production','production','intel']);
  let rarity='common';if(!starter){const r=Math.random();rarity=r<.01?'legendary':r<.16?'rare':'common'}
  if(rarity==='legendary')type='defense';
  let pool=POOLS[type][rarity]||POOLS[type].common;
  if(rarity==='legendary'&&p.hand.some(c=>c.id==='rainbow'))pool=POOLS[type].rare;
  const c=makeCard(pick(pool));p.hand.push(c);return c;
}
function initialHand(room,p){for(const type of ['attack','defense','production','intel']){draw(room,p,type,true);draw(room,p,type,true)}shuffle(p.hand);const attackIndex=p.hand.findIndex(c=>c.type==='attack');if(attackIndex>0)[p.hand[0],p.hand[attackIndex]]=[p.hand[attackIndex],p.hand[0]]}
function eventCard(room){if(!room.eventDeck.length)room.eventDeck=shuffle([...EVENTS]);return room.eventDeck.shift()}
function heal(room,p,n){if(!p.alive)return;const was=p.hp;p.hp=Math.min(25,p.hp+n);if(p.hp>was)addLog(room,`${p.name} HP ${p.hp-was} 회복`,'good')}
function hurt(room,p,n,source){if(!p.alive||n<=0)return;p.hp=Math.max(0,p.hp-n);addLog(room,`${p.name} ${n} 피해 · ${source}`,'hit');if(p.hp===0){p.alive=false;p.choice=null;addLog(room,`${p.name} 탈락`,'death')}}
function consume(p,c){const i=p.hand.findIndex(x=>x.uid===c.uid);if(i>=0)p.discard.push(p.hand.splice(i,1)[0]);p.choiceUsed=true}
function publicCard(c){return c?{id:c.id,uid:c.uid,name:c.name,type:c.type,rarity:c.rarity,text:c.text}:null}

function createRoom(name){
  const code=roomCode(),host=makePlayer(name,0);
  const room={code,hostId:host.id,createdAt:Date.now(),updatedAt:Date.now(),status:'lobby',phase:'lobby',players:[host],clients:new Map(),logs:[],effects:[],fxSeq:0,round:0,startIndex:0,event:null,eventDeck:shuffle([...EVENTS]),revealIndex:0,revealCurrentId:null,deadline:null,timer:null,nextEnergy:false,winner:null};
  rooms.set(code,room);return {room,player:host};
}
function joinRoom(code,name){const room=rooms.get(code);if(!room)throw Error('존재하지 않는 방입니다.');if(room.status!=='lobby')throw Error('이미 게임이 시작된 방입니다.');if(room.players.length>=8)throw Error('방이 가득 찼습니다.');const p=makePlayer(name,room.players.length);room.players.push(p);addLog(room,`${p.name} 입장`,'system');broadcast(room);return {room,player:p}}
function auth(body){const room=rooms.get(String(body.code||''));if(!room)throw Error('방을 찾을 수 없습니다.');const player=room.players.find(p=>p.id===body.token);if(!player)throw Error('접속 정보가 올바르지 않습니다.');return {room,player}}

function view(room,me){
  const fullyRevealed=['result','finished'].includes(room.phase),revealedIds=new Set(room.phase==='reveal'?ordered(room).slice(0,room.revealIndex).map(p=>p.id):[]);
  const visibleChoice=p=>fullyRevealed||revealedIds.has(p.id)||(room.phase==='select'&&p.id===me.id);
  return {
    code:room.code,status:room.status,phase:room.phase,round:room.round,deadline:room.deadline,event:room.event,winner:room.winner,revealIndex:room.revealIndex,revealCurrentId:room.revealCurrentId,
    hostId:room.hostId,meId:me.id,startPlayerId:room.players[room.startIndex]?.id,
    players:room.players.map(p=>({id:p.id,name:p.name,seat:p.seat,ready:p.ready,connected:p.connected,hp:p.hp,alive:p.alive,handCount:p.hand.length,buffs:p.buffs,submitted:!!p.choice,choice:p.choice?(visibleChoice(p)?{kind:p.choice.kind,card:publicCard(p.choice.card)}:{kind:'hidden'}):null})),
    hand:me.hand.map(publicCard),intel:me.intel.slice(0,4),logs:room.logs.slice(0,30),effects:room.effects.slice(-30)
  };
}
function sendSse(res,data){res.write(`data: ${JSON.stringify(data)}\n\n`)}
function broadcast(room){room.updatedAt=Date.now();for(const [playerId,res] of room.clients){const p=room.players.find(x=>x.id===playerId);if(p)sendSse(res,view(room,p))}}

function deleteRoom(room){
  clearTimeout(room.timer);room.status='deleted';room.phase='deleted';room.deadline=null;
  addLog(room,'방장이 방을 삭제했습니다.','system');broadcast(room);
  setTimeout(()=>{for(const res of room.clients.values())res.end();room.clients.clear();rooms.delete(room.code)},800);
}

function startGame(room){
  if(room.players.length<2)throw Error('최소 2명이 필요합니다.');if(!room.players.every(p=>p.ready))throw Error('모든 플레이어가 준비해야 합니다.');
  room.status='playing';room.players.forEach(p=>{p.hp=20;p.alive=true;p.hand=[];p.discard=[];p.choice=null;p.buffs={weapon:0,shield:0,stock:0,factory:0};initialHand(room,p)});room.startIndex=Math.floor(Math.random()*room.players.length);addLog(room,'게임 시작 · 마지막 생존자를 결정합니다.','system');beginRound(room);
}
function applyEvent(room){
  const id=room.event.id;
  if(id==='mass')alive(room).forEach(p=>draw(room,p));
  if(id==='medical')alive(room).forEach(p=>heal(room,p,2));
  if(id==='energy')room.nextEnergy=true;
  if(id==='market')alive(room).forEach(p=>{if(p.hand.length)p.discard.push(p.hand.splice(Math.floor(Math.random()*p.hand.length),1)[0]);draw(room,p);draw(room,p)});
}
function beginRound(room){
  clearTimeout(room.timer);if(checkWinner(room))return;
  room.round++;room.phase='select';room.event=room.round===1?OPENING_EVENT:eventCard(room);room.revealIndex=0;room.revealCurrentId=null;room.effects=[];room.deadline=Date.now()+30000;
  for(const p of alive(room)){p.choice=null;p.choiceUsed=false;if(p.buffs.stock){for(let i=0;i<p.buffs.stock;i++)draw(room,p);p.buffs.stock=0}if(p.buffs.factory>0){draw(room,p);p.buffs.factory--}if(room.nextEnergy)draw(room,p)}room.nextEnergy=false;
  applyEvent(room);addLog(room,`ROUND ${room.round} · ${room.event.name}`,'system');broadcast(room);
  room.timer=setTimeout(()=>forceSelections(room),30200);
}
function forceSelections(room){
  if(room.phase!=='select')return;
  for(const p of alive(room)){if(p.choice)continue;if(room.event.id==='emergency'||room.event.id==='drought'||p.hand.length>=12){const c=pick(p.hand);p.choice=c?{kind:'card',card:c}:{kind:'draw'}}else p.choice={kind:'draw'}}beginReveal(room);
}
function submit(room,p,kind,uid){
  if(room.phase!=='select')throw Error('지금은 카드를 선택할 수 없습니다.');if(!p.alive)throw Error('탈락한 플레이어입니다.');if(p.choice)throw Error('이미 선택을 확정했습니다.');
  if(kind==='draw'){if(room.event.id==='emergency')throw Error('비상사태에는 카드를 제출해야 합니다.');if(room.event.id==='drought')throw Error('자원 고갈로 카드를 뽑을 수 없습니다.');if(p.hand.length>=12)throw Error('손패가 가득 찼습니다.');p.choice={kind:'draw'};}
  else {const c=p.hand.find(x=>x.uid===Number(uid));if(!c)throw Error('손패에 없는 카드입니다.');p.choice={kind:'card',card:c}}
  addLog(room,`${p.name} 선택 완료`,'quiet');broadcast(room);if(alive(room).every(x=>x.choice))beginReveal(room);
}
function beginReveal(room){
  if(room.phase!=='select')return;clearTimeout(room.timer);room.phase='reveal';room.revealIndex=0;room.revealCurrentId=null;room.deadline=Date.now()+650+ordered(room).length*1050+800;broadcast(room);room.timer=setTimeout(()=>revealNext(room),650)
}
function revealNext(room){
  if(room.phase!=='reveal')return;const order=ordered(room);
  if(room.revealIndex>=order.length){room.revealCurrentId=null;room.deadline=Date.now()+800;broadcast(room);room.timer=setTimeout(()=>resolveRound(room),800);return}
  const player=order[room.revealIndex];room.revealCurrentId=player.id;room.revealIndex++;addLog(room,`${player.name} 카드 공개`,'reveal');broadcast(room);room.timer=setTimeout(()=>revealNext(room),1050)
}
function attackBonus(room){return room.event.id==='arms'?2:room.event.id==='race'?3:0}
function defenseBonus(room){return room.event.id==='fortify'?2:room.event.id==='race'?1:0}
function damageValue(room,p,c){let n=c.damage||0;if(p.buffs.weapon){n+=2;p.buffs.weapon--}n+=attackBonus(room);if(room.event.id==='peace')n=Math.ceil(n/2);return n}
function attack(room,attacker,target,packet,depth=0){
  if(!attacker.alive||!target.alive)return;const tc=target.choice?.kind==='card'?target.choice.card:null;
  if(tc&&!target.choiceUsed&&tc.type==='attack'&&!tc.counter){addEffect(room,'clash',target,attacker,tc,'공격 충돌');hurt(room,target,packet.damage,packet.name);consume(target,tc);addLog(room,`${target.name}의 공격 카드 충돌로 무효`);return}
  if(tc&&!target.choiceUsed&&tc.counter&&!packet.noCounter){addEffect(room,'counter',target,nextAlive(room,target),tc,'반격');consume(target,tc);if(depth>=2){hurt(room,target,packet.damage,'반격 한도 초과');return}const next=nextAlive(room,target);addLog(room,`${target.name} 반격 · ${packet.damage+3} 피해 전달`,'good');attack(room,target,next,{damage:packet.damage+3,name:'반격'},depth+1);return}
  if(tc&&!target.choiceUsed&&tc.type==='defense'){
    addEffect(room,tc.reflect?'reflect':'defense',target,attacker,tc,tc.name);consume(target,tc);
    if(tc.rainbow||tc.full){addLog(room,`${target.name} ${tc.name} · 공격 무효`,'good');if(packet.allin)hurt(room,attacker,10,'이판사판 반동');return}
    if(tc.reflect&&!packet.noReflect){addLog(room,`${target.name} 가시 방어 · ${packet.damage} 반사`,'good');hurt(room,attacker,packet.damage,'가시 반사');return}
    if(packet.pierce){hurt(room,target,packet.damage,packet.name+' 관통');return}
    let block=(tc.block||0)+defenseBonus(room);if(target.buffs.shield&&tc.block){block+=2;target.buffs.shield--}const left=Math.max(0,packet.damage-block);addLog(room,`${target.name} ${block} 방어 · ${left} 피해 통과`,'good');if(left)hurt(room,target,left,packet.name);else if(packet.allin)hurt(room,attacker,10,'이판사판 반동');return;
  }
  hurt(room,target,packet.damage,packet.name);
}
function utility(room,p,c){
  const others=alive(room).filter(x=>x!==p);
  addEffect(room,c.type==='intel'?'intel':'production',p,null,c,c.name);
  if(c.id==='supply'){draw(room,p);draw(room,p);addLog(room,`${p.name} 카드 2장 보급`,'good')}
  else if(c.id==='heal')heal(room,p,3);
  else if(c.id==='forge'){p.buffs.weapon=Math.min(2,p.buffs.weapon+1);addLog(room,`${p.name} 무기 강화 준비`,'good')}
  else if(c.id==='shield'){p.buffs.shield=Math.min(2,p.buffs.shield+1);addLog(room,`${p.name} 방패 강화 준비`,'good')}
  else if(c.id==='stock'){p.buffs.stock=3;addLog(room,`${p.name} 카드 3장 예약`,'good')}
  else if(c.id==='factory'){p.buffs.factory=3;addLog(room,`${p.name} 군수공장 가동`,'good')}
  else if(c.id==='recycle'){const i=p.discard.findIndex(x=>x.rarity==='common');if(i>=0)p.hand.push(p.discard.splice(i,1)[0])}
  else if(c.id==='scout'&&others.length){const t=pick(others),seen=pick(t.hand);intel(p,`${t.name} 손패: ${seen?.name||'없음'}`)}
  else if(c.id==='intercept'){const t=room.players[room.startIndex];intel(p,`감청: ${t.name} — ${t.choice?.kind==='draw'?'카드 뽑기':t.choice?.card?.name}`)}
  else if(c.id==='predict')intel(p,`다음 사건: ${room.eventDeck[0]?.name||'사건 덱 재구성'}`);
  else if(c.id==='hack'){const valid=others.filter(x=>x.hand.length>4&&x.hand.some(c=>c.rarity==='common'));if(valid.length){const t=pick(valid),c=pick(t.hand.filter(x=>x.rarity==='common')),i=t.hand.indexOf(c);t.discard.push(t.hand.splice(i,1)[0]);addLog(room,`${p.name} 해킹 · ${t.name} 카드 폐기`)}}
  else if(c.id==='wiretap')intel(p,`공격 신호: ${alive(room).filter(x=>x.choice?.card?.type==='attack').map(x=>x.name).join(', ')||'없음'}`);
  else if(c.id==='bluff')addLog(room,`${p.name} 가짜 카드 신호 전송`);
  else if(c.id==='foresight')intel(p,alive(room).map(x=>`${x.name}:${x.choice?.kind==='draw'?'뽑기':x.choice?.card?.name}`).join(' · '));
}
function intel(p,text){p.intel.unshift(text);p.intel=p.intel.slice(0,6)}
function resolveRound(room){
  if(room.phase!=='reveal')return;
  for(const p of ordered(room)){
    if(!p.alive||!p.choice||p.choiceUsed)continue;
    if(p.choice.kind==='draw'){addEffect(room,'draw',p,null,null,'카드 뽑기');if(room.event.id!=='drought'){draw(room,p);addLog(room,`${p.name} 카드 1장 획득`)}p.choiceUsed=true;continue}
    const c=p.choice.card;
    if(c.type==='attack'&&!c.counter){const target=nextAlive(room,p),amount=damageValue(room,p,c);addEffect(room,'attack',p,target,c,c.name);consume(p,c);addLog(room,`${p.name} ${c.name} → ${target.name}`,'hit');if(c.selfDamage)hurt(room,p,c.selfDamage,'등가교환 대가');if(p.alive)attack(room,p,target,{damage:amount,name:c.name,pierce:c.pierce,allin:c.allin})}
    else if(c.type==='defense'||c.counter){addEffect(room,c.counter?'counter':'defense',p,null,c,'대상 없음');consume(p,c);if(c.reflect)hurt(room,p,5,'가시 방어 실패');else addLog(room,`${p.name} ${c.name} · 막을 공격 없음`)}
    else {consume(p,c);utility(room,p,c)}
    if(checkWinner(room))return;
  }
  for(const p of alive(room))while(p.hand.length>12)p.discard.push(p.hand.pop());
  room.startIndex=room.players.indexOf(nextAlive(room,room.players[room.startIndex]));room.phase='result';room.revealCurrentId=null;const resultDuration=Math.max(6000,room.effects.length*850+1400);room.deadline=Date.now()+resultDuration;broadcast(room);room.timer=setTimeout(()=>beginRound(room),resultDuration);
}
function checkWinner(room){const survivors=alive(room);if(survivors.length>1)return false;clearTimeout(room.timer);room.status='finished';room.phase='finished';room.winner=survivors[0]?{id:survivors[0].id,name:survivors[0].name}:null;room.deadline=null;addLog(room,room.winner?`${room.winner.name} 최종 승리`:'공동 탈락','system');broadcast(room);return true}

function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body)}
function readBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>1e6)req.destroy()});req.on('end',()=>{try{resolve(data?JSON.parse(data):{})}catch(e){reject(Error('잘못된 요청입니다.'))}});req.on('error',reject)})}
async function api(req,res,url){
  try{
    if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,service:'last-signal-online'});
    if(req.method==='POST'&&url.pathname==='/api/room/create'){const b=await readBody(req),x=createRoom(b.name);return json(res,200,{code:x.room.code,token:x.player.id})}
    if(req.method==='POST'&&url.pathname==='/api/room/join'){const b=await readBody(req),x=joinRoom(String(b.code||''),b.name);return json(res,200,{code:x.room.code,token:x.player.id})}
    if(req.method==='POST'&&url.pathname==='/api/ready'){const b=await readBody(req),{room,player}=auth(b);if(room.status!=='lobby')throw Error('대기실 단계가 아닙니다.');player.ready=!player.ready;broadcast(room);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/start'){const b=await readBody(req),{room,player}=auth(b);if(room.hostId!==player.id)throw Error('방장만 시작할 수 있습니다.');startGame(room);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/room/delete'){const b=await readBody(req),{room,player}=auth(b);if(room.hostId!==player.id)throw Error('방장만 방을 삭제할 수 있습니다.');deleteRoom(room);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/state'){const b=await readBody(req),{room,player}=auth(b);return json(res,200,view(room,player))}
    if(req.method==='POST'&&url.pathname==='/api/select'){const b=await readBody(req),{room,player}=auth(b);submit(room,player,b.kind,b.uid);return json(res,200,{ok:true})}
    if(req.method==='GET'&&url.pathname==='/api/events'){
      const room=rooms.get(url.searchParams.get('code')),id=url.searchParams.get('token'),player=room?.players.find(p=>p.id===id);if(!room||!player)return json(res,401,{error:'접속 정보가 만료되었습니다.'});
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});player.connected=true;room.clients.set(id,res);sendSse(res,view(room,player));broadcast(room);
      const ping=setInterval(()=>res.write(': ping\n\n'),20000);req.on('close',()=>{clearInterval(ping);room.clients.delete(id);player.connected=false;setTimeout(()=>broadcast(room),100)});return;
    }
    return json(res,404,{error:'없는 API입니다.'});
  }catch(e){return json(res,400,{error:e.message||'요청을 처리하지 못했습니다.'})}
}
function staticFile(req,res,url){
  let requested=url.pathname==='/'?'/online.html':url.pathname;const safe=path.normalize(requested).replace(/^(\.\.[/\\])+/, '');const file=path.join(ROOT,safe);
  if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return json(res,404,{error:'파일을 찾을 수 없습니다.'});
  const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-store':'public, max-age=3600'});fs.createReadStream(file).pipe(res);
}
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))api(req,res,url);else staticFile(req,res,url)});
server.listen(PORT,'0.0.0.0',()=>console.log(`LAST SIGNAL online server: http://localhost:${PORT}`));

setInterval(()=>{const cutoff=Date.now()-6*60*60*1000;for(const [code,room] of rooms)if(room.updatedAt<cutoff){clearTimeout(room.timer);rooms.delete(code)}},30*60*1000).unref();
