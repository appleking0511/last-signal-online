const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const rooms = new Map();
let cardUid = 1;
const DEFAULT_SETTINGS=Object.freeze({mode:'survival',roundLimit:10,turnSeconds:30,startHp:20,startItems:2});

function normalizeSettings(value={}){
  const allowedRounds=[3,5,10,15,20],allowedTimes=[15,20,30,45,60],allowedHp=[15,20,25],allowedItems=[0,1,2,3];
  return {mode:value.mode==='rounds'?'rounds':'survival',roundLimit:allowedRounds.includes(Number(value.roundLimit))?Number(value.roundLimit):DEFAULT_SETTINGS.roundLimit,turnSeconds:allowedTimes.includes(Number(value.turnSeconds))?Number(value.turnSeconds):DEFAULT_SETTINGS.turnSeconds,startHp:allowedHp.includes(Number(value.startHp))?Number(value.startHp):DEFAULT_SETTINGS.startHp,startItems:allowedItems.includes(Number(value.startItems))?Number(value.startItems):DEFAULT_SETTINGS.startItems};
}

// Optional Supabase persistence. Keep the secret key on the server only.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PERSISTENCE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);
const persistenceQueues = new Map();
const roomLoadPromises = new Map();

function databaseHeaders(extra={}){
  return {apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,'content-type':'application/json',...extra};
}
async function databaseRequest(resource,options={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/${resource}`,{...options,headers:databaseHeaders(options.headers),signal:controller.signal});
    if(!response.ok){const detail=await response.text();throw Error(`Supabase ${response.status}: ${detail.slice(0,300)}`)}
    if(response.status===204)return null;const text=await response.text();return text?JSON.parse(text):null;
  }finally{clearTimeout(timeout)}
}
function serializableRoom(room){
  const {clients,timer,...state}=room;
  return {...state,players:state.players.map(p=>({...p,connected:false}))};
}
function queuePersistence(code,work){
  if(!PERSISTENCE_ENABLED)return Promise.resolve();
  const previous=persistenceQueues.get(code)||Promise.resolve();
  const task=previous.catch(()=>{}).then(work);
  persistenceQueues.set(code,task);
  task.then(()=>{if(persistenceQueues.get(code)===task)persistenceQueues.delete(code)},error=>{
    if(persistenceQueues.get(code)===task)persistenceQueues.delete(code);
    console.error(`[persistence] ${code}:`,error.message);
  });
  return task;
}
function persistRoom(room){
  if(!PERSISTENCE_ENABLED||room.status==='deleted')return Promise.resolve();
  const code=room.code,state=serializableRoom(room),updated_at=new Date().toISOString();
  return queuePersistence(code,()=>databaseRequest('game_rooms?on_conflict=code',{
    method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:JSON.stringify({code,state,updated_at})
  }));
}
function removePersistedRoom(code){
  return queuePersistence(code,()=>databaseRequest(`game_rooms?code=eq.${encodeURIComponent(code)}`,{method:'DELETE'}));
}
function refreshCardUid(room){
  let max=0;const scan=c=>{if(c&&Number.isFinite(Number(c.uid)))max=Math.max(max,Number(c.uid))};
  for(const p of room.players||[]){for(const c of p.hand||[])scan(c);for(const c of p.discard||[])scan(c);scan(p.choice?.card)}
  scan(room.event);scan(room.nextPresented);for(const packet of Object.values(room.pendingAttacks||{}))scan(packet?.card);
  cardUid=Math.max(cardUid,max+1);
}
function resumeRoomTimer(room){
  clearTimeout(room.timer);room.timer=null;
  if(room.status!=='playing')return;
  const delay=Math.max(50,(Number(room.deadline)||Date.now())-Date.now()+200);
  if(room.phase==='turn'){const current=room.players.find(p=>p.id===room.currentPlayerId&&p.alive);room.timer=setTimeout(()=>current?.isBot?runBotTurn(room,current):forceTurn(room),current?.isBot?Math.min(delay,900):delay)}
  else if(room.phase==='turn_result')room.timer=setTimeout(()=>advanceTurn(room),delay);
  else room.timer=setTimeout(()=>recoverContinuousTurn(room),50);
}
async function loadPersistedRoom(code){
  if(!PERSISTENCE_ENABLED)return null;
  const rows=await databaseRequest(`game_rooms?code=eq.${encodeURIComponent(code)}&select=state&limit=1`);
  const state=rows?.[0]?.state;if(!state||state.status==='deleted')return null;
  const room={...state,code:String(state.code||code),clients:new Map(),timer:null};
  room.players=(room.players||[]).map(p=>({...p,isBot:!!p.isBot,connected:!!p.isBot}));room.effects=room.effects||[];room.logs=room.logs||[];room.pendingAttacks=room.pendingAttacks||{};
  if(Number(room.rulesVersion||0)<3){for(const [playerId,packet] of Object.entries(room.pendingAttacks))if(packet?.attackerId==='presented')delete room.pendingAttacks[playerId];room.event=null;room.nextPresented=null;room.presentedDeck=[];room.rulesVersion=3;room.turnNumber=Math.max(1,Number(room.turnNumber)||Number(room.round||0)*Math.max(1,room.players.length)+Number(room.turnCursor||0)+1);if(!['turn','turn_result'].includes(room.phase)){room.phase='turn';room.currentPlayerId=room.players[room.startIndex]?.id||room.players.find(p=>p.alive)?.id;const current=room.players.find(p=>p.id===room.currentPlayerId);if(current){current.choice=null;current.choiceUsed=false}room.revealCurrentId=null;room.deadline=Date.now()+30000}}
  if(Number(room.rulesVersion||0)<4){room.rulesVersion=4;for(const p of room.players)migratePlayerItems(room,p)}else for(const p of room.players){p.buffs={...blankBuffs(),...(p.buffs||{})};p.items=Array.isArray(p.items)?p.items:[];p.itemUsedThisTurn=!!p.itemUsedThisTurn}
  if(Number(room.rulesVersion||0)<5){room.rulesVersion=5;for(const p of room.players)p.turnsTaken=0}else for(const p of room.players)p.turnsTaken=Math.max(0,Number(p.turnsTaken)||0);
  if(Number(room.rulesVersion||0)<6)room.rulesVersion=6;for(const p of room.players)if(p.isBot){p.ready=true;p.connected=true}
  if(Number(room.rulesVersion||0)<8){room.rulesVersion=8;for(const p of room.players){p.hand=(p.hand||[]).map(refreshCardRules);p.discard=(p.discard||[]).map(refreshCardRules);if(p.choice?.card)p.choice.card=p.hand.find(c=>c.uid===p.choice.card.uid)||refreshCardRules(p.choice.card)}for(const packet of Object.values(room.pendingAttacks||{}))if(packet?.card)packet.card=refreshCardRules(packet.card)}room.direction=room.direction===-1?-1:1;room.eliminationOrder=Array.isArray(room.eliminationOrder)?room.eliminationOrder:room.players.filter(p=>!p.alive).map(p=>p.id);room.ranking=Array.isArray(room.ranking)?room.ranking:[];if(room.status==='finished'&&!room.ranking.length)buildRanking(room);
  if(Number(room.rulesVersion||0)<9)room.rulesVersion=9;room.settings=normalizeSettings(room.settings);room.roundState=room.roundState&&typeof room.roundState==='object'?room.roundState:null;room.winners=Array.isArray(room.winners)?room.winners:room.winner?[room.winner]:[];room.endReason=room.endReason||null;
  refreshCardUid(room);rooms.set(code,room);resumeRoomTimer(room);return room;
}
async function getRoom(code){
  code=String(code||'');if(rooms.has(code))return rooms.get(code);if(!PERSISTENCE_ENABLED)return null;
  if(!roomLoadPromises.has(code)){
    const loading=loadPersistedRoom(code).finally(()=>roomLoadPromises.delete(code));roomLoadPromises.set(code,loading);
  }
  return roomLoadPromises.get(code);
}

const CARDS = {
  weak:{name:'약공격',type:'attack',rarity:'common',text:'다음 생존자에게 3 피해',damage:3},
  strong:{name:'강공격',type:'attack',rarity:'common',text:'다음 생존자에게 5 피해',damage:5},
  trade:{name:'등가교환',type:'attack',rarity:'common',text:'대상 6 피해 · 자신 3 피해',damage:6,selfDamage:3},
  counter:{name:'반격',type:'attack',rarity:'common',text:'공격을 막고 피해 +3 전달',counter:true},
  allin:{name:'이판사판 공격',type:'attack',rarity:'rare',text:'10 피해 · 완전 방어 시 반동',damage:10,allin:true},
  pierce:{name:'관통 공격',type:'attack',rarity:'rare',text:'일반 방어를 무시하는 4 피해',damage:4,pierce:true},
  guided:{name:'유도탄',type:'attack',rarity:'rare',text:'원하는 생존자에게 4 피해 · 대상 차례에 대응',damage:4,chooseTarget:true},
  doom:{name:'멸망의 노래',type:'attack',rarity:'legendary',text:'막지 못하면 3턴간 저주 · 저주 중 공격을 받으면 즉사',damage:0,doom:true},
  roulette:{name:'러시안 룰렛',type:'attack',rarity:'legendary',text:'동전 앞면: 자신 10 고정 피해 · 뒷면: 다음 생존자 10 고정 피해',roulette:true},
  block3:{name:'적당한 방어',type:'defense',rarity:'common',text:'80% 확률로 들어온 피해 3 감소',block:3,defenseChance:80},
  block5:{name:'괜찮은 방어',type:'defense',rarity:'common',text:'80% 확률로 들어온 피해 5 감소',block:5,defenseChance:80},
  full:{name:'완전한 방어',type:'defense',rarity:'rare',text:'80% 확률로 공격 피해 완전 무효',full:true,defenseChance:80},
  thorn:{name:'가시 돋친 방어',type:'defense',rarity:'rare',text:'공격 반사 · 실패 시 5 자해',reflect:true},
  rainbow:{name:'무지개 방어',type:'defense',rarity:'legendary',text:'모든 형태의 공격 무효',rainbow:true},
  lastDefense:{name:'최후의 방어',type:'defense',rarity:'legendary',text:'HP 5 이하에서만 사용 · 공격자를 즉시 탈락',lastDefense:true},
  supply:{name:'보급',type:'production',rarity:'common',text:'카드 2장 획득'},
  heal:{name:'응급 치료',type:'production',rarity:'common',text:'HP 3 회복'},
  forge:{name:'무기 제작',type:'production',rarity:'common',text:'다음 공격 피해 +2'},
  shield:{name:'방패 제작',type:'production',rarity:'common',text:'다음 수치 방어량 +2'},
  stock:{name:'자원 축적',type:'production',rarity:'common',text:'다음 자신의 차례에 카드 3장'},
  recycle:{name:'재활용',type:'production',rarity:'common',text:'버린 일반 카드 1장 회수'},
  factory:{name:'군수공장',type:'production',rarity:'rare',text:'다음 3번의 자신의 차례마다 카드 1장'},
  blockade:{name:'봉쇄',type:'production',rarity:'rare',text:'현재 진행 방향의 다음 생존자 차례를 1회 건너뜀'},
  reverse:{name:'역전',type:'production',rarity:'rare',text:'턴과 공격의 진행 방향을 반대로 전환'},
};
const POOLS = {
  attack:{common:['weak','weak','strong','trade','counter'],rare:['allin','pierce','guided','guided'],legendary:['doom','roulette']},
  defense:{common:['block3','block3','block5'],rare:['full','thorn'],legendary:['rainbow','lastDefense']},
  production:{common:['supply','heal','forge','shield','stock','recycle'],rare:['factory','blockade','reverse']}
};
const ITEMS = {
  swap:{name:'등가교환',text:'선택한 상대와 손패 전체를 교환',target:true},
  reveal:{name:'넌 내 손 안에 있어',text:'선택한 상대의 손패를 모두 확인',target:true},
  scramble:{name:'해킹',text:'선택한 상대의 손패를 같은 수의 무작위 카드로 교체',target:true},
  warrior:{name:'긍지 높은 전사',text:'다음 공격 피해 +2',target:false},
  poison:{name:'독화살',text:'선택한 상대의 다음 차례 행동 확정 시 2 피해',target:true},
  weakness:{name:'약점 간파',text:'선택한 상대가 다음 공격을 방어할 수 없음',target:true},
  tax:{name:'원천징수',text:'선택한 상대에게서 무작위 카드 최대 2장 강탈',target:true},
  cleanse:{name:'정화제',text:'자신에게 적용된 독화살과 약점 간파 제거',target:false},
  shift:{name:'전술 교대',text:'선택한 상대와 자리를 바꿔 턴 순서와 공격 방향 변경',target:true},
  evade:{name:'완전회피',text:'들어온 공격 또는 다음 공격을 완전히 무효화',target:false,legendary:true}
};
const NORMAL_ITEM_IDS=['swap','reveal','scramble','warrior','poison','weakness','tax','cleanse','shift'];
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
const PRESENTED_ATTACK_POOL=['weak','weak','weak','strong','strong','pierce'];
const PRESENTED_ATTACKER={id:'presented',name:'제시 공격',alive:true,system:true};

const pick = a => a[Math.floor(Math.random()*a.length)];
const DRAW_TYPE_POOL=['attack','attack','attack','attack','attack','defense','defense','production','production'];
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function token(){return crypto.randomBytes(18).toString('hex')}
function roomCode(){let code;do{code=String(Math.floor(100000+Math.random()*900000))}while(rooms.has(code));return code}
function makeCard(id){return {id,uid:cardUid++,...CARDS[id]}}
function refreshCardRules(card){return card?.id&&CARDS[card.id]?{...card,...CARDS[card.id],id:card.id,uid:card.uid}:card}
function makeItem(id){return {id,uid:token().slice(0,12),...ITEMS[id]}}
function randomItem(){return makeItem(Math.random()<.01?'evade':pick(NORMAL_ITEM_IDS))}
function publicItem(item){return item?{id:item.id,uid:item.uid,name:item.name,text:item.text,target:!!item.target,legendary:!!item.legendary}:null}
function blankBuffs(){return {weapon:0,shield:0,stock:0,factory:0,itemAttack:0,poison:0,poisonSourceId:null,weakness:0,fullEvade:0,doomTurns:0,doomFresh:false,doomSourceId:null,skipTurns:0}}
function makePlayer(name,index,isBot=false){return {id:token(),name:String(name||'플레이어').trim().slice(0,10),seat:index,isBot:!!isBot,ready:!!isBot,connected:true,hp:20,alive:true,hand:[],discard:[],items:[],itemUsedThisTurn:false,turnsTaken:0,choice:null,choiceUsed:false,buffs:blankBuffs(),intel:[]}}
function replacementCard(old){const type=pick(DRAW_TYPE_POOL),id=pick(POOLS[type].common);return {...makeCard(id),uid:old?.uid||cardUid++}}
function migratePlayerItems(room,p){
  p.isBot=!!p.isBot;if(p.isBot){p.ready=true;p.connected=true}p.buffs={...blankBuffs(),...(p.buffs||{})};p.items=Array.isArray(p.items)?p.items:[];p.itemUsedThisTurn=!!p.itemUsedThisTurn;p.intel=Array.isArray(p.intel)?p.intel:[];
  const convert=c=>c?.type==='intel'?replacementCard(c):c;p.hand=(p.hand||[]).map(convert);p.discard=(p.discard||[]).map(convert);
  if(p.choice?.card?.type==='intel')p.choice.card=p.hand.find(c=>c.uid===p.choice.card.uid)||replacementCard(p.choice.card);
  if(room.status==='playing')while(p.items.length<2)p.items.push(randomItem());
}
function alive(room){return room.players.filter(p=>p.alive)}
function ordered(room){const out=[],step=room.direction===-1?-1:1;for(let i=0;i<room.players.length;i++){const index=(room.startIndex+step*i+room.players.length)%room.players.length,p=room.players[index];if(p.alive)out.push(p)}return out}
function nextAlive(room,p){let i=room.players.indexOf(p),step=room.direction===-1?-1:1;do{i=(i+step+room.players.length)%room.players.length}while(!room.players[i].alive);return room.players[i]}
function addLog(room,text,kind='normal'){room.logs.unshift({id:token().slice(0,8),text,kind,at:Date.now()});room.logs=room.logs.slice(0,80)}
function addEffect(room,type,actor,target,card,text=''){
  room.fxSeq=(room.fxSeq||0)+1;room.effects.push({seq:room.fxSeq,type,actorId:actor?.id||null,targetId:target?.id||null,card:publicCard(card),text,at:Date.now()});room.effects=room.effects.slice(-30);
}
function legendaryGain(room,p,card,source='획득'){
  if(card?.rarity!=='legendary')return;addEffect(room,'legendary_gain',p,p,card,`${card.name} · 전설 카드 ${source}`);addLog(room,`${p.name} 전설 카드 획득 · ${card.name}`,'good');
}
function draw(room,p,forcedType=null,starter=false){
  let type=forcedType||pick(DRAW_TYPE_POOL);
  let rarity='common';if(!starter){const r=Math.random();rarity=r<.01?'legendary':r<.16?'rare':'common'}
  if(rarity==='legendary')type=pick(['attack','defense']);
  let pool=POOLS[type][rarity]||POOLS[type].common;
  if(rarity==='legendary'){const available=pool.filter(id=>!p.hand.some(c=>c.id===id));pool=available.length?available:POOLS[type].rare}
  const c=makeCard(pick(pool));p.hand.push(c);if(!starter)legendaryGain(room,p,c);return c;
}
function initialHand(room,p){for(const type of ['attack','attack','attack','attack','defense','defense','production','production'])draw(room,p,type,true);shuffle(p.hand)}
function eventCard(room){if(!room.eventDeck.length)room.eventDeck=shuffle([...EVENTS]);return room.eventDeck.shift()}
function presentedAttack(room){if(!room.presentedDeck.length)room.presentedDeck=shuffle([...PRESENTED_ATTACK_POOL]);const c=makeCard(room.presentedDeck.shift());return {...c,icon:'⚔',text:`제시 공격 · ${c.text}`}}
function nextPresentedAttack(room){if(!room.nextPresented)room.nextPresented=presentedAttack(room);return room.nextPresented}
function heal(room,p,n){if(!p.alive)return;const was=p.hp;p.hp=Math.min(25,p.hp+n);if(p.hp>was)addLog(room,`${p.name} HP ${p.hp-was} 회복`,'good')}
function hurt(room,p,n,source){if(!p.alive||n<=0)return;p.hp=Math.max(0,p.hp-n);addLog(room,`${p.name} ${n} 피해 · ${source}`,'hit');if(p.hp===0){p.alive=false;p.choice=null;p.buffs.doomTurns=0;p.buffs.doomFresh=false;p.buffs.doomSourceId=null;delete room.pendingAttacks[p.id];room.eliminationOrder=room.eliminationOrder||[];if(!room.eliminationOrder.includes(p.id))room.eliminationOrder.push(p.id);addEffect(room,'elimination',p,p,null,`${p.name} 탈락`);addLog(room,`${p.name} 탈락`,'death')}}
function consume(p,c){const i=p.hand.findIndex(x=>x.uid===c.uid);if(i>=0)p.discard.push(p.hand.splice(i,1)[0]);p.choiceUsed=true}
function publicCard(c){return c?{id:c.id,uid:c.uid,name:c.name,type:c.type,rarity:c.rarity,text:c.text,chooseTarget:!!c.chooseTarget}:null}

function createRoom(name){
  const code=roomCode(),host=makePlayer(name,0);
  const room={code,hostId:host.id,createdAt:Date.now(),updatedAt:Date.now(),rulesVersion:9,status:'lobby',phase:'lobby',players:[host],clients:new Map(),logs:[],effects:[],fxSeq:0,round:0,turnNumber:0,startIndex:0,direction:1,event:null,eventDeck:shuffle([...EVENTS]),presentedDeck:[],nextPresented:null,revealIndex:0,revealCurrentId:null,currentPlayerId:null,turnOrder:[],turnCursor:0,pendingAttacks:{},eliminationOrder:[],ranking:[],deadline:null,timer:null,nextEnergy:false,winner:null,winners:[],endReason:null,settings:normalizeSettings(),roundState:null};
  rooms.set(code,room);persistRoom(room);return {room,player:host};
}
async function joinRoom(code,name){const room=await getRoom(code);if(!room)throw Error('존재하지 않는 방입니다.');if(room.status!=='lobby')throw Error('이미 게임이 시작된 방입니다.');if(room.players.length>=8)throw Error('방이 가득 찼습니다.');const p=makePlayer(name,room.players.length);room.players.push(p);addLog(room,`${p.name} 입장`,'system');broadcast(room);return {room,player:p}}
function setBotCount(room,host,count){
  if(room.status!=='lobby')throw Error('대기실에서만 AI를 변경할 수 있습니다.');if(room.hostId!==host.id)throw Error('방장만 AI를 추가할 수 있습니다.');
  const humans=room.players.filter(p=>!p.isBot),wanted=Math.floor(Number(count));if(!Number.isFinite(wanted)||wanted<0||wanted>8-humans.length)throw Error(`AI는 0명부터 ${8-humans.length}명까지 추가할 수 있습니다.`);
  let bots=room.players.filter(p=>p.isBot);
  while(bots.length<wanted){let number=1;const names=new Set(room.players.map(p=>p.name));while(names.has(`AI ${number}`))number++;const bot=makePlayer(`AI ${number}`,room.players.length,true);room.players.push(bot);bots.push(bot);addLog(room,`${bot.name} 참가`,'system')}
  while(bots.length>wanted){const bot=bots.pop(),index=room.players.indexOf(bot);if(index>=0)room.players.splice(index,1);addLog(room,`${bot.name} 퇴장`,'system')}
  room.players.forEach((p,index)=>p.seat=index);broadcast(room);
}
function updateSettings(room,host,value){
  if(room.status!=='lobby')throw Error('게임 시작 전 대기실에서만 설정할 수 있습니다.');if(room.hostId!==host.id)throw Error('방장만 세부 설정을 변경할 수 있습니다.');
  room.settings=normalizeSettings(value);for(const p of room.players)if(!p.isBot)p.ready=false;
  addLog(room,`방 설정 변경 · ${room.settings.mode==='rounds'?`${room.settings.roundLimit}라운드 모드`:'최후 생존 모드'} · 제한 ${room.settings.turnSeconds}초`,'system');broadcast(room);
}
async function auth(body){const room=await getRoom(String(body.code||''));if(!room)throw Error('방을 찾을 수 없습니다.');const player=room.players.find(p=>p.id===body.token);if(!player)throw Error('접속 정보가 올바르지 않습니다.');return {room,player}}

function view(room,me){
  const fullyRevealed=['turn','turn_result','result','finished'].includes(room.phase),revealedIds=new Set(room.phase==='reveal'?ordered(room).slice(0,room.revealIndex).map(p=>p.id):[]);
  const visibleChoice=p=>fullyRevealed||revealedIds.has(p.id)||(room.phase==='select'&&p.id===me.id);
  return {
    code:room.code,status:room.status,phase:room.phase,turnNumber:room.turnNumber||0,direction:room.direction===-1?-1:1,deadline:room.deadline,event:room.event,winner:room.winner,winners:room.winners||[],endReason:room.endReason||null,ranking:room.ranking||[],settings:normalizeSettings(room.settings),roundState:room.roundState||null,revealIndex:room.revealIndex,revealCurrentId:room.revealCurrentId,currentPlayerId:room.currentPlayerId,currentIncoming:room.currentPlayerId&&room.pendingAttacks?.[room.currentPlayerId]?room.pendingAttacks[room.currentPlayerId]:null,
    hostId:room.hostId,meId:me.id,startPlayerId:room.players[room.startIndex]?.id,
    players:room.players.map(p=>({id:p.id,name:p.name,seat:p.seat,isBot:!!p.isBot,ready:p.ready,connected:p.connected,hp:p.hp,alive:p.alive,handCount:p.hand.length,itemCount:p.items?.length||0,legendaryCount:p.hand.filter(c=>c.rarity==='legendary').length,turnsTaken:p.turnsTaken||0,pendingAttack:!!room.pendingAttacks?.[p.id],buffs:p.buffs,submitted:!!p.choice,choice:p.choice?(visibleChoice(p)?{kind:p.choice.kind,card:publicCard(p.choice.card)}:{kind:'hidden'}):null})),
    hand:me.hand.map(publicCard),items:(me.items||[]).map(publicItem),itemUsedThisTurn:!!me.itemUsedThisTurn,intel:me.intel.slice(0,6),logs:room.logs.slice(0,30),effects:room.effects.slice(-30)
  };
}
function sendSse(res,data){res.write(`data: ${JSON.stringify(data)}\n\n`)}
function broadcast(room){room.updatedAt=Date.now();for(const [playerId,res] of room.clients){const p=room.players.find(x=>x.id===playerId);if(p)sendSse(res,view(room,p))}persistRoom(room)}

function deleteRoom(room){
  clearTimeout(room.timer);room.status='deleted';room.phase='deleted';room.deadline=null;
  addLog(room,'방장이 방을 삭제했습니다.','system');broadcast(room);
  setTimeout(()=>{for(const res of room.clients.values())res.end();room.clients.clear();rooms.delete(room.code);removePersistedRoom(room.code)},800);
}

function startGame(room){
  if(room.players.length<2)throw Error('최소 2명이 필요합니다.');if(!room.players.every(p=>p.ready))throw Error('모든 플레이어가 준비해야 합니다.');
  const settings=room.settings=normalizeSettings(room.settings);room.status='playing';room.round=settings.mode==='rounds'?1:0;room.turnNumber=0;room.direction=1;room.pendingAttacks={};room.eliminationOrder=[];room.ranking=[];room.winner=null;room.winners=[];room.endReason=null;room.currentPlayerId=null;room.players.forEach(p=>{if(p.isBot){p.ready=true;p.connected=true}p.hp=settings.startHp;p.alive=true;p.hand=[];p.discard=[];p.items=[];for(let i=0;i<settings.startItems;i++)p.items.push(randomItem());p.itemUsedThisTurn=false;p.turnsTaken=0;p.choice=null;p.choiceUsed=false;p.buffs=blankBuffs();p.intel=[];initialHand(room,p)});room.roundState=settings.mode==='rounds'?{number:1,participants:room.players.map(p=>p.id),completed:[]}:null;room.startIndex=crypto.randomInt(room.players.length);const starter=room.players[room.startIndex];addLog(room,`게임 시작 · ${starter.name}이 무작위 시작자로 선정되었습니다. · ${settings.mode==='rounds'?`${settings.roundLimit}라운드 모드`:'최후 생존 모드'}`,'system');beginContinuousTurn(room,starter,true);
}
function applyEvent(room){
  const id=room.event.id;
  if(id==='mass')alive(room).forEach(p=>draw(room,p));
  if(id==='medical')alive(room).forEach(p=>heal(room,p,2));
  if(id==='energy')room.nextEnergy=true;
  if(id==='market')alive(room).forEach(p=>{if(p.hand.length)p.discard.push(p.hand.splice(Math.floor(Math.random()*p.hand.length),1)[0]);draw(room,p);draw(room,p)});
}
function beginContinuousTurn(room,p,initial=false){
  clearTimeout(room.timer);if(room.status!=='playing'||checkWinner(room))return;if(!p?.alive)p=alive(room)[0];
  room.phase='turn';room.event=null;room.currentPlayerId=p.id;room.revealCurrentId=null;room.turnNumber=(room.turnNumber||0)+1;p.choice=null;p.choiceUsed=false;p.itemUsedThisTurn=false;
  if(p.buffs.fullEvade&&room.pendingAttacks[p.id]){const incoming=room.pendingAttacks[p.id];delete room.pendingAttacks[p.id];p.buffs.fullEvade=0;addEffect(room,'defense',p,p,ITEMS.evade,'완전회피');addLog(room,`${p.name} 완전회피 · ${incoming.name} 무효`,'good')}
  const doomIncoming=room.pendingAttacks[p.id],doomAttacker=doomIncoming?incomingAttacker(room,doomIncoming):null;
  if(p.buffs.doomTurns>0&&doomIncoming&&doomAttacker?.alive){
    delete room.pendingAttacks[p.id];const source=doomAttacker.system?'누군가의 공격':`${doomAttacker.name}의 ${doomIncoming.name}`;
    addEffect(room,'doom_death',doomAttacker,p,doomIncoming.card,'멸망의 노래 · 즉사');addLog(room,`${p.name} 멸망의 노래 발동 · ${source}을 받아 즉시 탈락`,'death');hurt(room,p,Math.max(1,p.hp),'멸망의 노래');
    if(checkWinner(room))return;if(completeRoundTurn(room,p)==='finished')return;const next=nextAlive(room,p),delay=1800;room.phase='turn_result';room.deadline=Date.now()+delay;broadcast(room);room.timer=setTimeout(()=>beginContinuousTurn(room,next),delay);return
  }
  p.turnsTaken=(Number(p.turnsTaken)||0)+1;
  if(p.hand.length<12){draw(room,p);addEffect(room,'draw',p,p,null,'턴 시작 자동 수급');addLog(room,`${p.name} 턴 시작 · 카드 1장 자동 수급`,'good')}else addLog(room,`${p.name} 손패 최대 · 자동 카드 수급 보류`,'quiet');
  if(p.turnsTaken%2===0){p.items.push(randomItem());addEffect(room,'item_gain',p,p,null,'2턴 보상 아이템 획득');addLog(room,`${p.name} 개인 턴 2회 보상 · 아이템 1개 자동 수급`,'good')}
  if(p.buffs.stock){for(let i=0;i<p.buffs.stock;i++)draw(room,p);p.buffs.stock=0}if(p.buffs.factory>0){draw(room,p);p.buffs.factory--}if(room.nextEnergy){draw(room,p);room.nextEnergy=false}
  while(p.hand.length>12)p.discard.push(p.hand.pop());const turnDelay=p.isBot?crypto.randomInt(1300,2201):normalizeSettings(room.settings).turnSeconds*1000;room.deadline=Date.now()+turnDelay;const incoming=room.pendingAttacks[p.id];
  if(!initial)addLog(room,incoming?`TURN ${room.turnNumber} · ${p.name}이 ${incoming.name}에 대응합니다.`:`TURN ${room.turnNumber} · ${p.name}의 차례`,'system');broadcast(room);room.timer=setTimeout(()=>p.isBot?runBotTurn(room,p):forceTurn(room),turnDelay+150);
}
function recoverContinuousTurn(room){
  const current=room.players.find(p=>p.id===room.currentPlayerId&&p.alive)||room.players[room.startIndex]||alive(room)[0];beginContinuousTurn(room,current)
}
function forceTurn(room){
  if(room.phase!=='turn')return;const p=room.players.find(x=>x.id===room.currentPlayerId);if(!p||!p.alive){advanceTurn(room);return}
  if(p.hand.length>=12){const incoming=room.pendingAttacks[p.id],targets=alive(room).filter(x=>x!==p&&!room.pendingAttacks[x.id]),cards=p.hand.filter(c=>(!c.chooseTarget||targets.length)&&(!c.lastDefense||(incoming&&p.hp<=5&&!p.buffs.weakness))&&!(incoming&&p.buffs.weakness&&c.type==='defense')),c=pick(cards);p.choice=c?{kind:'card',card:c,targetId:c.chooseTarget?pick(targets)?.id:null}:{kind:'draw'}}else p.choice={kind:'draw'};addLog(room,`${p.name} 시간 종료 · 자동 선택`,'quiet');resolveSubmittedTurn(room,p);
}
function botItemPlan(room,p){
  if(p.itemUsedThisTurn||p.choice||!p.items?.length)return null;const incoming=room.pendingAttacks[p.id],targets=alive(room).filter(x=>x!==p);if(!targets.length)return null;
  let item=p.items.find(x=>x.id==='cleanse'&&(p.buffs.poison||p.buffs.weakness));if(item)return {item,target:null};
  item=p.items.find(x=>x.id==='evade'&&incoming);if(item)return {item,target:null};
  item=p.items.find(x=>x.id==='warrior'&&!incoming&&p.hand.some(c=>c.type==='attack'&&!c.counter));if(item&&Math.random()<.7)return {item,target:null};
  item=p.items.find(x=>x.id==='evade'&&!incoming&&p.hp<=8);if(item&&Math.random()<.65)return {item,target:null};
  if(Math.random()>.3)return null;const usable=p.items.filter(x=>x.id!=='cleanse'&&x.id!=='evade'&&(x.id!=='warrior'||!incoming));if(!usable.length)return null;item=pick(usable);
  let target=null;if(item.target){if(['tax','reveal','scramble','swap'].includes(item.id))target=[...targets].sort((a,b)=>b.hand.length-a.hand.length)[0];else if(['poison','weakness'].includes(item.id))target=[...targets].sort((a,b)=>a.hp-b.hp)[0];else target=pick(targets)}
  return {item,target};
}
function botCardPlan(room,p){
  const incoming=room.pendingAttacks[p.id],hand=p.hand||[];
  if(incoming){
    const counters=hand.filter(c=>c.counter),defenses=p.buffs.weakness?[]:hand.filter(c=>c.type==='defense'&&(!c.lastDefense||p.hp<=5));let card=null;
    if(incoming.doom)card=pick([...defenses,...counters]);
    else{const absolute=defenses.filter(c=>c.full||c.rainbow||c.reflect),enough=incoming.pierce?[]:defenses.filter(c=>(c.block||0)+(p.buffs.shield?2:0)>=incoming.damage);card=pick(absolute)||pick(enough)||pick(counters)||(incoming.pierce?null:pick(defenses))}
    if(card)return {kind:'card',card};
    const healCard=hand.find(c=>c.id==='heal'&&p.hp>incoming.damage);if(healCard)return {kind:'card',card:healCard};
    if(hand.length<12)return {kind:'draw'};const fallback=hand.find(c=>c.type==='production')||hand.find(c=>c.type==='attack')||hand[0];return {kind:'card',card:fallback};
  }
  const healCard=hand.find(c=>c.id==='heal'&&p.hp<=15);if(healCard)return {kind:'card',card:healCard};
  const targets=alive(room).filter(x=>x!==p&&!room.pendingAttacks[x.id]),next=nextAlive(room,p),attacks=hand.filter(c=>c.type==='attack'&&!c.counter&&(c.chooseTarget?targets.length:!room.pendingAttacks[next.id])),production=hand.filter(c=>c.type==='production');
  if(hand.length<12&&Math.random()<.24)return {kind:'draw'};let card;if(attacks.length&&(!production.length||Math.random()<.64))card=pick(attacks);else card=pick(production)||pick(attacks);
  if(!card){if(hand.length<12)return {kind:'draw'};card=hand.find(c=>c.id!=='thorn')||hand[0]}
  const targetId=card.chooseTarget?[...targets].sort((a,b)=>a.hp-b.hp)[0]?.id:null;return {kind:'card',card,targetId};
}
function finishBotTurn(room,p){
  if(room.status!=='playing'||room.phase!=='turn'||room.currentPlayerId!==p.id||!p.alive||p.choice)return;const plan=botCardPlan(room,p);
  try{if(plan.kind==='draw')submit(room,p,'draw');else submit(room,p,'card',plan.card.uid,plan.targetId)}catch(error){addLog(room,`${p.name} 판단 오류 · 자동 행동으로 전환`,'quiet');p.choice=null;forceTurn(room)}
}
function runBotTurn(room,p){
  if(room.status!=='playing'||room.phase!=='turn'||room.currentPlayerId!==p.id||!p.alive||p.choice)return;clearTimeout(room.timer);const plan=botItemPlan(room,p);
  if(plan){try{room.deadline=Date.now()+950;useItem(room,p,plan.item.uid,plan.target?.id||null);room.timer=setTimeout(()=>finishBotTurn(room,p),950);return}catch(error){addLog(room,`${p.name}이 아이템 사용을 취소했습니다.`,'quiet')}}
  finishBotTurn(room,p);
}
function submit(room,p,kind,uid,targetId){
  if(room.phase!=='turn')throw Error('지금은 카드를 선택할 수 없습니다.');if(room.currentPlayerId!==p.id)throw Error('아직 당신의 차례가 아닙니다.');if(!p.alive)throw Error('탈락한 플레이어입니다.');if(p.choice)throw Error('이미 선택을 확정했습니다.');
  if(kind==='draw'){if(p.hand.length>=12)throw Error('손패가 가득 찼습니다.');p.choice={kind:'draw'};}
  else {const c=p.hand.find(x=>x.uid===Number(uid));if(!c)throw Error('손패에 없는 카드입니다.');const incoming=room.pendingAttacks[p.id];if(incoming&&p.buffs.weakness&&c.type==='defense')throw Error('약점이 간파되어 이번 공격에는 방어 카드를 사용할 수 없습니다.');if(c.lastDefense&&(!incoming||p.hp>5))throw Error('최후의 방어는 HP가 5 이하이고 공격을 받고 있을 때만 사용할 수 있습니다.');let chosenTarget=null;if(c.chooseTarget&&!incoming){chosenTarget=room.players.find(x=>x.id===targetId&&x.alive&&x!==p);if(!chosenTarget)throw Error('유도탄을 발사할 상대를 선택하세요.');if(room.pendingAttacks[chosenTarget.id])throw Error('이미 공격을 기다리는 플레이어에게는 유도탄을 발사할 수 없습니다.')}p.choice={kind:'card',card:c,targetId:chosenTarget?.id||null}}
  addLog(room,`${p.name} 카드 제출`,'quiet');resolveSubmittedTurn(room,p);
}
function useItem(room,p,uid,targetId){
  if(room.phase!=='turn'||room.currentPlayerId!==p.id)throw Error('아이템은 자신의 차례에만 사용할 수 있습니다.');if(!p.alive)throw Error('탈락한 플레이어입니다.');if(p.choice)throw Error('카드를 선택하기 전에 아이템을 사용해야 합니다.');if(p.itemUsedThisTurn)throw Error('한 턴에는 아이템을 1개만 사용할 수 있습니다.');
  const index=(p.items||[]).findIndex(item=>item.uid===String(uid));if(index<0)throw Error('보유하지 않은 아이템입니다.');const item=p.items[index];let target=null;
  if(item.target){target=room.players.find(x=>x.id===targetId&&x.alive&&x!==p);if(!target)throw Error('유효한 상대를 선택하세요.')}
  if(item.id==='cleanse'&&!p.buffs.poison&&!p.buffs.weakness)throw Error('현재 제거할 독화살 또는 약점 간파 효과가 없습니다.');
  p.items.splice(index,1);p.itemUsedThisTurn=true;addEffect(room,'item',p,target,item,item.name);
  if(item.id==='swap'){const mine=p.hand,targetHand=target.hand,mineLegendary=new Set(mine.filter(c=>c.rarity==='legendary').map(c=>c.uid)),targetLegendary=new Set(targetHand.filter(c=>c.rarity==='legendary').map(c=>c.uid));p.hand=targetHand;target.hand=mine;for(const c of p.hand)if(c.rarity==='legendary'&&!mineLegendary.has(c.uid))legendaryGain(room,p,c,'교환');for(const c of target.hand)if(c.rarity==='legendary'&&!targetLegendary.has(c.uid))legendaryGain(room,target,c,'교환');addLog(room,`${p.name} 등가교환 · ${target.name}과 손패 전체 교환`,'good')}
  else if(item.id==='reveal'){intel(p,`${target.name} 전체 손패: ${target.hand.map(c=>c.name).join(', ')||'없음'}`);addLog(room,`${p.name}이 ${target.name}의 손패를 간파했습니다.`,'good')}
  else if(item.id==='scramble'){const count=target.hand.length;target.discard.push(...target.hand);target.hand=[];for(let i=0;i<count;i++)draw(room,target);addLog(room,`${p.name} 해킹 · ${target.name}의 카드 ${count}장 무작위 교체`,'good')}
  else if(item.id==='warrior'){p.buffs.itemAttack=(p.buffs.itemAttack||0)+2;addLog(room,`${p.name} 긍지 높은 전사 · 다음 공격 +2`,'good')}
  else if(item.id==='poison'){target.buffs.poison=2;target.buffs.poisonSourceId=p.id;addLog(room,`${p.name} 독화살 → ${target.name}`,'hit')}
  else if(item.id==='weakness'){target.buffs.weakness=1;addLog(room,`${p.name} 약점 간파 → ${target.name}`,'hit')}
  else if(item.id==='tax'){const count=Math.min(2,target.hand.length);for(let i=0;i<count;i++){const n=crypto.randomInt(target.hand.length),stolen=target.hand.splice(n,1)[0];p.hand.push(stolen);legendaryGain(room,p,stolen,'강탈')}addLog(room,`${p.name} 원천징수 · ${target.name}에게서 카드 ${count}장 강탈`,'good')}
  else if(item.id==='cleanse'){p.buffs.poison=0;p.buffs.poisonSourceId=null;p.buffs.weakness=0;addLog(room,`${p.name} 정화제 · 독화살과 약점 간파 제거`,'good')}
  else if(item.id==='shift'){const startId=room.players[room.startIndex]?.id,a=room.players.indexOf(p),b=room.players.indexOf(target);[room.players[a],room.players[b]]=[room.players[b],room.players[a]];room.players.forEach((x,i)=>x.seat=i);room.startIndex=Math.max(0,room.players.findIndex(x=>x.id===startId));addLog(room,`${p.name} 전술 교대 · ${target.name}과 자리 및 턴 순서 교환`,'good')}
  else if(item.id==='evade'){const incoming=room.pendingAttacks[p.id];if(incoming){delete room.pendingAttacks[p.id];addLog(room,`${p.name} 완전회피 · ${incoming.name} 즉시 무효`,'good')}else{p.buffs.fullEvade=1;addLog(room,`${p.name} 완전회피 준비 · 다음 공격 무효`,'good')}}
  broadcast(room);
}
function attackBonus(){return 0}
function defenseBonus(){return 0}
function damageValue(room,p,c){let n=c.damage||0;if(p.buffs.weapon){n+=2;p.buffs.weapon--}if(p.buffs.itemAttack){n+=p.buffs.itemAttack;p.buffs.itemAttack=0}return n}
function defenseSucceeds(card){return !card?.defenseChance||crypto.randomInt(100)<card.defenseChance}
function attack(room,attacker,target,packet,depth=0){
  if((!attacker||!attacker.alive)||!target.alive)return;const tc=target.choice?.kind==='card'?target.choice.card:null;
  if(tc&&!target.choiceUsed&&tc.type==='attack'&&!tc.counter){addEffect(room,'clash',target,target,tc,'공격 충돌 · 자신의 공격 무효');hurt(room,target,packet.damage,packet.name);consume(target,tc);addLog(room,`${target.name}의 공격 카드 충돌로 무효`);return}
  if(tc&&!target.choiceUsed&&tc.counter&&!packet.noCounter){addEffect(room,'counter',target,nextAlive(room,target),tc,'반격');consume(target,tc);if(depth>=2){hurt(room,target,packet.damage,'반격 한도 초과');return}const next=nextAlive(room,target);addLog(room,`${target.name} 반격 · ${packet.damage+3} 피해 전달`,'good');attack(room,target,next,{damage:packet.damage+3,name:'반격'},depth+1);return}
  if(tc&&!target.choiceUsed&&tc.type==='defense'){
    const success=defenseSucceeds(tc);addEffect(room,success?(tc.reflect?'reflect':'defense'):'defense_fail',target,success?attacker:target,tc,success?`${tc.name} · 방어 성공`:`${tc.name} · 방어 실패`);consume(target,tc);
    if(!success){addLog(room,`${target.name} ${tc.name} · 방어 실패`,'hit');hurt(room,target,packet.damage,packet.name);return}
    if(tc.rainbow||tc.full){addLog(room,`${target.name} ${tc.name} · 공격 무효`,'good');if(packet.allin&&!attacker.system)hurt(room,attacker,10,'이판사판 반동');return}
    if(tc.reflect&&!packet.noReflect){addLog(room,`${target.name} 가시 방어 · ${packet.damage} 반사`,'good');if(attacker.system)addLog(room,'제시 공격이 반사되어 소멸','good');else hurt(room,attacker,packet.damage,'가시 반사');return}
    if(packet.pierce){hurt(room,target,packet.damage,packet.name+' 관통');return}
    let block=(tc.block||0)+defenseBonus(room);if(target.buffs.shield&&tc.block){block+=2;target.buffs.shield--}const left=Math.max(0,packet.damage-block);addLog(room,`${target.name} ${block} 방어 · ${left} 피해 통과`,'good');if(left)hurt(room,target,left,packet.name);else if(packet.allin&&!attacker.system)hurt(room,attacker,10,'이판사판 반동');return;
  }
  hurt(room,target,packet.damage,packet.name);
}
function utility(room,p,c){
  let blockadeTarget=null;
  if(c.id==='blockade'){blockadeTarget=nextAlive(room,p);blockadeTarget.buffs.skipTurns=(blockadeTarget.buffs.skipTurns||0)+1;addEffect(room,'blockade',p,blockadeTarget,c,'다음 차례 봉쇄');addLog(room,`${p.name} 봉쇄 → ${blockadeTarget.name}의 다음 차례 건너뜀`,'good')}
  else if(c.id==='reverse'){room.direction=room.direction===-1?1:-1;addEffect(room,'reverse',p,p,c,room.direction===1?'시계방향 전환':'반시계방향 전환');addLog(room,`${p.name} 역전 · 진행 방향이 ${room.direction===1?'시계방향':'반시계방향'}으로 변경`,'system')}
  else addEffect(room,'production',p,null,c,c.name);
  if(c.id==='supply'){draw(room,p);draw(room,p);addLog(room,`${p.name} 카드 2장 보급`,'good')}
  else if(c.id==='heal')heal(room,p,3);
  else if(c.id==='forge'){p.buffs.weapon=Math.min(2,p.buffs.weapon+1);addLog(room,`${p.name} 무기 강화 준비`,'good')}
  else if(c.id==='shield'){p.buffs.shield=Math.min(2,p.buffs.shield+1);addLog(room,`${p.name} 방패 강화 준비`,'good')}
  else if(c.id==='stock'){p.buffs.stock=3;addLog(room,`${p.name} 카드 3장 예약`,'good')}
  else if(c.id==='factory'){p.buffs.factory=3;addLog(room,`${p.name} 군수공장 가동`,'good')}
  else if(c.id==='recycle'){const i=p.discard.findIndex(x=>x.rarity==='common');if(i>=0)p.hand.push(p.discard.splice(i,1)[0])}
}
function intel(p,text){p.intel.unshift(text);p.intel=p.intel.slice(0,6)}

function applyDoom(room,target,source,card){
  target.buffs.doomTurns=3;target.buffs.doomFresh=true;target.buffs.doomSourceId=source?.id||null;
  addEffect(room,'doom',source,target,card,'멸망의 노래 · 3턴');addLog(room,`${target.name} 멸망의 노래 저주 · 3턴 동안 공격을 받으면 즉시 탈락`,'death');
}
function queueAttack(room,attacker,target,packet,card){
  if(!target?.alive)return;room.pendingAttacks[target.id]={attackerId:attacker.id,damage:packet.damage,name:packet.name,pierce:!!packet.pierce,allin:!!packet.allin,doom:!!packet.doom,card:publicCard(card)};
}
function incomingAttacker(room,incoming){return incoming.attackerId==='presented'?PRESENTED_ATTACKER:room.players.find(p=>p.id===incoming.attackerId)}
function resolveSubmittedTurn(room,p){
  if(room.phase!=='turn'||room.currentPlayerId!==p.id||!p.choice)return;clearTimeout(room.timer);room.phase='turn_result';room.revealCurrentId=p.id;room.deadline=null;const effectsBefore=room.fxSeq||0;
  if(p.buffs.poison){const source=room.players.find(x=>x.id===p.buffs.poisonSourceId);p.buffs.poison=0;p.buffs.poisonSourceId=null;addEffect(room,'damage',source||p,p,null,'독화살 · 2 피해');hurt(room,p,2,'독화살');if(!p.alive){p.choice=null;if(checkWinner(room))return;const delay=1250;room.deadline=Date.now()+delay;broadcast(room);room.timer=setTimeout(()=>advanceTurn(room),delay);return}}
  let incoming=room.pendingAttacks[p.id]||null;delete room.pendingAttacks[p.id];const attacker=incoming?incomingAttacker(room,incoming):null;
  if(incoming&&(!attacker||!attacker.alive)){addLog(room,`${incoming.name} · 공격자가 탈락해 소멸`);incoming=null}
  if(incoming)resolveIncomingTurn(room,p,p.choice,incoming,attacker);else resolveFreeTurn(room,p,p.choice);
  if(checkWinner(room))return;const freshEffects=room.effects.filter(effect=>effect.seq>effectsBefore),added=Math.max(1,freshEffects.length),hasRoulette=freshEffects.some(effect=>effect.type==='roulette'),delay=Math.max(hasRoulette?added*1100+1900:1250,added*720+450);room.deadline=Date.now()+delay;broadcast(room);room.timer=setTimeout(()=>advanceTurn(room),delay);
}
function resolveIncomingTurn(room,p,choice,incoming,attacker){
  const card=choice.kind==='card'?choice.card:null;if(p.buffs.weakness)p.buffs.weakness=0;if(attacker.system)addEffect(room,'attack',attacker,p,incoming.card,`제시 공격 · ${incoming.name}`);
  if(card?.lastDefense&&p.hp<=5){addEffect(room,'reflect',p,attacker,card,'최후의 방어 · 공격자 즉사');consume(p,card);addLog(room,`${p.name} 최후의 방어 · ${attacker.name} 즉시 탈락`,'death');if(!attacker.system)hurt(room,attacker,Math.max(1,attacker.hp),'최후의 방어');return}
  if(incoming.doom){
    if(card?.counter){const next=nextAlive(room,p);addEffect(room,'counter',p,next,card,'멸망의 노래 반격');consume(p,card);queueAttack(room,p,next,{damage:3,name:'반격',pierce:false},card);addLog(room,`${p.name} 반격 · 멸망의 노래를 막고 3 피해가 ${next.name}에게 전달`,'good');return}
    if(card?.type==='defense'){const success=defenseSucceeds(card);addEffect(room,success?'defense':'defense_fail',p,success?attacker:p,card,success?'멸망의 노래 봉쇄':`${card.name} · 방어 실패`);consume(p,card);if(success){addLog(room,`${p.name} ${card.name} · 멸망의 노래 저주 무효`,'good');return}addLog(room,`${p.name} ${card.name} · 방어 실패`,'hit')}
    if(card?.type==='attack'){addEffect(room,'clash',p,p,card,'공격 충돌 · 자신의 공격 무효');consume(p,card);addLog(room,`${p.name}의 ${card.name} 무효`)}
    applyDoom(room,p,attacker,incoming.card);
    if(choice.kind==='draw'){p.choiceUsed=true;draw(room,p);addEffect(room,'draw',p,null,null,'카드 뽑기');addLog(room,`${p.name} 카드 1장 획득`)}
    else if(card?.type==='production'){consume(p,card);utility(room,p,card)}
    return
  }
  if(choice.kind==='draw'){addEffect(room,'damage',attacker,p,incoming.card,incoming.name);hurt(room,p,incoming.damage,incoming.name);p.choiceUsed=true;if(p.alive){draw(room,p);addEffect(room,'draw',p,null,null,'카드 뽑기');addLog(room,`${p.name} 카드 1장 획득`)}return}
  if(card.type==='attack'&&!card.counter){addEffect(room,'clash',p,p,card,'공격 충돌 · 자신의 공격 무효');hurt(room,p,incoming.damage,incoming.name);consume(p,card);addLog(room,`${p.name}의 ${card.name} 무효`);return}
  if(card.counter){const next=nextAlive(room,p);addEffect(room,'counter',p,next,card,'반격');consume(p,card);queueAttack(room,p,next,{damage:incoming.damage+3,name:'반격',pierce:false},card);addLog(room,`${p.name} 반격 · ${incoming.damage+3} 피해가 ${next.name}에게 전달`,'good');return}
  if(card.type==='defense'){
    const success=defenseSucceeds(card);addEffect(room,success?(card.reflect?'reflect':'defense'):'defense_fail',p,success?attacker:p,card,success?`${card.name} · 방어 성공`:`${card.name} · 방어 실패`);consume(p,card);
    if(!success){addLog(room,`${p.name} ${card.name} · 방어 실패`,'hit');addEffect(room,'damage',attacker,p,incoming.card,incoming.name);hurt(room,p,incoming.damage,incoming.name);return}
    if(card.rainbow||card.full){addLog(room,`${p.name} ${card.name} · 공격 무효`,'good');if(incoming.allin&&!attacker.system)hurt(room,attacker,10,'이판사판 반동');return}
    if(card.reflect){addLog(room,`${p.name} 가시 방어 · ${incoming.damage} 반사`,'good');if(attacker.system)addLog(room,'제시 공격이 반사되어 소멸','good');else hurt(room,attacker,incoming.damage,'가시 반사');return}
    if(incoming.pierce){addEffect(room,'damage',attacker,p,incoming.card,'관통');hurt(room,p,incoming.damage,incoming.name+' 관통');return}
    let block=card.block||0;if(p.buffs.shield&&card.block){block+=2;p.buffs.shield--}const left=Math.max(0,incoming.damage-block);addLog(room,`${p.name} ${block} 방어 · ${left} 피해 통과`,'good');if(left){addEffect(room,'damage',attacker,p,incoming.card,incoming.name);hurt(room,p,left,incoming.name)}else if(incoming.allin&&!attacker.system)hurt(room,attacker,10,'이판사판 반동');return
  }
  addEffect(room,'damage',attacker,p,incoming.card,incoming.name);hurt(room,p,incoming.damage,incoming.name);if(p.alive){consume(p,card);utility(room,p,card)}
}
function resolveFreeTurn(room,p,choice){
  if(choice.kind==='draw'){draw(room,p);p.choiceUsed=true;addEffect(room,'draw',p,null,null,'카드 뽑기');addLog(room,`${p.name} 카드 1장 획득`);return}
  const card=choice.card;
  if(card.roulette){const next=nextAlive(room,p),heads=crypto.randomInt(2)===0,victim=heads?p:next,evaded=!heads&&victim.buffs.fullEvade;consume(p,card);addEffect(room,'roulette',p,victim,card,heads?'heads':evaded?'tails_evaded':'tails');
    if(evaded){victim.buffs.fullEvade=0;addEffect(room,'defense',victim,victim,ITEMS.evade,'완전회피');addLog(room,`${p.name} 러시안 룰렛 · 뒷면! ${victim.name}의 완전회피로 무효`,'good')}
    else if(!heads&&victim.buffs.doomTurns>0){addLog(room,`${p.name} 러시안 룰렛 · 뒷면! ${victim.name}의 멸망의 노래 발동`,'death');addEffect(room,'doom_death',p,victim,card,'멸망의 노래 · 즉사');hurt(room,victim,Math.max(1,victim.hp),'멸망의 노래')}
    else{addLog(room,`${p.name} 러시안 룰렛 · ${heads?'앞면! 자신':'뒷면! '+next.name}에게 10 고정 피해`,'hit');hurt(room,victim,10,`러시안 룰렛 ${heads?'앞면':'뒷면'}`)}return}
  if(card.type==='attack'&&!card.counter){const selected=card.chooseTarget?room.players.find(x=>x.id===choice.targetId&&x.alive&&x!==p):null,target=selected||nextAlive(room,p),amount=damageValue(room,p,card);addEffect(room,'attack',p,target,card,card.name);consume(p,card);addLog(room,`${p.name} ${card.name} → ${target.name}`,'hit');if(card.selfDamage)hurt(room,p,card.selfDamage,'등가교환 대가');if(p.alive)queueAttack(room,p,target,{damage:amount,name:card.name,pierce:card.pierce,allin:card.allin,doom:card.doom},card);return}
  if(card.type==='defense'||card.counter){addEffect(room,card.counter?'counter':'defense',p,null,card,'대상 없음');consume(p,card);if(card.reflect)hurt(room,p,5,'가시 방어 실패');else addLog(room,`${p.name} ${card.name} · 막을 공격 없음`);return}
  consume(p,card);utility(room,p,card)
}
function buildRoundRanking(room){
  const sorted=[...room.players].sort((a,b)=>b.hp-a.hp||Number(b.alive)-Number(a.alive)||a.seat-b.seat);let previousHp=null,rank=0;
  room.ranking=sorted.map((p,index)=>{if(previousHp!==p.hp)rank=index+1;previousHp=p.hp;return {rank,id:p.id,name:p.name,isBot:!!p.isBot,hp:p.hp,alive:p.alive}});
  const topHp=sorted[0]?.hp??0,winners=sorted.filter(p=>p.hp===topHp);room.winners=winners.map(p=>({id:p.id,name:p.name,isBot:!!p.isBot,hp:p.hp}));room.winner=room.winners[0]?{...room.winners[0],shared:room.winners.length>1}:null;return room.ranking;
}
function finishRoundMode(room){
  clearTimeout(room.timer);room.status='finished';room.phase='finished';room.endReason='round_limit';room.deadline=null;buildRoundRanking(room);const names=room.winners.map(w=>w.name).join(', ');addEffect(room,'round_finish',room.players.find(p=>p.id===room.currentPlayerId),null,null,`${room.roundState?.number||room.round}라운드 종료`);addLog(room,`${room.roundState?.number||room.round}라운드 종료 · ${names} ${room.winners.length>1?'공동 우승':'최종 승리'}`,'system');broadcast(room);
}
function completeRoundTurn(room,p){
  if(normalizeSettings(room.settings).mode!=='rounds')return 'ongoing';let state=room.roundState;if(!state){state=room.roundState={number:1,participants:alive(room).map(x=>x.id),completed:[]}}
  const completed=new Set(state.completed||[]);if(p?.id&&state.participants.includes(p.id))completed.add(p.id);for(const id of state.participants){const player=room.players.find(x=>x.id===id);if(!player?.alive)completed.add(id)}state.completed=[...completed];
  if(!state.participants.every(id=>completed.has(id)))return 'ongoing';const settings=normalizeSettings(room.settings);if(state.number>=settings.roundLimit){finishRoundMode(room);return 'finished'}
  state.number++;room.round=state.number;state.participants=alive(room).map(x=>x.id);state.completed=[];addEffect(room,'round_start',p,p,null,`ROUND ${state.number}`);addLog(room,`ROUND ${state.number}/${settings.roundLimit} 시작`,'system');return 'advanced';
}
function advanceTurn(room){
  if(room.status!=='playing'||checkWinner(room))return;const current=room.players.find(p=>p.id===room.currentPlayerId);if(!current)return recoverContinuousTurn(room);while(current.hand.length>12)current.discard.push(current.hand.pop());
  if(current.buffs.doomTurns>0){if(current.buffs.doomFresh)current.buffs.doomFresh=false;else{current.buffs.doomTurns--;if(!current.buffs.doomTurns){current.buffs.doomSourceId=null;addLog(room,`${current.name} 멸망의 노래 저주에서 생존`,'good')}}}
  if(completeRoundTurn(room,current)==='finished')return;let next=nextAlive(room,current);while(next.buffs.skipTurns>0){next.buffs.skipTurns--;addEffect(room,'skip',current,next,null,`${next.name} 차례 봉쇄`);addLog(room,`${next.name} 봉쇄 발동 · 이번 차례 건너뜀`,'system');if(completeRoundTurn(room,next)==='finished')return;next=nextAlive(room,next)}beginContinuousTurn(room,next)
}
function buildRanking(room){const result=[],seen=new Set(),survivors=alive(room);for(const p of survivors){if(!seen.has(p.id)){seen.add(p.id);result.push(p)}}for(const id of [...(room.eliminationOrder||[])].reverse()){const p=room.players.find(x=>x.id===id);if(p&&!seen.has(p.id)){seen.add(p.id);result.push(p)}}for(const p of room.players)if(!seen.has(p.id)){seen.add(p.id);result.push(p)}room.ranking=result.map((p,index)=>({rank:index+1,id:p.id,name:p.name,isBot:!!p.isBot,hp:p.hp,alive:p.alive}));return room.ranking}
function checkWinner(room){const survivors=alive(room);if(survivors.length>1)return false;clearTimeout(room.timer);room.status='finished';room.phase='finished';room.endReason='last_survivor';room.winner=survivors[0]?{id:survivors[0].id,name:survivors[0].name,isBot:!!survivors[0].isBot,hp:survivors[0].hp}:null;room.winners=room.winner?[room.winner]:[];room.deadline=null;buildRanking(room);addLog(room,room.winner?`${room.winner.name} 최종 승리`:'공동 탈락','system');broadcast(room);return true}

function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body)}
function readBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>1e6)req.destroy()});req.on('end',()=>{try{resolve(data?JSON.parse(data):{})}catch(e){reject(Error('잘못된 요청입니다.'))}});req.on('error',reject)})}
async function api(req,res,url){
  try{
    if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,service:'last-signal-online',persistence:PERSISTENCE_ENABLED?'supabase':'memory'});
    if(req.method==='POST'&&url.pathname==='/api/room/create'){const b=await readBody(req),x=createRoom(b.name);return json(res,200,{code:x.room.code,token:x.player.id})}
    if(req.method==='POST'&&url.pathname==='/api/room/join'){const b=await readBody(req),x=await joinRoom(String(b.code||''),b.name);return json(res,200,{code:x.room.code,token:x.player.id})}
    if(req.method==='POST'&&url.pathname==='/api/ready'){const b=await readBody(req),{room,player}=await auth(b);if(room.status!=='lobby')throw Error('대기실 단계가 아닙니다.');player.ready=!player.ready;broadcast(room);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/bots'){const b=await readBody(req),{room,player}=await auth(b);setBotCount(room,player,b.count);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/settings'){const b=await readBody(req),{room,player}=await auth(b);updateSettings(room,player,b.settings);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/start'){const b=await readBody(req),{room,player}=await auth(b);if(room.hostId!==player.id)throw Error('방장만 시작할 수 있습니다.');startGame(room);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/room/delete'){const b=await readBody(req),{room,player}=await auth(b);if(room.hostId!==player.id)throw Error('방장만 방을 삭제할 수 있습니다.');deleteRoom(room);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/state'){const b=await readBody(req),{room,player}=await auth(b);return json(res,200,view(room,player))}
    if(req.method==='POST'&&url.pathname==='/api/item/use'){const b=await readBody(req),{room,player}=await auth(b);useItem(room,player,b.uid,b.targetId);return json(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/select'){const b=await readBody(req),{room,player}=await auth(b);submit(room,player,b.kind,b.uid,b.targetId);return json(res,200,{ok:true})}
    if(req.method==='GET'&&url.pathname==='/api/events'){
      const room=await getRoom(url.searchParams.get('code')),id=url.searchParams.get('token'),player=room?.players.find(p=>p.id===id);if(!room||!player)return json(res,401,{error:'접속 정보가 만료되었습니다.'});
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

setInterval(()=>{const cutoff=Date.now()-6*60*60*1000;for(const [code,room] of rooms)if(room.updatedAt<cutoff){clearTimeout(room.timer);rooms.delete(code);removePersistedRoom(code)}},30*60*1000).unref();
