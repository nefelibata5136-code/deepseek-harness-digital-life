window.__ModuleLoader__.load({id:'@local/persona-reference-ui',factory:require=>{
const React=require('react'),{createRoot}=require('react-dom/client'),{flushSync}=require('react-dom'),{MarkdownText}=require('@deepseek-ai/dsh-client-ui-primitives');
const asset=name=>'/api/persona.referenceImage?name='+name;
const paths={menu:'M4 6h16M4 12h16M4 18h16',home:'m3 10 9-7 9 7v10H15v-7H9v7H3z',chat:'M21 11a9 9 0 0 1-9 9H4l-2 2v-9a10 10 0 0 1 19-2ZM8 11h.01M12 11h.01M16 11h.01',work:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',memory:'M5 3h14v18H5zM8 7h2m4 0h2M8 11h8M8 15h8',world:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18ZM5 6h14M5 18h14',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v6l5 3',plugin:'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',auto:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM11 8h3l-2 4h2l-3 5 1-5h-2z',settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',clip:'m8 14 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L13 3a3 3 0 0 1 4 4L7 17',image:'M3 4h18v16H3zM3 16l5-6 4 5 4-7 5 8M8 8h.01',plus:'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 8v8M8 12h8',send:'m3 11 18-8-7 18-3-7-8-3ZM11 14l6-7',chevron:'m9 5 7 7-7 7',check:'M4 3h16v18H4zM8 11l3 3 5-6',smile:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 14c2 3 6 3 8 0M8 8h.01M16 8h.01',bot:'M5 6h14v14H5zM12 2v4M8 11h.01M16 11h.01M9 16h6',bolt:'m13 2-7 11h6l-1 9 7-12h-6z'};
const icon=(name,cls='')=>`<svg class="ref-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.chat}"/></svg>`;
const img=(name,cls='')=>`<img class="${cls}" src="${asset(['article-icon.png','chat-icon.png','github-icon.png','bluesky-icon.png'].includes(name)?name.replace('.png','.svg'):name)}" alt="" draggable="false">`;
const css=`
body:has(.yb-workspace.ref-ui){overflow:hidden}
.yb-workspace.ref-ui{--ref-bg:#0e1722;--ref-text:#eef2ff;--ref-muted:#92accf;position:fixed;inset:0;z-index:100;display:grid;grid-template-columns:284px minmax(0,1fr) 431px;grid-template-rows:108px minmax(0,1fr);height:100dvh;width:100%;background:radial-gradient(ellipse at 60% 4%,#19263455,transparent 55%),var(--ref-bg);color:var(--ref-text);font-family:'Microsoft YaHei','Segoe UI',sans-serif;font-size:16px;border-radius:12px;overflow:hidden}
.ref-ui *{box-sizing:border-box}.ref-ui button{font-family:inherit}.ref-icon{height:26px;width:26px;flex-shrink:0}.ref-ui button{color:inherit;cursor:pointer}.ref-ui button:focus-visible,.ref-ui summary:focus-visible{outline:2px solid #68baff;outline-offset:3px}.ref-ui button:disabled{cursor:default}
.ref-nav{grid-column:1;grid-row:1/3;display:flex;flex-direction:column;border-right:1px solid #263547;padding:15px 13px 19px;background:linear-gradient(90deg,#0f1925,#0e1721);min-height:0}.ref-menu{background:none;border:0;width:32px;height:29px;padding:4px;margin:0 0 12px 3px;align-self:flex-start}.ref-menu .ref-icon{width:23px;height:23px}.ref-logo{height:30px;width:233px;object-fit:contain;margin:5px 9px 28px}.ref-nav-items{display:flex;flex-direction:column;gap:8px}.ref-nav-item{position:relative;display:flex;align-items:center;gap:15px;width:100%;min-height:60px;padding:6px 12px;text-align:left;border:1px solid transparent;border-radius:12px;background:transparent}.ref-nav-item .ref-nav-symbol{width:41px;height:43px;display:flex;align-items:center;justify-content:center}.ref-nav-item .ref-icon{height:26px;width:26px}.ref-nav-item strong{font-size:17px;font-weight:500;display:block;line-height:25px}.ref-nav-item small{font-size:14px;color:#94afd6;line-height:22px;display:block}.ref-nav-item:hover{background:#ffffff06}.ref-nav-item.selected{background:linear-gradient(100deg,#214276,#1c2d50);border-color:#3167ce;box-shadow:inset 0 0 16px #3d6eff17}.ref-nav-item.selected:before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:2px;background:#6ed9ff;box-shadow:0 0 9px #5cdaff}.ref-nav-item.selected .ref-icon{color:#96d2ff}.ref-nav-item:first-child .ref-nav-symbol{background:#ffffff05;border-radius:12px}.ref-nav-divider{height:1px;background:#293a4e;margin:23px 9px 15px}.ref-profile{display:flex;gap:16px;align-items:center;margin-top:auto;padding:16px 10px 6px;background:transparent;border:0;font-size:16px}.ref-letter{width:44px;height:44px;background:linear-gradient(140deg,#6545fa,#4430be);border:1px solid #8264ff44;display:grid;place-items:center;border-radius:50%;font-size:20px}.ref-profile .ref-icon{width:17px;height:17px;margin-left:auto;transform:rotate(90deg)}
.ref-top{grid-column:2/4;grid-row:1;display:flex;gap:25px;min-width:0;padding:13px 15px 14px}.ref-statusbar{display:flex;align-items:center;flex:1;min-width:0;border:1px solid #26364a;border-radius:12px;height:81px;padding:16px 20px;background:linear-gradient(110deg,#13202a22,#101b2655)}.ref-status-cell{display:flex;gap:13px;align-items:center;border-right:1px solid #425674;padding:0 20px;min-width:0;height:36px;flex:1}.ref-status-cell:first-child{padding-left:0;flex:1.27}.ref-status-cell:nth-child(2){flex:1.1}.ref-status-cell:nth-child(3){flex:.6}.ref-status-cell:nth-child(4){flex:1.12}.ref-status-cell:nth-child(5){flex:.9}.ref-status-cell:last-child{border:0;padding-right:0;flex:1.3}.ref-status-cell .ref-icon{color:#70baff;width:24px;height:24px}.ref-status-cell .bolt{color:#ffe486;fill:#ffe486;stroke-width:0}.ref-status-cell .smile{color:#ffda74}.ref-status-cell strong{display:block;font-size:13px;font-weight:500;line-height:20px;color:#c7d7ed}.ref-status-cell small{display:block;font-size:14px;line-height:23px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:175px}.ref-online{width:18px;height:18px;border-radius:50%;background:#50ed88;box-shadow:0 0 10px #52ec8020;flex:none}.ref-online.offline{background:#e5bc65}.ref-top-note{flex:0 0 320px;position:relative;padding:20px 20px 0 0;font:18px/27px 'KaiTi','楷体','STKaiti',serif;letter-spacing:1.2px;color:#b9caff;transform:rotate(-3deg)}.ref-top-note small{display:block;text-align:right;font:17px/22px 'KaiTi','楷体','STKaiti',serif}.ref-window-controls{position:absolute;right:0;top:-2px;display:flex;gap:40px;transform:rotate(3deg);font:19px/20px 'Segoe UI',sans-serif;color:#e7eeff}.ref-window-controls span{display:block}
.ref-ui>.yb-root{grid-column:2;grid-row:2;height:100%;min-height:0;min-width:0;background:none;display:flex;overflow:hidden}.ref-ui .yb-status-switch,.ref-ui #yb-status-panel,.ref-ui .yb-activity{display:none!important}.ref-ui>.yb-tasks{display:none!important}.ref-ui.ref-conversations-open>.yb-tasks{display:flex!important;position:absolute;inset:108px auto 90px 284px;width:290px;z-index:25;max-height:none;background:#142131;border:1px solid #3b5271;border-radius:12px;box-shadow:10px 10px 35px #0006}.ref-hero{position:relative;flex:0 0 166px;height:166px;border:1px solid #425878;border-radius:12px;margin:0 14px;overflow:hidden;background:#101d35 url('${asset('hero-scene-no-text.png')}') center/100% 100% no-repeat;box-shadow:inset 0 0 28px #19489211}.ref-hero-copy{position:absolute;left:247px;top:24px;right:155px}.ref-hero-copy h1{font-size:25px;line-height:34px;margin:0 0 4px;font-weight:650;letter-spacing:.5px}.ref-hero-copy p{font-size:16px;line-height:26px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ref-hero-copy blockquote{font:20px/30px 'KaiTi','楷体','STKaiti',serif;color:#99d1ff;letter-spacing:2px;margin:17px 0 0}.ref-hero-clock{position:absolute;right:23px;top:31px;text-align:right;color:#eef3ff}.ref-hero-clock small{font-size:14px;color:#99caff}.ref-hero-clock time{font:30px/42px 'Segoe UI',sans-serif;display:block;margin-bottom:8px}.ref-hero-clock span{font-size:14px;color:#b5cbef}
.ref-ui .yb-list{flex:1;min-height:0;overflow:auto;padding:21px 36px 9px 106px;scrollbar-width:thin;scrollbar-color:#41587a transparent}.ref-ui .yb-message{position:relative;margin:0 0 15px;font-size:17px;line-height:1.58;white-space:normal;color:#edf2ff;padding:0;background:transparent;border:0;border-radius:0}.ref-ui .yb-message:before{content:'';position:absolute;left:-70px;top:0;width:56px;height:56px;background:url('${asset('persona-avatar.png')}') center/contain no-repeat}.ref-ui .yb-message.yb-user:before{content:'F';width:46px;height:46px;left:-68px;top:0;background:linear-gradient(145deg,#8050f5,#5336d3);border:1px solid #9878ff55;border-radius:50%;color:#f0deff;display:grid;place-items:center;font:21px 'Segoe UI',sans-serif}.ref-ui .yb-role{font-size:16px;line-height:23px;height:25px;color:#edf2ff;margin:0 0 2px;font-weight:600;white-space:nowrap}.ref-ui .yb-role time{font-size:14px;font-weight:400;color:#93afd7;margin-left:14px}.ref-ui .yb-message>.yb-markdown{font-size:17px;line-height:1.58;padding:12px 19px;background:linear-gradient(120deg,#202e42,#1c2839);border:1px solid #26344844;border-radius:12px;white-space:normal}.ref-ui .yb-user>.yb-markdown{display:inline-block;padding:10px 12px;background:#203452;border:0;max-width:100%;font-size:16px;line-height:26px}.ref-ui .yb-markdown p{margin:0 0 9px}.ref-ui .yb-markdown p:last-child{margin:0}.ref-ui .yb-markdown ul,.ref-ui .yb-markdown ol{padding-left:22px}.ref-ui .yb-markdown pre{max-width:100%;overflow:auto}.ref-ui .yb-progress{background:none;border:0}.ref-ui .yb-run{font-size:13px}
.ref-ui .yb-thinking{background:linear-gradient(120deg,#1c2c41,#1c2839);border:1px solid #376fc9;border-radius:11px;overflow:hidden;margin:8px 0;color:#bbcceb;font-size:16px;line-height:1.6}.ref-ui .yb-thinking>summary{position:relative;display:flex;padding:13px 19px 7px;color:#eff3ff;font-weight:600;font-size:18px;gap:14px;list-style:none;min-height:44px}.ref-ui .yb-thinking>summary:before{content:'';width:31px;height:29px;background:url('${asset('brain-icon.png')}') center/contain no-repeat;flex-shrink:0}.ref-ui .yb-thinking .yb-chevron{margin-left:0;font-size:11px;transform:rotate(90deg)}.ref-ui .yb-thinking[open] .yb-chevron{transform:rotate(-90deg)}.ref-thinking-meta{margin-left:auto;font-size:14px;font-weight:400;color:#91afd8}.ref-ui .yb-thinking-text{font:16px/1.58 'Microsoft YaHei','Segoe UI',sans-serif;border:0;padding:3px 21px 11px;margin:0;max-height:360px;color:#c1d0ec}.ref-ui .yb-translation-controls{padding:0 20px}.ref-ui .yb-thinking .yb-translation-text{border:0;font-size:16px;padding:3px 21px 11px}.ref-ui .yb-translation[hidden]{display:none}
.ref-ui .yb-actions{margin:0 0 7px}.ref-ui .yb-actions-heading{display:none}.ref-ui .yb-action-card{border-color:#33465e;background:#1b293c;padding:9px 12px}.ref-ui .yb-actions.ref-group>.ref-operation-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:7px}.ref-operation-card{border:1px solid #33475e;border-radius:11px;background:linear-gradient(120deg,#202f41,#1c293a);overflow:hidden}.ref-operation-card>summary{height:59px;display:flex;align-items:center;padding:7px 16px;gap:17px;list-style:none;cursor:pointer}.ref-operation-card>summary img{width:34px;height:35px;object-fit:contain}.ref-operation-card>summary strong{font-size:16px;display:block;line-height:24px}.ref-operation-card>summary small{font-size:13px;color:#92add3;display:block;line-height:20px}.ref-operation-card>summary>.ref-icon{width:16px;height:16px;margin-left:auto;transform:rotate(90deg)}.ref-operation-card[open]>summary>.ref-icon{transform:rotate(-90deg)}.ref-operation-card .ref-operation-body{padding:8px 12px;max-height:340px;overflow:auto}.ref-operation-body p{font-size:14px;line-height:1.65}.ref-operation-body pre{white-space:pre-wrap;word-break:break-word}.ref-operation-card:not([open])>.ref-operation-body{display:none}
.ref-ui .yb-foot{flex:0 0 auto;margin:9px 18px 17px;padding:0;background:linear-gradient(120deg,#152131,#172232);border:1px solid #3a77ef;border-radius:11px}.ref-ui .yb-composer{max-width:none;display:flex;align-items:center;gap:14px;padding:9px 12px;height:65px;position:relative}.ref-ui .yb-input{order:0;flex:1;resize:none;background:none;border:0;border-left:1px solid #2a3c54;border-radius:0;padding:7px 12px;min-height:36px;height:42px;line-height:26px;color:#ecf2ff;font-size:17px;max-height:145px;outline:none}.ref-ui .yb-input::placeholder{color:#8eaccf}.ref-ui .yb-composer>.yb-btn{border:0;background:none;padding:5px;display:grid;place-items:center;border-radius:9px;height:42px;width:29px;flex-shrink:0;font-size:0}.ref-ui .yb-composer>.yb-btn .ref-icon{width:24px;height:24px}.ref-ui .yb-composer>.yb-send{background:linear-gradient(150deg,#3474ff,#326cfa);width:47px;height:47px;box-shadow:0 2px 8px #082042;font-size:0;opacity:1}.ref-ui .yb-send:disabled{background:linear-gradient(150deg,#3474ff,#326cfa);opacity:.8}.ref-ui .yb-send .ref-icon{width:25px;height:25px;fill:#eef4ff;stroke:#fff;stroke-width:.7}.ref-ui .yb-composer>.yb-btn[aria-label='停止执行']{font-size:12px;width:auto;white-space:nowrap;color:#ffccac}.ref-ui .yb-foot>.yb-tip{padding:4px 12px;font-size:12px;margin:0}.ref-composer-action{border:0;background:none;width:29px;height:34px;padding:2px}.ref-composer-action .ref-icon{height:24px;width:24px}
.ref-dashboard{grid-column:3;grid-row:2;display:flex;flex-direction:column;gap:10px;overflow:auto;padding:0 15px 17px 0;min-height:0;scrollbar-width:none}.ref-panel{border:1px solid #293b51;border-radius:12px;background:linear-gradient(130deg,#111d2a55,#0d1722);padding:12px 18px;flex:0 0 auto}.ref-panel-head{display:flex;align-items:center;gap:14px;min-height:24px;margin-bottom:11px}.ref-panel-head h2{font-size:17px;font-weight:650;line-height:24px;margin:0}.ref-panel-head small{font-size:13px;color:#8ba8d0}.ref-panel-head button{margin-left:auto;font-size:13px;color:#abc2e9;background:none;border:0;padding:0;white-space:nowrap;display:flex;gap:4px;align-items:center}.ref-panel-head .ref-icon{width:16px;height:16px}.ref-changes .ref-panel-head{margin-bottom:10px}.ref-change{height:47px;display:flex;align-items:center;gap:12px;background:linear-gradient(120deg,#202e3e,#1a2738);border:1px solid #27374b;border-radius:11px;padding:5px 8px;margin-bottom:7px}.ref-change:last-child{margin-bottom:0}.ref-change-icon{width:40px;height:35px;background:#ffffff04;border-radius:10px;display:grid;place-items:center;font-size:25px}.ref-change strong{font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.ref-change small{font-size:13px;color:#93aed3;white-space:nowrap}.ref-change-dot{width:8px;height:8px;border-radius:50%;background:#5684ef;flex:none}.ref-change:last-child .ref-change-dot{background:#f0cc6c}.ref-changes{min-height:216px}.ref-recent{min-height:256px}.ref-recent .ref-panel-head{margin-bottom:4px}.ref-recent-row{height:51px;display:flex;gap:15px;align-items:center;padding:2px 4px}.ref-recent-row>img{width:43px;height:43px;object-fit:contain}.ref-recent-row strong{display:block;font-size:15px;font-weight:500;line-height:23px}.ref-recent-row small{display:block;color:#99b4da;font-size:13px;line-height:19px}.ref-recent-row time{margin-left:auto;font-size:13px;color:#95b3db}.ref-world{min-height:127px}.ref-world .ref-panel-head{margin-bottom:12px}.ref-world-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}.ref-world-tile{height:63px;border:1px solid #27374d;background:linear-gradient(130deg,#1d2c3d,#1b2736);border-radius:10px;display:flex;align-items:center;gap:9px;padding:8px}.ref-world-tile img{width:32px;height:38px;object-fit:contain}.ref-world-tile strong{display:block;font-size:13px;white-space:nowrap;font-weight:400;line-height:22px}.ref-world-tile small{display:block;font-size:11px;color:#8eaacd;line-height:17px}.ref-rhythm{flex:1;min-height:187px}.ref-rhythm-bar{display:flex;height:14px;border-radius:9px;background:#24334e;overflow:hidden;margin:7px 0 11px}.ref-rhythm-bar span{border-radius:9px}.ref-rhythm-legend{display:flex;justify-content:space-between;gap:7px}.ref-rhythm-item{text-align:center;font-size:12px;white-space:nowrap}.ref-rhythm-item i{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px}.ref-rhythm-item small{display:block;font:14px/26px 'Segoe UI',sans-serif}.ref-rhythm blockquote{font:18px/26px 'KaiTi','楷体','STKaiti',serif;letter-spacing:1.4px;text-align:center;color:#b7c9ee;margin:15px 0 4px}.ref-empty{font-size:14px;line-height:1.8;color:#91aacb;padding:10px 4px}.ref-development{grid-column:2;grid-row:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}.ref-development .ref-icon{height:46px;width:46px;color:#84baff}.ref-development h1{font-size:25px;font-weight:600;margin:0}.ref-development p{font-size:17px;color:#9fb5d5;margin:0}.ref-development button{border:1px solid #4478c8;border-radius:9px;background:#233b61;color:#dae9ff;padding:10px 20px;font-size:15px}.ref-ui.ref-development-open>.yb-root{display:none!important}.ref-toast{position:absolute;bottom:104px;left:50%;transform:translateX(-50%);padding:10px 16px;border:1px solid #45618a;background:#20314b;border-radius:9px;z-index:40;font-size:14px;color:#dce8ff}
@media(max-width:1450px){.yb-workspace.ref-ui{grid-template-columns:236px minmax(0,1fr) 360px}.ref-top-note{flex-basis:250px}.ref-statusbar{padding:16px 12px}.ref-status-cell{padding:0 11px;gap:9px}.ref-status-cell small{font-size:12px}.ref-logo{width:205px;margin-left:0}.ref-hero-copy{left:210px}.ref-hero-copy p{font-size:14px}.ref-hero-copy blockquote{font-size:18px}.ref-panel{padding:12px}.ref-change strong{font-size:13px}.ref-change small{font-size:11px}.ref-nav-item{gap:9px}.ref-nav-item small{font-size:12px}.ref-ui.ref-conversations-open>.yb-tasks{left:236px}.ref-ui .yb-list{padding-left:91px;padding-right:22px}.ref-ui .yb-message>.yb-markdown{font-size:15px}}
@media(max-width:1180px){.yb-workspace.ref-ui{grid-template-columns:210px minmax(0,1fr);grid-template-rows:94px minmax(0,1fr)}.ref-top{grid-column:2;padding:10px 14px}.ref-top-note{display:none}.ref-statusbar{height:74px}.ref-status-cell:nth-child(4),.ref-status-cell:nth-child(5){display:none}.ref-dashboard{display:none}.ref-logo{width:180px}.ref-nav-item{padding:6px}.ref-nav-item strong{font-size:16px}.ref-ui.ref-conversations-open>.yb-tasks{left:210px;top:94px}.ref-hero-copy{left:230px}}
@media(max-width:760px){.yb-workspace.ref-ui{grid-template-columns:76px minmax(0,1fr);grid-template-rows:80px minmax(0,1fr);border-radius:0}.ref-nav{padding:13px 8px}.ref-logo{width:55px;height:27px;object-fit:cover;object-position:left;margin:6px 0 20px}.ref-nav-item{min-height:52px;justify-content:center}.ref-nav-item .ref-nav-text,.ref-profile>span:not(.ref-letter),.ref-profile>.ref-icon{display:none}.ref-nav-item .ref-nav-symbol{width:38px}.ref-nav-items{gap:4px}.ref-nav-divider{margin:15px 5px}.ref-profile{padding:10px 7px;gap:0}.ref-statusbar{height:58px;border-radius:9px;padding:10px}.ref-status-cell{border:0;padding:0 8px!important;flex:1!important}.ref-status-cell strong{font-size:11px}.ref-status-cell small{font-size:11px}.ref-status-cell:nth-child(2),.ref-status-cell:nth-child(6){display:none}.ref-online{width:11px;height:11px}.ref-top{padding:11px 10px}.ref-hero{margin:0 10px;flex-basis:135px;height:135px;background-size:auto 135px;background-position:20% center}.ref-hero-copy{left:126px;top:20px;right:10px}.ref-hero-copy h1{font-size:19px}.ref-hero-copy p{font-size:12px;white-space:normal;line-height:20px}.ref-hero-copy blockquote{font-size:14px;margin-top:8px;letter-spacing:0}.ref-hero-clock{display:none}.ref-ui .yb-list{padding:18px 10px 8px 62px}.ref-ui .yb-message:before{left:-48px;width:42px;height:42px}.ref-ui .yb-message.yb-user:before{left:-44px;width:33px;height:33px;font-size:17px}.ref-ui .yb-message>.yb-markdown{padding:10px;font-size:14px}.ref-ui .yb-role{font-size:14px}.ref-ui .yb-role time{font-size:12px;margin-left:8px}.ref-ui .yb-thinking>summary{font-size:14px;padding:10px;gap:7px}.ref-ui .yb-thinking>summary:before{width:24px;height:24px}.ref-thinking-meta{display:none}.ref-ui .yb-thinking-text{padding:5px 10px 10px;font-size:13px}.ref-ui .yb-actions.ref-group>.ref-operation-pair{grid-template-columns:1fr;gap:6px}.ref-operation-card>summary{height:53px;padding:7px 10px;gap:10px}.ref-operation-card>summary strong{font-size:14px}.ref-operation-card>summary small{font-size:12px}.ref-ui .yb-foot{margin:8px 10px 12px}.ref-ui .yb-composer{flex-wrap:nowrap;gap:5px;padding:6px;height:59px}.ref-ui .yb-input{order:0;flex-basis:0;width:0;min-width:0;font-size:13px;padding:6px;min-height:36px;height:38px}.ref-ui .yb-composer>.yb-send{width:38px;height:38px}.ref-ui .yb-composer>.yb-btn{width:23px}.ref-ui .yb-composer>.yb-btn .ref-icon{width:20px}.ref-composer-action{width:21px}.ref-composer-action .ref-icon{width:20px}.ref-ui.ref-conversations-open>.yb-tasks{left:76px;top:80px;width:min(285px,calc(100vw - 86px))}.ref-ui .yb-composer>.yb-btn[aria-label='停止执行']{width:26px;font-size:0}.ref-development h1{font-size:20px}.ref-development p{font-size:14px}}
`;
const refinements=`
.ref-ui .yb-markdown{color:#edf2ff!important;font-weight:400}.ref-ui .yb-markdown>div,.ref-ui .yb-markdown :is(p,li,span,strong,blockquote,h1,h2,h3){color:inherit!important;font-size:inherit;line-height:inherit}.ref-ui .yb-markdown p{margin:0 0 9px!important}.ref-ui .yb-markdown p:last-child{margin:0!important}.ref-ui .yb-markdown a{color:#91c7ff}.ref-ui .yb-markdown>div{font-size:inherit!important;line-height:inherit!important}.ref-ui .yb-user>.yb-markdown{color:#eaf1ff!important}.ref-ui .yb-message.yb-user:before{border-radius:50%!important}.ref-nav-items{gap:6px}.ref-logo{margin-bottom:24px}.ref-nav-divider{margin-top:19px}.ref-ui .yb-thinking[data-ref-chinese=true] .yb-translation-controls{display:none}.ref-ui .yb-thinking[data-ref-chinese=true] .yb-translation-text{margin:0}.ref-ui .yb-thinking[data-ref-chinese=true] .yb-translation{padding:0}.ref-ui .yb-thinking .yb-translation-text{font:16px/1.58 'Microsoft YaHei','Segoe UI',sans-serif}.ref-world-tile small{white-space:nowrap;font-size:10px}.ref-recent-row>img{border-radius:11px}.ref-status-cell small{max-width:100%}.ref-status-cell>div{min-width:0}.ref-top-note{padding-top:20px}.ref-nav-item strong{font-weight:400}.ref-ui .yb-message>.yb-markdown{padding-top:11px;padding-bottom:11px}.ref-ui .yb-message{margin-bottom:15px}
`;
const expansionStyles=`
.ref-dashboard{overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;scrollbar-width:thin;scrollbar-color:#405775 transparent;scrollbar-gutter:stable}.ref-dashboard .ref-panel{flex:0 0 auto}.ref-dashboard .ref-rhythm{min-height:187px}.ref-change{height:auto;display:block;padding:0}.ref-change>summary{display:flex;align-items:center;gap:12px;min-height:47px;padding:5px 8px;list-style:none;cursor:pointer;user-select:none}.ref-change>summary::-webkit-details-marker{display:none}.ref-change>summary:focus-visible{outline:2px solid #75baff;outline-offset:-2px;border-radius:10px}.ref-change[open]{border-color:#466b9e;background:linear-gradient(120deg,#24354b,#1a2738)}.ref-change[open]>summary strong{white-space:normal}.ref-change .ref-expanded-body{border-top:1px solid #344a67;padding:11px 13px 14px;color:#c6d7ef;font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.ref-expanded-body p{margin:0 0 7px}.ref-expanded-body time{font-size:12px;color:#91add2}.ref-change:not([open])>.ref-expanded-body{display:none}.ref-recent-row>img{image-rendering:auto}.ref-ui .yb-message>.yb-markdown{font-size:16px;line-height:1.58}.ref-ui .yb-message{margin-bottom:13px}.ref-ui .yb-user>.yb-markdown{font-size:16px}.ref-ui .yb-thinking{margin-top:8px}.ref-ui .yb-thinking>summary{padding-bottom:9px}.ref-ui .yb-thinking-text,.ref-ui .yb-thinking .yb-translation-text{line-height:1.58}.ref-ui .yb-message.yb-user:before{aspect-ratio:1;border-radius:50%!important;clip-path:circle(50%)}
@media(max-width:760px){.ref-ui .yb-message>.yb-markdown{font-size:14px}.ref-change .ref-expanded-body{font-size:13px}}
`;
const layoutStyles=`
.yb-workspace.ref-ui{--ref-left:284px;--ref-right:431px;--ref-top-height:108px;grid-template-columns:var(--ref-left) minmax(0,1fr) var(--ref-right);grid-template-rows:var(--ref-top-height) minmax(0,1fr)}
.ref-statusbar{display:grid;grid-template-columns:192px 166px 108px 166px 146px minmax(0,1fr)}.ref-status-cell{width:100%;flex:none!important}.ref-dashboard{scrollbar-gutter:auto}.ref-change>summary{min-height:45px}.ref-ui .yb-message:not(.yb-user)>.yb-markdown{font-size:15.7px}
html[data-windows-titlebar] .ref-window-controls{display:none}.ref-top-note{-webkit-app-region:drag}.ref-layout-toggle,.ref-ui button{-webkit-app-region:no-drag}
.ref-ui .yb-actions.ref-group{display:flex;flex-direction:column}.ref-ui .yb-actions.ref-group>.ref-operation-pair{order:-1}.ref-ui .yb-actions.ref-group>.ref-operation-body{display:none;max-height:340px;overflow:auto;border:1px solid #33475e;border-radius:10px;background:#172537;padding:8px 12px;margin-bottom:8px}.ref-ui .yb-actions.ref-group.ref-tools-open>.ref-operation-body{display:block}
.ref-ui .yb-thinking[data-ref-duplicate=true]{display:none}
.ref-nav-items{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#334760 transparent}.ref-nav-item,.ref-nav-divider,.ref-profile,.ref-logo,.ref-menu{flex-shrink:0}.ref-world-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.ref-world-tile,.ref-world-tile>div,.ref-recent-row>div{min-width:0}.ref-world-tile img{flex-shrink:0}.ref-world-tile strong,.ref-world-tile small,.ref-recent-row strong,.ref-recent-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ref-recent-row>div{flex:1}.ref-recent-row time{flex-shrink:0}
.ref-layout-toggle{position:absolute;z-index:45;display:grid;place-items:center;width:22px;height:34px;padding:0;background:#172537;border:1px solid #3b5270;border-radius:6px;color:#abc5e9;box-shadow:0 2px 6px #0003;font:12px 'Segoe UI',sans-serif}.ref-layout-toggle:hover{background:#27405e;color:#fff}.ref-layout-toggle[data-region=left]{left:calc(var(--ref-left) - 11px);top:50%}.ref-layout-toggle[data-region=right]{right:calc(var(--ref-right) - 11px);top:50%}.ref-layout-toggle[data-region=top]{left:calc(var(--ref-left) + (100% - var(--ref-left) - var(--ref-right))/2 - 17px);top:calc(var(--ref-top-height) - 11px);width:34px;height:22px}
.ref-ui.ref-left-collapsed{--ref-left:24px!important}.ref-ui.ref-right-collapsed{--ref-right:24px!important}.ref-ui.ref-top-collapsed{--ref-top-height:28px!important}.ref-ui.ref-left-collapsed>.ref-nav,.ref-ui.ref-right-collapsed>.ref-dashboard,.ref-ui.ref-top-collapsed>.ref-top,.ref-ui.ref-top-collapsed .ref-hero{display:none!important}.ref-ui.ref-left-collapsed>.ref-layout-toggle[data-region=left]{left:1px}.ref-ui.ref-right-collapsed>.ref-layout-toggle[data-region=right]{right:1px}.ref-ui.ref-top-collapsed>.ref-layout-toggle[data-region=top]{top:3px}.ref-ui.ref-conversations-open>.yb-tasks{left:var(--ref-left);top:var(--ref-top-height)}
@media(max-width:1450px){.yb-workspace.ref-ui{--ref-left:236px;--ref-right:360px}.ref-statusbar{display:flex}.ref-status-cell{width:auto;flex:1!important}.ref-status-cell:first-child{flex:1.27!important}.ref-hero{background-size:auto 100%;background-position:left center}}
@media(max-width:1180px){.yb-workspace.ref-ui{--ref-left:210px;--ref-right:0px;--ref-top-height:94px}.ref-top{grid-column:2/4}.ref-layout-toggle[data-region=right]{display:none}.ref-ui.ref-right-collapsed{--ref-right:0px!important}}
@media(max-width:760px){.yb-workspace.ref-ui{--ref-left:76px;--ref-top-height:80px}.ref-ui .yb-message:not(.yb-user)>.yb-markdown{font-size:14px}}
`;
const el=(tag,cls,html='')=>{const node=document.createElement(tag);node.className=cls;node.innerHTML=html;return node;};
const clock=value=>new Date(value||Date.now()).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'});
const relativeTime=value=>{const minutes=Math.max(0,Math.floor((Date.now()-value)/60000));return minutes<60?minutes+' 分钟前':Math.floor(minutes/60)+' 小时前';};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chatStyles=`
.ref-attachment-rail{display:flex;gap:10px;flex-wrap:wrap;padding:8px 20px;max-height:180px;overflow:auto}.ref-attachment-card{display:flex;flex-direction:column;gap:5px;max-width:160px;overflow-wrap:anywhere;font-size:12px}.ref-attachment-card button,.ref-attachment-card a{background:#1b2e44;border:1px solid #405777;border-radius:8px;padding:6px;color:inherit;cursor:pointer}.ref-attachment-thumb{display:block;width:120px;height:90px;object-fit:cover;border-radius:6px}.ref-attachment-viewer{position:fixed;inset:0;z-index:10000;background:#000d;display:flex;align-items:center;justify-content:center;padding:55px 20px}.ref-attachment-viewer img{max-width:100%;max-height:100%;object-fit:contain}.ref-attachment-close{position:absolute;right:20px;top:15px;font-size:20px;padding:8px 15px;background:#27394e;color:white;border:1px solid #8092aa;border-radius:8px}.ref-chat-compose .ref-attachment-add{flex:0 0 38px;width:38px;padding:6px}
.ref-message-delivery{font-size:12px;line-height:1.6;color:#9cb7d5;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}.ref-message-delivery[data-state=failed],.ref-chat-feedback[data-state=failed],.ref-agent-run[data-status=failed] .ref-run-status{color:#ffaaa4}.ref-message-delivery[data-state=sending]{color:#83baff}.ref-agent-run[data-status=failed]{border-color:#855454}.ref-chat-feedback{white-space:pre-wrap;overflow-wrap:anywhere}
.ref-work-tabs{display:flex;align-items:center;gap:8px;border-bottom:1px solid #2e4059;padding:8px 4px;flex:none}.ref-work-tabs button{background:none;border:1px solid transparent;border-radius:7px;padding:7px 13px;color:#92accf;font:inherit;font-size:13px}.ref-work-tabs button[aria-selected=true]{background:#213957;border-color:#365c9e;color:#dceaff}.ref-work-tabs .ref-work-expand{margin-left:auto;font-size:12px}.ref-work-log{flex:1;min-height:0;overflow:auto;padding:16px 4px;overscroll-behavior:contain}.ref-work-log[hidden]{display:none!important}.ref-work-intro{color:#92accf;font-size:12px;line-height:1.7;padding:0 3px 14px}.ref-work-record{border:1px solid #304763;border-radius:10px;margin-bottom:12px;background:linear-gradient(135deg,#1a2b40,#132233);overflow:hidden}.ref-work-record>summary{display:flex;align-items:center;gap:10px;cursor:pointer;padding:13px 15px;list-style:none;min-width:0}.ref-work-record>summary:before{content:'▸';color:#88b6ed}.ref-work-record[open]>summary:before{content:'▾'}.ref-work-record>summary strong{font-size:14px;min-width:0;overflow-wrap:anywhere}.ref-work-record>summary small{color:#8fa9ca;font-size:11px;margin-left:auto;text-align:right;flex:none;line-height:1.7}.ref-work-record[data-status=error]{border-color:#815457}.ref-work-record[data-status=running]{border-color:#a28b4e}.ref-work-body{padding:0 15px 14px}.ref-work-body label{display:block;color:#94aecf;font-size:12px;margin:9px 0 6px}.ref-work-pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;background:#0b1725;border:1px solid #293b51;border-radius:7px;padding:12px;color:#d4e1f3;font-family:'Microsoft YaHei','Segoe UI',sans-serif;font-size:13px;line-height:1.75;margin:0}.ref-work-body img{max-width:100%;height:auto;border-radius:7px;margin-top:10px}.ref-work-live{color:#afc8e8;font-size:13px;line-height:1.7;margin:12px 3px}.ref-work-record time{color:#8fa9ca}.ref-work-source{color:#819bbd;font-size:11px;margin-top:9px}
.ref-chat-log[hidden]{display:none!important}.ref-chat-shell .ref-chat-compose textarea{height:60px;min-height:60px;max-height:160px;resize:none;overflow-y:auto}.ref-chat-header{min-height:84px}.ref-chat-shell{padding-top:0}
.ref-chat-history-picker{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0;color:#91a9c7;font-size:12px}.ref-chat-history-picker select{max-width:200px;min-width:0;background:#17283d;color:#dbe7fa;border:1px solid #354962;border-radius:7px;padding:8px;font:inherit}.ref-chat-header>div{flex:1}.ref-chat-history-picker select:focus-visible{outline:2px solid #68baff}@media(max-width:760px){.ref-chat-header{flex-wrap:wrap}.ref-chat-history-picker{width:100%;margin-left:0}.ref-chat-history-picker select{flex:1;max-width:none}}
.ref-ui:not(.ref-room-active) .ref-chat-shell{display:none}.ref-chat-header>div{min-width:0}.ref-chat-header strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ref-chat-bubble>[class*="markdown"]{color:#dbe7f9!important;font-size:15px!important;line-height:1.75!important}.ref-chat-bubble :is(p,li,strong,em,blockquote){color:inherit!important}.ref-chat-bubble :is(h1,h2,h3,h4){color:inherit!important;font-size:17px!important;line-height:1.6!important;margin:14px 0 8px}.ref-chat-bubble :is(code,pre){color:#d3e4ff!important;background:#132237!important}.ref-chat-bubble code{font-size:13px!important}.ref-chat-avatar{border-radius:50%!important}.ref-chat-bubble table{max-width:100%;display:block;overflow:auto}
.ref-chat-bubble{white-space:normal!important}.ref-chat-bubble p{margin:0 0 10px}.ref-chat-bubble p:last-child{margin-bottom:0}.ref-chat-bubble ul,.ref-chat-bubble ol{padding-left:22px}.ref-chat-bubble pre{white-space:pre;max-width:100%;overflow:auto}.ref-chat-bubble img{max-width:100%}.ref-chat-bubble a{color:#99c8ff}.ref-chat-avatar>.ref-icon{width:29px;height:29px}
.ref-nav .ref-contact-search{display:flex;align-items:center;gap:8px;margin:20px 0 12px}.ref-contact-search input{width:100%;min-width:0;border:1px solid #30435e;border-radius:9px;background:#162334;color:#c9d8ee;padding:12px;font:inherit;font-size:13px}.ref-contact-tabs{display:flex;border-bottom:1px solid #2b3e57;margin-bottom:12px}.ref-contact-tabs button{flex:1;border:0;background:none;color:#8da1bf;padding:12px 4px;font:inherit;cursor:pointer}.ref-contact-tabs button.selected{color:#5590ff;border-bottom:3px solid #447eff}.ref-contact-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px}.ref-contact{display:flex;align-items:center;gap:14px;flex-shrink:0;width:100%;padding:16px 10px;border:1px solid transparent;border-bottom-color:#283b52;border-radius:10px;background:none;color:#dae7fa;text-align:left;cursor:pointer;font:inherit}.ref-contact.selected{border-color:#365c9e;background:linear-gradient(100deg,#223962,#1b2e50);box-shadow:inset 0 0 20px #386bce12}.ref-contact:hover{background-color:#203552}.ref-contact-copy{min-width:0;flex:1}.ref-contact strong{display:block;font-size:16px;font-weight:600;line-height:25px}.ref-contact small{display:block;font-size:13px;color:#8daecc;line-height:23px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ref-chat-avatar{position:relative;width:52px;height:52px;flex:none;border-radius:50%;background:linear-gradient(140deg,#4075ea,#2555d3);display:grid;place-items:center;color:#fff;font-size:27px;overflow:hidden}.ref-chat-avatar img{width:100%;height:100%;object-fit:cover}.ref-chat-avatar.seed{background:#e5efeb}.ref-chat-avatar.human{background:linear-gradient(140deg,#557898,#2c465e);font-size:19px}.ref-contact-note{font-size:12px;color:#92a9c7;padding:10px;line-height:1.6}.ref-chat-shell{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;padding:0 18px}.ref-chat-header{display:flex;align-items:center;gap:12px;padding:14px 4px;border-bottom:1px solid #2e4059;flex:none}.ref-chat-header strong{font-size:16px}.ref-chat-header small{display:block;font-size:12px;color:#91a9c7;margin-top:4px}.ref-chat-log{flex:1;min-height:0;overflow:auto;padding:22px 4px;overscroll-behavior:contain}.ref-chat-row{display:flex;align-items:flex-start;gap:12px;margin:0 0 20px}.ref-chat-row.mine{flex-direction:row-reverse}.ref-chat-row .ref-chat-avatar{width:38px;height:38px;font-size:20px}.ref-chat-content{max-width:82%;min-width:0}.ref-chat-meta{display:flex;align-items:center;gap:12px;font-size:12px;color:#94abc7;margin-bottom:6px;flex-wrap:wrap}.mine .ref-chat-meta{justify-content:flex-end}.ref-chat-bubble{border:1px solid #354962;background:linear-gradient(135deg,#223248,#1b2c40);border-radius:3px 15px 15px;padding:13px 17px;color:#dbe7f9;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.75}.mine .ref-chat-bubble{border-color:#3961a1;background:linear-gradient(135deg,#294b7d,#223d68);border-radius:15px 3px 15px 15px}.ref-chat-empty{color:#90a8c8;text-align:center;padding:36px 15px;line-height:1.8}.ref-chat-compose{flex:none;border:1px solid #355c9b;border-radius:10px;padding:9px 12px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-end;background:#142135}.ref-chat-compose textarea{flex:1;min-width:0;resize:vertical;min-height:44px;max-height:180px;border:1px solid #597980;border-radius:3px;background:#182839;color:#dce8fa;padding:9px 12px;font:inherit;font-size:14px;line-height:1.5}.ref-chat-compose button{width:45px;height:45px;background:#306bff;color:white;border:0;border-radius:8px;cursor:pointer}.ref-chat-compose button:disabled{opacity:.4;cursor:default}.ref-chat-compose .ref-icon{width:25px;height:25px}.ref-chat-feedback{flex:none;font-size:12px;line-height:1.6;color:#9eb4cf;padding:0 5px 8px}.ref-room-active>.yb-root>.yb-list,.ref-room-active>.yb-root>.yb-foot{display:none!important}.ref-room-active>.yb-root>.ref-chat-shell{display:flex}.ref-nav{display:flex;flex-direction:column}.ref-nav .ref-profile{flex:none}.ref-nav .ref-chat-settings{font-size:12px;color:#8ea6c4;background:none;border:0;cursor:pointer;padding:8px}.ref-chat-shell[hidden]{display:none!important}
@media(max-width:760px){.ref-nav .ref-contact-search,.ref-nav .ref-contact-tabs,.ref-nav .ref-contact-copy,.ref-nav .ref-contact-note,.ref-nav .ref-chat-settings{display:none}.ref-contact{padding:12px 0;justify-content:center}.ref-contact .ref-chat-avatar{width:43px;height:43px}.ref-chat-shell{padding:0 10px}.ref-chat-content{max-width:85%}.ref-chat-bubble{font-size:14px;padding:10px 12px}.ref-chat-meta{font-size:11px;gap:5px}.ref-chat-header{padding:10px 0}}

.ref-agent-run{margin:0 10px 16px;padding:12px;border:1px solid #354f6c;border-radius:13px;background:linear-gradient(120deg,#1b2b40,#182839);color:#dae7f9;min-width:0;overflow:hidden}.ref-run-header{display:flex;align-items:center;gap:12px;padding:0 0 10px}.ref-run-header .ref-chat-avatar{width:38px;height:38px;font-size:21px}.ref-run-header>div{display:flex;align-items:center;gap:12px;min-width:0}.ref-run-header strong{font-size:15px}.ref-run-status{font-size:12px;color:#93b4d4}.ref-run-header time{margin-left:auto;font-size:12px;color:#96b4d3;white-space:nowrap}.ref-run-body{max-height:min(420px,48vh);overflow:auto;overflow-anchor:none;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#486281 transparent;padding:0 4px 0 48px}.ref-run-body .ref-chat-row{margin:0 0 12px}.ref-run-body .ref-chat-row>.ref-chat-avatar{display:none}.ref-run-body .ref-chat-content{width:100%;max-width:100%}.ref-run-body .ref-chat-meta{font-size:11px;margin-bottom:4px}.ref-run-body .ref-chat-meta>span{display:none}.ref-run-body .ref-chat-bubble{background:#13223566;border:1px solid #314960;border-radius:8px;padding:10px 12px;font-size:14px;line-height:1.65}.ref-run-body .ref-work-record{margin:0;border-radius:0;border-color:#334c65;background:#18293b99}.ref-run-body .ref-work-record:first-child{border-radius:8px 8px 0 0}.ref-run-body .ref-work-record:last-child{border-radius:0 0 8px 8px}.ref-run-body .ref-work-record summary{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px 12px}.ref-run-body .ref-work-record summary:before{display:none}.ref-run-symbol{color:#58a7ff}.ref-run-symbol .ref-icon{width:21px;height:21px}.ref-run-preview{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#98adc7;font-size:12px;margin-top:4px}.ref-run-body .ref-work-record[open] .ref-run-preview{display:none}.ref-run-live{padding:10px;color:#9fbede;font-size:13px}.ref-agent-run[data-status=running]{border-color:#46729e}.ref-agent-run[data-status=running] .ref-run-status{color:#7ebdff}
@media(max-width:760px){.ref-agent-run{margin:0 0 12px;padding:10px}.ref-run-body{padding-left:0;max-height:min(360px,46vh)}.ref-run-header{flex-wrap:wrap}.ref-run-header time{font-size:10px}.ref-run-header>div{gap:8px}.ref-run-body .ref-work-record summary{grid-template-columns:20px minmax(0,1fr);gap:6px}.ref-run-body .ref-work-record summary>small{grid-column:2;text-align:left}.ref-run-preview{max-width:100%}}
`;
// Human Room projection only. This component never builds Agent input.
const HUMAN_MESSAGE_LIMIT=100; // 用户：每个聊天室前端只显示最近100条，原始历史保留。
// Local read-through cache, never a second authoritative message store.
const chatDatabase=new Promise(resolve=>{
 try{const r=indexedDB.open('persona-human-chat-cache',1);r.onupgradeneeded=()=>r.result.createObjectStore('rooms',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);r.onblocked=()=>resolve(null);}catch{resolve(null);}
});
async function cachedChats(owner){const db=await chatDatabase;if(!db)return [];return new Promise(resolve=>{const r=db.transaction('rooms').objectStore('rooms').getAll();r.onsuccess=()=>resolve(r.result.filter(x=>x.owner===owner&&x.version===1));r.onerror=()=>resolve([]);});}
async function saveChatCache(owner,snapshot){const db=await chatDatabase;if(!db)return false;return new Promise(resolve=>{const tx=db.transaction('rooms','readwrite');tx.objectStore('rooms').put({...snapshot,key:owner+'|'+snapshot.roomId,owner,version:1,cachedAt:Date.now()});tx.oncomplete=()=>resolve(true);tx.onerror=()=>resolve(false);tx.onabort=()=>resolve(false);});}
async function pruneChatCache(owner,allowed){const db=await chatDatabase;if(!db)return;const rows=await cachedChats(owner);const tx=db.transaction('rooms','readwrite');for(const row of rows)if(!allowed.has(row.roomId))tx.objectStore('rooms').delete(row.key);}
function contactEntries(rooms,owner){
 const entries=new Map(),seen=new Set();
 for(const room of rooms){
  if(seen.has(room.room_id))continue;seen.add(room.room_id);
  const personal=!room.activity_sessions?.length&&room.room_type==='direct'&&room.participants.length===2&&room.participants.includes(owner);
  const key=personal?'person:'+room.participants.find(id=>id!==owner):'room:'+room.room_id;
  if(!entries.has(key))entries.set(key,{key,rooms:[]});entries.get(key).rooms.push(room);
 }
 for(const entry of entries.values())entry.rooms.sort((a,b)=>(Date.parse(a.created_at)||Infinity)-(Date.parse(b.created_at)||Infinity)||a.room_id.localeCompare(b.room_id));
 return [...entries.values()];
}
// Pure human renderer model; stable owner/session/turn keys, never Agent input.
const messageTime=m=>Date.parse(m.local_state?m.client_observed_at:m.timestamp)||0;
function deliverySummary(message,execution,unavailable=false){
 if(message.local_state){const label={sending:'正在保存消息…',save_failed:'消息保存失败：'+(message.local_error??'请求被拒绝'),unconfirmed:'保存未确认：'+(message.local_error??'连接超时')+'；正在核对原记录，未重复发送。'}[message.local_state]??'保存未确认';return {state:message.local_state==='sending'?'sending':'failed',label};}
 const receipts=(execution?.agents??[]).flatMap(a=>a.deliveries??[]).filter(d=>d.message_id===message.message_id);
 if(!receipts.length)return {state:unavailable?'unknown':'saved',label:unavailable?'消息已保存；交付状态连接暂时不可用。':'消息已保存；正在查询交付状态…'};
 const failed=receipts.some(d=>['failed','interrupted'].includes(d.stage)),label='消息已保存\n'+receipts.map(d=>d.display_name+'：'+d.label+(d.phase?.step!=null&&d.stage==='processing'?'（第 '+d.phase.step+' 步）':'')+(d.error?'\n'+d.error.message+' ['+d.error.code+']':'')).join('\n');
 return {state:failed?'failed':receipts.some(d=>d.stage==='processing')?'processing':receipts.every(d=>['replied','completed','no_action','ignored'].includes(d.stage))?'completed':'waiting',label:label+(unavailable&&!failed?'\n状态连接暂时不可用，以上为最近记录。':'')};
}
function groupRunTimeline(messages,execution,owner,historyMessages=messages){
 const models=new Map(),bindings=new Map(),nativeBindings=new Map();
 const ready=execution?.scope==='room-linked-execution'&&(execution.agents??[]).every(a=>Array.isArray(a.runs));
 for(const agent of execution?.scope==='room-linked-execution'?execution.agents??[]:[])for(const run of agent.runs??[]){
  const model={kind:'run',key:run.run_id,life_id:run.life_id,session_id:run.session_id,display_name:run.display_name,status:run.status,legacy:run.legacy,time:Number.isFinite(run.first_visible_time)?run.first_visible_time:0,items:(run.rows??[]).map(row=>({kind:'work',row:{...row,legacy:run.legacy},time:row.time??0,seq:row.seq,rank:0}))};
  model.admitted=run.admitted;
  model.phase=run.phase;
  if(run.decision?.kind==='no_action')model.items.push({kind:'decision',decision:run.decision,life_id:run.life_id,session_id:run.session_id,display_name:run.display_name,time:run.decision.time,seq:run.decision.seq,rank:2});
  models.set(model.key,model);for(const id of run.message_ids??[])bindings.set(run.life_id+':'+id,run.run_id);
  for(const [seq,id]of Object.entries(agent.native_event_runs??{}))if(id===run.run_id)nativeBindings.set(run.life_id+':'+run.session_id+':'+seq,id);
 }
 for(const message of messages){const time=messageTime(message),item={kind:'message',message,time,seq:message.source_ref?.event_seq??message.seq,rank:1};
  const agent=String(message.sender_id).startsWith('life-');
  if(!agent||message.sender_id===owner){models.set('human:'+message.message_id,{kind:'human',key:'human:'+message.message_id,time,item});continue;}
  // Wait for association metadata on first load instead of briefly splitting a
  // known multi-step run into independent AI bubbles. Human text renders now.
  if(!ready&&!execution?.error)continue;
  const runId=bindings.get(message.sender_id+':'+message.message_id)??nativeBindings.get(message.sender_id+':'+message.source_ref?.session_id+':'+message.source_ref?.event_seq);
  const key=runId??'unlinked:'+message.sender_id+':'+message.message_id;
  if(!models.has(key))models.set(key,{kind:'run',key,life_id:message.sender_id,session_id:message.origin_session_id??message.source_ref?.session_id,display_name:message.display_name??message.sender_id,status:'unknown',legacy:false,time,items:[]});
  const model=models.get(key);model.items.push(item);model.time=Math.min(model.time,time);
 }
 // The recent-message window chooses runs, but must not cut the beginning of
 // a selected run. Supplement its older public chunks from the already
 // permission-filtered chat history, never from a guessed time interval.
 const cutoff=messages.length?Math.min(...messages.map(messageTime)):0;
 for(const [key,model]of models)if(model.kind==='run'&&!model.items.some(i=>i.kind==='message'||i.time>=cutoff))models.delete(key);
 const recentIds=new Set(messages.map(m=>m.message_id));
 for(const message of historyMessages){if(recentIds.has(message.message_id))continue;
  const id=bindings.get(message.sender_id+':'+message.message_id)??nativeBindings.get(message.sender_id+':'+message.source_ref?.session_id+':'+message.source_ref?.event_seq),model=models.get(id);
  if(model)model.items.push({kind:'message',message,time:Date.parse(message.timestamp)||0,seq:message.source_ref?.event_seq??message.seq,rank:1});
 }
 for(const model of models.values())if(model.kind==='run')model.items.sort((a,b)=>(a.kind==='decision')-(b.kind==='decision')||a.time-b.time||a.seq-b.seq||a.rank-b.rank);
 return [...models.values()].filter(m=>m.kind==='human'||m.items.length).sort((a,b)=>a.time-b.time||a.key.localeCompare(b.key));
}
function reconcileChildren(parent,children){const keep=new Set(children);for(const n of [...parent.children])if(!keep.has(n))n.remove();let cursor=parent.firstElementChild;for(const n of children){if(n===cursor)cursor=cursor.nextElementSibling;else parent.insertBefore(n,cursor);}}
function installChats({nav,root,workspace,added,onSelect}){
 let disposed=false,catalog={rooms:[],lives:[],statuses:[]},selected=null,tab='all',pane='chat',polling=false,initialized=false;
 const views=new Map(),inFlight=new Map();
 const clearView=view=>{view.resizeObserver?.disconnect();view.roots.forEach(root=>root.unmount());view.roots=[];};
 const retained=window.__personaHumanChats??={selected:null,drafts:{},pending:{}};
 retained.attachments??={};retained.uploading??={};
 retained.confirmed??={};
 retained.contactRooms??={};
 const scrollStorageKey='persona.chat-scroll.v1';let scrollSaveTimer;
 if(!retained.scrollPositions){try{retained.scrollPositions=JSON.parse(localStorage.getItem(scrollStorageKey)||'{}');}catch{retained.scrollPositions={};}}
 if(!retained.scrollPositions||typeof retained.scrollPositions!=='object'||Array.isArray(retained.scrollPositions))retained.scrollPositions={};
 function persistScroll(){clearTimeout(scrollSaveTimer);try{localStorage.setItem(scrollStorageKey,JSON.stringify(retained.scrollPositions));}catch{}}
 function saveScrollSoon(){clearTimeout(scrollSaveTimer);scrollSaveTimer=setTimeout(persistScroll,120);}
 const unitId=n=>n.dataset.runId??n.dataset.messageId;
 function captureScroll(view){
  const node=view?.node;if(!node||node.hidden||!node.clientHeight||!view.restored||!principal())return;
  const state=view.scrollState,rect=node.getBoundingClientRect(),anchor=[...node.children].find(n=>unitId(n)&&n.getBoundingClientRect().bottom>rect.top+1);
  state.top=node.scrollTop;state.bottom=node.scrollHeight-node.scrollTop-node.clientHeight<40;
  state.anchor=anchor?{id:unitId(anchor),offset:anchor.getBoundingClientRect().top-rect.top}:null;
  const inner={};for(const [id,card]of view.cards??[]){const body=card.body;if(body.clientHeight)inner[id]={top:body.scrollTop,bottom:body.scrollHeight-body.scrollTop-body.clientHeight<30};}state.inner=inner;
  retained.scrollPositions[principal()]??={};retained.scrollPositions[principal()][node.dataset.roomId]=state;saveScrollSoon();
 }
 function restoreScroll(view){
  const node=view.node;if(disposed||node.hidden||!node.clientHeight||views.get(selected)!==view)return;
  const state=view.scrollState;
  for(const [id,card]of view.cards??[]){const saved=state.inner[id];if(saved&&card.body.clientHeight)card.body.scrollTop=saved.bottom?card.body.scrollHeight:saved.top;}
  const anchor=state.anchor&&[...node.children].find(n=>unitId(n)===state.anchor.id);
  if(state.bottom)node.scrollTop=node.scrollHeight;
  else if(anchor)node.scrollTop+=anchor.getBoundingClientRect().top-node.getBoundingClientRect().top-state.anchor.offset;
  else node.scrollTop=state.top;
  const ready=view.snapshot?.execution?.scope==='room-linked-execution'||view.snapshot?.execution?.error;
  if(ready){view.restored=true;captureScroll(view);}
 }
 function scheduleScroll(view){if(view.scrollFrame)return;view.scrollFrame=requestAnimationFrame(()=>{view.scrollFrame=null;restoreScroll(view);});}
 const request=async(path,input)=>{const response=await fetch('/api/persona.'+path,{...(input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{}),signal:AbortSignal.timeout(input?10000:8000)});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error??'聊天室暂时无法连接'),{code:value.code,status:response.status});return value;};
 const shell=el('section','ref-chat-shell');shell.hidden=true;shell.setAttribute('aria-label','聊天室');root.append(shell);added.push(shell);
 shell.innerHTML=`<header class="ref-chat-header"></header><div class="ref-chat-log" role="log" aria-label="聊天历史"></div><div class="ref-chat-feedback" role="status"></div><form class="ref-chat-compose"><textarea aria-label="聊天室消息" placeholder="写一条消息…"></textarea><button aria-label="发送聊天室消息" title="发送">${icon('send')}</button></form>`;
 let list=shell.querySelector('.ref-chat-log');list.remove();
 const input=shell.querySelector('textarea'),send=shell.querySelector('.ref-chat-compose button'),feedback=shell.querySelector('.ref-chat-feedback');
 const attachmentRail=el('div','ref-attachment-rail');attachmentRail.setAttribute('aria-label','待发送附件');shell.insertBefore(attachmentRail,shell.querySelector('form'));
 const picker=el('input','');picker.type='file';picker.multiple=true;picker.hidden=true;shell.append(picker);
 const add=el('button','ref-attachment-add',icon('clip'));add.type='button';add.setAttribute('aria-label','添加聊天附件');shell.querySelector('form').insertBefore(add,input);add.onclick=()=>picker.click();
 const isImage=f=>/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type??'')||/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name??'');
 const fileUrl=f=>'/api/persona.chatAttachment?'+new URLSearchParams({room_id:f.room_id,id:f.id});
 function openImage(f){const overlay=el('div','ref-attachment-viewer');overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','完整图片 '+f.name);const image=el('img','');image.src=fileUrl(f);image.alt=f.name;const close=el('button','ref-attachment-close','关闭');const previous=document.activeElement;const dismiss=()=>{overlay.remove();document.removeEventListener('keydown',key);previous?.focus();};const key=e=>{if(e.key==='Escape')dismiss();if(e.key==='Tab'){e.preventDefault();close.focus();}};close.onclick=dismiss;overlay.onclick=e=>{if(e.target===overlay)dismiss();};overlay.append(image,close);document.body.append(overlay);document.addEventListener('keydown',key);close.focus();}
 function fileCard(f,remove){const card=el('div','ref-attachment-card');card.dataset.attachmentId=f.id;const link=el(isImage(f)?'button':'a','');if(isImage(f)){link.type='button';link.setAttribute('aria-label','查看完整图片 '+f.name);const image=el('img','ref-attachment-thumb');image.src=fileUrl(f);image.alt=f.name;link.append(image);link.onclick=()=>openImage(f);}else{link.href=fileUrl(f);link.textContent='附件 · '+f.name;link.download=f.name;}card.append(link);const name=el('span','');name.textContent=f.name;card.append(name);if(remove){const b=el('button','','移除');b.type='button';b.setAttribute('aria-label','移除附件 '+f.name);b.onclick=remove;card.append(b);}return card;}
 function renderAttachments(){attachmentRail.replaceChildren();for(const f of retained.attachments[selected]??[])attachmentRail.append(fileCard(f,()=>{retained.attachments[selected]=retained.attachments[selected].filter(x=>x.id!==f.id);renderAttachments();}));if(retained.uploading[selected])attachmentRail.append(el('span','','正在上传附件…'));add.disabled=!catalog.rooms.find(r=>r.room_id===selected)?.access.can_send||!!retained.uploading[selected];send.disabled=add.disabled||!!retained.pending[selected];}
 async function intake(files,native=false){const room=selected;if((retained.attachments[room]??[]).length+files.length>32){feedback.textContent='每条消息最多 32 个附件';return;}if(!catalog.rooms.find(r=>r.room_id===room)?.access.can_send)return;retained.uploading[room]=(retained.uploading[room]??0)+1;renderAttachments();try{let saved=[];if(native){const r=await request('chatClipboard',{room_id:room});saved=r.files;if(r.errors?.length)feedback.textContent=r.errors.map(x=>x.name+': '+x.error).join('; ');}else for(const f of files){if(f.size>128*1024*1024)throw Error('单个附件不能超过 128 MB');const form=new FormData();form.set('room_id',room);form.set('file',f);const response=await fetch('/api/persona.chatUpload',{method:'POST',body:form});const v=await response.json();if(!response.ok)throw Error(v.error);retained.attachments[room]=[...(retained.attachments[room]??[]),{...v,room_id:room}];if(!disposed)renderAttachments();}retained.attachments[room]=[...(retained.attachments[room]??[]),...saved.map(f=>({...f,room_id:room}))];}catch(e){feedback.textContent=e.message;}finally{retained.uploading[room]--;if(!disposed)renderAttachments();}}
 picker.onchange=()=>{void intake(Array.from(picker.files));picker.value='';};let pasteCount=0;
 input.onpaste=e=>{pasteCount++;const files=Array.from(e.clipboardData?.files??[]);if(files.length){e.preventDefault();void intake(files);}else if(e.clipboardData?.items&&Array.from(e.clipboardData.items).some(i=>i.kind==='file')){e.preventDefault();void intake(Array.from(e.clipboardData.items).map(i=>i.getAsFile()).filter(Boolean));}};
 const attachmentMarker='\n\n[DSH 用户附件 v1]\n';
 function splitAttachments(body){const pos=body.lastIndexOf(attachmentMarker);if(pos<0)return {text:body,files:[]};try{const files=JSON.parse(body.slice(pos+attachmentMarker.length));if(!Array.isArray(files)||!files.every(f=>typeof f.id==='string'&&typeof f.room_id==='string'&&typeof f.name==='string'))return {text:body,files:[]};return {text:body.slice(0,pos),files};}catch{return {text:body,files:[]};}}
 function resizeInput(){input.style.height='0px';input.style.height=Math.min(160,Math.max(60,input.scrollHeight+2))+'px';input.style.overflowY=input.scrollHeight>160?'auto':'hidden';}
 function viewFor(id){if(!views.has(id)){const node=el('div','ref-chat-log'),work=el('div','ref-work-log');node.dataset.roomId=work.dataset.roomId=id;node.hidden=work.hidden=true;node.setAttribute('role','log');node.setAttribute('aria-label','聊天历史');work.setAttribute('aria-label','Agent工作记录');shell.insertBefore(node,feedback);shell.insertBefore(work,feedback);const saved=retained.scrollPositions[principal()]?.[id],view={node,work,roots:[],key:null,workKey:null,snapshot:null,restored:false,scrollState:saved?{...saved,inner:{...saved.inner}}:{top:0,bottom:true,anchor:null,inner:{}}};views.set(id,view);node.addEventListener('scroll',()=>captureScroll(view),true);view.resizeObserver=new ResizeObserver(()=>scheduleScroll(view));view.resizeObserver.observe(node);}return views.get(id);}
 function showPane(){for(const [id,v]of views){v.node.hidden=id!==selected;v.work.hidden=true;}void refreshLiveThinking();}
 nav.innerHTML=`<button class="ref-menu" aria-label="打开原生任务列表">${icon('menu')}</button>${img('deepseek-logo.png','ref-logo')}<div class="ref-contact-search"><input type="search" aria-label="搜索联系人" placeholder="搜索联系人…"></div><div class="ref-contact-tabs"><button data-tab="all" class="selected">联系人</button><button data-tab="groups">群组</button></div><div class="ref-contact-list"></div><div class="ref-contact-note" role="status">正在读取通讯录…</div><button class="ref-nav-item ref-chat-settings" data-name="设置">设置</button><button class="ref-profile" aria-label="选择原生任务"><span class="ref-letter">广</span><span class="ref-profile-name">用户</span>${icon('chevron')}</button>`;
 const principal=()=>catalog.principal?.sender_id;
 const life=id=>catalog.lives.find(l=>l.life_id===id);
 const name=id=>id===principal()?'用户':life(id)?.display_name??id;
 const title=room=>room.display_name??(room.room_type==='group'?(room.room_id==='public:living-room'?'公共聊天室':room.display_name??'群聊 · '+room.participants.map(name).join('、')):room.participants.includes(principal())?name(room.participants.find(id=>id!==principal())):room.participants.map(name).join(' ↔ '));
 const avatar=(id,group=false)=>group?`<span class="ref-chat-avatar">${icon('chat')}</span>`:life(id)?.kind==='legacy'?`<span class="ref-chat-avatar">${img('persona-avatar.png','')}</span>`:id===principal()?'<span class="ref-chat-avatar human">广</span>':'<span class="ref-chat-avatar seed">🌱</span>';
 const peerStatus=room=>catalog.statuses.find(s=>s.life_id===room.participants.find(id=>id!==principal()));
 const peerOffline=room=>room.room_type==='direct'&&room.participants.includes(principal())&&(peerStatus(room)?.worker_state==='offline'||peerStatus(room)?.phase==='offline');
 function roomStatus(room){if(room.room_type==='group')return room.participants.map(name).join('、');const s=peerStatus(room);return room.access?.can_send===false?'双方聊天 · 只读':peerOffline(room)?'离线 · 连接未恢复':s?.observation_stale||s?.busy==null?'状态未确认':s.busy?'正在活动':'在线';}
 function renderContacts(){
  const query=nav.querySelector('input').value.trim().toLowerCase();
  const entries=contactEntries(catalog.rooms,principal()).sort((a,b)=>{const rank=r=>r.room_type==='group'?2:!r.participants.includes(principal())?3:life(r.participants.find(id=>id!==principal()))?.kind==='legacy'?0:1;return rank(a.rooms[0])-rank(b.rooms[0]);}).filter(e=>(tab!=='groups'||e.rooms[0].room_type==='group')&&title(e.rooms[0]).toLowerCase().includes(query));
  const html=entries.map(entry=>{const room=entry.rooms.find(r=>r.room_id===retained.contactRooms[entry.key])??entry.rooms[0],active=entry.rooms.some(r=>r.room_id===selected);return `<button class="ref-contact ${active?'selected':''}" data-contact="${escape(entry.key)}" data-room="${escape(room.room_id)}" aria-label="${escape(title(room))}" aria-pressed="${active}">${avatar(room.participants.find(id=>id!==principal()),room.room_type==='group')}<span class="ref-contact-copy"><strong>${escape(title(room))}</strong><small>${escape(roomStatus(room))}</small><small>${room.access?.can_send===false?'已授权查看的会话':room.room_type==='group'?'分享生活，遇见彼此':entry.rooms.length>1?entry.rooms.length+' 个会话 · 与你在这里相遇':'与你在这里相遇'}</small></span></button>`;}).join('');
  const contacts=nav.querySelector('.ref-contact-list');if(contacts.innerHTML!==html){contacts.innerHTML=html;contacts.querySelectorAll('button').forEach(b=>b.onclick=()=>select(b.dataset.room));}
  nav.querySelector('.ref-contact-note').textContent=catalog.rooms.length?'按会话查看最近 100 条消息':'还没有可访问的聊天室';
 }
 const timestamp=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))+' 北京':'发生时间未知';
 function workHTML(r){
  const status={completed:'已完成',running:'执行中',error:'失败',unknown:'结果未知'}[r.status]??'已记录';
  const title=r.role==='thinking'?'思考':r.role==='tool'?'工具 · '+r.text:r.role==='progress'?'进展说明':'执行记录';
  const body=r.role==='tool'?`<label>调用参数</label><pre class="ref-work-pre">${escape(r.detail??'未记录参数')}</pre><label>执行结果</label><pre class="ref-work-pre">${escape(r.result??(r.status==='running'?'等待工具返回…':'未记录到结果；不推断成功。'))}</pre>${r.legacy?(r.image_refs??[]).map(im=>`<img loading="lazy" src="/api/persona.screenshot?${new URLSearchParams({sessionId:r.session_id,attachmentId:im.attachmentId})}" alt="此次工具调用的截图">`).join(''):(r.image_refs?.length?'<label>原始结果还包含 '+r.image_refs.length+' 个图像附件。</label>':'')}`:`<pre class="ref-work-pre">${escape(r.role==='result'?r.detail??r.text:r.text)}</pre>`;
  const brief=r.role==='tool'?(r.result??r.detail??''):r.text;
  return `<summary><span class="ref-run-symbol">${icon(r.role==='tool'?'work':'chat')}</span><span><strong>${escape(title)}</strong><span class="ref-run-preview">${escape(String(brief).slice(0,180))}</span></span><small>${escape(status)}${Number.isFinite(r.durationMs)?' · '+(r.durationMs/1000).toFixed(1)+'s':''}</small></summary><div class="ref-work-body">${body}<div class="ref-work-source">${escape(timestamp(r.timestamp))} · 原生日志事件 #${r.seq}${r.resultSeq!=null?' → 结果 #'+r.resultSeq:''}</div></div>`;
 }
 let displayRoom=null,displayController=null,displayTimer;
 function paintDisplay(view){
  if(!view||view.node.hidden)return;
  captureScroll(view);
  for(const card of view.cards?.values()??[]){
   const a=view.liveStreams?.find(x=>x.active?.run_id===card.node.dataset.runId)?.active;
   if(!a||card.node.dataset.status!=='running'){card.live?.remove();card.live=null;continue;}
   if(!a.reasoning&&!a.text)continue;
   if(!card.live){card.live=el('div','ref-run-live');card.live.innerHTML='<details class="ref-live-reasoning" open><summary>实时思考</summary><pre class="ref-work-pre ref-live-thinking"></pre></details><div class="ref-live-output ref-chat-bubble" aria-label="实时正文"></div>';card.body.append(card.live);}
   const thinking=card.live.querySelector('.ref-live-thinking'),output=card.live.querySelector('.ref-live-output');
   card.live.querySelector('details').hidden=!a.reasoning;
   if(thinking.textContent!==a.reasoning)thinking.textContent=a.reasoning;
   output.hidden=!a.text;if(output.textContent!==a.text)output.textContent=a.text;
   card.node.querySelector('.ref-run-status').textContent=a.text?'正在输出':'正在思考';
  }
  restoreScroll(view);scheduleScroll(view);
 }
 function refreshLiveThinking(){
  if(disposed||!selected)return;
  if(displayRoom===selected){paintDisplay(views.get(selected));return;}
  displayController?.abort();clearTimeout(displayTimer);displayRoom=selected;
  const room=selected,owner=principal();
  const read=async()=>{
   if(disposed||displayRoom!==room)return;const controller=new AbortController();displayController=controller;
   try{
    const r=await fetch('/api/persona.chatStream?'+new URLSearchParams({room_id:room}),{signal:controller.signal});if(!r.ok)throw Error('STREAM_UNAVAILABLE');
    const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(!disposed&&displayRoom===room){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
     while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!frame.startsWith('data: '))continue;
      const data=JSON.parse(frame.slice(6));if(data.room_id!==room||owner!==principal())continue;
      const view=views.get(room);if(!view)continue;const ended=view.liveStreams?.some(x=>x.active&&!data.agents.some(y=>y.active?.attempt_id===x.active.attempt_id&&y.life_id===x.life_id));
      view.liveStreams=data.agents;paintDisplay(view);if(ended){void refreshRunState();void loadMessages(room).catch(()=>{});}
     }
    }
   }catch{/* Keep the last visible text across a temporary disconnect. */}
   finally{if(!disposed&&displayRoom===room&&!controller.signal.aborted)displayTimer=setTimeout(read,1000);}
  };void read();
 }
 let runStateBusy=false;
 async function refreshRunState(){if(runStateBusy||disposed)return;const id=selected,view=views.get(id),owner=principal();if(!view?.snapshot)return;runStateBusy=true;
  try{const execution=await request('chatExecution?room_id='+encodeURIComponent(id));if(!disposed&&owner===principal()&&views.get(id)===view&&execution.scope==='room-linked-execution'){view.executionUnavailable=false;renderSnapshot({...view.snapshot,execution});}}catch{if(!disposed&&views.get(id)===view){view.executionUnavailable=true;renderSnapshot(view.snapshot);}}finally{runStateBusy=false;}
 }
 function renderHeader(room){
  const entry=contactEntries(catalog.rooms,principal()).find(e=>e.rooms.some(r=>r.room_id===room.room_id));
  const picker=entry.rooms.length>1?`<label class="ref-chat-history-picker">会话<select aria-label="切换此联系人的会话">${entry.rooms.map((r,i)=>`<option value="${escape(r.room_id)}" ${r.room_id===room.room_id?'selected':''}>${escape(r.display_name??(i===0?'主要会话':'会话 '+(i+1)+' · '+timestamp(r.created_at)))}</option>`).join('')}</select></label>`:'';
  const header=shell.querySelector('.ref-chat-header'),html=`${avatar(room.participants.find(id=>id!==principal()),room.room_type==='group')}<div><strong>${escape(title(room))}</strong><small>${escape(room.participants.map(name).join(' ↔ '))}${room.access.can_send?'':' · 只读会话'}</small>${peerOffline(room)?'<small class="ref-chat-connection">对方连接未恢复；消息会保存，恢复后再交付。</small>':''}<small class="ref-chat-count"></small></div>${picker}`;
  if(header.dataset.content===html)return;header.innerHTML=html;header.dataset.content=html;
  const selectRoom=header.querySelector('select');if(selectRoom)selectRoom.onchange=()=>select(selectRoom.value);
  const snapshot=views.get(room.room_id)?.snapshot;if(snapshot)shell.querySelector('.ref-chat-count').textContent=`最近 ${snapshot.messages.length} 条消息${snapshot.historyCount>snapshot.messages.length?' · 完整历史已保留':''}`;
 }
 function renderSnapshot(snapshot){
  const {roomId,messages,room,historyCount}=snapshot,view=viewFor(roomId),node=view.node;
  view.snapshot=snapshot;view.entries??=new Map();view.cards??=new Map();view.runAnchors??=new Map();
  const displayMessages=[...messages,...(retained.confirmed[roomId]??[]).filter(m=>m.sender_id===principal()&&!messages.some(x=>x.message_id===m.message_id))];
  const pending=retained.pending[roomId];if(pending&&(!pending.owner||pending.owner===principal())&&!displayMessages.some(m=>m.message_id===pending.message_id))displayMessages.push({room_id:roomId,message_id:pending.message_id,sender_id:principal(),display_name:'用户',body:pending.body,seq:Number.MAX_SAFE_INTEGER,timestamp:null,client_observed_at:pending.client_observed_at,local_state:pending.local_state??'unconfirmed',local_error:pending.local_error});
  const models=groupRunTimeline(displayMessages.slice(-HUMAN_MESSAGE_LIMIT),snapshot.execution,principal(),snapshot.runMessages??messages);
  captureScroll(view);const usedEntries=new Set(),usedCards=new Set();
  const entryNode=item=>{
   const key=item.kind==='decision'?'decision:'+item.life_id+':'+item.session_id+':'+item.decision.seq:item.kind==='message'?'message:'+item.message.message_id:'work:'+item.row.life_id+':'+item.row.session_id+':'+item.row.id;
   usedEntries.add(key);let entry=view.entries.get(key);
   if(!entry){entry={node:el(item.kind==='message'||item.kind==='decision'?'article':'details',item.kind==='decision'?'ref-chat-row ref-run-decision':item.kind==='message'?'ref-chat-row':'ref-work-record'),key:null,root:null};view.entries.set(key,entry);}
   const receipt=item.kind==='message'&&item.message.sender_id===principal()?deliverySummary(item.message,snapshot.execution,view.executionUnavailable):null;
   const contentKey=JSON.stringify([item.kind==='decision'?item:item.kind==='message'?item.message:item.row,receipt]);
   if(entry.key!==contentKey){
    const n=entry.node;
    if(item.kind==='decision'){n.dataset.lifeId=item.life_id;n.dataset.sessionId=item.session_id;n.dataset.eventSeq=item.decision.seq;n.dataset.time=item.time;n.innerHTML=`<div class="ref-chat-content"><div class="ref-chat-meta"><span>本轮选择</span><time>${escape(timestamp(new Date(item.time).toISOString()))}</time></div><div class="ref-chat-bubble">${escape(item.display_name)}选择不行动</div></div>`;
    }else if(item.kind==='message'){const m=item.message;n.className='ref-chat-row'+(m.sender_id===principal()?' mine':'');n.dataset.messageId=m.message_id;n.dataset.roomId=m.room_id;n.dataset.time=String(Date.parse(m.timestamp)||0);
     if(!entry.root){n.innerHTML=`${avatar(m.sender_id)}<div class="ref-chat-content"><div class="ref-chat-meta"></div><div class="ref-chat-bubble"></div></div>`;entry.root=createRoot(n.querySelector('.ref-chat-bubble'));view.roots.push(entry.root);}
     n.querySelector('.ref-chat-meta').innerHTML=`<span>${escape(m.display_name??name(m.sender_id))}</span><time>${escape(m.local_state?'本地待确认':timestamp(m.timestamp))}</time>`;
     if(receipt){let status=n.querySelector('.ref-message-delivery');if(!status){status=el('div','ref-message-delivery');status.setAttribute('role','status');n.querySelector('.ref-chat-content').append(status);}status.dataset.state=receipt.state;status.textContent=receipt.label;n.dataset.deliveryState=receipt.state;}
     const parts=splitAttachments(m.body);flushSync(()=>entry.root.render(React.createElement(MarkdownText,{text:parts.text,labels:{code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'注释'}})));let rail=n.querySelector('.ref-message-attachments');if(!rail){rail=el('div','ref-attachment-rail ref-message-attachments');n.querySelector('.ref-chat-content').append(rail);}rail.replaceChildren(...parts.files.filter(f=>f.room_id===m.room_id).map(f=>fileCard(f)));
    }else{const r=item.row,open=n.open;n.dataset.executionId=r.life_id+':'+r.session_id+':'+r.id;n.dataset.lifeId=r.life_id;n.dataset.sessionId=r.session_id;n.dataset.eventSeq=r.seq;n.dataset.time=r.time??0;n.dataset.status=r.status??'completed';n.innerHTML=workHTML(r);n.open=open;}
    entry.key=contentKey;
   }return entry.node;
  };
  const units=models.map(model=>{
   if(model.kind==='human')return {node:entryNode(model.item),time:model.time,key:model.key};
   usedCards.add(model.key);let card=view.cards.get(model.key);
   if(!card){const n=el('article','ref-agent-run');n.dataset.runId=model.key;n.dataset.lifeId=model.life_id;n.dataset.sessionId=model.session_id??'';n.innerHTML='<header class="ref-run-header"></header><div class="ref-run-body"></div>';card={node:n,body:n.querySelector('.ref-run-body'),headerKey:null,live:null};view.cards.set(model.key,card);}
   // Pin the first visible time; completion and later appends never move a card.
   if(!view.runAnchors.has(model.key))view.runAnchors.set(model.key,model.time);
   const anchor=view.runAnchors.get(model.key);card.node.dataset.firstVisibleTime=String(anchor);card.node.dataset.status=model.status;
   const headKey=JSON.stringify([model.display_name,model.status,model.admitted,model.phase,view.executionUnavailable,anchor]);if(card.headerKey!==headKey){const status=view.executionUnavailable&&model.status==='running'?'运行状态连接暂时不可用 · 显示最近记录':model.status==='running'?(model.admitted?'已接收 · ':'')+(model.phase?.label??'正在处理…'):{failed:'处理失败',completed:'已完成',interrupted:'已中断',unknown:'状态未确认'}[model.status]??'已记录';card.node.querySelector('header').innerHTML=`${avatar(model.life_id)}<div><strong>${escape(model.display_name)}</strong><small class="ref-run-status">${escape(status)}</small></div><time>${escape(timestamp(anchor?new Date(anchor).toISOString():null))}</time>`;card.headerKey=headKey;}
   const visible=!node.hidden&&node.clientHeight>0,innerStick=visible&&card.body.children.length>0&&card.body.scrollHeight-card.body.scrollTop-card.body.clientHeight<40,innerTop=card.body.scrollTop;
   const children=model.items.map(entryNode);
   if(model.status==='running'){if(card.live)children.push(card.live);}else{card.live?.remove();card.live=null;}
   reconcileChildren(card.body,children);if(visible)card.body.scrollTop=innerStick?card.body.scrollHeight:innerTop;view.resizeObserver.observe(card.node);
   return {node:card.node,time:anchor,key:model.key};
  });
  units.sort((a,b)=>a.time-b.time||a.key.localeCompare(b.key));
  for(const [id,entry]of view.entries)if(!usedEntries.has(id)){entry.root?.unmount();view.roots=view.roots.filter(r=>r!==entry.root);entry.node.remove();view.entries.delete(id);}
  for(const [id,card]of view.cards)if(!usedCards.has(id)){card.node.remove();view.cards.delete(id);}
  if(units.length)reconcileChildren(node,units.map(x=>x.node));else{if(!node.querySelector('.ref-chat-empty'))node.innerHTML='<div class="ref-chat-empty">还没有公开消息或工作记录。</div>';}
  restoreScroll(view);scheduleScroll(view);view.key=JSON.stringify([room,messages]);void refreshLiveThinking();
  if(selected===roomId){shell.querySelector('.ref-chat-count').textContent=`最近 ${messages.length} 条消息${historyCount>messages.length?' · 完整历史已保留':''}`;
   const pending=retained.pending[roomId];if(pending&&messages.some(m=>m.message_id===pending.message_id)){delete retained.pending[roomId];if(retained.drafts[roomId]===(pending.draft??pending.body)){retained.drafts[roomId]='';if(selected===roomId){input.value='';resizeInput();}}retained.attachments[roomId]=(retained.attachments[roomId]??[]).filter(f=>!(pending.attachmentIds??[]).includes(f.id));if(selected===roomId)renderAttachments();}
   const latest=displayMessages.findLast(m=>m.sender_id===principal());if(latest){const state=deliverySummary(latest,snapshot.execution,view.executionUnavailable);feedback.textContent=state.label;feedback.dataset.state=state.state;feedback.setAttribute('role',state.state==='failed'?'alert':'status');}
  }
 }
 async function loadMessages(roomId){
  if(inFlight.has(roomId))return inFlight.get(roomId);
  const owner=principal();
  const operation=(async()=>{
   let after=0,messages=[],native=[],room,seen=new Set();
   for(;;){const page=await request('chatMessages?room_id='+encodeURIComponent(roomId)+'&after='+after);if(disposed||owner!==principal()||!catalog.rooms.some(r=>r.room_id===roomId))return;room={...page.room,display_name:catalog.rooms.find(r=>r.room_id===roomId)?.display_name};
    if(page.native_history)native=page.native_history;
    for(const message of page.messages){if(message.room_id!==roomId)throw Error('聊天室消息来源不符');if(!seen.has(message.message_id)){seen.add(message.message_id);messages.push(message);}}
    if(!page.hasMore)break;if(page.nextAfter<=after)throw Error('历史分页未前进');after=page.nextAfter;
   }
   retained.confirmed[roomId]=(retained.confirmed[roomId]??[]).filter(m=>!seen.has(m.message_id));
   native=native.filter(m=>m.room_id===roomId&&(!m.request_id||!seen.has(m.request_id)));
   messages=[...native,...messages].sort((a,b)=>native.length?((Date.parse(a.timestamp)||0)-(Date.parse(b.timestamp)||0))||a.seq-b.seq:a.seq-b.seq);
   const snapshot={roomId,room,historyCount:messages.length,messages:messages.slice(-HUMAN_MESSAGE_LIMIT),runMessages:messages,execution:views.get(roomId)?.snapshot?.execution};
   renderSnapshot(snapshot);
   snapshot.execution=await request('chatExecution?room_id='+encodeURIComponent(roomId)).catch(()=>snapshot.execution?.scope==='room-linked-execution'?snapshot.execution:{error:'工作记录暂时无法读取；聊天历史仍可查看。'});if(disposed||owner!==principal()||!catalog.rooms.some(r=>r.room_id===roomId))return;
   renderSnapshot(snapshot);await saveChatCache(owner,snapshot);
  })();inFlight.set(roomId,operation);try{return await operation;}finally{if(inFlight.get(roomId)===operation)inFlight.delete(roomId);}
 }
 function select(id){
  const room=catalog.rooms.find(r=>r.room_id===id);if(!room)return;
  const entry=contactEntries(catalog.rooms,principal()).find(e=>e.rooms.some(r=>r.room_id===id));retained.contactRooms[entry.key]=id;
  if(selected){retained.drafts[selected]=input.value;captureScroll(views.get(selected));}selected=id;retained.selected=id;
  onSelect();workspace.classList.add('ref-room-active');shell.hidden=false;renderContacts();
  renderHeader(room);
  input.value=retained.drafts[id]??'';input.disabled=!room.access.can_send;send.disabled=!room.access.can_send||!!retained.pending[id];input.placeholder=room.access.can_send?'写一条消息…':'已授权查看，不能代替他们发言';feedback.textContent=retained.pending[id]?'上次发送尚未确认，正在核对真实记录…':'';resizeInput();renderAttachments();
  const view=viewFor(id);view.restored=false;showPane();list=view.node;
  if(view.snapshot){renderSnapshot(view.snapshot);restoreScroll(view);scheduleScroll(view);}
  else if(!view.node.childElementCount)view.node.innerHTML='<div class="ref-chat-empty">首次载入聊天历史…</div>';
  void loadMessages(id).catch(error=>{if(selected===id&&!disposed){if(view.snapshot)renderSnapshot(view.snapshot);else feedback.textContent=error.message;}});
 }
 input.oninput=()=>{if(selected)retained.drafts[selected]=input.value;resizeInput();};
 shell.querySelector('form').onsubmit=async e=>{e.preventDefault();const id=selected,room=catalog.rooms.find(r=>r.room_id===id),draft=input.value,files=retained.attachments[id]??[],body=files.length?(draft.trim()||'请查看附件。')+attachmentMarker+JSON.stringify(files.map(({id,name,type,size,path,sha256,room_id})=>({id,name,type,size,path,sha256,room_id}))):draft,previous=retained.pending[id];if(!room?.access.can_send||!body.trim()||files.length>32||retained.uploading[id]||previous&&previous.local_state!=='save_failed')return;
  const pending={room_id:id,message_id:previous?.body===body?previous.message_id:'human-chat:'+crypto.randomUUID(),body,draft,attachmentIds:files.map(f=>f.id),owner:principal(),client_observed_at:new Date().toISOString(),local_state:'sending'};retained.pending[id]=pending;retained.drafts[id]=draft;send.disabled=true;
  const view=viewFor(id),snapshot=()=>view.snapshot??{roomId:id,room,historyCount:0,messages:[],runMessages:[]};renderSnapshot(snapshot());
  try{const receipt=await request('chatMessage',{room_id:id,message_id:pending.message_id,body}),m=receipt.message;
   if(receipt.state!=='saved'||m?.message_id!==pending.message_id||m.room_id!==id||m.sender_id!==pending.owner||m.body!==body)throw Error('保存回执与发送内容不一致');
   retained.confirmed[id]=[...(retained.confirmed[id]??[]).filter(x=>x.message_id!==m.message_id),m].slice(-10);delete retained.pending[id];if(retained.drafts[id]===draft)retained.drafts[id]='';retained.attachments[id]=(retained.attachments[id]??[]).filter(f=>!files.some(x=>x.id===f.id));renderAttachments();
   if(!disposed){if(selected===id){input.value=retained.drafts[id];resizeInput();send.disabled=!room.access.can_send;}renderSnapshot(snapshot());void refreshRunState();void loadMessages(id).catch(()=>{});}
  }catch(error){pending.local_state=error.code==='INVALID_CHAT_MESSAGE'?'save_failed':'unconfirmed';pending.local_error=error.name==='TimeoutError'?'10 秒内未收到保存确认':error.message;if(!disposed){if(selected===id&&pending.local_state==='save_failed')send.disabled=false;renderSnapshot(snapshot());void loadMessages(id).catch(()=>{});}}
 };
 input.onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'&&!e.altKey&&!e.shiftKey){const before=pasteCount,room=selected;setTimeout(()=>{if(!disposed&&selected===room&&pasteCount===before)void intake([],true);},150);}if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();shell.querySelector('form').requestSubmit();}};
 nav.querySelector('input').oninput=renderContacts;
 nav.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;nav.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('selected',x===b));renderContacts();});
 async function refresh(){
  if(disposed||polling)return;polling=true;
  try{
   const next=await request('chatRooms');if(disposed)return;
   const oldOwner=principal();catalog=next;const allowed=new Set(catalog.rooms.map(r=>r.room_id));
   if(oldOwner&&oldOwner!==principal()){for(const view of views.values()){clearView(view);view.node.remove();view.work.remove();}views.clear();selected=null;initialized=false;}
   for(const [id,view]of views)if(!allowed.has(id)){clearView(view);view.node.remove();view.work.remove();views.delete(id);}
   const remembered=retained.scrollPositions[principal()];if(remembered){for(const id of Object.keys(remembered))if(!allowed.has(id))delete remembered[id];saveScrollSoon();}
   renderContacts();
   if(!initialized){const cached=await cachedChats(principal());if(disposed)return;
    for(const snapshot of cached)if(allowed.has(snapshot.roomId)){snapshot.room=catalog.rooms.find(r=>r.room_id===snapshot.roomId);renderSnapshot(snapshot);}
    void pruneChatCache(principal(),allowed);initialized=true;
   }
   if(!allowed.has(selected)){selected=null;shell.hidden=true;workspace.classList.remove('ref-room-active');
    const first=catalog.rooms.find(r=>r.participants.includes(principal())&&life(r.participants.find(id=>id!==principal()))?.kind==='legacy')??catalog.rooms[0];
    if(first)select(allowed.has(retained.selected)?retained.selected:first.room_id);
   }else{const room=catalog.rooms.find(r=>r.room_id===selected);renderHeader(room);input.disabled=!room.access.can_send;send.disabled=!room.access.can_send||!!retained.pending[selected];}
   // Warm every authorized Room, at most two fetch/render operations at once.
   // Existing DOM stays mounted; inactive snapshots update in the background.
   const ids=[selected,...catalog.rooms.map(r=>r.room_id).filter(id=>id!==selected)].filter(Boolean);
   for(let i=0;i<ids.length;i+=2){if(disposed)return;await Promise.allSettled(ids.slice(i,i+2).map(loadMessages));}
  }catch(error){if(!disposed){nav.querySelector('.ref-contact-note').textContent='通讯录连接暂时不可用';if(!views.get(selected)?.snapshot)feedback.textContent=error.message;}}
  finally{polling=false;}
 }
 void refresh();const timer=setInterval(refresh,5000);
 const resizeObserver=new ResizeObserver(()=>{if(!disposed)resizeInput();});resizeObserver.observe(shell);
 const thinkingTimer=setInterval(()=>{void refreshRunState();void refreshLiveThinking();},1500);
 return {dispose(){captureScroll(views.get(selected));persistScroll();disposed=true;displayController?.abort();clearTimeout(displayTimer);clearInterval(timer);clearInterval(thinkingTimer);resizeObserver.disconnect();for(const view of views.values())clearView(view);if(selected)retained.drafts[selected]=input.value;workspace.classList.remove('ref-room-active');},select};

}
function apply(ctx){
 window.__personaStreamDisplayVersion='20261007-stream-1';
 ctx.effect(()=>{
  window.__personaReferenceCleanup?.();
  const style=el('style','');style.dataset.plugin='@local/persona-reference-ui';style.textContent=css+refinements+expansionStyles+layoutStyles+chatStyles+`
  .yb-workspace.ref-ui{--ref-control-height:44px;grid-template-rows:var(--ref-control-height) var(--ref-top-height) minmax(0,1fr)}
  .ref-ui>.ref-global-start{grid-column:2/4;grid-row:1;display:flex;align-items:center;gap:12px;padding:5px 14px;border-bottom:1px solid #26364a;min-width:0;z-index:46;background:#111c2b}
  .ref-global-start button{flex-shrink:0;border:1px solid #5684c7;background:#243e61;color:#e1edff;border-radius:7px;padding:6px 12px;font:13px 'Segoe UI',sans-serif;cursor:pointer}
  .ref-global-start button:disabled{opacity:.65;cursor:wait}.ref-global-start small{font:12px 'Segoe UI',sans-serif;color:#b5c9e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ref-life-control{display:flex;align-items:center;gap:6px;min-width:0}.ref-life-control strong{font:13px 'Segoe UI',sans-serif;white-space:nowrap}.ref-life-control button{padding:5px 10px}.ref-life-control button[data-action=stop]{background:#352c3c;border-color:#71566f}.ref-global-start{overflow-x:auto}
  .ref-ui>.ref-top{grid-row:2}.ref-ui>.ref-nav{grid-row:1/4}.ref-ui>.ref-dashboard,.ref-ui>.yb-root,.ref-ui>.ref-development{grid-row:3}
  .ref-ui>.ref-layout-toggle[data-region=top]{top:calc(var(--ref-control-height) + var(--ref-top-height) - 11px)}.ref-ui.ref-top-collapsed>.ref-layout-toggle[data-region=top]{top:calc(var(--ref-control-height) + 3px)}
  .ref-ui.ref-conversations-open>.yb-tasks{top:calc(var(--ref-control-height) + var(--ref-top-height))}
  @media(max-width:760px){.yb-workspace.ref-ui{--ref-control-height:80px}.ref-ui>.ref-global-start{padding:4px 8px;gap:2px;flex-wrap:wrap;align-content:center}.ref-global-start .ref-life-control{width:100%}.ref-global-start small{font-size:11px}.ref-global-start>[role=status]:empty{display:none}}
  `;document.head.append(style);
  let workspace=null,nav,top,hero,dashboard,development,globalControls,globalBusy=false,globalPolling=false,globalTimer,disposed=false,data={},timer,polling=false,scheduled=false;
  const added=[],expandedCards=new Set();let changesCollapsed=false,chats;
  const layoutKey='persona.reference-layout.v1';let layout={left:false,right:false,top:false};
  try{const saved=JSON.parse(localStorage.getItem(layoutKey));for(const region of Object.keys(layout))layout[region]=saved?.[region]===true;}catch{}
  const append=(parent,node,first=false)=>{first?parent.prepend(node):parent.append(node);added.push(node);return node;};
  function toast(text){const old=workspace.querySelector('.ref-toast');old?.remove();const box=el('div','ref-toast');box.textContent=text;box.setAttribute('role','status');workspace.append(box);setTimeout(()=>box.remove(),2800);}
  function navigate(name){workspace.classList.remove('ref-conversations-open');const chat=name==='对话';workspace.classList.toggle('ref-development-open',!chat);development.hidden=chat;development.style.display=chat?'none':'flex';development.querySelector('h1').textContent=name;nav.querySelectorAll('.ref-nav-item').forEach(b=>{const selected=b.dataset.name===name;b.classList.toggle('selected',selected);selected?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');});}
  function mount(w){
   workspace=w;w.classList.add('ref-ui');w.dataset.referenceUiVersion='1.0.0';
   // Recover wrappers left by an earlier presentation revision without changing
   // any of the conversation component's data or callbacks.
   for(const group of w.querySelectorAll('.yb-actions.ref-group')){const body=group.querySelector('.ref-operation-body');if(body&&body.parentElement!==group)group.insertBefore(body,group.querySelector('.ref-operation-pair'));body?.classList.remove('ref-operation-body');group.querySelector('.ref-operation-pair')?.remove();group.classList.remove('ref-group','ref-tools-open');}
   nav=append(w,el('nav','ref-nav'),true);nav.setAttribute('aria-label','主导航');
   const entries=[['人格','你的数字生命伙伴','home'],['对话','和人格聊任何事','chat'],['工作台','从想法到行动','work'],['挂念','你在意的事','heart'],['记忆','共同的记忆','memory'],['世界','连接更大的世界','world'],['今天','今日生活与进展','clock'],['插件','扩展能力','plugin'],['自动化任务','让人格持续工作','auto'],['设置','个性化与偏好','settings']];
   nav.innerHTML=`<button class="ref-menu" aria-label="展开对话列表">${icon('menu')}</button>${img('deepseek-logo.png','ref-logo')}<div class="ref-nav-items">${entries.map(([name,sub,symbol],i)=>`${i===7?'<div class="ref-nav-divider"></div>':''}<button class="ref-nav-item ${i===1?'selected':''}" data-name="${name}" ${i===1?'aria-current="page"':''}><span class="ref-nav-symbol">${icon(symbol)}</span><span class="ref-nav-text"><strong>${name}</strong><small>${sub}</small></span></button>`).join('')}</div><button class="ref-profile" aria-label="选择对话"><span class="ref-letter">F</span><span class="ref-profile-name">用户</span>${icon('chevron')}</button>`;
   nav.querySelectorAll('[data-name]').forEach(b=>b.onclick=()=>navigate(b.dataset.name));
   function conversations(){const wasOpen=w.classList.contains('ref-conversations-open');navigate('对话');w.classList.remove('ref-room-active');w.classList.toggle('ref-conversations-open',!wasOpen);if(!w.querySelector('.yb-tasks'))w.querySelector('.yb-status-switch [aria-controls="yb-navigation"]')?.click();}
   nav.querySelector('.ref-menu').onclick=conversations;nav.querySelector('.ref-profile').onclick=conversations;
   globalControls=append(w,el('div','ref-global-start'));globalControls.setAttribute('aria-label','生命全局控制');
   globalControls.innerHTML='<small role="status" aria-live="polite">正在读取两个生命的状态…</small>';
   globalControls.onclick=async event=>{
    const button=event.target.closest('button[data-life-id]');if(!button||globalBusy)return;
    delete data.controlError;globalBusy=true;renderGlobal();
    try{const r=await fetch('/api/persona.lifeControl',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({life_id:button.dataset.lifeId,action:button.dataset.action})});const result=await r.json();if(!r.ok)throw Error(result.error);data.global={...data.global,operation:result.operation};}
    catch(error){data.controlError='操作未确认（'+error.message+'），请核对状态';}
    finally{globalBusy=false;renderGlobal();void refreshGlobal();}
   };
   top=append(w,el('header','ref-top'));top.innerHTML=`<div class="ref-statusbar"></div><div class="ref-top-note"><div class="ref-window-controls" aria-hidden="true"><span>−</span><span>▢</span><span>×</span></div>和你在一起，<br>　就是最好的状态。<small>— 人格 ♡</small></div>`;
   hero=null;
   dashboard=append(w,el('aside','ref-dashboard'));dashboard.setAttribute('aria-label','人格的近况');
   development=append(w,el('section','ref-development',`${icon('work')}<h1></h1><p>此功能正在开发</p><button>返回对话</button>`));development.style.display='none';development.querySelector('button').onclick=()=>navigate('对话');
   chats?.dispose();chats=installChats({nav,root:w.querySelector('.yb-root'),workspace:w,added,onSelect:()=>navigate('对话')});
   nav.querySelector('.ref-menu').onclick=conversations;nav.querySelector('.ref-profile').onclick=conversations;
   for(const [region,label] of [['left','左侧导航'],['right','右侧近况'],['top','上部状态与横幅']]){
    const toggle=append(w,el('button','ref-layout-toggle'));toggle.type='button';toggle.dataset.region=region;
    const update=()=>{const collapsed=layout[region];w.classList.toggle('ref-'+region+'-collapsed',collapsed);toggle.textContent=region==='top'?(collapsed?'▼':'▲'):region==='left'?(collapsed?'▶':'◀'):(collapsed?'◀':'▶');toggle.setAttribute('aria-label',(collapsed?'展开':'收起')+label);toggle.title=toggle.getAttribute('aria-label');toggle.setAttribute('aria-expanded',String(!collapsed));};
    toggle.onclick=()=>{layout[region]=!layout[region];update();try{localStorage.setItem(layoutKey,JSON.stringify(layout));}catch{}};update();
   }
   renderDashboard();decorate();void refresh();void refreshGlobal();
  }
  function renderDashboard(){
   const previousScroll=dashboard.scrollTop;
   const preview=data.referencePreview===true,live=data.live;
   const x=preview?data.referenceExtras:live?{
    changes:live.changes.map(c=>({...c,occurredAt:c.time,time:relativeTime(c.time)})),
    recent:live.recent.map(r=>({...r,time:clock(r.time)})),
    world:[['Bluesky','bluesky','bluesky-icon.png'],['GitHub','github','github-icon.png'],['网页资料','articles','article-icon.png']].map(([title,key,icon])=>({title,icon,sub:live.world[key]+' 次已完成访问'})),
    rhythm:live.rhythm
   }:{};
   const changes=x.changes??[];
   const recent=x.recent??(data.rows??[]).filter(r=>r.role==='tool').slice(-4).reverse().map(r=>({title:/bluesky/i.test(r.text)?'浏览 Bluesky':/github/i.test(r.text)?'查看 GitHub':r.text,sub:r.status==='completed'?'已完成':r.status==='error'?'执行失败':'等待执行结果',time:clock(r.time),icon:/bluesky/i.test(r.text)?'bluesky-icon.png':/github/i.test(r.text)?'github-icon.png':'article-icon.png'}));
   const world=x.world??[];
   const hours=x.hours??null;
   dashboard.innerHTML=`<section class="ref-panel ref-changes"><div class="ref-panel-head"><h2>偶发变化</h2><small>这些小小的变化，构成了生活</small><button aria-label="收起偶发变化">⌃</button></div><div class="ref-changes-body">${changes.length?changes.map((c,index)=>`<details class="ref-change" data-change-id="${escape(c.id??'preview-'+index)}" ${expandedCards.has(c.id??'preview-'+index)?'open':''}><summary><span class="ref-change-icon">${escape(c.icon)}</span><strong>${escape(c.text)}</strong><small>${escape(c.time)}</small><span class="ref-change-dot"></span></summary><div class="ref-expanded-body"><p>${escape(c.text)}</p>${c.reason?'<p>'+escape(c.reason)+'</p>':''}<time>${escape(c.occurredAt?new Date(c.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):c.time)}</time></div></details>`).join(''):'<div class="ref-empty">此刻还没有新的变化记录。</div>'}</div></section><section class="ref-panel ref-recent"><div class="ref-panel-head"><h2>最近动作</h2><button data-open="actions">查看全部 ${icon('chevron')}</button></div>${recent.length?recent.map(r=>`<div class="ref-recent-row">${img(r.icon||'article-icon.png')}<div><strong>${escape(r.title)}</strong><small>${escape(r.sub)}</small></div><time>${escape(r.time)}</time></div>`).join(''):'<div class="ref-empty">新的动作会出现在这里。</div>'}</section><section class="ref-panel ref-world"><div class="ref-panel-head"><h2>世界</h2><small>今天接触的内容</small><button data-open="world">查看全部 ${icon('chevron')}</button></div>${world.length?`<div class="ref-world-grid">${world.map(c=>`<div class="ref-world-tile">${img(c.icon)}<div><strong>${escape(c.title)}</strong><small>${escape(c.sub)}</small></div></div>`).join('')}</div>`:'<div class="ref-empty">今天接触的内容，慢慢积累。</div>'}</section><section class="ref-panel ref-rhythm"><div class="ref-panel-head"><h2>今日节律</h2><small>${hours?'4.2 小时在线':'记录今天的步调'}</small><button data-open="rhythm">详情 ${icon('chevron')}</button></div>${hours?`<div class="ref-rhythm-bar">${hours.map((v,i)=>`<span style="width:${[35,16,27,12,10][i]}%;background:${['#3773ff','#50a8f7','#474fba','#bfa0ee','#28374c'][i]}"></span>`).join('')}</div><div class="ref-rhythm-legend">${hours.map((v,i)=>`<div class="ref-rhythm-item"><i style="background:${['#3773ff','#50a8f7','#a195f8','#d5b5f5','#93baff'][i]}"></i>${['工作','对话','浏览世界','整理记忆','休息'][i]}<small>${v}h</small></div>`).join('')}</div>`:'<div class="ref-rhythm-bar"></div><div class="ref-empty">时长记录尚未接入。</div>'}<blockquote>一点一点，把想做的事，变成真实的生活。</blockquote></section>`;
   if(x.rhythm){const panel=dashboard.querySelector('.ref-rhythm');panel.querySelector('.ref-panel-head small').textContent=(x.rhythm.nativeTurnMs/3600000).toFixed(1)+' 小时运行';panel.querySelector('.ref-rhythm-bar').innerHTML='<span style="width:100%;background:#3773ff"></span>';panel.querySelector('.ref-empty').innerHTML='<span style="color:#b6c9e8">对话与行动 '+(x.rhythm.nativeTurnMs/3600000).toFixed(1)+'h</span><br><small>以今日原生回合记录计时 · 休息时长未记录</small>';}
   const changesBox=dashboard.querySelector('.ref-changes-body');changesBox.hidden=changesCollapsed;
   const changesButton=dashboard.querySelector('.ref-changes button');changesButton.textContent=changesCollapsed?'⌄':'⌃';changesButton.setAttribute('aria-label',changesCollapsed?'展开偶发变化':'收起偶发变化');
   changesButton.onclick=e=>{changesCollapsed=!changesCollapsed;changesBox.hidden=changesCollapsed;e.currentTarget.textContent=changesCollapsed?'⌄':'⌃';e.currentTarget.setAttribute('aria-label',changesCollapsed?'展开偶发变化':'收起偶发变化');};
   dashboard.querySelectorAll('.ref-change').forEach(d=>d.addEventListener('toggle',()=>{if(!d.isConnected)return;d.open?expandedCards.add(d.dataset.changeId):expandedCards.delete(d.dataset.changeId);}));
   dashboard.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{if(b.dataset.open==='actions'){workspace.querySelector('.yb-list').scrollTop=workspace.querySelector('.yb-list').scrollHeight;workspace.querySelectorAll('.ref-operation-card,.yb-action-card').forEach(d=>d.open=true);}else navigate(b.dataset.open==='world'?'世界':'今天');});
   dashboard.scrollTop=previousScroll;
  }
  function renderStatus(){
   const preview=data.referencePreview===true,x=preview?data.referenceExtras:{},ready=data.ready===true,live=data.live;
   const latest=(data.rows??[]).filter(r=>r.role==='progress').at(-1)?.text;
   const activity=x.activity??live?.self.activity??(latest?latest.split('\n')[0]:data.running?'正在处理对话':'尚未写下当前活动');
   const mood=x.mood??live?.mental?.text??'尚未写下此刻的心境';
   const availability=preview?'随时可以叫我':!ready?'正在重连':live?.running?'可补充消息':'可发消息';
   const cells=[['online',ready?'在场':'连接中',ready?'人格在这里，与你一起':'正在连接人格'],['bot','正在做什么',activity],['bolt','档位',x.effort??live?.request.actualEffort??'未记录'],['chat','可打扰程度',availability],['check','挂着几件事',preview?'2 件':'未记录'],['smile','我的状态',mood]];
   top.querySelector('.ref-statusbar').innerHTML=cells.map(([i,title,value])=>`<div class="ref-status-cell">${i==='online'?`<span class="ref-online ${ready?'':'offline'}"></span>`:icon(i,i)}<div><strong>${escape(title)}</strong><small title="${escape(value)}">${escape(value)}</small></div></div>`).join('');
   nav.querySelector('.ref-profile-name').textContent=preview?'felibata ne':'用户';
  }
  function renderGlobal(){
   if(!globalControls)return;
   const g=data.global,op=g?.operation,starting=globalBusy||['starting','stopping'].includes(op?.state);
   if(!g)return;
   const labels={idle:'在线待机',busy:'正在活动',offline:'未启动',disabled:'已停用'};
   const failed=op?.workers?.filter(w=>w.state==='failed')??[];
   const markup=(g.workers??[]).map(w=>{
    const active=starting&&op?.target_life_id===w.life_id;
    const state=active?(op.action==='stop'?'正在停止…':'正在启动…'):w.execution_disabled&&w.healthy?'停止未完成':labels[w.state]??'状态待确认';
    const stopDisabled=globalBusy||starting&&!(active&&op.action==='start');
    return `<div class="ref-life-control"><strong>${escape(w.display_name.replace('（待自命名）',''))}</strong><small>${escape(state)}</small><button type="button" data-life-id="${escape(w.life_id)}" data-action="start" aria-label="启动${escape(w.display_name)}" ${starting?'disabled':''}>启动</button><button type="button" data-life-id="${escape(w.life_id)}" data-action="stop" aria-label="停止${escape(w.display_name)}" ${stopDisabled?'disabled':''}>停止</button></div>`;
   }).join('')+'<small role="status" aria-live="polite">'+escape(data.controlError??(failed.length?failed.map(w=>w.display_name+'操作失败（'+w.error_code+'）').join('；'):op?.state==='failed'?'操作失败（'+op.error_code+'）':''))+'</small>';
   if(globalControls.innerHTML!==markup)globalControls.innerHTML=markup;
  }
  async function refreshGlobal(){
   if(globalPolling||disposed||!workspace)return;globalPolling=true;
   try{const r=await fetch('/api/persona.globalStatus');if(!r.ok)throw Error('status');const value=await r.json();if(!disposed){data.global=value;renderGlobal();}}
   catch{if(!disposed&&globalControls)globalControls.querySelector('[role=status]').textContent='全局控制连接暂时不可用';}
   finally{globalPolling=false;}
  }
  function decorate(){
   if(!workspace?.isConnected)return;
   for(const role of workspace.querySelectorAll('.yb-message>.yb-role')){
    const original=role.textContent;if(role.dataset.refText===original)continue;
    const pieces=original.split(' · ');const user=role.parentElement.classList.contains('yb-user');
    role.innerHTML=`<strong>${escape(user?'我':pieces[0])}</strong><time>${escape((pieces[1]??'').replace(/^(\d\d:\d\d):\d\d$/,'$1'))}</time>`;role.dataset.refText=role.textContent;
   }
   const composer=workspace.querySelector('.yb-composer');
   if(composer){
    const attach=composer.querySelector('[aria-label="添加附件"]');if(attach&&!attach.dataset.refIcon){attach.innerHTML=icon('clip');attach.dataset.refIcon='true';}
    const send=composer.querySelector('.yb-send');if(send&&!send.querySelector('svg')){send.setAttribute('aria-label','发送消息');send.title='发送消息';send.innerHTML=icon('send');}
    const stop=[...composer.querySelectorAll('button')].find(b=>b.textContent==='停止执行');if(stop)stop.setAttribute('aria-label','停止执行');
    if(!composer.querySelector('.ref-image-button')){const image=el('button','ref-composer-action ref-image-button',icon('image'));image.type='button';image.setAttribute('aria-label','添加图片');image.onclick=()=>composer.querySelector('input[type=file]').click();const plus=el('button','ref-composer-action ref-plus-button',icon('plus'));plus.type='button';plus.setAttribute('aria-label','新建或切换对话');plus.onclick=()=>nav.querySelector('.ref-profile').click();composer.insertBefore(image,send);composer.insertBefore(plus,send);}
   }
   for(const d of workspace.querySelectorAll('.yb-thinking')){
    const duplicate=d.dataset.thinkingLive==='true'&&!data.running&&(data.rows??[]).some(r=>r.role==='thinking'&&String(r.turn)===d.dataset.thinkingTurn&&r.text);if(d.dataset.refDuplicate!==String(duplicate))d.dataset.refDuplicate=String(duplicate);
    const source=d.querySelector('.yb-thinking-text')?.textContent??'';if(source.length)d.dataset.refChinese=String((source.match(/[\u3400-\u9fff]/g)??[]).length/source.length>.2);
    const summary=d.querySelector(':scope>summary');if(!summary)continue;
    const textNode=[...summary.childNodes].find(n=>n.nodeType===3);if(textNode&&textNode.textContent.startsWith('🧠 '))textNode.textContent=data.referencePreview?'思考摘要（已展开）':textNode.textContent.replace('🧠 ','');
    if(data.referencePreview&&!d.querySelector('.ref-thinking-meta')){const meta=el('span','ref-thinking-meta','生成于 22:16 · 用时 8.4s');summary.append(meta);d.open=true;}
   }
   for(const group of workspace.querySelectorAll('.yb-actions:not(.ref-group)')){
    const body=group.querySelector(':scope>div:not(.yb-actions-heading)');if(!body)continue;const rows=body.querySelectorAll('.yb-action-card');
    group.classList.add('ref-group');const pair=el('div','ref-operation-pair');
    const completed=[...rows].filter(d=>d.dataset.status==='completed').length;
    const tools=el('details','ref-operation-card',`<summary>${img('wrench-icon.png')}<div><strong>工具调用</strong><small>已使用 ${rows.length} 个工具</small></div>${icon('chevron')}</summary>`);
    // Keep React's original children under their original parent. Visibility
    // is controlled by CSS so polling, Session switches and removal remain safe.
    body.classList.add('ref-operation-body');tools.addEventListener('toggle',()=>group.classList.toggle('ref-tools-open',tools.open));
    const action=el('details','ref-operation-card',`<summary>${img('action-icon.png')}<div><strong>动作</strong><small>已完成 ${completed} 项动作</small></div>${icon('chevron')}</summary><div class="ref-operation-body"><p>${completed?'记录中的动作已完成。':'结果会随执行记录更新。'}</p></div>`);
    pair.append(tools,action);group.append(pair);
   }
   for(const group of workspace.querySelectorAll('.yb-actions.ref-group')){const rows=[...group.querySelectorAll(':scope>.ref-operation-body .yb-action-card')],complete=rows.filter(d=>d.dataset.status==='completed').length;const labels=group.querySelectorAll('.ref-operation-card>summary small');for(const [i,text] of [[0,`已使用 ${rows.length} 个工具`],[1,`已完成 ${complete} 项动作`]])if(labels[i]&&labels[i].textContent!==text)labels[i].textContent=text;}
   // React may update its owned summaries during a poll; decoration is idempotent.
  }
  async function refresh(){
   if(polling||disposed||!workspace)return;polling=true;
   try{
    const r=await fetch('/api/persona.status');if(!r.ok)throw Error('status');const status=await r.json();
    const previous=JSON.stringify(data);data={...data,...status};
    if(!status.referencePreview){const state=await fetch('/api/persona.referenceState');if(state.ok)data.live=await state.json();}
    const selected=window.__personaDesktopState?.selectedSessionId;
    if(status.ready&&selected&&!workspace.classList.contains('ref-room-active')){const log=await fetch('/api/persona.historyState?sessionId='+encodeURIComponent(selected));if(log.ok){const history=await log.json();data.rows=history.rows;data.running=history.running;}}
    if(disposed)return;renderStatus();if(previous!==JSON.stringify(data))renderDashboard();decorate();
   }catch{if(!disposed){data.ready=false;renderStatus();}}finally{polling=false;}
  }
  function scan(){scheduled=false;if(disposed)return;const w=document.querySelector('.yb-workspace');if(w&&w!==workspace)mount(w);else decorate();}
  const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(scan);}});
  observer.observe(document.body,{childList:true,subtree:true,characterData:true});scan();
  timer=setInterval(()=>{void refresh();},2500);
  globalTimer=setInterval(()=>{void refreshGlobal();},2500);
  const cleanup=()=>{if(disposed)return;disposed=true;chats?.dispose();clearInterval(timer);clearInterval(globalTimer);observer.disconnect();style.remove();
   for(const group of workspace?.querySelectorAll('.yb-actions.ref-group')??[]){const body=group.querySelector('.ref-operation-body');if(body&&body.parentElement!==group)group.insertBefore(body,group.querySelector('.ref-operation-pair'));body?.classList.remove('ref-operation-body');group.querySelector('.ref-operation-pair')?.remove();group.classList.remove('ref-group','ref-tools-open');}
   workspace?.querySelectorAll('.ref-composer-action,.ref-thinking-meta').forEach(n=>n.remove());workspace?.classList.remove('ref-ui','ref-development-open','ref-conversations-open','ref-left-collapsed','ref-right-collapsed','ref-top-collapsed');added.forEach(n=>n.remove());if(window.__personaReferenceCleanup===cleanup)delete window.__personaReferenceCleanup;};
  window.__personaReferenceCleanup=cleanup;return cleanup;
 });
}
return {apply,contactEntries,groupRunTimeline,deliverySummary};
}});
