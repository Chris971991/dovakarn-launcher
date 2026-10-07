const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {LocalPlay}=require('../src/localPlay')
function fixture(){
  const log=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'dov-local-play-')),'server.log')
  fs.writeFileSync(log,'Character selection ready profile 1 user 0\n')
  let now=1000,running=false,online=true,players=[],starts=0,launches=0,checks=0
  const player=new LocalPlay({runtime:{start:async()=>{starts++},status:async()=>online?({online,players,uptime:4380.7}):({online:false,players:[]})},running:async()=>running,launch:async()=>{launches++;running=true;return {success:true}},refreshFiles:()=>{checks++},serverLog:log,now:()=>now})
  return {player,log,setTime:n=>now=n,setRunning:n=>running=n,setOnline:n=>online=n,setPlayers:n=>players=n,counts:()=>({starts,launches,checks})}
}
test('local launch checks files and confirms menu/game independently of process startup',async()=>{
  const f=fixture();assert.equal((await f.player.play()).success,true)
  assert.deepEqual(f.counts(),{starts:1,launches:1,checks:1})
  assert.equal((await f.player.state()).phase.stage,'connecting','Old roster logs must not count as a new connection')
  fs.appendFileSync(f.log,'Character selection ready profile 2 user 1\n')
  assert.equal((await f.player.state()).phase.stage,'connecting','Another account is not this launch')
  fs.appendFileSync(f.log,'Character selection ready profile 1 user 0\n')
  assert.equal((await f.player.state()).phase.stage,'characterMenu')
  f.setPlayers([{profileId:1}]);assert.equal((await f.player.state()).phase.stage,'playing')
})
test('existing Skyrim is not launched again and pending launches are serialized',async()=>{
  const f=fixture();f.setRunning(true);assert.equal((await f.player.play()).success,false);assert.equal(f.counts().launches,0)
  f.setRunning(false);let release;f.player.runtime.start=()=>new Promise(r=>release=r)
  const first=f.player.play();await new Promise(r=>setImmediate(r));assert.equal((await f.player.play()).success,false);release();assert.equal((await first).success,true)
})
test('failed and ended game sessions remain actionable rather than claiming connection',async()=>{
  const f=fixture();await f.player.play();f.setTime(190000);assert.equal((await f.player.state()).phase.stage,'failed')
  f.setRunning(false);assert.equal((await f.player.state()).phase.stage,'ready')
  f.player.launch=async()=>({success:false,error:'Missing multiplayer files'})
  assert.equal((await f.player.play()).success,false);assert.match(f.player.phase.message,/Missing multiplayer files/)
})
const filesResult=(over={})=>({revision:'r1',collection:{name:'Dovakarn',url:'https://www.nexusmods.com/games/skyrimspecialedition/collections/abc'},checked:219,updated:[],patched:[],base:[],mods:[],blocked:false,warnings:[],...over})
test('missing critical mods stop the launch and expose names and the collection link only',async()=>{
  const f=fixture(),opened=[];f.player.openUrl=url=>opened.push(url)
  const mod={name:'TrueHUD',nexusId:62775,missing:['Data/SKSE/Plugins/TrueHUD.dll'],changed:[],critical:true}
  f.player.checkFiles=async()=>filesResult({mods:[mod],blocked:true})
  const result=await f.player.play();assert.equal(result.success,false);assert.equal(f.counts().launches,0)
  assert.equal(f.player.phase.stage,'filesBlocked');assert.match(result.error,/1 mod is missing or out of date/)
  const view=(await f.player.state()).files
  assert.deepEqual(view,{blocked:true,mods:[{name:'TrueHUD',missing:1,changed:0,critical:true,nexusId:62775}],collection:true,collectionName:'Dovakarn',collectionCheck:null})
  assert.equal(JSON.stringify(view).includes('SKSE'),false,'File paths stay in the main process')
  assert.equal(f.player.openCollection().success,true);assert.deepEqual(opened,[filesResult().collection.url])
})
test('mod warnings need Play anyway and a base game mismatch always blocks',async()=>{
  const f=fixture();const warn={name:'Textures',nexusId:null,missing:[],changed:['Data/Textures.bsa'],critical:false}
  f.player.checkFiles=async()=>filesResult({mods:[warn],warnings:[warn]})
  const first=await f.player.play();assert.equal(first.success,false);assert.equal(first.canPlayAnyway,true);assert.equal(f.player.phase.stage,'filesWarning')
  assert.equal((await f.player.state()).files.blocked,false)
  assert.equal((await f.player.play({ignoreWarnings:true})).success,true);assert.equal(f.counts().launches,1)
  assert.equal((await f.player.state()).files,null,'The panel closes once the launch continues')
  const g=fixture();g.player.checkFiles=async()=>filesResult({base:[{path:'Data/Skyrim.esm',state:'changed'}],blocked:true})
  assert.equal((await g.player.play({ignoreWarnings:true})).success,false);assert.match(g.player.phase.message,/base game files do not match/)
  assert.equal((await g.player.state()).files.mods[0].name,'Skyrim base game')
})
test('file updates report progress and servers without a list still launch',async()=>{
  const f=fixture(),seen=[];f.player.notify=p=>seen.push(p.message)
  f.player.checkFiles=async progress=>{progress({stage:'checking'});progress({stage:'updating',done:1,total:2});progress({stage:'patching',done:1,total:1});return filesResult({updated:['a','b'],patched:['c']})}
  assert.equal((await f.player.play()).success,true)
  assert.ok(seen.includes('Updating Dovakarn files, 1 of 2...'))
  assert.ok(seen.includes('Adapting mod files for the server, 1 of 1...'))
  assert.ok(seen.every(line => !/[();]/.test(line)), 'no brackets or semicolons in the status line')
  const g=fixture();g.player.checkFiles=async()=>null;assert.equal((await g.player.play()).success,true)
  assert.equal(g.player.openCollection().success,false,'No list means no collection link')
  const h=fixture();h.player.checkFiles=async()=>{throw Error('Could not read the server\'s file list: timeout')}
  assert.equal((await h.player.play()).success,false);assert.match(h.player.phase.message,/file list/);assert.equal(h.counts().launches,0)
})
test('Check mods checks and repairs files without launching and records the result',async()=>{
  const f=fixture(),seen=[];f.player.notify=p=>seen.push(p.stage)
  f.player.checkFiles=async()=>filesResult({updated:['Data/a.js'],patched:['Data/KCF.esm']})
  assert.deepEqual(await f.player.check(),{success:true});assert.deepEqual(f.counts(),{starts:1,launches:0,checks:1})
  assert.deepEqual(seen,['startingServer','checking','ready'])
  assert.equal(f.player.phase.message,'Your game was brought up to date: updated 1 Dovakarn file, adapted 1 mod file.')
  assert.deepEqual((await f.player.state()).lastCheck,{at:1000,published:true,checked:219,updated:1,patched:1,moved:0,keysWritten:0,problems:0,blocked:false,collection:null})
  // Files the server does not use are named with where they went, so nobody thinks they were deleted
  f.player.checkFiles=async()=>filesResult({moved:['Data/SKSE/Plugins/Other.dll','Data/Other.ini'],keysWritten:['Data/MCM/Settings/TrueHUD.ini']})
  assert.deepEqual(await f.player.check(),{success:true})
  assert.equal(f.player.phase.message,'Your game was brought up to date: moved 2 files the server does not use into "Dovakarn removed files" in your Skyrim folder.')
  assert.deepEqual([(await f.player.state()).lastCheck.moved,(await f.player.state()).lastCheck.keysWritten],[2,1])
  // The page is told the keys the player bound, from main.js
  f.player.keyChoices=()=>({'Data/MCM/Settings/TrueDirectionalMovement.ini|Keys|uTargetLockKey':258})
  assert.deepEqual((await f.player.state()).keyChoices,{'Data/MCM/Settings/TrueDirectionalMovement.ini|Keys|uTargetLockKey':258})
  const mod={name:'TrueHUD',nexusId:62775,missing:['Data/TrueHUD.esp'],changed:[],critical:true}
  f.setTime(2000);f.player.checkFiles=async()=>filesResult({mods:[mod],blocked:true})
  const blocked=await f.player.check();assert.equal(blocked.success,false);assert.match(blocked.error,/1 mod is missing/)
  const state=await f.player.state()
  assert.deepEqual([state.phase.stage,state.files.mods[0].name,state.lastCheck.problems,state.lastCheck.blocked,state.lastCheck.at],['filesBlocked','TrueHUD',1,true,2000])
  assert.equal(f.counts().launches,0,'A check never starts Skyrim')
  const warn={name:'Textures',nexusId:null,missing:[],changed:['Data/T.bsa'],critical:false}
  f.player.checkFiles=async()=>filesResult({mods:[warn],warnings:[warn]})
  assert.equal((await f.player.check()).canPlayAnyway,true);assert.equal(f.player.phase.stage,'filesWarning')
})
test('for Dovakarn\'s own game copy, files the server does not use are said to be in Dovakarn\'s game folder',async()=>{
  const f=fixture();f.player.prepareGame=async()=>({})
  f.player.checkFiles=async()=>filesResult({moved:['Data/SKSE/Plugins/Other.dll','Data/Other.ini']})
  assert.deepEqual(await f.player.check(),{success:true})
  assert.equal(f.player.phase.message,'Your game was brought up to date: moved 2 files the server does not use into "Dovakarn removed files" in Dovakarn\'s game folder.')
})
test('Check mods waits for Skyrim to close, never overlaps a launch, and reports failures and missing lists',async()=>{
  const f=fixture();let called=0;f.player.checkFiles=async()=>{called++;return filesResult()}
  f.setRunning(true);const refused=await f.player.check()
  assert.equal(refused.success,false);assert.match(refused.error,/Close Skyrim before checking your mods/)
  assert.deepEqual([f.counts().starts,called,f.player.lastCheck],[0,0,null],'Nothing starts or changes while Skyrim holds its files')
  f.setRunning(false);let release;f.player.runtime.start=()=>new Promise(r=>release=r)
  const pending=f.player.check();await new Promise(r=>setImmediate(r))
  // A missing busy guard would wait on the held server start, so time out instead of hanging.
  const refusal=p=>Promise.race([p,new Promise(r=>setTimeout(()=>r({error:'no refusal'}),500))])
  assert.match((await refusal(f.player.play())).error,/already being prepared/);assert.match((await refusal(f.player.check())).error,/already being prepared/)
  // The Nexus window's install trigger retries on this code, never on the words
  assert.equal((await refusal(f.player.check())).code,'BUSY')
  release();assert.equal((await pending).success,true);assert.equal(called,1);f.player.runtime.start=async()=>{}
  f.player.checkFiles=async()=>{throw Error('Could not read the server\'s file list: timeout')}
  assert.equal((await f.player.check()).success,false);assert.equal(f.player.phase.stage,'failed')
  assert.deepEqual(f.player.lastCheck,{at:1000,failed:true,error:'Could not read the server\'s file list: timeout'})
  f.player.checkFiles=async()=>null;assert.equal((await f.player.check()).success,true)
  assert.match(f.player.phase.message,/does not publish a file list/);assert.deepEqual(f.player.lastCheck,{at:1000,published:false})
})
test('while something holds the game (Dovakarn being removed), Play, Check and Set up refuse with why, and nothing runs',async()=>{
  const f=fixture();let why='Wait until Dovakarn is removed.';f.player.held=()=>why
  let built=0,checked=0;f.player.buildGame=async()=>{built++};f.player.checkFiles=async()=>{checked++;return filesResult()}
  for(const run of [()=>f.player.play(),()=>f.player.check(),()=>f.player.setupGame()])assert.deepEqual(await run(),{success:false,error:why})
  assert.deepEqual([f.counts(),checked,built,f.player.busy,f.player.lastCheck],[{starts:0,launches:0,checks:0},0,0,false,null],'nothing started, nothing recorded')
  why='';assert.equal((await f.player.check()).success,true,'free again once it lets go')
  f.player.held=()=>{throw Error('gone')};assert.equal((await f.player.check()).success,true,'a held() that throws holds nothing')
})
test('state gives the page server details as names and numbers only',async()=>{
  const f=fixture(),list={version:{commit:'abc12345',date:'2026-01-15T10:00:00Z',modified:false},files:219,mods:[],collection:{name:'Dovakarn',url:''}}
  f.setPlayers([{id:1,profileId:1,name:'Lydia',location:{pos:[1,2,3]}},{id:2,profileId:2}]);f.player.fileList=()=>list
  let s=await f.player.state()
  assert.deepEqual(s.server,{name:'Dovakarn-Local-Test',address:'',uptime:4380,players:['Lydia','Player'],count:2,max:8});assert.equal(s.fileList,list);assert.equal(s.lastCheck,null)
  assert.equal(JSON.stringify(s.server).includes('pos'),false,'Positions and ids stay in the main process')
  f.setOnline(false);f.player.fileList=()=>{throw Error('invalid entry')}
  s=await f.player.state();assert.deepEqual([s.serverOnline,s.server,s.fileList],[false,{name:'Dovakarn-Local-Test',address:'',uptime:null,players:[],count:0,max:8},null])
  assert.equal(s.launcherVersion,'','No launcher version unless main passes one')
})
test('a missing collection warns with Play anyway and is recorded for the Collection line',async()=>{
  const f=fixture(),row={name:'Dovakarn collection, revision 3',nexusId:null,missing:[],changed:[],critical:false,collection:'notInstalled',count:52}
  f.player.checkFiles=async()=>filesResult({mods:[row],warnings:[row],collectionCheck:{revision:3,total:52,missing:Array(52).fill({modId:1,name:'x'}),outdated:[]}})
  const result=await f.player.check();assert.equal(result.canPlayAnyway,true);assert.equal(f.counts().launches,0)
  assert.match(f.player.phase.message,/Dovakarn collection, revision 3, is not installed\. Install it with Vortex/)
  const s=await f.player.state()
  assert.deepEqual(s.files.mods,[{name:'Dovakarn collection, revision 3',missing:0,changed:0,critical:false,state:'notInstalled',count:52}])
  assert.deepEqual(s.lastCheck.collection,{revision:3,total:52,missing:52,outdated:0})
  assert.equal((await f.player.play({ignoreWarnings:true})).success,true,'Play anyway still launches')
})
test('Nexus mod pages open only for whole mod ids, on the collection\'s game site',async()=>{
  const f=fixture(),opened=[];f.player.openUrl=u=>opened.push(u)
  for(const bad of [0,-1,1.5,'62775',null,undefined,NaN,2**60])assert.equal(f.player.openMod(bad).success,false,String(bad))
  assert.deepEqual(opened,[])
  assert.equal(f.player.openMod(62775).success,true)
  f.player.fileList=()=>({collection:{name:'Dovakarn',url:'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef'}})
  f.player.openMod(12604)
  assert.deepEqual(opened,['https://www.nexusmods.com/skyrimspecialedition/mods/62775','https://www.nexusmods.com/skyrimspecialedition/mods/12604'])
})
test('a new Skyrim folder clears results that belonged to the old one',async()=>{
  const f=fixture();let folder={path:'C:\\Games\\Skyrim Special Edition - Dovakarn',serverCopy:true};f.player.gameFolder=()=>folder
  assert.deepEqual((await f.player.state()).gameFolder,folder)
  const mod={name:'TrueHUD',nexusId:62775,missing:['Data/TrueHUD.esp'],changed:[],critical:true}
  f.player.checkFiles=async()=>filesResult({mods:[mod],blocked:true});await f.player.check()
  assert.notEqual((await f.player.state()).files,null)
  folder={path:'C:\\Games\\Skyrim Special Edition',serverCopy:false};f.player.folderChanged()
  const s=await f.player.state()
  assert.deepEqual([s.files,s.lastCheck,s.phase.stage,s.gameFolder],[null,null,'ready',folder])
})
test('the collection opens from the published list before any check',async()=>{
  const f=fixture(),opened=[];f.player.openUrl=u=>opened.push(u)
  assert.equal(f.player.openCollection().success,false)
  f.player.fileList=()=>({collection:{name:'Dovakarn',url:'https://www.nexusmods.com/games/skyrimspecialedition/collections/abc'}})
  assert.equal(f.player.openCollection().success,true);assert.deepEqual(opened,['https://www.nexusmods.com/games/skyrimspecialedition/collections/abc'])
})
test('a stopped server invalidates old menu logs and a closed game cannot remain playing',async()=>{
  const f=fixture();await f.player.play()
  fs.appendFileSync(f.log,'Character selection ready profile 1 user 0\n')
  assert.equal((await f.player.state()).phase.stage,'characterMenu')
  f.setOnline(false);assert.equal((await f.player.state()).phase.stage,'failed')
  assert.match(f.player.phase.message,/server is no longer responding/)
  f.setOnline(true);assert.equal((await f.player.state()).phase.stage,'failed','Restart alone cannot confirm reconnection')
  fs.appendFileSync(f.log,'Character selection ready profile 1 user 1\n')
  assert.equal((await f.player.state()).phase.stage,'characterMenu')
  f.setPlayers([{profileId:1}]);assert.equal((await f.player.state()).phase.stage,'playing')
  f.setRunning(false);f.setTime(30000);assert.equal((await f.player.state()).phase.stage,'ready')
})
test('each check first keeps the server in step with this PC\'s mods, restarting it only when nobody is on',async()=>{
  const f=fixture(),order=[],messages=[];let stops=0,staged={changed:false}
  f.player.runtime.stop=async()=>{stops++;order.push('stop')}
  const start=f.player.runtime.start;f.player.runtime.start=async()=>{order.push('start');return start()}
  f.player.notify=p=>messages.push(p.message)
  f.player.prepareHost=async onProgress=>{order.push('prepare');onProgress('Generating animations with Nemesis...');return staged}
  assert.equal((await f.player.check()).success,true)
  assert.deepEqual([order,stops],[['prepare','start'],0],'Staging runs before the server starts; nothing changed, so no restart')
  assert.ok(messages.includes('Generating animations with Nemesis...'),'Its progress shows in the launcher')
  staged={changed:true};order.length=0
  await f.player.check()
  assert.deepEqual(order,['prepare','stop','start'],'Changed mods restart an empty server')
  f.setPlayers([{profileId:2}]);order.length=0
  await f.player.check()
  assert.deepEqual(order,['prepare','start'],'Players already in keep playing')
  f.setOnline(false);f.setPlayers([]);order.length=0
  await f.player.check()
  assert.deepEqual(order,['prepare','start'],'An offline server just starts')
  assert.equal(f.player.lastCheck.unfixed,undefined,'every online fix to mod files made: nothing to say')
  // A fix setup could not make is shown with the check, and never stops it
  const unfixed={fix:'SKSE Menu Framework: its menu opens on F10 and does not pause the game',path:'SKSE/Plugins/SKSEMenuFramework.ini',reason:'the mod\'s file changed ("ToggleKey = F1" does not end its line there), so players get it as the mod ships it.'}
  staged={changed:false,unfixed:[unfixed]}
  assert.equal((await f.player.check()).success,true)
  assert.deepEqual(f.player.lastCheck.unfixed,[{fix:unfixed.fix,reason:unfixed.reason}])
  assert.deepEqual((await f.player.state()).lastCheck.unfixed,[{fix:unfixed.fix,reason:unfixed.reason}],'the page gets it')
  f.player.prepareHost=async()=>{throw Error('Nemesis could not generate the animation files.')}
  const failed=await f.player.check()
  assert.equal(failed.success,false);assert.match(failed.error,/Could not set up the server's mods: Nemesis could not generate/)
  assert.deepEqual([f.player.lastCheck.failed,f.player.busy],[true,false],'The failure is shown and the launcher stays usable')
  assert.equal((await f.player.play()).success,false,'Nothing launches on a failed setup')
  assert.equal(f.counts().launches,0)
})

test('a check right after server setup reuses the list it built, and the Skyrim folder is read alongside the rest',async()=>{
  const f=fixture(),flags=[]
  f.player.checkFiles=async(_progress,{signal,...options})=>{flags.push(options);assert.ok(signal instanceof AbortSignal,'every check can be stopped');return filesResult()}
  f.player.prepareHost=async()=>({changed:false});await f.player.check()
  f.player.prepareHost=async()=>null;await f.player.check()
  assert.deepEqual(flags,[{published:true},{published:false}],'Only a server setup that ran has already rebuilt the list')
  let answer;f.player.gameFolder=()=>new Promise(resolve=>answer=resolve)
  const pending=f.player.state();await new Promise(r=>setImmediate(r))
  answer({path:'D:\\Skyrim',exe:true,version:'1.6.1170.0',versionOk:true})
  assert.equal((await pending).gameFolder.path,'D:\\Skyrim','The version read no longer blocks, so state waits for its answer')
})

test("a server with its own console window is restarted through it", async () => {
  const f = fixture(), order = []
  f.player.runtime.stop = async () => order.push("stop")
  f.player.runtime.restart = async () => order.push("restart")
  const start = f.player.runtime.start; f.player.runtime.start = async () => { order.push("start"); return start() }
  f.player.prepareHost = async () => ({ changed: true })
  await f.player.check()
  assert.deepEqual(order, ["restart", "start"])
})

// Discord login on a local server that runs online: account stand-in in the shape discordLogin.js returns
function discordFixture({loggedIn=true,play}={}){
  const f=fixture(),launched=[]
  let status={loggedIn,account:loggedIn?{number:12,name:'Hadvar'}:null,pending:false,error:null}
  f.player.loginMode=()=>({discord:true,master:'http://127.0.0.1:4000',masterKey:'local-master-key'})
  const refreshes=[]
  f.player.account={status:()=>status,inviteUrl:async()=>'https://discord.gg/MTxxdWbcCz',refresh:async options=>{refreshes.push(options);return status},
    play:play||(async()=>({session:'b'.repeat(64),account:status.account}))}
  f.player.launch=async options=>{launched.push(options);f.setRunning(true);return {success:true}}
  return {...f,launched,refreshes,setStatus:s=>status=s}
}
test('a banned player, a non-member or a pending member is told before the long file check, with Discord asked afresh',async()=>{
  for(const [account,code,text] of [
    [{number:12,name:'Hadvar',banned:true,banReason:'Cheating'},'banned',/^You are banned: Cheating$/],
    [{number:12,name:'Hadvar',banned:true,banLinked:true,banReason:'This PC or network is linked to a banned account.'},'banned',/^This PC or network is linked/],
    [{number:12,name:'Hadvar',member:false,requireMembership:true},'notMember',/Join the Dovakarn Discord/],
    [{number:12,name:'Hadvar',member:true,pending:true},'pendingMember',/rules screen/],
  ]){
    const f=discordFixture();f.setStatus({loggedIn:true,account,pending:false,error:null})
    const result=await f.player.play()
    assert.equal(result.account,code);assert.match(result.error,text)
    assert.deepEqual(f.counts(),{starts:0,launches:0,checks:0},'nothing runs first')
    assert.deepEqual(f.refreshes,[{fresh:true}])
    assert.equal(result.inviteUrl,code==='banned'?null:'https://discord.gg/MTxxdWbcCz')
  }
  // A server that does not require the Discord lets a non-member, or one who has not finished its rules screen, play
  const open=discordFixture();open.setStatus({loggedIn:true,account:{number:12,name:'Hadvar',member:false,requireMembership:false},pending:false,error:null})
  assert.equal((await open.player.play()).success,true)
  const rules=discordFixture();rules.setStatus({loggedIn:true,account:{number:12,name:'Hadvar',member:true,pending:true,requireMembership:false},pending:false,error:null})
  assert.equal((await rules.player.play()).success,true,'the server lets them in, so the launcher does too')
  // An answer Discord gave before (the backend asks it at most every 30 seconds: askAgainIn) never turns away a player
  // who joined a moment ago: Play goes on, and the backend's Play asks Discord itself. A ban still stops here.
  for (const account of [{number:12,name:'Hadvar',member:false,requireMembership:true},{number:12,name:'Hadvar',member:true,pending:true}]){
    const cached=discordFixture();cached.setStatus({loggedIn:true,account,pending:false,error:null,reached:true,askAgainIn:12})
    assert.equal((await cached.player.play()).success,true,JSON.stringify(account))
  }
  const bannedCached=discordFixture();bannedCached.setStatus({loggedIn:true,account:{number:12,name:'Hadvar',banned:true,banReason:'Cheating'},pending:false,error:null,reached:true,askAgainIn:12})
  assert.deepEqual([(await bannedCached.player.play()).account,bannedCached.counts().launches],['banned',0])
  // The server did not answer: said plainly, before the file check, instead of judging the account saved last time
  const down=discordFixture();down.setStatus({loggedIn:true,account:{number:12,name:'Hadvar',member:false,requireMembership:true},pending:false,error:null,reached:false,problem:'The Dovakarn server could not be reached. Check your internet connection, or try again in a minute.'})
  const unreachable=await down.player.play()
  assert.deepEqual([unreachable.success,unreachable.account,down.player.phase.stage],[false,'unreachable','failed'])
  assert.match(unreachable.error,/could not be reached/)
  assert.deepEqual(down.counts(),{starts:0,launches:0,checks:0})
})
test('with Discord login, Play asks for a login before the long file check and hands the game its play session',async()=>{
  const out=discordFixture({loggedIn:false})
  const refused=await out.player.play()
  assert.deepEqual([refused.success,refused.account,out.player.phase.stage],[false,'notLoggedIn','account'])
  assert.deepEqual(out.counts(),{starts:0,launches:0,checks:0},'Nothing runs for a player who is not logged in')
  assert.equal((await out.player.state()).login.discord,true)

  const f=discordFixture()
  assert.equal((await f.player.play()).success,true)
  assert.deepEqual(f.launched,[{login:{session:'b'.repeat(64),account:{number:12,name:'Hadvar'},master:'http://127.0.0.1:4000',masterKey:'local-master-key',inviteUrl:'https://discord.gg/MTxxdWbcCz'},gameKeys:null}])
  fs.appendFileSync(f.log,'Character selection ready profile 1 user 0\n')
  assert.equal((await f.player.state()).phase.stage,'connecting','Test profile 1 is not this Discord account')
  fs.appendFileSync(f.log,'Character selection ready profile 12 user 0\n')
  assert.equal((await f.player.state()).phase.stage,'characterMenu','The account number is who connects')
  f.setPlayers([{profileId:12}]);assert.equal((await f.player.state()).phase.stage,'playing')
})
test('a refused play session (not in the Discord, banned) stops the launch with the reason',async()=>{
  const err=Object.assign(Error('Join the Dovakarn Discord to play.'),{code:'notMember',inviteUrl:'https://discord.gg/MTxxdWbcCz'})
  const f=discordFixture({play:async()=>{throw err}})
  const result=await f.player.play()
  assert.deepEqual([result.success,result.error,result.account,result.inviteUrl],[false,'Join the Dovakarn Discord to play.','notMember','https://discord.gg/MTxxdWbcCz'])
  assert.deepEqual([f.launched.length,f.player.phase.stage],[0,'account'],'The account notice explains this one, so the status line steps aside')
  // Refusals the account notice does not explain are news: recorded as failures so they are always shown
  for (const code of ['membershipUnknown','accessUnavailable','serverLocked','unreachable','loginChanged']){
    const other=discordFixture({play:async()=>{throw Object.assign(Error(`refused: ${code}`),{code})}})
    const refused=await other.player.play()
    assert.deepEqual([refused.success,refused.account,other.player.phase],[false,code,{stage:'failed',message:`refused: ${code}`}],code)
  }
  const offline=fixture();offline.player.launch=async options=>{offline.launchedWith=options;return {success:true}}
  await offline.player.play()
  assert.deepEqual(offline.launchedWith,{login:null,gameKeys:null},'A server without Discord login plays as the test profile')
  // The game client's own keys from the check just passed go to the launch, which writes them to the client settings file
  const keyed=fixture();keyed.player.checkFiles=async()=>filesResult({gameKeys:{dodgeKeyCode:56,sneakKeyCode:45}})
  keyed.player.launch=async options=>{keyed.launchedWith=options;return {success:true}}
  await keyed.player.play()
  assert.deepEqual(keyed.launchedWith,{login:null,gameKeys:{dodgeKeyCode:56,sneakKeyCode:45}})
})
test('the status line reaches the page only when it changes, however often the state is asked for',async()=>{
  const f=fixture(),told=[];f.player.notify=phase=>told.push(`${phase.stage}: ${phase.message}`)
  f.player.progress('checking','Checking your game files against the server...')
  f.player.progress('checking','Checking your game files against the server...')
  f.player.progress('checking','Checking the mod collection on Nexus...')
  assert.deepEqual(told,['checking: Checking your game files against the server...','checking: Checking the mod collection on Nexus...'])
  await f.player.play();told.length=0
  f.setTime(190000);for(let i=0;i<3;i++)await f.player.state()
  assert.deepEqual(told,['failed: The character menu has not been confirmed yet. Close Skyrim and try again from this launcher. If you still see the normal main menu, check the multiplayer client logs.'],'a state asked for every second repeats nothing')
})
test('a launch keeps the account number it started with, so logging out while Skyrim runs does not lose track of it',async()=>{
  const f=discordFixture()
  assert.equal((await f.player.play()).success,true)
  f.setStatus({loggedIn:false,account:null,pending:false,error:null})
  assert.equal(f.player.activeProfileId(),12)
  fs.appendFileSync(f.log,'Character selection ready profile 12 user 0\n')
  assert.equal((await f.player.state()).phase.stage,'characterMenu')
  f.setPlayers([{profileId:12}]);assert.equal((await f.player.state()).phase.stage,'playing')
  // Once Skyrim closes, the next launch plays as whoever is logged in then
  f.setRunning(false);f.setTime(30000);assert.equal((await f.player.state()).phase.stage,'ready')
  assert.equal(f.player.activeProfileId(),null,'no one is logged in now')
  f.setStatus({loggedIn:true,account:{number:31,name:'Serana'},pending:false,error:null});assert.equal(f.player.activeProfileId(),31)
  // A launch that fails keeps nothing either
  const g=discordFixture();g.player.launch=async()=>({success:false,error:'Skyrim could not start.'})
  assert.equal((await g.player.play()).success,false);assert.equal(g.player.launchedProfileId,null)
  g.setStatus({loggedIn:true,account:{number:40,name:'Lydia'},pending:false,error:null});assert.equal(g.player.activeProfileId(),40)
})

// Online mode: the same coordinator pointed at the Dovakarn server (main.js onlinePlayDeps). No server log, no
// server start from this PC, a heartbeat that counts players without naming them.
function onlineFixture({play}={}){
  let now=1000,running=false,online=true,count=3,starts=0,launches=0
  const launched=[]
  let status={loggedIn:true,account:{number:12,name:'Hadvar'},pending:false,error:null}
  const player=new LocalPlay({
    serverName:'Dovakarn',serverAddress:'dovakarn.com',online:true,serverLog:null,maxPlayers:20,
    runtime:{status:async()=>online?({online:true,players:[],count,max:20,uptime:null}):({online:false,players:[]}),
      start:async()=>{starts++;if(!online)throw Error('Dovakarn is not answering right now. Check your internet connection, or try again in a minute.')}},
    running:async()=>running,refreshFiles:()=>{},now:()=>now,
    launch:async options=>{launched.push(options);running=true;return {success:true}},
    loginMode:()=>({discord:true,master:null,masterKey:null}),
    account:{status:()=>status,inviteUrl:async()=>'https://discord.gg/MTxxdWbcCz',refresh:async()=>({...status,reached:true}),
      play:play||(async()=>({session:'b'.repeat(64),account:status.account}))},
  })
  return {player,launched,setTime:n=>now=n,setRunning:n=>running=n,setOnline:n=>online=n,setCount:n=>count=n,counts:()=>({starts,launches})}
}
test('online play contacts Dovakarn instead of starting a server, and hands the game its play session',async()=>{
  const f=onlineFixture(),seen=[]
  f.player.notify=p=>seen.push(p.message)
  assert.equal((await f.player.play()).success,true)
  assert.ok(seen.includes('Contacting Dovakarn...'),JSON.stringify(seen))
  assert.equal(f.counts().starts,1,'The start step only confirms the server answers')
  // The master address and key are filled by the launch pipeline from the server itself; the session travels as is
  assert.deepEqual(f.launched,[{login:{session:'b'.repeat(64),account:{number:12,name:'Hadvar'},master:null,masterKey:null,inviteUrl:'https://discord.gg/MTxxdWbcCz'},gameKeys:null}])
})
test('online state counts players without names, carries the world name and address, and never fakes a failure from silence',async()=>{
  const f=onlineFixture()
  let s=await f.player.state()
  assert.deepEqual(s.server,{name:'Dovakarn',address:'dovakarn.com',uptime:null,players:[],count:3,max:20})
  assert.equal(s.mode,'online')
  assert.equal(s.serverOnline,true)
  await f.player.play()
  // No server log online: half an hour into the game, the page still says nothing worse than "connecting"
  f.setTime(30*60*1000)
  s=await f.player.state()
  assert.equal(s.phase.stage,'connecting','No false character-menu timeout without a log to confirm from')
  // A missed heartbeat while the game runs is not called a failure either
  f.setOnline(false)
  assert.equal((await f.player.state()).phase.stage,'connecting')
  // The game closing is still noticed
  f.setRunning(false)
  assert.equal((await f.player.state()).phase.stage,'ready')
})
test('an unreachable Dovakarn stops Play and Check with a plain answer',async()=>{
  const f=onlineFixture();f.setOnline(false)
  const result=await f.player.play()
  assert.equal(result.success,false)
  assert.match(result.error,/Dovakarn is not answering right now/)
  assert.equal(f.launched.length,0)
  const check=await f.player.check()
  assert.equal(check.success,false);assert.match(check.error,/not answering right now/)
})

test('with the server window closed, Play opens it first and then asks the account: the backend starts with the window',async()=>{
  const f=discordFixture();f.setOnline(false)
  let started=false
  f.player.runtime.start=async()=>{started=true;f.setOnline(true)}
  const account={number:12,name:'Hadvar',member:true}
  f.player.account.refresh=async options=>{f.refreshes.push(options);return started?{loggedIn:true,account,reached:true}:{loggedIn:true,account,reached:false,problem:'The Dovakarn server could not be reached.'}}
  const result=await f.player.play()
  assert.equal(result.success,true,JSON.stringify(result))
  assert.equal(started,true)
  assert.deepEqual(f.refreshes,[{fresh:true},{fresh:true}],'asked again once the window runs')
  // With the server running, a backend that does not answer is said plainly, and nothing is started
  const down=discordFixture();down.player.account.refresh=async()=>({loggedIn:true,account,reached:false,problem:'The Dovakarn server could not be reached.'})
  const refused=await down.player.play()
  assert.deepEqual([refused.success,refused.account,down.counts().starts],[false,'unreachable',0])
})
test('online: a newer published revision turns the state into an update ask until a verify matches it',async()=>{
  let published='rev-2',remembered='rev-1',probes=0,now=5000
  const player=new LocalPlay({runtime:{start:async()=>{},status:async()=>({online:true,players:[]})},running:async()=>false,launch:async()=>({success:true}),refreshFiles:()=>{},serverLog:null,now:()=>now,online:true,serverName:'Dovakarn',
    filesRevision:async()=>{probes++;return published},verifiedRevision:()=>remembered,rememberRevision:r=>{remembered=r},
    checkFiles:async()=>({revision:published,collection:{name:'Dovakarn',url:''},collectionCheck:null,checked:3,updated:['a.esp'],patched:[],base:[],mods:[],blocked:false,warnings:[]})})
  assert.equal((await player.state()).filesUpdate.needed,true,'a revision this PC has not verified asks for an update')
  await player.state();assert.equal(probes,1,'the published revision is asked at most once a minute')
  now=70000;await player.state();assert.equal(probes,2,'and asked again after that minute')
  const checked=await player.check()
  assert.equal(checked.success,true)
  assert.equal(remembered,'rev-2','a successful verify remembers the revision it matched')
  assert.equal((await player.state()).filesUpdate.needed,false,'the update ask clears without waiting out the probe cache')
  // The local test launcher has no published revision and never asks
  const local=new LocalPlay({runtime:{start:async()=>{},status:async()=>({online:true,players:[]})},running:async()=>false,launch:async()=>({success:true}),refreshFiles:()=>{},serverLog:null,now:()=>now})
  assert.equal((await local.state()).filesUpdate,null)
})

test('the progress bar gets a percent: by bytes where there are bytes, by files otherwise, and one message per whole percent',async()=>{
  const f=fixture(),seen=[];f.player.notify=p=>seen.push(p)
  f.player.checkFiles=async progress=>{
    progress({stage:'checking',done:0,total:4,received:0,bytes:400});progress({stage:'checking',done:2,total:4,received:201,bytes:400});progress({stage:'checking',done:2,total:4,received:202,bytes:400})
    progress({stage:'updating',done:1,total:2,received:50,bytes:200});progress({stage:'patching',done:1,total:2});progress({stage:'patching',done:2,total:2});progress({stage:'collection'})
    return filesResult({updated:['a','b'],patched:['c','d']})}
  assert.equal((await f.player.play()).success,true)
  const meters=seen.filter(p=>p.meter).map(p=>[p.stage,p.meter.percent])
  assert.deepEqual(meters,[['checking',0],['checking',50],['updatingFiles',25],['patchingFiles',0],['patchingFiles',50]],'202 of 400 is still 50%, so the page is not told again')
  assert.deepEqual(seen.find(p=>p.stage==='updatingFiles').meter,{percent:25,received:50,bytes:200,done:1,total:2})
  assert.equal(seen.find(p=>/mod collection/.test(p.message)).meter,undefined,'nothing to measure on Nexus')
})

test('Cancel stops a running check at once: it reports stopped, not failed, and the last real result stands',async()=>{
  const f=fixture(),before={at:1,failed:false,published:true,problems:0,updated:0,patched:0}
  f.player.lastCheck=before
  let seen=null
  f.player.checkFiles=(progress,{signal})=>new Promise((resolve,reject)=>{seen=signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('Stopped.'),{code:'CANCELLED'})))})
  assert.deepEqual(f.player.cancel(),{success:false},'nothing running: nothing to stop')
  const running=f.player.check()
  await new Promise(resolve=>setImmediate(resolve))
  assert.ok(seen&&!seen.aborted,'the check is given a signal')
  assert.deepEqual(f.player.cancel(),{success:true})
  const result=await running
  assert.deepEqual([result.success,result.cancelled,result.error],[false,true,'Stopped. Anything already downloaded is kept.'])
  const state=await f.player.state()
  assert.deepEqual([state.phase.stage,state.phase.message,state.busy],['ready','Stopped. Anything already downloaded is kept.',false])
  assert.equal(f.player.lastCheck,before,'a stopped check is not recorded as a failed one')
  assert.deepEqual(f.player.cancel(),{success:false},'the signal is gone with the run')
  // Play stops the same way, and nothing launches
  f.player.checkFiles=(progress,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('socket hang up')))})
  const playing=f.player.play()
  await new Promise(resolve=>setImmediate(resolve))
  f.player.cancel()
  const played=await playing
  assert.deepEqual([played.success,played.cancelled,f.counts().launches],[false,true,0],'any error after Cancel counts as stopped')
})
